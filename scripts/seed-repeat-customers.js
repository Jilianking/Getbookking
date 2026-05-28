#!/usr/bin/env node
/**
 * Seed repeat customers + booking requests (past visits + upcoming confirmed).
 *
 * Usage (from Test/):
 *   node scripts/seed-repeat-customers.js --email=banky1@example.com
 *   node scripts/seed-repeat-customers.js --slug=test100
 *
 * Auth: firebase login or GOOGLE_APPLICATION_CREDENTIALS
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
  writeRepeatCustomerSeedData,
  enrichRepeatCustomerProfiles,
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
    customers: 10,
    enrichOnly: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--customers=")) {
      out.customers = Math.min(10, Math.max(1, parseInt(arg.slice(12), 10) || 10));
    } else if (arg === "--enrich-only") out.enrichOnly = true;
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

async function resolveTenant(db, args) {
  if (args.tenantId) {
    const doc = await db.collection("tenants").doc(args.tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${args.tenantId}`);
    return { id: args.tenantId, slug: (doc.data().slug || "").toString() };
  }
  if (args.email) {
    return resolveTenantByOwnerEmail(db, args.email);
  }
  if (args.slug) {
    return resolveTenantBySlug(db, args.slug);
  }
  throw new Error("Provide --email=owner@example.com, --slug=..., or --tenantId=...");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed repeat customers + booking requests (source "seed"), with full profile fields.

  node scripts/seed-repeat-customers.js --email=banky1@example.com
  node scripts/seed-repeat-customers.js --email=banky1@example.com --enrich-only

--enrich-only  Updates existing customers/bookings (no new booking rows).
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, Timestamp } = await initFirestore(projectId);
  const tenant = await resolveTenant(db, args);

  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.slug || "(no slug)"} (${tenant.id})`);

  if (args.enrichOnly) {
    console.log(`Enriching ${args.customers} customer profiles + patching bookings...`);
    const result = await enrichRepeatCustomerProfiles(db, tenant.id, Timestamp, {
      customerCount: args.customers,
    });
    console.log(
      `Done. ${result.enrichedCustomers} customers enriched, ${result.patchedBookings} bookings patched.`
    );
    if (result.servicePricesUpdated) {
      console.log(`Set default prices on ${result.servicePricesUpdated} catalog service(s).`);
    }
  } else {
    console.log(`Seeding ${args.customers} repeat customers with bookings...`);
    const result = await writeRepeatCustomerSeedData(db, tenant.id, Timestamp, {
      customerCount: args.customers,
    });
    console.log(
      `Done. ${result.writtenCustomers} customers, ${result.writtenBookings} booking requests.`
    );
    if (result.servicePricesUpdated) {
      console.log(`Set default prices on ${result.servicePricesUpdated} catalog service(s).`);
    }
  }

  console.log(`Paths:`);
  console.log(`  tenants/${tenant.id}/customers`);
  console.log(`  tenants/${tenant.id}/bookingRequests`);
  console.log("Sign in → Customers & Requests → pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
