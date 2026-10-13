/**
 * Read-only audit: looks for signs the old database rules were misused. Changes nothing.
 * Usage: node scripts/audit-tenant-access.js
 *
 * Reports:
 *   1. Profiles attached to a business they don't own and have no accepted invite for.
 *   2. Businesses marked paid with no Stripe subscription and no App Store plan.
 *   3. Web addresses (slugs) claimed by more than one business, or whose public site
 *      belongs to a different business.
 *
 * An invite record is deleted when a business is shut down, so a flagged profile is a
 * prompt to look, not proof of misuse.
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { Firestore } = require("@google-cloud/firestore");

const PROJECT_ID = "test-app-96812";

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return cfg && cfg.tokens && cfg.tokens.refresh_token;
}

async function createDb() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new Firestore({ projectId: PROJECT_ID });
  }
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error("No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS.");
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
  return new Firestore({ projectId: PROJECT_ID, authClient });
}

function text(value) {
  return (value || "").toString().trim();
}

function dateLabel(value) {
  try {
    if (value && typeof value.toDate === "function") return value.toDate().toISOString().slice(0, 10);
  } catch (_) {
    /* not a timestamp */
  }
  return "unknown date";
}

async function main() {
  const db = await createDb();
  const [usersSnap, tenantsSnap, invitesSnap, sitesSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("tenants").get(),
    db.collection("tenantInvites").get(),
    db.collection("publicSites").get(),
  ]);

  const tenants = new Map(tenantsSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
  const invited = new Set();
  for (const doc of invitesSnap.docs) {
    const inv = doc.data() || {};
    if (text(inv.usedByUid) && text(inv.tenantId)) {
      invited.add(`${text(inv.tenantId)}|${text(inv.usedByUid)}`);
    }
  }

  // 1. Profiles attached to a business without owning it or accepting an invite.
  const unexplained = [];
  const orphaned = [];
  let attached = 0;
  for (const doc of usersSnap.docs) {
    const user = doc.data() || {};
    const tenantId = text(user.tenantId);
    if (!tenantId) continue;
    attached += 1;
    const tenant = tenants.get(tenantId);
    const row = `${doc.id}  ${text(user.email) || "(no email)"}  → business ${tenantId}` +
      `  role=${text(user.role || user.accessRole) || "none"}  created ${dateLabel(user.createdAt)}`;
    if (!tenant) {
      orphaned.push(row);
    } else if (text(tenant.ownerUid) !== doc.id && !invited.has(`${tenantId}|${doc.id}`)) {
      unexplained.push(`${row}  (${text(tenant.displayName || tenant.businessName) || "unnamed"})`);
    }
  }

  // 2. Businesses marked paid with nothing behind it.
  const paidWithoutBilling = [];
  for (const [tenantId, tenant] of tenants) {
    if (text(tenant.subscriptionStatus).toLowerCase() !== "active") continue;
    if (tenant.isDemoAccount === true) continue;
    const hasStripe = !!text(tenant.stripeSubscriptionId);
    const hasApple = text(tenant.billingSource) === "apple" && !!text(tenant.appleOriginalTransactionId);
    if (!hasStripe && !hasApple) {
      paidWithoutBilling.push(
        `${tenantId}  ${text(tenant.displayName || tenant.businessName) || "unnamed"}` +
          `  plan=${text(tenant.subscriptionPlan) || "none"}`
      );
    }
  }

  // 3. Web addresses claimed twice, or published under another business.
  const bySlug = new Map();
  for (const [tenantId, tenant] of tenants) {
    const slug = text(tenant.slug).toLowerCase();
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(tenantId);
  }
  const sharedSlugs = [...bySlug].filter(([, ids]) => ids.length > 1)
    .map(([slug, ids]) => `${slug}  claimed by ${ids.join(", ")}`);
  const mismatchedSites = [];
  for (const doc of sitesSnap.docs) {
    const siteTenantId = text((doc.data() || {}).tenantId);
    const claimants = bySlug.get(doc.id.toLowerCase()) || [];
    if (siteTenantId && claimants.length && !claimants.includes(siteTenantId)) {
      mismatchedSites.push(`${doc.id}  published by ${siteTenantId}, slug held by ${claimants.join(", ")}`);
    }
  }

  const section = (title, rows) => {
    console.log(`\n${title}: ${rows.length}`);
    rows.forEach((row) => console.log(`  ${row}`));
  };
  console.log(`Checked ${usersSnap.size} profiles (${attached} attached to a business), ` +
    `${tenants.size} businesses, ${sitesSnap.size} public sites.`);
  section("1. Profiles attached to a business with no ownership or accepted invite", unexplained);
  section("   Profiles pointing at a business that no longer exists", orphaned);
  section("2. Businesses marked paid with no Stripe subscription or App Store plan", paidWithoutBilling);
  section("3. Web addresses claimed by more than one business", sharedSlugs);
  section("   Public sites published by a different business than the one holding the slug", mismatchedSites);
  console.log("\nNothing was changed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
