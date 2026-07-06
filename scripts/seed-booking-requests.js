#!/usr/bin/env node
/**
 * Seed booking requests for load-testing the Requests tab.
 *
 * Usage (from Test/):
 *   node scripts/seed-booking-requests.js --slug=test100 --count=100
 *   node scripts/seed-booking-requests.js --slug=styleit --count=10
 *   ./scripts/seed-booking-requests.sh 100
 *
 * Or from the app (DEBUG): Requests → ⋯ → Load test requests (owner, signed in).
 * That calls seedTenantBookingRequests (no local credentials).
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
  resolveTenantByOwnerEmail,
  writeSeedBookingRequests,
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
    email: null,
    count: 100,
    project: DEFAULT_PROJECT,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--count=")) {
      out.count = Math.min(500, Math.max(1, parseInt(arg.slice(8), 10) || 100));
    } else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function initFirestore(projectId) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    if (!admin.apps.length) admin.initializeApp({ projectId });
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

async function resolveTenantId(db, { slug, tenantId, email }) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, slug: (doc.data().slug || "").toString() };
  }
  if (email) {
    return resolveTenantByOwnerEmail(db, email);
  }
  return resolveTenantBySlug(db, slug);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed tenants/{tenantId}/bookingRequests for Requests tab testing.

  node scripts/seed-booking-requests.js --slug=test100 --count=100
  node scripts/seed-booking-requests.js --slug=styleit --count=10
  node scripts/seed-booking-requests.js --email=owner@example.com --count=10

Uses source "seed" — FCM on create is skipped when onTenantBookingRequestCreated is deployed.

Auth: firebase login — or GOOGLE_APPLICATION_CREDENTIALS.
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, Timestamp } = await initFirestore(projectId);

  const tenant = await resolveTenantId(db, args);
  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.slug || "(no slug)"} (${tenant.id})`);
  console.log(`Creating ${args.count} booking requests...`);

  const adminShim = { firestore: { Timestamp } };
  const { written } = await writeSeedBookingRequests(
    db,
    tenant.id,
    args.count,
    adminShim
  );

  console.log(`Done. ${written} requests at tenants/${tenant.id}/bookingRequests`);
  console.log("Open the app → Requests (same tenant, not demo mode) and pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
