#!/usr/bin/env node
/**
 * Smoke tests for payment fixes + Phase 1 (salon PI attach, charter amount bind).
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/run-payment-fixes-smoke.js
 *
 * Local only — gitignored. Uses Test 9000 (solo) and Test 9006 (charter).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, FieldValue } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const Stripe = require(path.join(__dirname, "../functions/node_modules/stripe"));

const PROJECT = process.env.FIREBASE_PROJECT || "test-app-96812";
const STRIPE_API_VERSION = "2024-11-20.acacia";
const PLATFORM_FEE_BPS = 100;
const STRIPE_ONLINE_BPS = 290;
const STRIPE_ONLINE_FIXED_CENTS = 30;
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

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json"
  );
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

/** Mirrors functions/index.js computeInPersonCheckoutTotals (online). */
function computeInPersonCheckoutTotals(serviceCents, taxCents) {
  const service = Math.max(0, Math.round(Number(serviceCents) || 0));
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  const checkout = computeCheckout(service + tax);
  return {
    serviceCents: service,
    taxCents: tax,
    surchargeCents: Math.max(0, checkout.totalCents - service - tax),
    totalCents: checkout.totalCents,
  };
}

function testInPersonTaxGrossUp() {
  const service = 10000;
  const tax = 1000;
  const oldWay = computeCheckout(service).totalCents + tax;
  const newWay = computeInPersonCheckoutTotals(service, tax).totalCents;
  if (newWay <= oldWay) {
    return {
      ok: false,
      name: "inPersonTaxGrossUp",
      detail: `expected new total > old (${newWay} vs ${oldWay})`,
    };
  }
  return { ok: true, name: "inPersonTaxGrossUp", oldTotal: oldWay, newTotal: newWay };
}

async function findTenant(db, businessName) {
  const snap = await db.collection("tenants").where("businessName", "==", businessName).limit(1).get();
  if (snap.empty) throw new Error(`Tenant not found: ${businessName}`);
  const doc = snap.docs[0];
  const data = doc.data() || {};
  const stripeAccountId = (data.stripeAccountId || "").toString().trim();
  if (!stripeAccountId.startsWith("acct_")) throw new Error(`${businessName} missing stripeAccountId`);
  return { tenantId: doc.id, stripeAccountId, ownerUid: (data.ownerUid || "").toString() };
}

async function poll(fn, { timeoutMs = 55000, intervalMs = 2500, label = "" }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(intervalMs);
  }
  return { ok: false, reason: "timeout", last, label };
}

function chargeMeta(tenant, extra) {
  return {
    tenantId: tenant.tenantId,
    paymentKind: extra.paymentKind || "service",
    serviceAmountCents: String(extra.serviceAmountCents || 0),
    surchargeCents: String(extra.surchargeCents || 0),
    chargeStripeAccountId: tenant.stripeAccountId,
    chargeStripeScope: "tenant",
    initiatedByUid: tenant.ownerUid || "",
    ...extra,
  };
}

async function confirmDirectPi(stripe, tenant, amount, metadata) {
  return stripe.paymentIntents.create(
    {
      amount,
      currency: "usd",
      confirm: true,
      off_session: true,
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      application_fee_amount: platformFeeCents(amount),
      metadata,
    },
    { stripeAccount: tenant.stripeAccountId }
  );
}

async function testDepositLinkRestrictions(stripe, tenant) {
  const checkout = computeCheckout(500);
  const meta = chargeMeta(tenant, {
    paymentKind: "deposit",
    serviceAmountCents: checkout.serviceCents,
    surchargeCents: checkout.surchargeCents,
  });
  const link = await stripe.paymentLinks.create(
    {
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Smoke deposit" },
            unit_amount: checkout.serviceCents,
          },
          quantity: 1,
        },
      ],
      application_fee_amount: checkout.platformFeeCents,
      metadata: meta,
      payment_intent_data: { metadata: meta },
      restrictions: { completed_sessions: { limit: 1 } },
    },
    { stripeAccount: tenant.stripeAccountId }
  );
  const limit = link.restrictions?.completed_sessions?.limit;
  if (limit !== 1) {
    return { ok: false, name: "depositLinkRestrictions", detail: `limit=${limit}` };
  }
  return { ok: true, name: "depositLinkRestrictions", linkId: link.id };
}

async function testSoloRefundLedger(stripe, db, tenant) {
  const checkout = computeCheckout(100);
  const pi = await confirmDirectPi(stripe, tenant, checkout.totalCents, chargeMeta(tenant, {
    paymentKind: "service",
    serviceAmountCents: checkout.serviceCents,
    surchargeCents: checkout.surchargeCents,
  }));

  const ledgerPoll = await poll(async () => {
    const snap = await db
      .collection("tenants")
      .doc(tenant.tenantId)
      .collection("paymentLedger")
      .doc(pi.id)
      .get();
    return snap.exists ? { ok: true } : { ok: false };
  }, { label: "solo-ledger" });

  if (!ledgerPoll.ok) {
    return { ok: false, name: "soloRefundLedger", detail: "ledger missing after charge" };
  }

  const refund = await stripe.refunds.create(
    {
      payment_intent: pi.id,
      amount: checkout.totalCents,
      refund_application_fee: true,
    },
    { stripeAccount: tenant.stripeAccountId }
  );

  const refundPoll = await poll(async () => {
    const snap = await db
      .collection("tenants")
      .doc(tenant.tenantId)
      .collection("paymentLedger")
      .doc(pi.id)
      .get();
    const d = snap.data() || {};
    const events = Array.isArray(d.refundEvents) ? d.refundEvents : [];
    if ((d.amountRefundedCents || 0) >= checkout.totalCents && events.length > 0) {
      return { ok: true, d };
    }
    return { ok: false };
  }, { label: "solo-refund-ledger" });

  if (!refundPoll.ok) {
    return { ok: false, name: "soloRefundLedger", detail: "ledger refund fields missing", pi: pi.id };
  }
  return {
    ok: true,
    name: "soloRefundLedger",
    pi: pi.id,
    refundId: refund.id,
    fullyRefunded: !!refundPoll.last?.d?.fullyRefunded,
  };
}

async function testShopOrderRefunded(stripe, db, tenant) {
  const subtotalCents = 500;
  const checkout = computeCheckout(subtotalCents);
  const piAmount = checkout.totalCents;
  const orderRef = db.collection("tenants").doc(tenant.tenantId).collection("shopOrders").doc();
  const orderId = orderRef.id;

  await orderRef.set({
    status: "pending_payment",
    source: "shop",
    tenantId: tenant.tenantId,
    customerName: "Smoke Shop",
    customerEmail: `smoke+${orderId}@example.com`,
    lineItems: [{ productId: "smoke", name: "Smoke item", qty: 1, unitPriceCents: subtotalCents, lineTotalCents: subtotalCents }],
    subtotalCents,
    shippingCents: 0,
    taxCents: 0,
    surchargeCents: checkout.surchargeCents,
    totalCents: piAmount,
    fulfillmentMethod: "pickup",
    createdAt: FieldValue.serverTimestamp(),
  });

  const pi = await confirmDirectPi(stripe, tenant, piAmount, chargeMeta(tenant, {
    paymentKind: "shop",
    shopOrderId: orderId,
    serviceAmountCents: subtotalCents,
    shippingCents: "0",
    taxCents: "0",
    surchargeCents: checkout.surchargeCents,
    fulfillmentMethod: "pickup",
  }));

  await orderRef.set({ stripePaymentIntentId: pi.id }, { merge: true });

  const paidPoll = await poll(async () => {
    const snap = await orderRef.get();
    const st = (snap.data()?.status || "").toString();
    const ledger = await db
      .collection("tenants")
      .doc(tenant.tenantId)
      .collection("paymentLedger")
      .doc(pi.id)
      .get();
    if (st === "paid" && ledger.exists) return { ok: true };
    return { ok: false, st };
  }, { label: "shop-paid" });

  if (!paidPoll.ok) {
    return { ok: false, name: "shopOrderRefunded", detail: "order not paid via webhook", orderId, pi: pi.id };
  }

  await stripe.refunds.create(
    { payment_intent: pi.id, amount: piAmount, refund_application_fee: true },
    { stripeAccount: tenant.stripeAccountId }
  );

  const refundPoll = await poll(async () => {
    const snap = await orderRef.get();
    const st = (snap.data()?.status || "").toString();
    if (st === "refunded") return { ok: true };
    return { ok: false, st };
  }, { label: "shop-refunded" });

  if (!refundPoll.ok) {
    return {
      ok: false,
      name: "shopOrderRefunded",
      detail: `status=${refundPoll.last?.st || "unknown"}`,
      orderId,
      pi: pi.id,
    };
  }
  return { ok: true, name: "shopOrderRefunded", orderId, pi: pi.id };
}

async function testSalonBookingPiAttach(stripe, db, tenant) {
  const checkout = computeCheckout(100);
  const bookingRef = db
    .collection("tenants")
    .doc(tenant.tenantId)
    .collection("bookingRequests")
    .doc();
  await bookingRef.set({
    status: "pending_deposit",
    source: "seed",
    tenantId: tenant.tenantId,
    customerName: "Smoke Salon Attach",
    customerEmail: "smoke-attach@example.com",
    chargeCents: checkout.serviceCents,
    createdAt: FieldValue.serverTimestamp(),
  });

  const pi = await confirmDirectPi(stripe, tenant, checkout.totalCents, chargeMeta(tenant, {
    paymentKind: "deposit",
    bookingRequestId: bookingRef.id,
    serviceAmountCents: checkout.serviceCents,
    surchargeCents: checkout.surchargeCents,
    checkoutChannel: "deposit_link",
  }));

  const attached = await poll(async () => {
    const snap = await bookingRef.get();
    const d = snap.data() || {};
    const stored = (d.stripePaymentIntentId || "").toString();
    const paid = Math.round(Number(d.paidCents) || 0);
    const st = (d.status || "").toString().toLowerCase();
    if (stored === pi.id && paid === checkout.totalCents && st === "confirmed") {
      return { ok: true };
    }
    return { ok: false, stored, paid, st };
  }, { label: "salon-pi-attach" });

  if (!attached.ok) {
    return {
      ok: false,
      name: "salonBookingPiAttach",
      detail: `pi=${attached.last?.stored || "missing"} status=${attached.last?.st || "?"}`,
      pi: pi.id,
      bookingId: bookingRef.id,
    };
  }
  return { ok: true, name: "salonBookingPiAttach", pi: pi.id, bookingId: bookingRef.id };
}

async function testCharterAmountMatch(stripe, db, tenant) {
  const chargeCents = 500;
  const checkout = computeCheckout(chargeCents);
  const bookingRef = db
    .collection("tenants")
    .doc(tenant.tenantId)
    .collection("bookingRequests")
    .doc();
  await bookingRef.set({
    status: "pending_deposit",
    source: "seed",
    tenantId: tenant.tenantId,
    customerName: "Smoke Charter Match",
    customerEmail: "smoke-charter-match@example.com",
    chargeCents,
    createdAt: FieldValue.serverTimestamp(),
  });

  const pi = await confirmDirectPi(stripe, tenant, checkout.totalCents, chargeMeta(tenant, {
    paymentKind: "deposit",
    bookingRequestId: bookingRef.id,
    serviceAmountCents: chargeCents,
    surchargeCents: checkout.surchargeCents,
    checkoutChannel: "charter_web_checkout",
  }));

  const confirmed = await poll(async () => {
    const snap = await bookingRef.get();
    const d = snap.data() || {};
    const st = (d.status || "").toString().toLowerCase();
    if (st === "confirmed" && (d.stripePaymentIntentId || "") === pi.id) return { ok: true };
    return { ok: false, st };
  }, { label: "charter-amount-match" });

  if (!confirmed.ok) {
    return {
      ok: false,
      name: "charterAmountMatch",
      detail: `status=${confirmed.last?.st || "?"}`,
      pi: pi.id,
      bookingId: bookingRef.id,
    };
  }
  return { ok: true, name: "charterAmountMatch", pi: pi.id, bookingId: bookingRef.id };
}

async function testCharterAmountMismatch(stripe, db, tenant) {
  const chargeCents = 500;
  const checkout = computeCheckout(chargeCents);
  const bookingRef = db
    .collection("tenants")
    .doc(tenant.tenantId)
    .collection("bookingRequests")
    .doc();
  await bookingRef.set({
    status: "pending_deposit",
    source: "seed",
    tenantId: tenant.tenantId,
    customerName: "Smoke Charter Mismatch",
    customerEmail: "smoke-charter-mismatch@example.com",
    chargeCents,
    createdAt: FieldValue.serverTimestamp(),
  });

  const pi = await confirmDirectPi(stripe, tenant, chargeCents, chargeMeta(tenant, {
    paymentKind: "deposit",
    bookingRequestId: bookingRef.id,
    serviceAmountCents: chargeCents,
    surchargeCents: String(checkout.surchargeCents),
    checkoutChannel: "charter_web_checkout",
  }));

  await sleep(8000);
  const snap = await bookingRef.get();
  const st = (snap.data()?.status || "").toString().toLowerCase();
  if (st === "confirmed") {
    return {
      ok: false,
      name: "charterAmountMismatch",
      detail: "booking confirmed on underpaid PI",
      pi: pi.id,
      bookingId: bookingRef.id,
    };
  }
  return {
    ok: true,
    name: "charterAmountMismatch",
    detail: `status=${st} (expected not confirmed)`,
    pi: pi.id,
    bookingId: bookingRef.id,
  };
}

async function testMismatchedTenantMetadataSkipped(stripe, db, tenant) {
  const checkout = computeCheckout(100);
  const pi = await confirmDirectPi(stripe, tenant, checkout.totalCents, chargeMeta(tenant, {
    tenantId: "not-this-tenant",
    paymentKind: "service",
    serviceAmountCents: checkout.serviceCents,
    surchargeCents: checkout.surchargeCents,
  }));

  await sleep(8000);
  const snap = await db
    .collection("tenants")
    .doc(tenant.tenantId)
    .collection("paymentLedger")
    .doc(pi.id)
    .get();
  if (snap.exists) {
    return {
      ok: false,
      name: "mismatchedTenantMetadata",
      detail: "ledger wrote for foreign tenantId metadata",
      pi: pi.id,
    };
  }
  return { ok: true, name: "mismatchedTenantMetadata", pi: pi.id };
}

async function testConnectDisputeCreated(stripe, db, tenant) {
  const checkout = computeCheckout(100);
  const pi = await stripe.paymentIntents.create(
    {
      amount: checkout.totalCents,
      currency: "usd",
      confirm: true,
      off_session: true,
      payment_method_types: ["card"],
      payment_method_data: {
        type: "card",
        card: { token: "tok_createDispute" },
      },
      application_fee_amount: platformFeeCents(checkout.totalCents),
      metadata: chargeMeta(tenant, {
        paymentKind: "service",
        serviceAmountCents: checkout.serviceCents,
        surchargeCents: checkout.surchargeCents,
        checkoutChannel: "manual_in_app",
      }),
    },
    { stripeAccount: tenant.stripeAccountId }
  );

  const ledgerPoll = await poll(async () => {
    const snap = await db
      .collection("tenants")
      .doc(tenant.tenantId)
      .collection("paymentLedger")
      .doc(pi.id)
      .get();
    return snap.exists ? { ok: true } : { ok: false };
  }, { label: "dispute-ledger", timeoutMs: 55000 });

  if (!ledgerPoll.ok) {
    return { ok: false, name: "connectDisputeCreated", detail: "ledger missing after dispute card", pi: pi.id };
  }

  const disputePoll = await poll(async () => {
    const snap = await db
      .collection("tenants")
      .doc(tenant.tenantId)
      .collection("paymentLedger")
      .doc(pi.id)
      .get();
    const d = snap.data() || {};
    const st = (d.disputeStatus || "").toString();
    const id = (d.disputeId || "").toString();
    if (st) return { ok: true, st, id: id || "" };
    return { ok: false, st, id };
  }, { label: "dispute-status", timeoutMs: 70000, intervalMs: 3000 });

  if (!disputePoll.ok) {
    return {
      ok: false,
      name: "connectDisputeCreated",
      detail: `no disputeStatus on ledger (got ${disputePoll.last?.st || "empty"})`,
      pi: pi.id,
    };
  }
  return {
    ok: true,
    name: "connectDisputeCreated",
    pi: pi.id,
    detail: `${disputePoll.last?.id || "no-dp-id"} ${disputePoll.last?.st}`,
  };
}

async function main() {
  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
    throw new Error("Set STRIPE_SECRET_KEY=sk_test_...");
  }
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const db = await createDb();
  const solo = await findTenant(db, "Test 9000");
  const charter = await findTenant(db, "Test 9006");

  const results = [testInPersonTaxGrossUp()];
  for (const fn of [
    () => testDepositLinkRestrictions(stripe, solo),
    () => testSoloRefundLedger(stripe, db, solo),
    () => testShopOrderRefunded(stripe, db, solo),
    () => testSalonBookingPiAttach(stripe, db, solo),
    () => testCharterAmountMatch(stripe, db, charter),
    () => testCharterAmountMismatch(stripe, db, charter),
    () => testMismatchedTenantMetadataSkipped(stripe, db, solo),
    () => testConnectDisputeCreated(stripe, db, solo),
  ]) {
    try {
      results.push(await fn());
    } catch (err) {
      results.push({ ok: false, name: "error", detail: err.message || String(err) });
    }
  }

  console.log("\nPayment fixes smoke\n");
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed += 1;
    console.log(
      `${mark}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}${r.pi ? ` pi=${r.pi}` : ""}${r.orderId ? ` order=${r.orderId}` : ""}${r.bookingId ? ` booking=${r.bookingId}` : ""}`
    );
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
