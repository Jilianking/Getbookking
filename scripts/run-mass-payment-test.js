#!/usr/bin/env node
/**
 * Mass Stripe Test-mode battery for Connect customer payments + ledger recon.
 *
 * Creates direct charges on Test 9000 (solo) and Test 9006 (charter) with the
 * same PaymentIntent metadata production uses, then settles each success
 * through `recordAndSettleTenantPayment` (the iOS `recordTenantPayment` path).
 * Connect webhooks do not write these ledger rows on their own.
 *
 * Resume a prior Stripe batch without new charges:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-mass-payment-test.js --from-report=scripts/payment-test-reports/mass-….json
 *
 * Usage (from repo root):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-mass-payment-test.js
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-mass-payment-test.js --count=30 --declines=3 --refunds=3
 *
 * Requires firebase login and a test-mode secret key. Refuses live keys.
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
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));
const teamPaymentSplit = require(path.join(__dirname, "../functions/teamPaymentSplit"));

const DEFAULT_PROJECT = "test-app-96812";
const STRIPE_API_VERSION = "2024-11-20.acacia";
const PLATFORM_FEE_BPS = 100;
const STRIPE_ONLINE_BPS = 290;
const STRIPE_ONLINE_FIXED_CENTS = 30;
const SUITE = "mass-solo-charter";
const QUOTES = [100, 500, 1000, 500, 2500, 100];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    count: 30,
    declines: 3,
    refunds: 3,
    concurrency: 3,
    delayMs: 300,
    waitMs: 4000,
    dryRun: false,
    fromReport: "",
    skipSettle: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--from-report=")) out.fromReport = arg.slice(14).trim();
    else if (arg === "--skip-settle") out.skipSettle = true;
    else if (arg.startsWith("--count=")) {
      out.count = Math.min(200, Math.max(1, parseInt(arg.slice(8), 10) || 30));
    } else if (arg.startsWith("--declines=")) {
      out.declines = Math.min(20, Math.max(0, parseInt(arg.slice(11), 10) || 0));
    } else if (arg.startsWith("--refunds=")) {
      out.refunds = Math.min(20, Math.max(0, parseInt(arg.slice(10), 10) || 0));
    } else if (arg.startsWith("--concurrency=")) {
      out.concurrency = Math.min(5, Math.max(1, parseInt(arg.slice(14), 10) || 3));
    } else if (arg.startsWith("--delay-ms=")) {
      out.delayMs = Math.min(5000, Math.max(0, parseInt(arg.slice(11), 10) || 0));
    } else if (arg.startsWith("--wait-ms=")) {
      out.waitMs = Math.min(120000, Math.max(0, parseInt(arg.slice(10), 10) || 0));
    } else if (arg === "--dry-run") out.dryRun = true;
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

function authorizedUserCreds() {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error("No credentials. Run: firebase login");
  }
  return {
    type: "authorized_user",
    client_id: FIREBASE_CLI_CLIENT_ID,
    client_secret: FIREBASE_CLI_CLIENT_SECRET,
    refresh_token: refresh,
  };
}

async function createDb(projectId) {
  const auth = new GoogleAuth({
    credentials: authorizedUserCreds(),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const authClient = await auth.getClient();
  return new Firestore({ projectId, authClient });
}

function initAdmin(projectId) {
  if (admin.apps.length) return;
  try {
    admin.initializeApp({ projectId });
  } catch (_) {
    /* FieldValue only; writes go through @google-cloud/firestore */
  }
}

const PAYMENT_SPLIT_APPLIES = new Set(["service", "deposit", "both"]);

function normalizeSubscriptionPlan(plan) {
  const p = (plan || "").toString().trim().toLowerCase();
  const legacy = {
    basic: "solo",
    free: "solo",
    starter: "solo",
    solo: "solo",
    growth: "studio",
    pro: "studio",
    enterprise: "shop",
    charter: "charter",
    charters: "charter",
    boat: "charter",
    fishing: "charter",
    boating: "charter",
  };
  if (legacy[p]) return legacy[p];
  if (p === "solo" || p === "studio" || p === "shop" || p === "charter") return p;
  return "solo";
}

function normalizePayoutMode(raw) {
  const m = (raw || "independent").toString().trim().toLowerCase();
  if (m === "studio_payroll" || m === "shop_split") return "shop_split";
  if (m === "independent") return "independent";
  return "independent";
}

function normalizeMemberSettings(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const useStudio = d.useStudioBookingPolicy === true;
  let bookingConfirmationOverride = (d.bookingConfirmationOverride || "")
    .toString()
    .trim();
  if (useStudio) bookingConfirmationOverride = "";
  let paymentSplitPercent = parseInt(d.paymentSplitPercent, 10);
  if (Number.isNaN(paymentSplitPercent)) paymentSplitPercent = 0;
  paymentSplitPercent = Math.min(100, Math.max(0, paymentSplitPercent));
  let paymentSplitAppliesTo = (d.paymentSplitAppliesTo || "service")
    .toString()
    .trim()
    .toLowerCase();
  if (!PAYMENT_SPLIT_APPLIES.has(paymentSplitAppliesTo)) {
    paymentSplitAppliesTo = "service";
  }
  let paymentSplitEnabled = d.paymentSplitEnabled === true;
  if (d.paymentSplitEnabled === undefined && paymentSplitPercent > 0) {
    paymentSplitEnabled = true;
  }
  const out = {
    useStudioBookingPolicy: useStudio,
    paymentSplitEnabled,
    paymentSplitPercent,
    paymentSplitAppliesTo,
    payoutMode: normalizePayoutMode(d.payoutMode),
    canEditPortfolio: d.canEditPortfolio === true,
    canEditPublicBio: d.canEditPublicBio === true,
    canTakePayments: d.canTakePayments !== false,
  };
  if (!useStudio && bookingConfirmationOverride) {
    out.bookingConfirmationOverride = bookingConfirmationOverride;
  }
  return out;
}

function paymentKindMatchesSplit(settings, paymentKind) {
  const normalized = normalizeMemberSettings(settings);
  if (!normalized.paymentSplitEnabled || normalized.paymentSplitPercent <= 0) {
    return false;
  }
  const kind = (paymentKind || "service").toString().trim().toLowerCase();
  const applies = normalized.paymentSplitAppliesTo;
  if (applies === "both") return true;
  if (kind === "deposit") return applies === "deposit";
  return applies === "service";
}

function computeTeamPaymentSplit({ memberSettings, paymentKind, serviceCents }) {
  const service = Math.max(0, Math.round(Number(serviceCents)));
  if (!paymentKindMatchesSplit(memberSettings, paymentKind)) {
    return {
      splitApplied: false,
      splitPercentApplied: 0,
      artistShareCents: 0,
      studioServiceShareCents: service,
    };
  }
  const normalized = normalizeMemberSettings(memberSettings);
  const percent = normalized.paymentSplitPercent;
  const artistShareCents = Math.round((service * percent) / 100);
  return {
    splitApplied: true,
    splitPercentApplied: percent,
    artistShareCents,
    studioServiceShareCents: service - artistShareCents,
  };
}

function resolveAttributedMemberUid(tenant, bookingRequest, initiatedByUid) {
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const assigned = ((bookingRequest && bookingRequest.assignedMemberUid) || "")
    .toString()
    .trim();
  if (assigned) return assigned;
  const initiator = (initiatedByUid || "").toString().trim();
  if (initiator && initiator !== ownerUid) return initiator;
  return ownerUid;
}

async function loadBookingRequestForPayment(db, tenantId, requestId) {
  const rid = (requestId || "").toString().trim();
  if (!tenantId || !rid) return null;
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .doc(rid)
    .get();
  return snap.exists ? snap.data() : null;
}

async function confirmBookingAfterDepositPaid(db, tenantId, bookingRequestId) {
  const tid = (tenantId || "").toString().trim();
  const rid = (bookingRequestId || "").toString().trim();
  if (!tid || !rid) return false;
  const reqRef = db.collection("tenants").doc(tid).collection("bookingRequests").doc(rid);
  const snap = await reqRef.get();
  if (!snap.exists) return false;
  const status = (snap.data().status || "").toString().trim().toLowerCase();
  if (status !== "pending_deposit" && status !== "pending_payment") return false;
  await reqRef.set(
    {
      status: "confirmed",
      depositPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return true;
}

async function settleCharge(stripe, adminDb, tenantCache, row) {
  if (!row || row.status !== "succeeded" || !row.paymentIntentId) {
    return { skipped: true };
  }
  let tenant = tenantCache.get(row.tenantId);
  if (!tenant) {
    const snap = await adminDb.collection("tenants").doc(row.tenantId).get();
    if (!snap.exists) throw new Error(`Tenant ${row.tenantId} missing`);
    tenant = snap.data() || {};
    tenantCache.set(row.tenantId, tenant);
  }
  const pi = await stripe.paymentIntents.retrieve(row.paymentIntentId, {
    stripeAccount: row.stripeAccountId,
  });
  return teamPaymentSplit.recordAndSettleTenantPayment(stripe, {
    db: adminDb,
    tenantId: row.tenantId,
    tenant,
    pi,
    stripeAccountId: row.stripeAccountId,
    chargeStripeScopeHint: "tenant",
    initiatedByUidFallback: row.initiatedByUid || tenant.ownerUid || "",
    platformFeeCents,
    normalizeSubscriptionPlan,
    normalizeMemberSettings,
    computeTeamPaymentSplit,
    resolveAttributedMemberUid,
    loadBookingRequestForPayment: (tenantId, requestId) =>
      loadBookingRequestForPayment(adminDb, tenantId, requestId),
    confirmBookingAfterDepositPaid: (tenantId, requestId) =>
      confirmBookingAfterDepositPaid(adminDb, tenantId, requestId),
  });
}

async function settleReportCharges(stripe, adminDb, report, args) {
  if (args.skipSettle) {
    console.log("skip settle (--skip-settle)");
    return;
  }
  const tenantCache = new Map();
  const succeeded = (report.charges || []).filter((c) => c && c.status === "succeeded");
  console.log(`settling ${succeeded.length} PaymentIntent(s) into paymentLedger…`);
  report.settled = [];
  for (const row of succeeded) {
    try {
      const result = await settleCharge(stripe, adminDb, tenantCache, row);
      report.settled.push({
        paymentIntentId: row.paymentIntentId,
        alreadyRecorded: !!result.alreadyRecorded,
        ledgerId: result.ledgerId || row.paymentIntentId,
        ok: result.ok !== false,
      });
      console.log(
        `settle ${row.acct || ""} ${row.paymentIntentId} ${result.alreadyRecorded ? "exists" : "wrote"}`
      );
    } catch (err) {
      const msg = `settle ${row.paymentIntentId}: ${err.message}`;
      report.errors.push(msg);
      console.error(msg);
    }
  }
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

function buildSlots(count) {
  const slots = [];
  const soloN = Math.ceil(count * 0.55);
  for (let i = 0; i < count; i++) {
    const quoteCents = QUOTES[i % QUOTES.length];
    const deposit = i % 5 === 3;
    slots.push({
      acct: i < soloN ? "solo" : "charter",
      channel: deposit ? "deposit" : "manual",
      quoteCents,
      paymentKind: deposit ? "deposit" : "service",
    });
  }
  return slots;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
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
        taxCents: "0",
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
    tenantId: tenant.tenantId,
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
    initiatedByUid: tenant.ownerUid,
  };
}

async function createDecline(stripe, tenant, index) {
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
          testSlot: `decline-${index}`,
        },
      },
      { stripeAccount: tenant.stripeAccountId }
    );
    return {
      index,
      acct: tenant.businessName,
      ok: false,
      unexpectedStatus: pi.status,
      paymentIntentId: pi.id,
      error: "Decline PaymentIntent succeeded unexpectedly",
    };
  } catch (err) {
    return {
      index,
      acct: tenant.businessName,
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
  };
}

async function readLedger(db, tenantId, paymentIntentId) {
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("paymentLedger")
    .doc(paymentIntentId)
    .get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return {
    paymentIntentId,
    grossCents: d.grossCents || 0,
    serviceCents: d.serviceCents || 0,
    platformFeeCents: d.platformFeeCents || 0,
    surchargeCents: d.surchargeCents || 0,
    paymentKind: d.paymentKind || "",
  };
}

async function reconCharges(db, charges, waitMs) {
  const succeeded = charges.filter((c) => c && c.status === "succeeded" && c.paymentIntentId);
  if (!succeeded.length) {
    return { rows: [], present: 0, missing: 0, feeMismatch: 0, grossMismatch: 0 };
  }
  const deadline = Date.now() + waitMs;
  const found = new Map();
  while (Date.now() < deadline) {
    for (const c of succeeded) {
      if (found.has(c.paymentIntentId)) continue;
      const row = await readLedger(db, c.tenantId, c.paymentIntentId);
      if (row) found.set(c.paymentIntentId, row);
    }
    if (found.size === succeeded.length) break;
    await sleep(2000);
  }
  const rows = succeeded.map((c) => {
    const ledger = found.get(c.paymentIntentId) || null;
    const feeMismatch = ledger ? ledger.platformFeeCents !== c.expectedFeeCents : false;
    const grossMismatch = ledger ? ledger.grossCents !== c.customerTotalCents : false;
    return {
      paymentIntentId: c.paymentIntentId,
      acct: c.acct,
      present: !!ledger,
      expectedFeeCents: c.expectedFeeCents,
      ledgerFeeCents: ledger ? ledger.platformFeeCents : null,
      expectedGrossCents: c.customerTotalCents,
      ledgerGrossCents: ledger ? ledger.grossCents : null,
      feeMismatch,
      grossMismatch,
    };
  });
  return {
    rows,
    present: rows.filter((r) => r.present).length,
    missing: rows.filter((r) => !r.present).length,
    feeMismatch: rows.filter((r) => r.feeMismatch).length,
    grossMismatch: rows.filter((r) => r.grossMismatch).length,
  };
}

function pickRefundTargets(charges, refunds) {
  const ok = charges.filter((c) => c && c.status === "succeeded");
  const targets = [];
  const used = new Set();
  const full = ok.find((c) => c.quoteCents === 100);
  if (full && refunds > 0) {
    targets.push({ row: full, amountCents: full.customerTotalCents, kind: "full" });
    used.add(full.paymentIntentId);
  }
  for (const c of ok) {
    if (targets.length >= refunds) break;
    if (used.has(c.paymentIntentId)) continue;
    if (c.quoteCents < 500) continue;
    targets.push({ row: c, amountCents: 200, kind: "partial" });
    used.add(c.paymentIntentId);
  }
  return targets;
}

function writeReport(report) {
  const dir = path.join(__dirname, "payment-test-reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `mass-${stamp}.json`);
  const mdPath = path.join(dir, `mass-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const rec = report.recon || {};
  const lines = [
    `# Mass payment test — ${report.ranAt}`,
    "",
    `Mode: Stripe **Test** · project=${report.project} · count=${report.count} · concurrency=${report.concurrency}`,
    "",
    "## Summary",
    "",
    `- Succeeded: **${report.charges.filter((c) => c.status === "succeeded").length}** / ${report.charges.length}`,
    `- Declines ok: **${(report.declines || []).filter((d) => d.ok).length}** / ${(report.declines || []).length}`,
    `- Refunds: **${(report.refunds || []).filter((r) => r.status === "succeeded").length}** / ${(report.refunds || []).length}`,
    `- Settled: **${(report.settled || []).filter((s) => s.ok).length}** / ${(report.settled || []).length}`,
    `- Ledger present: **${rec.present || 0}** / ${(rec.rows || []).length} (missing ${rec.missing || 0})`,
    `- Fee mismatches: **${rec.feeMismatch || 0}** · gross mismatches: **${rec.grossMismatch || 0}**`,
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
  lines.push("", "## Declines", "");
  if (!(report.declines || []).length) {
    lines.push("_None_");
  } else {
    for (const d of report.declines) {
      lines.push(
        `- #${d.index} ${d.ok ? "ok" : "UNEXPECTED"} ${d.code || d.unexpectedStatus || ""} ${d.declineCode || ""}`
      );
    }
  }
  lines.push("", "## Refunds", "");
  if (!(report.refunds || []).length) {
    lines.push("_None_");
  } else {
    lines.push("| Kind | Amt | Refund id | Status | PI |", "|---|---|---|---|---|");
    for (const r of report.refunds) {
      lines.push(
        `| ${r.kind} | ${usd(r.refundCents)} | ${r.refundId} | ${r.status} | ${r.paymentIntentId} |`
      );
    }
  }
  lines.push("", "## Ledger recon", "");
  if (!(rec.rows || []).length) {
    lines.push("_No succeeded charges to recon_");
  } else {
    const missing = (rec.rows || []).filter((r) => !r.present);
    if (missing.length) {
      lines.push("Missing ledger rows:", "");
      for (const r of missing) lines.push(`- ${r.acct} ${r.paymentIntentId}`);
      lines.push("");
    } else {
      lines.push("All succeeded PaymentIntents have a `paymentLedger` doc.");
      lines.push("");
    }
  }
  if (report.errors.length) {
    lines.push("## Errors", "");
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

  if (args.fromReport) {
    const prior = JSON.parse(fs.readFileSync(args.fromReport, "utf8"));
    const report = {
      ranAt: new Date().toISOString(),
      project: args.project,
      suite: SUITE,
      count: (prior.charges || []).length,
      concurrency: 1,
      fromReport: args.fromReport,
      tenants: prior.tenants || {},
      charges: prior.charges || [],
      declines: prior.declines || [],
      refunds: prior.refunds || [],
      settled: [],
      recon: null,
      errors: [],
    };
    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    await settleReportCharges(stripe, db, report, args);
    report.recon = await reconCharges(db, report.charges, args.waitMs);
    console.log(
      `ledger ${report.recon.present}/${report.recon.rows.length} present · missing ${report.recon.missing} · fee mismatch ${report.recon.feeMismatch}`
    );
    const paths = writeReport(report);
    console.log("report", paths.mdPath);
    if (report.errors.length || report.recon.missing || report.recon.feeMismatch) {
      process.exitCode = 1;
    }
    return;
  }

  const solo = await findTenantByBusinessName(db, TENANTS.solo.businessName);
  const charter = await findTenantByBusinessName(db, TENANTS.charter.businessName);
  const byAcct = { solo, charter };
  const slots = buildSlots(args.count);

  const report = {
    ranAt: new Date().toISOString(),
    project: args.project,
    suite: SUITE,
    count: args.count,
    concurrency: args.concurrency,
    tenants: {
      solo: { tenantId: solo.tenantId, plan: solo.subscriptionPlan, stripeAccountId: solo.stripeAccountId },
      charter: {
        tenantId: charter.tenantId,
        plan: charter.subscriptionPlan,
        stripeAccountId: charter.stripeAccountId,
      },
    },
    charges: [],
    declines: [],
    refunds: [],
    settled: [],
    recon: null,
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

  console.log(
    `mass ${args.count} charges · ${args.declines} declines · ${args.refunds} refunds · concurrency=${args.concurrency}`
  );

  const chargeResults = await mapPool(slots, args.concurrency, async (slot, i) => {
    const tenant = byAcct[slot.acct];
    try {
      const row = await createSuccessCharge(stripe, tenant, slot, i + 1);
      console.log(
        `#${row.index} ${row.acct} ${row.channel} quote=${usd(row.quoteCents)} total=${usd(row.customerTotalCents)} fee=${usd(row.expectedFeeCents)} ${row.status}`
      );
      if (args.delayMs) await sleep(args.delayMs);
      return row;
    } catch (err) {
      const msg = `#${i + 1} ${slot.acct} ${slot.channel}: ${err.message}`;
      report.errors.push(msg);
      console.error(msg);
      if (args.delayMs) await sleep(args.delayMs);
      return {
        index: i + 1,
        acct: slot.acct,
        channel: slot.channel,
        quoteCents: slot.quoteCents,
        customerTotalCents: 0,
        expectedFeeCents: 0,
        paymentIntentId: "",
        status: "error",
        error: err.message,
      };
    }
  });
  report.charges = chargeResults;

  for (let i = 0; i < args.declines; i++) {
    const tenant = i % 2 === 0 ? solo : charter;
    try {
      const d = await createDecline(stripe, tenant, i + 1);
      report.declines.push(d);
      console.log(
        "decline",
        d.ok ? "ok" : "UNEXPECTED",
        d.code || d.unexpectedStatus || ""
      );
      if (args.delayMs) await sleep(args.delayMs);
    } catch (err) {
      report.errors.push(`decline #${i + 1}: ${err.message}`);
      console.error("decline", err.message);
    }
  }

  const refundTargets = pickRefundTargets(report.charges, args.refunds);
  for (const t of refundTargets) {
    try {
      const r = await refundPayment(stripe, t.row, t.amountCents, t.kind);
      report.refunds.push(r);
      console.log("refund", t.kind, usd(r.refundCents), r.status);
      if (args.delayMs) await sleep(args.delayMs);
    } catch (err) {
      report.errors.push(`${t.kind} refund: ${err.message}`);
      console.error("refund", err.message);
    }
  }
  if (refundTargets.length < args.refunds) {
    report.errors.push(
      `refunds short: wanted ${args.refunds}, ran ${refundTargets.length}`
    );
  }

  await settleReportCharges(stripe, db, report, args);
  report.recon = await reconCharges(db, report.charges, args.waitMs);
  console.log(
    `ledger ${report.recon.present}/${report.recon.rows.length} present · missing ${report.recon.missing} · fee mismatch ${report.recon.feeMismatch}`
  );

  const paths = writeReport(report);
  console.log("report", paths.mdPath);
  if (report.errors.length || report.recon.missing || report.recon.feeMismatch) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
