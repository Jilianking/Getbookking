#!/usr/bin/env node
/**
 * Create team invites (same as Team → Invite) and complete join-page signup
 * (Auth createUser + acceptTenantInvite) for an owner email.
 *
 * Usage (from Test/):
 *   node scripts/invite-team-members-via-join.js --email=test1000@example.com --count=3
 *   node scripts/invite-team-members-via-join.js --email=owner@example.com --count=3 --password=1Abcdefg!
 *
 * Auth: firebase login (or GOOGLE_APPLICATION_CREDENTIALS)
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, FieldValue, Timestamp } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const {
  resolveTenantByOwnerEmail,
  resolveTenantBySlug,
} = require(path.join(__dirname, "../functions/seedBookingRequestsLib"));

const DEFAULT_PROJECT = "test-app-96812";
const DEFAULT_PASSWORD = "1Abcdefg!";
const WEB_API_KEY = "AIzaSyB9DwVkkCM-0cpYhkWRnTfScHIRNIDyJ3g";
const FUNCTIONS_REGION = "us-central1";
const JOIN_ORIGIN = "https://join.getbookking.com";
const TENANT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

const MEMBER_PRESETS = [
  {
    email: "alex.team.test1000@example.com",
    firstName: "Alex",
    lastName: "Rivera",
    phone: "(555) 201-1001",
  },
  {
    email: "jordan.team.test1000@example.com",
    firstName: "Jordan",
    lastName: "Lee",
    phone: "(555) 201-1002",
  },
  {
    email: "sam.team.test1000@example.com",
    firstName: "Sam",
    lastName: "Patel",
    phone: "(555) 201-1003",
  },
];

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
      "No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS."
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

function parseArgs(argv) {
  const out = {
    email: null,
    slug: null,
    count: 3,
    project: DEFAULT_PROJECT,
    password: DEFAULT_PASSWORD,
    help: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--count=")) {
      out.count = Math.max(1, parseInt(arg.slice(8), 10) || 1);
    } else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--password=")) out.password = arg.slice(11);
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
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

function defaultJobTitle(industry) {
  const map = {
    tattoos: "Artist",
    hair: "Stylist",
    barber: "Barber",
    nails: "Nail technician",
    custom: "Team member",
  };
  const key = (industry || "custom").toString().trim().toLowerCase();
  return map[key] || "Team member";
}

async function resolveTenant(db, { email, slug }) {
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
  throw new Error("Provide --email=owner@example.com or --slug=...");
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
  const user = data && data.users && data.users.find((u) => u.email === email);
  return user ? { uid: user.localId, email: user.email } : null;
}

/** Client path used by join.html: createUserWithEmailAndPassword */
async function signUpWithPassword(email, password, displayName) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        displayName,
        returnSecureToken: true,
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    const code = (body.error && body.error.message) || JSON.stringify(body);
    throw new Error(`Auth sign-up failed for ${email}: ${code}`);
  }
  return { uid: body.localId, idToken: body.idToken };
}

/** If user already exists, sign in and reuse for accept. */
async function signInWithPassword(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    const code = (body.error && body.error.message) || JSON.stringify(body);
    throw new Error(`Auth sign-in failed for ${email}: ${code}`);
  }
  return { uid: body.localId, idToken: body.idToken };
}

async function ensureAuthSession(email, password, displayName) {
  try {
    return { ...(await signUpWithPassword(email, password, displayName)), created: true };
  } catch (err) {
    const msg = (err.message || "").toString();
    if (msg.includes("EMAIL_EXISTS")) {
      return { ...(await signInWithPassword(email, password)), created: false };
    }
    throw err;
  }
}

async function callAcceptTenantInvite(projectId, idToken, payload) {
  const url = `https://${FUNCTIONS_REGION}-${projectId}.cloudfunctions.net/acceptTenantInvite`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data: payload }),
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    const err = body.error || body;
    const message =
      (err.message && String(err.message)) ||
      (err.status && `${err.status}: ${JSON.stringify(err)}`) ||
      JSON.stringify(body);
    throw new Error(`acceptTenantInvite failed: ${message}`);
  }
  return body.result || body.data || body;
}

async function createInviteDoc(db, tenant, ownerUid, jobTitle) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + TENANT_INVITE_TTL_MS);
  await db.collection("tenantInvites").doc(token).set({
    tenantId: tenant.id,
    createdByUid: ownerUid,
    createdAt: now,
    expiresAt,
    role: "member",
    accessRole: "member",
    jobTitle: jobTitle || "Team member",
  });
  const joinUrl = `${JOIN_ORIGIN}/join?t=${encodeURIComponent(token)}`;
  return { token, joinUrl };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.email && !args.slug)) {
    console.log(`
Create team invites + complete join signup (Auth + acceptTenantInvite).

  node scripts/invite-team-members-via-join.js --email=test1000@example.com --count=3
  node scripts/invite-team-members-via-join.js --slug=test100 --count=3

Default password: ${DEFAULT_PASSWORD}
`);
    process.exit(args.help ? 0 : 1);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, accessToken } = await createGoogleClients(projectId);
  const tenant = await resolveTenant(db, args);
  let plan = normalizePlan(tenant.data.subscriptionPlan);
  const industry = (tenant.data.industry || "custom").toString();
  const jobTitle = defaultJobTitle(industry);
  const ownerUid = (tenant.data.ownerUid || "").toString();

  if (!ownerUid) {
    throw new Error(`Tenant ${tenant.id} has no ownerUid`);
  }

  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.data.slug || "(no slug)"} (${tenant.id})`);
  console.log(`Owner UID: ${ownerUid}`);
  console.log(`Industry: ${industry} → job title: ${jobTitle}`);
  console.log(`Plan: ${plan}`);

  if (plan === "solo") {
    await db.collection("tenants").doc(tenant.id).update({
      subscriptionPlan: "studio",
      updatedAt: FieldValue.serverTimestamp(),
    });
    tenant.data.subscriptionPlan = "studio";
    plan = "studio";
    console.log("Upgraded tenant subscriptionPlan to studio (team seats).");
  }

  const rosterSnap = await db
    .collection("users")
    .where("tenantId", "==", tenant.id)
    .get();
  const existingEmails = new Set(
    rosterSnap.docs.map((d) => (d.data().email || "").toLowerCase()).filter(Boolean)
  );

  const members = MEMBER_PRESETS.slice(0, args.count);
  const toAdd = members.filter((m) => !existingEmails.has(m.email.toLowerCase()));
  if (rosterSnap.size + toAdd.length > maxSeats(plan)) {
    throw new Error(
      `Seat limit ${maxSeats(plan)} on plan ${plan}; roster ${rosterSnap.size}, adding ${toAdd.length}.`
    );
  }

  console.log(`\nProcessing ${members.length} invite signup(s)…\n`);
  const results = [];

  for (const member of members) {
    const email = member.email.toLowerCase();
    const displayName = `${member.firstName} ${member.lastName}`;

    if (existingEmails.has(email)) {
      console.log(`Skip ${email} (already on roster)`);
      results.push({ email, status: "already_member" });
      continue;
    }

    // Match Team → Invite button: createTenantInvite writes this doc.
    const { token, joinUrl } = await createInviteDoc(db, tenant, ownerUid, jobTitle);
    console.log(`Invite created: ${joinUrl}`);

    // Match join.html: Auth createUser + acceptTenantInvite callable.
    const session = await ensureAuthSession(email, args.password, displayName);
    console.log(
      `${session.created ? "Signed up" : "Signed in"} Auth ${email} (${session.uid})`
    );

    const accept = await callAcceptTenantInvite(projectId, session.idToken, {
      token,
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
    });
    console.log(`acceptTenantInvite OK for ${email}`, accept);

    results.push({
      email,
      password: args.password,
      firstName: member.firstName,
      lastName: member.lastName,
      uid: session.uid,
      joinUrl,
      status: "joined",
    });
    existingEmails.add(email);
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
      return `${a.firstName} ${a.lastName}`.localeCompare(
        `${b.firstName} ${b.lastName}`
      );
    })
    .forEach((x) => {
      console.log(
        `  ${x.firstName || ""} ${x.lastName || ""} <${x.email || ""}> role=${x.accessRole || x.role || ""} title=${x.jobTitle || ""}`
      );
    });

  console.log("\nNew logins:");
  results
    .filter((r) => r.status === "joined")
    .forEach((r) => {
      console.log(`  ${r.email} / ${r.password}  (${r.firstName} ${r.lastName})`);
    });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
