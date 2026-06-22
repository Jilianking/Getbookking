#!/usr/bin/env node
/**
 * Seed marketing demo activity: customers, bookings, SMS, showcase payments.
 *
 * Usage (from Test/):
 *   node scripts/seed-demo-activity.js
 *   node scripts/seed-demo-activity.js --only=northline-tattoo
 *   node scripts/seed-demo-activity.js --slug=stone-cut-barbers --no-replace
 *
 * Requires demo tenants from seed-demo-accounts.js first.
 * Deploy functions after first run (demoShowcase payment shim).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, Timestamp } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const {
  DEMO_ACTIVITY_BY_SLUG,
  resolveTenantBySlug,
  seedDemoActivity,
} = require(path.join(__dirname, "../functions/demoSeedActivityLib"));
const { resolveTenantByOwnerEmail } = require(path.join(
  __dirname,
  "../functions/seedBookingRequestsLib"
));

const DEFAULT_PROJECT = "test-app-96812";

const DEMO_OWNER_EMAIL_BY_SLUG = {
  "northline-tattoo": "demo-northline@getbookking.com",
  "iron-district-gym": "demo-iron-district@getbookking.com",
  "studio-amara": "demo-studio-amara@getbookking.com",
  "stone-cut-barbers": "demo-stone-cut-barbers@getbookking.com",
  "gilded-palm": "demo-gilded-palm@getbookking.com",
};

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

async function createFirestore(projectId) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));
    if (!admin.apps.length) admin.initializeApp({ projectId });
    return admin.firestore();
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
  return new Firestore({ projectId, authClient });
}

function parseArgs(argv) {
  const out = {
    slug: null,
    email: null,
    only: null,
    project: DEFAULT_PROJECT,
    replace: true,
    help: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--only=")) out.only = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--no-replace") out.replace = false;
    else if (arg === "--replace") out.replace = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  if (out.only) out.slug = out.only;
  return out;
}

function slugsToSeed(args) {
  if (args.slug) {
    if (!DEMO_ACTIVITY_BY_SLUG[args.slug]) {
      throw new Error(`Unknown slug: ${args.slug}`);
    }
    return [args.slug];
  }
  return Object.keys(DEMO_ACTIVITY_BY_SLUG);
}

async function resolveTenant(db, args, slug) {
  if (args.email) {
    return resolveTenantByOwnerEmail(db, args.email);
  }
  const email = DEMO_OWNER_EMAIL_BY_SLUG[slug];
  if (email) {
    try {
      return await resolveTenantByOwnerEmail(db, email);
    } catch (_) {
      /* fall through to slug */
    }
  }
  return resolveTenantBySlug(db, slug);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed demo marketing activity (customers, bookings, SMS, showcase payments).

  node scripts/seed-demo-activity.js
  node scripts/seed-demo-activity.js --only=northline-tattoo
  node scripts/seed-demo-activity.js --email=demo-northline@getbookking.com

Run seed-demo-accounts.js first. Then deploy Cloud Functions for fake payments in-app.

  firebase deploy --only functions:getConnectAccountStatus,functions:getConnectBalance,functions:getConnectBalanceTransactions
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const db = await createFirestore(projectId);
  const slugs = slugsToSeed(args);

  console.log(`Project: ${projectId}`);
  console.log(`Seeding activity for: ${slugs.join(", ")}`);
  console.log(`Replace existing demo-seed rows: ${args.replace}\n`);

  const results = [];
  for (const slug of slugs) {
    process.stdout.write(`${slug} ... `);
    const tenant = await resolveTenant(db, args, slug);
    const result = await seedDemoActivity(db, tenant.id, slug, Timestamp, {
      replace: args.replace,
    });
    results.push(result);
    console.log(
      `ok (${result.customers} clients, ${result.bookings} bookings, ${result.smsThreads} SMS threads, ${result.paymentTransactions} payments)`
    );
  }

  console.log("\nSign in as demo owner → Dashboard / Requests / Messages / Payments / Insights");
  console.log("Deploy functions if payments still show Connect Stripe banner.\n");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
