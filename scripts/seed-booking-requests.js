#!/usr/bin/env node
/**
 * Seed booking requests for load-testing the Requests tab.
 *
 * Usage (from Test/):
 *   node scripts/seed-booking-requests.js --slug=test100 --count=100
 *   ./scripts/seed-booking-requests.sh 100
 *
 * Or from the app (DEBUG): Requests → ⋯ → Load test requests (owner, signed in).
 * That calls seedTenantBookingRequests (no local credentials).
 *
 * Auth for this script:
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 *   gcloud auth application-default login
 */

const path = require("path");
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));
const {
  resolveTenantBySlug,
  writeSeedBookingRequests,
} = require(path.join(__dirname, "../functions/seedBookingRequestsLib"));

const DEFAULT_PROJECT = "test-app-96812";

function parseArgs(argv) {
  const out = { slug: "test100", tenantId: null, count: 100, project: DEFAULT_PROJECT };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--count=")) {
      out.count = Math.min(500, Math.max(1, parseInt(arg.slice(8), 10) || 100));
    } else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
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
Seed tenants/{tenantId}/bookingRequests for Requests tab testing.

  node scripts/seed-booking-requests.js --slug=test100 --count=100

Uses source "seed" — FCM on create is skipped when onTenantBookingRequestCreated is deployed.
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  admin.initializeApp({ projectId });
  const db = admin.firestore();

  const tenant = await resolveTenantId(db, args);
  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.slug || "(no slug)"} (${tenant.id})`);
  console.log(`Creating ${args.count} booking requests...`);

  const { written } = await writeSeedBookingRequests(db, tenant.id, args.count, admin);

  console.log(`Done. ${written} requests at tenants/${tenant.id}/bookingRequests`);
  console.log("Open the app → Requests (same tenant, not demo mode) and pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
