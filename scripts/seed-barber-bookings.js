#!/usr/bin/env node
/**
 * Seed barber booking requests for a tenant (May 20 – end of June by default).
 * 10 appointments per barber (Marc, Diego, James) with barber services and dates.
 *
 * Usage (from Test/):
 *   node scripts/seed-barber-bookings.js --slug=test100
 *   node scripts/seed-barber-bookings.js --slug=test100 --perBarber=10
 *
 * Auth: firebase login (uses ~/.config/configstore/firebase-tools.json refresh token)
 *   or GOOGLE_APPLICATION_CREDENTIALS for a service account.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));

const {
  resolveTenantBySlug,
  writeBarberSeedBookingRequests,
} = require(path.join(__dirname, "../functions/seedBookingRequestsLib"));

const DEFAULT_PROJECT = "test-app-96812";

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

function parseArgs(argv) {
  const out = {
    slug: "test100",
    tenantId: null,
    project: DEFAULT_PROJECT,
    perBarber: 10,
    start: "2026-05-20",
    end: "2026-06-30",
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--perBarber=")) {
      out.perBarber = Math.min(50, Math.max(1, parseInt(arg.slice(12), 10) || 10));
    } else if (arg.startsWith("--start=")) out.start = arg.slice(8).trim();
    else if (arg.startsWith("--end=")) out.end = arg.slice(6).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function initFirestore(projectId) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    admin.initializeApp({ projectId });
    return {
      db: admin.firestore(),
      Timestamp: admin.firestore.Timestamp,
    };
  }

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
  const { Firestore, Timestamp } = require(path.join(
    __dirname,
    "../functions/node_modules/@google-cloud/firestore"
  ));
  return { db: new Firestore({ projectId, authClient }), Timestamp };
}

async function resolveTenantId(db, { slug, tenantId }) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, slug: (doc.data().slug || "").toString() };
  }
  return resolveTenantBySlug(db, slug);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed barber booking requests (source "seed") for test100 / any tenant slug.

  node scripts/seed-barber-bookings.js --slug=test100
  node scripts/seed-barber-bookings.js --slug=test100 --perBarber=10 --start=2026-05-20 --end=2026-06-30

Creates 3 barbers × perBarber requests with requestedStartTime in range.
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, Timestamp } = await initFirestore(projectId);
  const tenant = await resolveTenantId(db, args);
  const startDate = new Date(`${args.start}T12:00:00`);
  const endDate = new Date(`${args.end}T12:00:00`);

  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.slug || "(no slug)"} (${tenant.id})`);
  console.log(
    `Seeding ${args.perBarber} bookings × 3 barbers (${args.start} – ${args.end})...`
  );

  const { written, perBarber, barbers } = await writeBarberSeedBookingRequests(
    db,
    tenant.id,
    Timestamp,
    { perBarber: args.perBarber, startDate, endDate }
  );

  console.log(
    `Done. ${written} requests (${perBarber} per barber × ${barbers} barbers).`
  );
  console.log(`Path: tenants/${tenant.id}/bookingRequests`);
  console.log("Open the app as test100@example.com → Requests → pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
