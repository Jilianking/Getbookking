#!/usr/bin/env node
/**
 * Phase 1 (solo + charter) Stripe Test-mode battery:
 * 7 successful Connect charges, 1 decline, 1 full refund, 1 partial refund.
 *
 * Usage (from repo root):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-phase1-payment-test.js
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-phase1-payment-test.js --flip
 *
 * Default: 4 solo (Test 9000) + 3 charter (Test 9006).
 * --flip: 4 charter + 3 solo.
 *
 * Requires firebase login (to read tenants) and a test-mode secret key.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const Stripe = require(path.join(__dirname, "../functions/node_modules/stripe"));

const DEFAULT_PROJECT = "test-app-96812";
const STRIPE_API_VERSION = "2024-11-20.acacia";
const PLATFORM_FEE_BPS = 100;
const STRIPE_ONLINE_BPS = 290;
const STRIPE_ONLINE_FIXED_CENTS = 30;
const SUITE = "phase1-solo-charter";

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

const TENANTS = {
  solo: { businessName: "Test 9000", plan: "solo" },
  charter: { businessName: "Test 9006", plan: "charter" },
};

function platformFeeCents(amountCents) {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round((n * PLATFORM_FEE_BPS) / 10000));
}

function computeCardCheckoutAmounts(serviceCents) {
  const service = Math.max(0, Math.round(Number(serviceCents)));
  if (service <= 0) {
    return { serviceCents: 0, surchargeCents: 0, totalCents: 0, platformFeeCents: 0 };
  }
  const combinedBps = STRIPE_ONLINE_BPS + PLATFORM_FEE_BPS;
  const totalCents = Math.ceil(
    (service + STRIPE_ONLINE_FIXED_CENTS) / (1 - combinedBps / 10000)
  );
  return {
    serviceCents: service,
    surchargeCents: totalCents - service,
    totalCents,
    platformFeeCents: platformFeeCents(totalCents),
  };
}

function usd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseArgs(argv) {
  const out = { project: DEFAULT_PROJECT, flip: false, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--flip") out.flip = true;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

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

async function createDb(projectId) {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error("No credentials. Run: firebase login");
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

async function findTenantByBusinessName(db, businessName) {
  const snap = await db
    .collection("tenants")
    .where("businessName", "==", businessName)
    .limit(5)
    .get();
  if (snap.empty) {
    throw new Error(`No tenant with businessName "${businessName}"`);
  }
  const doc = snap.docs[0];
  const data = doc.data() || {};
  const stripeAccountId = (data.stripeAccountId || "").toString().trim();
  if (!stripeAccountId) {
    throw new Error(`Tenant ${businessName} (${doc.id}) has no stripeAccountId`);
  }
  return {
    tenantId: doc.id,
    businessName: (data.businessName || "").toString(),
    subscriptionPlan: (data.subscriptionPlan || "").toString(),
    stripeAccountId,
    ownerUid: (data.ownerUid || data.ownerId || "").toString(),
  };
}

function daySlots(flip) {
  const soloManual = [
    { channel: "manual", quoteCents: 100, paymentKind: "service" },
    { channel: "manual", quoteCents: 500, paymentKind: "service" },
    { channel: "manual", quoteCents: 1000, paymentKind: "service" },
  ];
  const soloDeposit = { channel: "deposit", quoteCents: 500, paymentKind: "deposit" };
  const charterManual1 = { channel: "manual", quoteCents: 100, paymentKind: "service" };
  const charterDeposit = { channel: "deposit", quoteCents: 2500, paymentKind: "deposit" };
  const charterManual5 = { channel: "manual", quoteCents: 500, paymentKind: "service" };

  if (!flip) {
    return [
      { acct: "solo", ...soloManual[0] },
      { acct: "solo", ...soloManual[1] },
      { acct: "solo", ...soloManual[2] },
      { acct: "solo", ...soloDeposit },
      { acct: "charter", ...charterManual1 },
      { acct: "charter", ...charterDeposit },
      { acct: "charter", ...charterManual5 },
    ];
  }
  return [
    { acct: "charter", ...charterManual1 },
    { acct: "charter", channel: "manual", quoteCents: 500, paymentKind: "service" },
    { acct: "charter", channel: "manual", quoteCents: 1000, paymentKind: "service" },
    { acct: "charter", ...charterDeposit },
    { acct: "solo", ...soloManual[0] },
    { acct: "solo", ...soloDeposit },
    { acct: "solo", ...soloManual[1] },
  ];
}

async function createSuccessCharge(stripe, tenant, slot, index) {
  const checkout = computeCardCheckoutAmounts(slot.quoteCents);
  const pi = await stripe.paymentIntents.create(
    {
      amount: checkout.totalCents,
      currency: "usd",
      confirm: true,
      off_session: true,
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      application_fee_amount: checkout.platformFeeCents,
      metadata: {
        suite: SUITE,
        tenantId: tenant.tenantId,
        paymentKind: slot.paymentKind,
        serviceAmountCents: String(checkout.serviceCents),
        surchargeCents: String(checkout.surchargeCents),
        attributedMemberUid: tenant.ownerUid,
        chargeStripeAccountId: tenant.stripeAccountId,
        chargeStripeScope: "tenant",
        checkoutChannel: slot.channel === "deposit" ? "deposit_link_script" : "manual_script",
        initiatedByUid: tenant.ownerUid,
        testSlot: String(index),
      },
    },
    { stripeAccount: tenant.stripeAccountId }
  );
  const chargeId =
    typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : (pi.latest_charge && pi.latest_charge.id) || "";
  return {
    index,
    acct: slot.acct,
    plan: tenant.subscriptionPlan,
    businessName: tenant.businessName,
    channel: slot.channel,
    quoteCents: checkout.serviceCents,
    customerTotalCents: checkout.totalCents,
    expectedFeeCents: checkout.platformFeeCents,
    paymentIntentId: pi.id,
    chargeId,
    status: pi.status,
    stripeAccountId: tenant.stripeAccountId,
  };
}

async function createDecline(stripe, tenant) {
  const checkout = computeCardCheckoutAmounts(100);
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: checkout.totalCents,
        currency: "usd",
        confirm: true,
        off_session: true,
        payment_method: "pm_card_chargeDeclined",
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        application_fee_amount: checkout.platformFeeCents,
        metadata: {
          suite: SUITE,
          tenantId: tenant.tenantId,
          paymentKind: "service",
          testSlot: "decline",
        },
      },
      { stripeAccount: tenant.stripeAccountId }
    );
    return {
      ok: false,
      unexpectedStatus: pi.status,
      paymentIntentId: pi.id,
      error: "Decline PaymentIntent succeeded unexpectedly",
    };
  } catch (err) {
    return {
      ok: true,
      declined: true,
      code: err.code || "",
      declineCode: (err.raw && err.raw.decline_code) || "",
      message: err.message || String(err),
    };
  }
}

async function refundPayment(stripe, row, amountCents, kind) {
  const refund = await stripe.refunds.create(
    {
      payment_intent: row.paymentIntentId,
      amount: amountCents,
      reason: "requested_by_customer",
      refund_application_fee: true,
    },
    { stripeAccount: row.stripeAccountId }
  );
  return {
    kind,
    paymentIntentId: row.paymentIntentId,
    chargeId: row.chargeId,
    refundId: refund.id,
    refundCents: refund.amount,
    status: refund.status,
    appFeeRefund: refund.app_fee_refund || refund.fee_refund || null,
  };
}

function writeReport(report) {
  const dir = path.join(__dirname, "payment-test-reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `phase1-${stamp}.json`);
  const mdPath = path.join(dir, `phase1-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const lines = [
    `# Phase 1 payment test — ${report.ranAt}`,
    "",
    `Mode: Stripe **Test** · flip=${report.flip} · project=${report.project}`,
    "",
    "## Charges",
    "",
    "| # | Acct | Ch | Quote | Cust total | Exp 1% | PI | Status |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of report.charges) {
    lines.push(
      `| ${c.index} | ${c.acct} | ${c.channel} | ${usd(c.quoteCents)} | ${usd(c.customerTotalCents)} | ${usd(c.expectedFeeCents)} | ${c.paymentIntentId} | ${c.status} |`
    );
  }
  lines.push("", "## Decline", "", "```json", JSON.stringify(report.decline, null, 2), "```");
  lines.push("", "## Refunds", "");
  if (report.refunds.length === 0) {
    lines.push("_None_");
  } else {
    lines.push("| Kind | Amt | Refund id | Status |", "|---|---|---|---|");
    for (const r of report.refunds) {
      lines.push(`| ${r.kind} | ${usd(r.refundCents)} | ${r.refundId} | ${r.status} |`);
    }
  }
  if (report.errors.length) {
    lines.push("", "## Errors", "");
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  fs.writeFileSync(mdPath, lines.join("\n") + "\n");
  return { jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey && !args.dryRun) {
    throw new Error("Set STRIPE_SECRET_KEY=sk_test_... (Test mode only).");
  }
  if (secretKey && !secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
    throw new Error("Refusing to run: STRIPE_SECRET_KEY is not a test key (sk_test_ / rk_test_).");
  }

  const db = await createDb(args.project);
  const solo = await findTenantByBusinessName(db, TENANTS.solo.businessName);
  const charter = await findTenantByBusinessName(db, TENANTS.charter.businessName);
  const byAcct = { solo, charter };

  const slots = daySlots(args.flip);
  const report = {
    ranAt: new Date().toISOString(),
    project: args.project,
    flip: args.flip,
    suite: SUITE,
    tenants: {
      solo: { tenantId: solo.tenantId, plan: solo.subscriptionPlan, stripeAccountId: solo.stripeAccountId },
      charter: {
        tenantId: charter.tenantId,
        plan: charter.subscriptionPlan,
        stripeAccountId: charter.stripeAccountId,
      },
    },
    charges: [],
    decline: null,
    refunds: [],
    errors: [],
  };

  if (args.dryRun) {
    report.charges = slots.map((s, i) => ({
      index: i + 1,
      ...s,
      checkout: computeCardCheckoutAmounts(s.quoteCents),
    }));
    const paths = writeReport(report);
    console.log("dry-run", paths.mdPath);
    return;
  }

  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const tenant = byAcct[slot.acct];
    try {
      const row = await createSuccessCharge(stripe, tenant, slot, i + 1);
      report.charges.push(row);
      console.log(
        `#${row.index} ${row.acct} ${row.channel} quote=${usd(row.quoteCents)} total=${usd(row.customerTotalCents)} fee=${usd(row.expectedFeeCents)} ${row.status}`
      );
    } catch (err) {
      const msg = `#${i + 1} ${slot.acct} ${slot.channel}: ${err.message}`;
      report.errors.push(msg);
      console.error(msg);
    }
  }

  try {
    report.decline = await createDecline(stripe, solo);
    console.log("decline", report.decline.ok ? "ok" : "UNEXPECTED", report.decline.code || report.decline.unexpectedStatus || "");
  } catch (err) {
    report.errors.push(`decline: ${err.message}`);
    console.error("decline", err.message);
  }

  const fullTarget = report.charges.find(
    (c) => c.acct === "solo" && c.quoteCents === 100 && c.status === "succeeded"
  );
  const partialTarget = report.charges.find(
    (c) => c.acct === "solo" && c.quoteCents === 500 && c.status === "succeeded"
  );

  if (fullTarget) {
    try {
      const r = await refundPayment(stripe, fullTarget, fullTarget.customerTotalCents, "full");
      report.refunds.push(r);
      console.log("refund full", usd(r.refundCents), r.status);
    } catch (err) {
      report.errors.push(`full refund: ${err.message}`);
      console.error("full refund", err.message);
    }
  } else {
    report.errors.push("full refund skipped: no solo $1 success");
  }

  if (partialTarget) {
    try {
      const r = await refundPayment(stripe, partialTarget, 200, "partial");
      report.refunds.push(r);
      console.log("refund partial", usd(r.refundCents), r.status);
    } catch (err) {
      report.errors.push(`partial refund: ${err.message}`);
      console.error("partial refund", err.message);
    }
  } else {
    report.errors.push("partial refund skipped: no solo $5 success");
  }

  const paths = writeReport(report);
  console.log("report", paths.mdPath);
  if (report.errors.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
