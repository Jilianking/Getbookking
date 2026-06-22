/**
 * Demo marketing accounts: serve seeded payment data instead of Stripe.
 * Used by getConnectAccountStatus, getConnectBalance, getConnectBalanceTransactions.
 */

const DEMO_SHOWCASE_STRIPE_ACCOUNT_ID = "demo_showcase";

function isDemoShowcaseStripeAccountId(stripeAccountId) {
  return (
    (stripeAccountId || "").toString().trim() === DEMO_SHOWCASE_STRIPE_ACCOUNT_ID
  );
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object|null} payCtx
 */
async function loadDemoShowcaseForPayCtx(db, payCtx) {
  if (!payCtx?.tenantId) return null;
  const tenantDoc = await db.collection("tenants").doc(payCtx.tenantId).get();
  if (!tenantDoc.exists) return null;
  const tenant = tenantDoc.data() || {};
  if (!tenant.isDemoAccount) return null;
  const payments = tenant.demoShowcase?.payments;
  if (!payments || !Array.isArray(payments.transactions)) return null;
  return { payCtx, payments, tenant };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} uid
 * @param {() => Promise<object|null>} resolvePaymentStripeContext
 */
async function loadDemoShowcaseForUser(db, uid, resolvePaymentStripeContext) {
  const payCtx = await resolvePaymentStripeContext(uid);
  return loadDemoShowcaseForPayCtx(db, payCtx);
}

function demoConnectAccountStatusResponse(payCtx) {
  return {
    hasAccount: true,
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    terminalLocationId: payCtx.terminalLocationId || null,
    canTakePayments: true,
    usesOwnPayments: payCtx.scope === "user",
    payoutMode: payCtx.payoutMode,
    paymentScope: payCtx.scope,
    demoShowcase: true,
  };
}

function demoConnectBalanceResponse(payments) {
  return {
    availableCents: Math.max(0, Math.round(Number(payments.availableBalanceCents) || 0)),
    pendingCents: Math.max(0, Math.round(Number(payments.pendingBalanceCents) || 0)),
    demoShowcase: true,
  };
}

function transactionCreatedSeconds(tx) {
  if (typeof tx.created === "number" && tx.created > 0) return tx.created;
  if (tx.createdAt && typeof tx.createdAt.toDate === "function") {
    return Math.floor(tx.createdAt.toDate().getTime() / 1000);
  }
  if (tx.createdAt instanceof Date) {
    return Math.floor(tx.createdAt.getTime() / 1000);
  }
  return 0;
}

function demoConnectTransactionsResponse(payments, opts = {}) {
  const startTs = opts.startTimestampSeconds;
  const endTs = opts.endTimestampSeconds;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 100);

  let list = (payments.transactions || []).map((t) => {
    const amount = Math.round(Number(t.amountCents ?? t.amount) || 0);
    const fee = Math.round(Number(t.fee ?? t.feeCents) || 0);
    const net = Math.round(Number(t.netCents ?? t.net) || amount - fee);
    const created = transactionCreatedSeconds(t);
    const description =
      (t.description || "").toString().trim() ||
      (t.customerName
        ? `${t.customerName}`
        : null);
  return {
      id: (t.id || `demo_tx_${created}`).toString(),
      type: (t.type || "charge").toString(),
      amount,
      fee,
      net,
      created,
      description: description || null,
      reportingCategory: (t.reportingCategory || "charge").toString(),
      sourceId: (t.sourceId || t.chargeId || "").toString() || null,
    };
  });

  list.sort((a, b) => b.created - a.created);

  if (typeof startTs === "number" && startTs > 0) {
    list = list.filter((t) => t.created >= startTs);
  }
  if (typeof endTs === "number" && endTs > 0) {
    list = list.filter((t) => t.created <= endTs);
  }

  return { transactions: list.slice(0, limit), demoShowcase: true };
}

module.exports = {
  DEMO_SHOWCASE_STRIPE_ACCOUNT_ID,
  isDemoShowcaseStripeAccountId,
  loadDemoShowcaseForPayCtx,
  loadDemoShowcaseForUser,
  demoConnectAccountStatusResponse,
  demoConnectBalanceResponse,
  demoConnectTransactionsResponse,
};
