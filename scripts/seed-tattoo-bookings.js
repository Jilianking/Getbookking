#!/usr/bin/env node
/**
 * Seed tattoo booking requests for a tenant (May 20 – end of June by default).
 * 10 appointments per artist (Maya Chen, Leo Vega) with tattoo services and dates.
 *
 * Usage (from Test/):
 *   node scripts/seed-tattoo-bookings.js --email=daisybleu@gmail.com
 *   node scripts/seed-tattoo-bookings.js --slug=my-studio --perArtist=10
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
  writeTattooSeedBookingRequests,
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
    slug: null,
    tenantId: null,
    email: null,
    project: DEFAULT_PROJECT,
    perArtist: 10,
    start: "2026-05-20",
    end: "2026-06-30",
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--perArtist=")) {
      out.perArtist = Math.min(50, Math.max(1, parseInt(arg.slice(12), 10) || 10));
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

async function resolveTenantId(db, { slug, tenantId, email }) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, slug: (doc.data().slug || "").toString() };
  }
  if (email) {
    const t = await resolveTenantByOwnerEmail(db, email);
    return { id: t.id, slug: t.slug };
  }
  if (slug) {
    return resolveTenantBySlug(db, slug);
  }
  throw new Error("Provide --email=owner@example.com, --slug=..., or --tenantId=...");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed tattoo booking requests (source "seed") for a tenant.

  node scripts/seed-tattoo-bookings.js --email=daisybleu@gmail.com
  node scripts/seed-tattoo-bookings.js --slug=my-studio --perArtist=10 --start=2026-05-20 --end=2026-06-30

Creates 2 artists (Maya Chen, Leo Vega) × perArtist requests with requestedStartTime in range.
Run seed-team-members.js first if Maya/Leo are not on the roster yet.
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
    `Seeding ${args.perArtist} bookings × 2 artists (${args.start} – ${args.end})...`
  );

  const { written, perArtist, artists } = await writeTattooSeedBookingRequests(
    db,
    tenant.id,
    Timestamp,
    { perArtist: args.perArtist, startDate, endDate }
  );

  console.log(
    `Done. ${written} requests (${perArtist} per artist × ${artists} artists).`
  );
  console.log(`Path: tenants/${tenant.id}/bookingRequests`);
  console.log("Open the app → Requests → pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
