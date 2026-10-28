/**
 * Apple Pay / Google Pay: register shop booking addresses ({slug}.getbookking.com) on their
 * Stripe accounts. Shows what it would do first; changes Stripe only with --apply.
 *
 * Usage (from functions/), with the Stripe key read from Firebase secrets (never printed):
 *   STRIPE_SECRET_KEY="$(firebase functions:secrets:access STRIPE_SECRET_KEY --project test-app-96812)" \
 *     node scripts/register-wallet-domains.js --slug test4000 [--off] [--apply]
 *   … --all [--live] [--apply]
 *
 * Options:
 *   --slug <slug>  One shop.
 *   --all          Every shop that has connected Stripe.
 *   --off          Switch the address off instead (undo).
 *   --status       Only show what Stripe reports for Apple Pay / Google Pay (read-only).
 *   --live         Required when the key is a live key (switch day).
 *   --apply        Make the changes. Without it, nothing is changed.
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Stripe = require("stripe");
const { GoogleAuth } = require("google-auth-library");
const { Firestore } = require("@google-cloud/firestore");
const walletDomains = require("../walletDomains");

const PROJECT_ID = "test-app-96812";
const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

function parseArgs(argv) {
  const out = { apply: false, all: false, off: false, live: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--off") out.off = true;
    else if (arg === "--live") out.live = true;
    else if (arg === "--status") out.status = true;
    else if (arg === "--slug") out.slug = (argv[++i] || "").toLowerCase();
  }
  return out;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug && !args.all) throw new Error("Pass --slug <slug> or --all.");

  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set. See the usage at the top of this script.");
  const isLive = /^(sk|rk)_live_/.test(key);
  if (isLive && !args.live) {
    throw new Error("That is a LIVE Stripe key. Add --live if you mean to change live mode.");
  }
  console.log(`Stripe mode: ${isLive ? "LIVE" : "test (sandbox)"}`);
  const stripe = new Stripe(key, { apiVersion: "2024-11-20.acacia" });

  const db = await createDb();
  let docs;
  if (args.slug) {
    const snap = await db.collection("tenants").where("slug", "==", args.slug).get();
    if (snap.size !== 1) throw new Error(`Expected one business with slug "${args.slug}", found ${snap.size}.`);
    docs = snap.docs;
  } else {
    docs = (await db.collection("tenants").get()).docs.filter((d) => {
      const t = d.data() || {};
      return (t.stripeAccountId || "").toString().trim() && (t.slug || "").toString().trim();
    });
  }

  const enabled = !args.off;
  let shops = 0;
  for (const doc of docs) {
    const tenant = doc.data() || {};
    const host = walletDomains.bookingHostForSlug(tenant.slug);
    if (!host) continue;
    const accounts = await walletDomains.stripeAccountsForShop(db, doc.id, tenant);
    if (!accounts.length) {
      console.log(`${host}: no Stripe account connected — skipped`);
      continue;
    }
    shops += 1;
    if (args.status) {
      const lines = await walletDomains.walletDomainStatus(stripe, accounts, host);
      console.log(`${host}:\n  ${lines.join("\n  ")}`);
      continue;
    }
    if (!args.apply) {
      console.log(`${host}: would switch ${enabled ? "on" : "off"} for ${accounts.join(", ")}`);
      continue;
    }
    const results = await walletDomains.setWalletDomain(stripe, accounts, host, enabled);
    console.log(`${host}:\n  ${results.join("\n  ")}`);
  }
  const tail = args.status || args.apply ? "" : " Nothing changed. Run again with --apply to make these changes.";
  console.log(`\n${shops} shop(s).${tail}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
