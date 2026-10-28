/**
 * Grant or remove special access for one business. Shows the change first; writes only with --apply.
 *
 * Usage:
 *   node scripts/set-shop-access.js --email owner@example.com [options] [--apply]
 *   node scripts/set-shop-access.js --slug bleustattoos [options] [--apply]
 *
 * Options:
 *   --texting-exempt on|off     Let this business get texting numbers while the launch block is on.
 *   --domain-exempt on|off      Let this business buy or transfer a domain while the launch block is on.
 *   --complimentary on|off      Treat this business as paid (texting and payments) without billing.
 *   --area-code 727             Area code for its next texting number (3 digits).
 *   --text-notifications on|off The "Send client text notifications" switch in Notifications.
 *   --plan-ended on             Mark the plan as ended (like an expired subscription), for Apple's
 *                               demo account. Clears the App Store link so a new purchase starts fresh.
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { Firestore, FieldValue } = require("@google-cloud/firestore");

const PROJECT_ID = "test-app-96812";
const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function onOff(value, name) {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${name} must be "on" or "off".`);
}

async function createDb() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new Firestore({ projectId: PROJECT_ID });
  }
  const cfgPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error("No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS.");
  }
  const refresh = JSON.parse(fs.readFileSync(cfgPath, "utf8")).tokens.refresh_token;
  const auth = new GoogleAuth({
    credentials: {
      type: "authorized_user",
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      refresh_token: refresh,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return new Firestore({ projectId: PROJECT_ID, authClient: await auth.getClient() });
}

async function findTenant(db, args) {
  if (args.slug) {
    const snap = await db.collection("tenants").where("slug", "==", args.slug.toLowerCase()).get();
    if (snap.size !== 1) throw new Error(`Expected one business with slug "${args.slug}", found ${snap.size}.`);
    return snap.docs[0];
  }
  if (args.email) {
    const users = await db.collection("users").where("email", "==", args.email.toLowerCase()).get();
    if (users.empty) throw new Error(`No profile with email ${args.email}.`);
    const user = users.docs[0];
    const tenantId = (user.data().tenantId || "").toString();
    if (!tenantId) throw new Error(`${args.email} has no business.`);
    const tenant = await db.collection("tenants").doc(tenantId).get();
    if (!tenant.exists) throw new Error(`Business ${tenantId} not found.`);
    if ((tenant.data().ownerUid || "") !== user.id) {
      throw new Error(`${args.email} is not the owner of that business.`);
    }
    return tenant;
  }
  throw new Error("Pass --email or --slug.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const textingExempt = onOff(args["texting-exempt"], "--texting-exempt");
  const domainExempt = onOff(args["domain-exempt"], "--domain-exempt");
  const complimentary = onOff(args.complimentary, "--complimentary");
  const textNotifications = onOff(args["text-notifications"], "--text-notifications");
  const planEnded = onOff(args["plan-ended"], "--plan-ended");
  if (planEnded === false) {
    throw new Error("--plan-ended only takes \"on\". To bring a plan back, buy or restore it in the app.");
  }
  const areaCode = args["area-code"];
  if (areaCode !== undefined && !/^[2-9]\d{2}$/.test(areaCode)) {
    throw new Error("--area-code must be a 3-digit US area code.");
  }

  const db = await createDb();
  const doc = await findTenant(db, args);
  const tenant = doc.data() || {};
  const patch = {};
  const lines = [];
  const note = (label, before, after) => lines.push(`  ${label}: ${before} → ${after}`);

  if (textingExempt !== undefined) {
    patch.smsPurchaseBlockExempt = textingExempt ? true : FieldValue.delete();
    note("Texting block exception", tenant.smsPurchaseBlockExempt === true ? "on" : "off", textingExempt ? "on" : "off");
  }
  if (domainExempt !== undefined) {
    patch.domainPurchaseBlockExempt = domainExempt ? true : FieldValue.delete();
    note("Domain block exception", tenant.domainPurchaseBlockExempt === true ? "on" : "off", domainExempt ? "on" : "off");
  }
  if (complimentary !== undefined) {
    patch.complimentaryPaidAccess = complimentary ? true : FieldValue.delete();
    note("Complimentary paid access", tenant.complimentaryPaidAccess === true ? "on" : "off", complimentary ? "on" : "off");
  }
  if (areaCode !== undefined) {
    if ((tenant.smsPhoneNumber || "").toString().trim()) {
      throw new Error("This business already has a texting number; the area code only applies to a new one.");
    }
    patch.smsAreaCode = areaCode;
    note("Area code for next number", tenant.smsAreaCode || "(guessed)", areaCode);
  }
  if (textNotifications !== undefined) {
    const perms = tenant.managerPermissions && typeof tenant.managerPermissions === "object"
      ? tenant.managerPermissions
      : {};
    patch.managerPermissions = { ...perms, sendClientNotifications: textNotifications };
    note(
      "Send client text notifications",
      perms.sendClientNotifications === false ? "off" : perms.sendClientNotifications === true ? "on" : "(default)",
      textNotifications ? "on" : "off"
    );
  }
  let ownerPatch = null;
  let ownerRef = null;
  if (planEnded) {
    patch.subscriptionStatus = "canceled";
    for (const field of [
      "billingSource",
      "appleOriginalTransactionId",
      "appleProductId",
      "appleSignedDateMs",
      "appleExpiresAt",
      "complimentaryPaidAccess",
    ]) {
      if (tenant[field] !== undefined) patch[field] = FieldValue.delete();
    }
    note("Plan status", tenant.subscriptionStatus || "(none)", "canceled (plan ended)");
    if (tenant.appleOriginalTransactionId) note("App Store link", "set", "cleared");
    if (tenant.complimentaryPaidAccess === true) note("Complimentary paid access", "on", "off");
    // The owner's profile can carry its own status, and it wins over the business's.
    const ownerUid = (tenant.ownerUid || "").toString();
    if (ownerUid) {
      ownerRef = db.collection("users").doc(ownerUid);
      const owner = await ownerRef.get();
      const ownerStatus = owner.exists ? (owner.data().subscriptionStatus || "").toString() : "";
      if (ownerStatus) {
        ownerPatch = { subscriptionStatus: "canceled", updatedAt: FieldValue.serverTimestamp() };
        note("Owner profile plan status", ownerStatus, "canceled");
      }
    }
  }
  if (!lines.length) throw new Error("Nothing to change. See the options at the top of this script.");

  console.log(`Business: ${tenant.displayName || tenant.businessName || doc.id} (${tenant.slug || "no slug"})`);
  console.log(lines.join("\n"));
  if (!args.apply) {
    console.log("\nNothing written. Run again with --apply to make these changes.");
    return;
  }
  patch.updatedAt = FieldValue.serverTimestamp();
  await doc.ref.set(patch, { merge: true });
  if (ownerRef && ownerPatch) await ownerRef.set(ownerPatch, { merge: true });
  console.log("\nSaved.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
