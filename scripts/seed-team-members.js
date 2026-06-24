#!/usr/bin/env node
/**
 * Seed team members (Firebase Auth + users/{uid}) for a tenant.
 *
 * Usage (from Test/):
 *   node scripts/seed-team-members.js --slug=test100
 *   node scripts/seed-team-members.js --email=daisybleu@gmail.com
 *   node scripts/seed-team-members.js --email=owner@example.com --count=2
 *
 * Auth:
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 *   gcloud auth application-default login
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, FieldValue } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json"
  );
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return cfg && cfg.tokens && cfg.tokens.refresh_token;
}

async function createGoogleClients(projectId) {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error(
      "No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON."
    );
  }
  const auth = new GoogleAuth({
    credentials: {
      type: "authorized_user",
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      refresh_token: refresh,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const authClient = await auth.getClient();
  const db = new Firestore({ projectId, authClient });
  const accessToken = await auth.getAccessToken();
  return { db, accessToken };
}

async function lookupAuthUserByEmail(projectId, accessToken, email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: [email] }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user =
    data && data.users && data.users.find((u) => u.email === email);
  return user ? { uid: user.localId, email: user.email } : null;
}

async function createOrUpdateAuthUser(projectId, accessToken, { email, password, displayName }) {
  const existing = await lookupAuthUserByEmail(projectId, accessToken, email);
  if (existing) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localId: existing.uid,
          password,
          displayName,
          emailVerified: true,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Auth update failed for ${email}: ${res.status} ${err}`);
    }
    return { uid: existing.uid, created: false };
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        displayName,
        emailVerified: true,
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Auth create failed for ${email}: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return { uid: body.localId, created: true };
}
const {
  resolveTenantBySlug,
  resolveTenantByOwnerEmail,
} = require(path.join(__dirname, "../functions/seedBookingRequestsLib"));

const DEFAULT_PROJECT = "test-app-96812";
const DEFAULT_PASSWORD = "1Abcdefg!";

const MEMBER_PRESETS = {
  barber: [
    {
      email: "marc.barber1@example.com",
      firstName: "Marc",
      lastName: "Reyes",
      phone: "5552010001",
      jobTitle: "Barber",
    },
    {
      email: "diego.barber2@example.com",
      firstName: "Diego",
      lastName: "Cole",
      phone: "5552010002",
      jobTitle: "Barber",
    },
    {
      email: "james.barber3@example.com",
      firstName: "James",
      lastName: "Ortiz",
      phone: "5552010003",
      jobTitle: "Barber",
    },
  ],
  tattoos: [
    {
      email: "maya.artist1@example.com",
      firstName: "Maya",
      lastName: "Chen",
      phone: "5553010001",
      jobTitle: "Artist",
    },
    {
      email: "leo.artist2@example.com",
      firstName: "Leo",
      lastName: "Vega",
      phone: "5553010002",
      jobTitle: "Artist",
    },
  ],
};

function parseArgs(argv) {
  const out = {
    slug: null,
    tenantId: null,
    email: null,
    count: null,
    project: DEFAULT_PROJECT,
    password: DEFAULT_PASSWORD,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--count=")) {
      out.count = Math.max(1, parseInt(arg.slice(8), 10) || 1);
    } else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--password=")) out.password = arg.slice(11);
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function membersForTenant(tenant, count) {
  const industry = (tenant.data.industry || "barber").toString().trim().toLowerCase();
  const preset = MEMBER_PRESETS[industry] || MEMBER_PRESETS.barber;
  if (count != null) return preset.slice(0, count);
  return preset;
}

async function resolveTenant(db, { slug, tenantId, email }) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, data: doc.data() };
  }
  if (email) {
    const t = await resolveTenantByOwnerEmail(db, email);
    const doc = await db.collection("tenants").doc(t.id).get();
    return { id: t.id, data: doc.data() };
  }
  if (slug) {
    const t = await resolveTenantBySlug(db, slug);
    const doc = await db.collection("tenants").doc(t.id).get();
    return { id: t.id, data: doc.data() };
  }
  throw new Error("Provide --email=owner@example.com, --slug=..., or --tenantId=...");
}

function normalizePlan(raw) {
  const p = (raw || "").toString().trim().toLowerCase();
  if (["basic", "free", "starter", "solo"].includes(p)) return "solo";
  if (["growth", "pro", "studio"].includes(p)) return "studio";
  if (["enterprise", "shop"].includes(p)) return "shop";
  return p === "studio" || p === "shop" ? p : "solo";
}

function maxSeats(plan) {
  if (plan === "solo") return 1;
  if (plan === "studio") return 5;
  return 10;
}

function buildUserPatch(tenant, member) {
  const name = `${member.firstName} ${member.lastName}`.trim();
  const plan = normalizePlan(tenant.data.subscriptionPlan);
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.data.slug || "",
    role: "member",
    accessRole: "member",
    jobTitle: member.jobTitle,
    business: tenant.data.displayName || tenant.data.businessName || "",
    industry: (tenant.data.industry || "barber").toString(),
    subscriptionPlan: plan,
    subscriptionStatus: "active",
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    displayName: name,
    name,
    phone: member.phone,
    profilePhotoUrl: "",
    availability: {
      timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
      daysOpen: [1, 2, 3, 4, 5],
      timeZone: "America/New_York",
    },
    workflow: {
      confirmationType: "request_approve",
      responseTimeHours: 24,
    },
    memberSettings: {
      useStudioBookingPolicy: true,
      paymentSplitEnabled: false,
      paymentSplitPercent: 0,
      paymentSplitAppliesTo: "service",
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed team members for a tenant (Auth + Firestore users/{uid}).

  node scripts/seed-team-members.js --slug=test100
  node scripts/seed-team-members.js --email=daisybleu@gmail.com
  node scripts/seed-team-members.js --email=owner@example.com --count=2

Presets: barber (3), tattoos (2). --count limits how many are seeded.
Default password: ${DEFAULT_PASSWORD}
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, accessToken } = await createGoogleClients(projectId);

  const tenant = await resolveTenant(db, args);
  const members = membersForTenant(tenant, args.count);
  let plan = normalizePlan(tenant.data.subscriptionPlan);

  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.data.slug || args.slug || "(no slug)"} (${tenant.id})`);
  console.log(`Industry: ${tenant.data.industry || "(none)"}`);
  console.log(`Plan: ${plan}`);
  console.log(`Seeding ${members.length} member(s): ${members.map((m) => m.email).join(", ")}`);

  if (plan === "solo") {
    await db.collection("tenants").doc(tenant.id).update({
      subscriptionPlan: "studio",
      updatedAt: FieldValue.serverTimestamp(),
    });
    tenant.data.subscriptionPlan = "studio";
    plan = "studio";
    console.log("Upgraded tenant subscriptionPlan to studio (team seats).");
  }

  const snap = await db.collection("users").where("tenantId", "==", tenant.id).get();
  const byEmail = new Map(
    snap.docs.map((d) => [(d.data().email || "").toLowerCase(), d])
  );

  const toAdd = members.filter((m) => !byEmail.has(m.email.toLowerCase())).length;
  if (snap.size + toAdd > maxSeats(plan)) {
    throw new Error(
      `Seat limit ${maxSeats(plan)} on plan ${plan}; roster ${snap.size}, adding ${toAdd}.`
    );
  }

  for (const member of members) {
    const displayName = `${member.firstName} ${member.lastName}`;
    const existing = byEmail.get(member.email.toLowerCase());
    let uid;

    const r = await createOrUpdateAuthUser(projectId, accessToken, {
      email: member.email,
      password: args.password,
      displayName,
    });
    uid = r.uid;
    console.log(`${r.created ? "Created" : "Updated"} Auth ${member.email} (${uid})`);

    const patch = buildUserPatch(tenant, member);
    const prev = existing ? existing.data() : null;
    patch.createdAt = (prev && prev.createdAt) || FieldValue.serverTimestamp();
    await db.collection("users").doc(uid).set(patch, { merge: true });
  }

  const after = await db.collection("users").where("tenantId", "==", tenant.id).get();
  console.log(`\nRoster (${after.size} members):`);
  after.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const rank = { owner: 0, manager: 1, member: 2 };
      const ra = rank[(a.accessRole || a.role || "").toLowerCase()] ?? 3;
      const rb = rank[(b.accessRole || b.role || "").toLowerCase()] ?? 3;
      if (ra !== rb) return ra - rb;
      return `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
    })
    .forEach((x) => {
      console.log(
        `  ${x.firstName} ${x.lastName} <${x.email}> role=${x.accessRole || x.role} title=${x.jobTitle || ""}`
      );
    });

  console.log(`\nTeam member login password: ${args.password}`);
  console.log("Sign in as the business owner → Team to verify.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
