/**
 * Sends one example of every domain notice for a test shop, so you can see what owners receive:
 * app notification (to the owner's signed-in devices), activity-center notice, and email.
 * Titles start with "[Sample]". No domain is bought and nothing is charged.
 *
 * Usage (from functions/):
 *   node scripts/send-sample-domain-notices.js --slug test4000 [--email you@example.com] [--apply]
 *   node scripts/send-sample-domain-notices.js --slug test4000 --clear [--apply]
 *
 * Options:
 *   --slug <slug>    The test shop (its owner's devices get the app notifications).
 *   --email <addr>   Where the sample emails go (skip to send no emails).
 *   --domain <name>  Pretend domain shown in the messages (default: <slug>.com).
 *   --clear          Delete the sample notices from the shop's activity center instead.
 *   --apply          Actually send / delete. Without it, only shows what would happen.
 *
 * Auth: firebase login. Email uses RESEND_API_KEY from functions/.env.test-app-96812.
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
  const out = { apply: false, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--clear") out.clear = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

async function createClients() {
  const cfgPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(cfgPath)) throw new Error("No credentials. Run: firebase login");
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
  const authClient = await auth.getClient();
  return { db: new Firestore({ projectId: PROJECT_ID, authClient }), authClient };
}

/** App notification to one device via Firebase Cloud Messaging (same look as booking alerts). */
async function sendPush(authClient, token, title, body) {
  const res = await authClient.request({
    url: `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    method: "POST",
    data: {
      message: {
        token,
        notification: { title, body },
        data: { type: "account_notice", kind: "domain" },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { alert: { title, body }, sound: "default" } } },
      },
    },
    validateStatus: () => true,
  });
  return res.status;
}

function readEnvValue(name) {
  const envPath = path.join(__dirname, "..", `.env.${PROJECT_ID}`);
  if (!fs.existsSync(envPath)) return "";
  const line = fs.readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

/** Same wording the server sends (functions/customDomain.js), filled with example values. */
function sampleNotices(domain, slug) {
  const card = "Visa ending 4242";
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const renewNote =
    `It renews yearly at $21.00 on this card until you turn off auto-renew in Settings → Domain. ` +
    "Renewal is handled by Get Bookking, so you can ignore renewal reminders from Namecheap.";
  const confirmNote =
    "One thing to do: the domain registrar (Namecheap) will email you asking to confirm your email address. " +
    "Please click the link in that email, or the domain can be paused.";
  return [
    {
      title: "Domain purchased",
      subject: `Your domain ${domain} is set up`,
      body: `Charged $21.00 to ${card} on ${today} for: domain registration of ${domain} (1 year). ` +
        `We're connecting it to your Get Bookking site now — usually under an hour. ${renewNote} ${confirmNote}`,
    },
    {
      title: "Domain transfer started",
      subject: `Transfer of ${domain} started`,
      body: `Charged $21.00 to ${card} on ${today} for: domain transfer of ${domain} (includes 1 year). ` +
        "Your current registrar may email you to approve the transfer; approving makes it faster. " +
        "Once connected, your domain will open your Get Bookking site instead of your old website. " +
        `Remember to cancel your old website plan. ${renewNote} ${confirmNote}`,
    },
    {
      title: "Your domain is live",
      subject: `${domain} is live`,
      body: `${domain} now opens your Get Bookking site. Your old link (${slug}.getbookking.com) automatically forwards there.`,
    },
    {
      title: "Domain renewal coming up",
      subject: `${domain} renews on May 2, 2027 for $21.00`,
      body: `${domain} renews on May 2, 2027 for $21.00, charged to your ${card}. ` +
        "Turn off auto-renew in Settings → Domain if you don't want to keep it.",
    },
    {
      title: "Domain renewed",
      subject: `${domain} renewed`,
      body: `We charged $21.00 to your ${card} on May 2, 2027. ${domain} is renewed until Jun 1, 2028.`,
    },
    {
      title: "Domain renewal payment failed",
      subject: `Action needed: we couldn't renew ${domain}`,
      body: `We couldn't charge $21.00 to your ${card} to renew ${domain}. ` +
        "Update your card at getbookking.com → Billing → Website domain before Jun 1, 2027 to keep your domain. We'll try again in 3 days.",
    },
    {
      title: "Your domain won't renew",
      subject: `${domain} expires on Jun 1, 2027`,
      body: `Auto-renew is off, so ${domain} expires on Jun 1, 2027. To keep it, turn auto-renew on in Settings → Domain.`,
    },
    {
      title: "Your domain expired",
      subject: `${domain} has expired`,
      body: `${domain} expired and is no longer connected. Your site is back on ${slug}.getbookking.com. ` +
        "Contact domainsupport@getbookking.com within 30 days if you want it back.",
    },
    {
      title: "Domain transfer didn't go through",
      subject: `The transfer of ${domain} didn't go through`,
      body: `Your old registrar cancelled or rejected the transfer of ${domain} (CANCELLED). ` +
        "Contact domainsupport@getbookking.com and we'll sort it out.",
    },
  ].map((n) => ({ ...n, title: `[Sample] ${n.title}`, subject: `[Sample] ${n.subject}` }));
}

function escapeHtml(text) {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug) throw new Error("Pass --slug <slug>.");
  const { db, authClient } = await createClients();
  const snap = await db.collection("tenants").where("slug", "==", args.slug.toLowerCase()).get();
  if (snap.size !== 1) throw new Error(`Expected one business with slug "${args.slug}", found ${snap.size}.`);
  const tenantRef = snap.docs[0].ref;
  const tenant = snap.docs[0].data() || {};
  console.log(`Business: ${tenant.businessName || tenant.displayName || tenantRef.id} (${args.slug})`);

  if (args.clear) {
    const samples = await tenantRef.collection("accountNotices").where("sample", "==", true).get();
    console.log(`${samples.size} sample notice(s) in the activity center.`);
    if (!args.apply) return console.log("Nothing deleted. Run again with --apply to delete them.");
    for (const doc of samples.docs) await doc.ref.delete();
    return console.log("Deleted.");
  }

  const domain = (args.domain || `${args.slug}.com`).toLowerCase();
  const notices = sampleNotices(domain, args.slug.toLowerCase());
  const ownerUid = (tenant.ownerUid || "").toString();
  const tokens = [];
  if (ownerUid) {
    (await db.collection("users").doc(ownerUid).collection("deviceTokens").get()).forEach((t) => {
      const token = t.data().token;
      if (token) tokens.push(token);
    });
  }
  const resendKey = readEnvValue("RESEND_API_KEY");
  const from = readEnvValue("PASSWORD_RESET_EMAIL_FROM") || "Get Bookking <noreply@getbookking.com>";
  const replyTo = readEnvValue("SUPPORT_EMAIL") || "support@getbookking.com";

  console.log(`App notifications: ${tokens.length} signed-in device(s) for the owner.`);
  console.log(`Emails: ${args.email ? `to ${args.email}` : "none (no --email)"}${args.email && !resendKey ? " — RESEND_API_KEY missing" : ""}`);
  console.log(`Activity center: ${notices.length} notices saved (shown by the new app build).\n`);
  notices.forEach((n, i) => console.log(`${i + 1}. ${n.title}\n   Email subject: ${n.subject}\n   ${n.body}\n`));
  if (!args.apply) return console.log("Nothing sent. Run again with --apply to send these.");

  for (const n of notices) {
    await tenantRef.collection("accountNotices").add({
      kind: "domain",
      title: n.title,
      body: n.body,
      sample: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    for (const token of tokens) {
      const status = await sendPush(authClient, token, n.title, n.body);
      if (status >= 300) console.warn(`App notification to one device failed (${status}) — it may be signed out.`);
    }
    if (args.email && resendKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: args.email,
          subject: n.subject,
          reply_to: replyTo,
          html: [
            "<p>Hello,</p>",
            `<p>${escapeHtml(n.body)}</p>`,
            "<p>Questions? Just reply to this email.</p>",
            "<p>Thanks,<br>Your Get Bookking team</p>",
          ].join("\n"),
        }),
      });
      if (!res.ok) console.warn(`Email "${n.subject}" failed: ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log("Sent. Clear the activity-center samples later with: --clear --apply");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
