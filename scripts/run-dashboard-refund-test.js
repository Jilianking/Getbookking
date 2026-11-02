#!/usr/bin/env node
/**
 * Refund-gap checks against Stripe test mode.
 * Dashboard-style refunds omit refund_application_fee so the webhook returns it.
 *
 *   node scripts/run-dashboard-refund-test.js
 *
 * Local only — gitignored. Refuses live Stripe keys.
 */

const { execFileSync } = require("child_process");
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
const split = require(path.join(__dirname, "../functions/teamPaymentSplit"));

const PROJECT = process.env.FIREBASE_PROJECT || "test-app-96812";
const STRIPE_API_VERSION = "2024-11-20.acacia";
const PLATFORM_FEE_BPS = 100;
const STRIPE_ONLINE_BPS = 290;
const STRIPE_ONLINE_FIXED_CENTS = 30;
const SERVICE_CENTS = 1000;
const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLI_CLIENT_SECRET ||
  process.env.FIREBASE_CLIENT_SECRET ||
  "j9iVZfS8kkCEFUPaAeJV0sAi";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadStripeKey() {
  const fromEnv = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const key = execFileSync(
    "firebase",
    ["functions:secrets:access", "STRIPE_SECRET_KEY", "--project", PROJECT],
    { encoding: "utf8" }
  ).trim();
  return key;
}

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return cfg?.tokens?.refresh_token || null;
}

async function createDb() {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) throw new Error("firebase login required");
  const auth = new GoogleAuth({
    credentials: {
      type: "authorized_user",
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      refresh_token: refresh,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return new Firestore({ projectId: PROJECT, authClient: await auth.getClient() });
}

function platformFeeCents(amountCents) {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round((n * PLATFORM_FEE_BPS) / 10000));
}

function computeCheckout(serviceCents) {
  const service = Math.max(0, Math.round(Number(serviceCents)));
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function findStudioMember(db) {
  const tenants = await db.collection("tenants").get();
  const ranked = tenants.docs.slice().sort((a, b) => {
    const an = ((a.data() || {}).businessName || "").toString();
    const bn = ((b.data() || {}).businessName || "").toString();
    if (an === "Test 3000") return -1;
    if (bn === "Test 3000") return 1;
    return an.localeCompare(bn);
  });
  for (const doc of ranked) {
    const tenant = doc.data() || {};
    const plan = (tenant.subscriptionPlan || "").toString().toLowerCase();
    if (plan !== "studio" && plan !== "shop") continue;
    const tenantAcct = (tenant.stripeAccountId || "").toString().trim();
    if (!tenantAcct.startsWith("acct_")) continue;
    const users = await db.collection("users").where("tenantId", "==", doc.id).get();
    for (const userDoc of users.docs) {
      if (userDoc.id === (tenant.ownerUid || "").toString()) continue;
      const user = userDoc.data() || {};
      const memberAcct = (user.stripeAccountId || "").toString().trim();
      if (!memberAcct.startsWith("acct_")) continue;
      const settings = user.memberSettings || {};
      const percent = Math.round(Number(settings.paymentSplitPercent) || 0);
      const applies = (settings.paymentSplitAppliesTo || "").toString();
      if (settings.paymentSplitEnabled !== true || percent <= 0) continue;
      if (applies !== "service" && applies !== "both") continue;
      const artist = Math.round((SERVICE_CENTS * percent) / 100);
      const studioShare = SERVICE_CENTS - artist;
      if (studioShare <= 0) continue;
      return {
        tenantId: doc.id,
        businessName: (tenant.businessName || doc.id).toString(),
        tenantAcct,
        memberUid: userDoc.id,
        memberAcct,
        percent,
        studioShare,
      };
    }
  }
  throw new Error("No studio/shop member with a split and their own Connect account");
}

async function chargeStudio(stripe, member, checkout) {
  const fee = checkout.platformFeeCents + member.studioShare;
  const pi = await stripe.paymentIntents.create(
    {
      amount: checkout.totalCents,
      currency: "usd",
      confirm: true,
      off_session: true,
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      application_fee_amount: fee,
      metadata: {
        tenantId: member.tenantId,
        paymentKind: "service",
        serviceAmountCents: String(checkout.serviceCents),
        surchargeCents: String(checkout.surchargeCents),
        chargeStripeAccountId: member.memberAcct,
        chargeStripeScope: "user",
        initiatedByUid: member.memberUid,
        attributedMemberUid: member.memberUid,
        splitApplied: "true",
        studioShareCents: String(member.studioShare),
        artistShareCents: String(SERVICE_CENTS - member.studioShare),
        splitPercentApplied: String(member.percent),
        suite: "refund-gaps",
      },
    },
    { stripeAccount: member.memberAcct }
  );
  return { pi, fee };
}

async function waitForLedger(db, member, piId, predicate) {
  const ref = db.collection("tenants").doc(member.tenantId).collection("paymentLedger").doc(piId);
  const deadline = Date.now() + 45000;
  let last = null;
  while (Date.now() < deadline) {
    const snap = await ref.get();
    last = snap.exists ? snap.data() || {} : null;
    if (last && predicate(last)) return last;
    await sleep(2000);
  }
  throw new Error(`ledger timeout ${piId} last=${JSON.stringify(last && {
    status: last.studioShareStatus,
    refunded: last.amountRefundedCents,
    shareReversed: last.studioShareReversedCents,
    fee: last.platformFeeCents,
  })}`);
}

async function feeRefunded(stripe, member, chargeId) {
  const charge = await stripe.charges.retrieve(chargeId, {}, { stripeAccount: member.memberAcct });
  const feeId = typeof charge.application_fee === "string"
    ? charge.application_fee
    : charge.application_fee && charge.application_fee.id;
  const fee = await stripe.applicationFees.retrieve(feeId);
  return {
    amount: fee.amount,
    refunded: fee.amount_refunded || 0,
    chargeRefunded: charge.amount_refunded || 0,
  };
}

async function refundWithoutFeeFlag(stripe, member, chargeId, amount) {
  return stripe.refunds.create(
    {
      charge: chargeId,
      amount,
      refund_application_fee: false,
    },
    { stripeAccount: member.memberAcct }
  );
}

function expectedFeeSlice(feeAmount, captured, basis, already) {
  return split.applicationFeeRefundSliceCents({
    feeAmountCents: feeAmount,
    alreadyRefundedCents: already,
    capturedCents: captured,
    basisCents: basis,
  });
}

function expectedShareSlice(studioShare, transferred, already, captured, refundCents) {
  return split.studioShareReverseSliceCents({
    studioShareCents: studioShare,
    transferredCents: transferred,
    alreadyReversedCents: already,
    capturedCents: captured,
    refundCents,
  });
}

async function testPartialThenRemainder(stripe, db, member, checkout) {
  const { pi, fee } = await chargeStudio(stripe, member, checkout);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
  const ledger = await waitForLedger(
    db,
    member,
    pi.id,
    (row) => row.studioShareStatus === "transferred" || row.studioShareStatus === "failed"
  );
  assert(ledger.studioShareStatus === "transferred", `share did not transfer: ${ledger.studioShareStatus} ${ledger.studioShareError || ""}`);
  const half = Math.floor(checkout.totalCents / 2);
  const refund = await refundWithoutFeeFlag(stripe, member, chargeId, half);
  const afterHalf = await waitForLedger(db, member, pi.id, (row) => {
    const reversed = Math.round(Number(row.studioShareReversedCents) || 0);
    return reversed > 0 && (row.refundEvents || []).some((ev) => ev.refundId === refund.id);
  });
  const feeHalf = await feeRefunded(stripe, member, chargeId);
  const wantFee = expectedFeeSlice(fee, checkout.totalCents, half, 0);
  const wantShare = expectedShareSlice(member.studioShare, null, 0, checkout.totalCents, half);
  assert(feeHalf.refunded === wantFee, `half fee ${feeHalf.refunded} != ${wantFee}`);
  assert(
    Math.round(Number(afterHalf.studioShareReversedCents) || 0) === wantShare,
    `half share ${afterHalf.studioShareReversedCents} != ${wantShare}`
  );
  await sleep(8000);
  const feeStill = await feeRefunded(stripe, member, chargeId);
  const still = await db.collection("tenants").doc(member.tenantId).collection("paymentLedger").doc(pi.id).get();
  const stillData = still.data() || {};
  assert(feeStill.refunded === wantFee, `second notice moved the fee to ${feeStill.refunded}`);
  assert(
    Math.round(Number(stillData.studioShareReversedCents) || 0) === wantShare,
    `second notice moved the share to ${stillData.studioShareReversedCents}`
  );

  const rest = checkout.totalCents - half;
  const refund2 = await refundWithoutFeeFlag(stripe, member, chargeId, rest);
  await waitForLedger(db, member, pi.id, (row) =>
    (row.refundEvents || []).some((ev) => ev.refundId === refund2.id) &&
    Math.round(Number(row.studioShareReversedCents) || 0) >= member.studioShare
  );
  const feeFull = await feeRefunded(stripe, member, chargeId);
  assert(feeFull.refunded === fee, `remainder fee ${feeFull.refunded} != ${fee}`);
  assert(feeFull.chargeRefunded === checkout.totalCents, `customer refund ${feeFull.chargeRefunded}`);
  return {
    name: "partial-then-remainder",
    pi: pi.id,
    halfFee: wantFee,
    halfShare: wantShare,
    fee: feeFull.refunded,
    share: member.studioShare,
  };
}

async function testFullRefund(stripe, db, member, checkout) {
  const { pi, fee } = await chargeStudio(stripe, member, checkout);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
  await waitForLedger(
    db,
    member,
    pi.id,
    (row) => row.studioShareStatus === "transferred" || row.studioShareStatus === "failed"
  );
  const refund = await refundWithoutFeeFlag(stripe, member, chargeId, checkout.totalCents);
  await waitForLedger(db, member, pi.id, (row) =>
    (row.refundEvents || []).some((ev) => ev.refundId === refund.id) &&
    Math.round(Number(row.studioShareReversedCents) || 0) >= member.studioShare
  );
  const feeFull = await feeRefunded(stripe, member, chargeId);
  assert(feeFull.refunded === fee, `full fee ${feeFull.refunded} != ${fee}`);
  assert(feeFull.chargeRefunded === checkout.totalCents, "full customer refund");
  return { name: "full-refund", pi: pi.id, fee: feeFull.refunded, share: member.studioShare };
}

function applySentinel(data, key, value) {
  const method = value && value.methodName;
  if (method === "FieldValue.delete") {
    delete data[key];
    return;
  }
  if (method === "FieldValue.arrayUnion") {
    const prev = Array.isArray(data[key]) ? data[key] : [];
    data[key] = [...new Set([...prev, ...(value.elements || [])])];
    return;
  }
  if (value && value.constructor && value.constructor.name === "ServerTimestampTransform") {
    data[key] = new Date().toISOString();
    return;
  }
  data[key] = value;
}

function memoryLedger(initial) {
  const data = { ...initial };
  const ref = {
    async get() {
      return { exists: true, data: () => ({ ...data }) };
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch || {})) applySentinel(data, key, value);
    },
  };
  return {
    ref,
    read: () => ({ ...data }),
  };
}

async function testRefundBeforeTransfer() {
  const calls = [];
  const stripe = {
    transfers: {
      async list() {
        return { data: [] };
      },
      async create(params) {
        calls.push(params);
        return { id: "tr_test_withheld", amount: params.amount, amount_reversed: 0 };
      },
      async retrieve() {
        throw new Error("no transfer");
      },
      async createReversal() {
        throw new Error("should not reverse when nothing was sent");
      },
    },
  };
  const ledger = memoryLedger({
    grossCents: 1000,
    amountRefundedCents: 1000,
    disputeLostCents: 0,
    studioServiceShareCents: 500,
    splitApplied: true,
    studioShareStatus: "failed",
    chargeStripeScope: "user",
    refundEvents: [{ refundId: "re_test_full", amountCents: 1000, status: "succeeded" }],
  });
  const tenant = { subscriptionPlan: "studio", stripeAccountId: "acct_test_studio" };
  const result = await split.settleStudioPaymentSplit(stripe, {
    tenant,
    tenantId: "tenant_test",
    ledgerRef: ledger.ref,
    ledgerData: ledger.read(),
    chargeStripeScope: "user",
    paymentIntentId: "pi_test_before_transfer",
    chargeId: "ch_test",
    normalizeSubscriptionPlan: (plan) => (plan || "").toString().toLowerCase(),
  });
  const saved = ledger.read();
  assert(calls.length === 0, `sent a share after a full refund: ${JSON.stringify(calls)}`);
  assert(result.studioShareStatus === "reversed", `status ${result.studioShareStatus}`);
  assert(saved.studioShareTransferCents === 0, "transfer cents");
  assert(
    (saved.studioShareReversedRefundIds || []).includes("re_test_full"),
    "refund id not marked settled"
  );

  const partialCalls = [];
  const partialStripe = {
    transfers: {
      async list() {
        return { data: [] };
      },
      async create(params) {
        partialCalls.push(params);
        return { id: "tr_test_partial", amount: params.amount, amount_reversed: 0 };
      },
    },
  };
  const partial = memoryLedger({
    grossCents: 1000,
    amountRefundedCents: 500,
    studioServiceShareCents: 500,
    splitApplied: true,
    studioShareStatus: "failed",
    chargeStripeScope: "user",
    refundEvents: [{ refundId: "re_test_half", amountCents: 500, status: "succeeded" }],
  });
  await split.settleStudioPaymentSplit(partialStripe, {
    tenant,
    tenantId: "tenant_test",
    ledgerRef: partial.ref,
    ledgerData: partial.read(),
    chargeStripeScope: "user",
    paymentIntentId: "pi_test_partial_before",
    chargeId: "ch_test_partial",
    normalizeSubscriptionPlan: (plan) => (plan || "").toString().toLowerCase(),
  });
  assert(partialCalls.length === 1, "partial refund should still send the uncovered share");
  assert(partialCalls[0].amount === 250, `sent ${partialCalls[0] && partialCalls[0].amount} expected 250`);
  return { name: "refund-before-transfer", fullSent: 0, partialSent: partialCalls[0].amount };
}

async function main() {
  const secretKey = loadStripeKey();
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
    throw new Error("Refusing to run: STRIPE_SECRET_KEY is not a test key.");
  }
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const db = await createDb();
  const member = await findStudioMember(db);
  const checkout = computeCheckout(SERVICE_CENTS);
  console.log(JSON.stringify({
    business: member.businessName,
    percent: member.percent,
    studioShare: member.studioShare,
    total: checkout.totalCents,
    platformFee: checkout.platformFeeCents,
  }));
  const before = await testRefundBeforeTransfer();
  console.log("PASS", JSON.stringify(before));
  const partial = await testPartialThenRemainder(stripe, db, member, checkout);
  console.log("PASS", JSON.stringify(partial));
  const full = await testFullRefund(stripe, db, member, checkout);
  console.log("PASS", JSON.stringify(full));
  console.log("ALL PASSED");
}

main().catch((err) => {
  console.error("FAIL", err && err.message ? err.message : err);
  process.exit(1);
});
