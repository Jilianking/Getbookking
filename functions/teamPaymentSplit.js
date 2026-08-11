/**
 * Studio/Shop team payment split settlement.
 *
 * Charge flow stays normal (customer pays Stripe + Bookking 1%).
 * For team members with a payment split: studio share is included in
 * application_fee at charge time, then transferred to the tenant Connect
 * account after payment_intent.succeeded. All members use their own Connect.
 */

const admin = require("firebase-admin");
const functions = require("firebase-functions");

/** Member Connect modes (legacy studio_payroll → shop_split). */
function memberUsesOwnConnect(payoutMode) {
  const m = (payoutMode || "").toString().trim().toLowerCase();
  return (
    m === "independent" ||
    m === "shop_split" ||
    m === "studio_payroll" ||
    !m
  );
}

function isTeamSplitPlan(plan, normalizeSubscriptionPlan) {
  const p = normalizeSubscriptionPlan(plan);
  return p === "studio" || p === "shop";
}

/**
 * @returns {Promise<object>}
 */
async function resolveIndependentStudioShareForCharge({
  db,
  tenant,
  tenantId,
  payCtx,
  paymentKind,
  serviceCents,
  normalizeSubscriptionPlan,
  normalizeMemberSettings,
  computeTeamPaymentSplit,
}) {
  const empty = {
    splitApplied: false,
    splitPercentApplied: 0,
    artistShareCents: 0,
    studioServiceShareCents: 0,
    shouldCollectViaApplicationFee: false,
  };
  if (!tenant || !payCtx) return empty;
  if (!isTeamSplitPlan(tenant.subscriptionPlan, normalizeSubscriptionPlan)) {
    return empty;
  }
  if (!memberUsesOwnConnect(payCtx.payoutMode)) return empty;
  if ((payCtx.scope || "").toString() !== "user") return empty;

  const ownerUid = (tenant.ownerUid || "").toString().trim();
  const attributedMemberUid = (payCtx.attributedMemberUid || "").toString().trim();
  if (!attributedMemberUid || attributedMemberUid === ownerUid) return empty;

  let memberSettings = {};
  const memberSnap = await db.collection("users").doc(attributedMemberUid).get();
  if (
    memberSnap.exists &&
    (memberSnap.data().tenantId || "").toString() === (tenantId || "").toString()
  ) {
    memberSettings = memberSnap.data().memberSettings || {};
  }
  const normalized = normalizeMemberSettings(memberSettings);
  if (!memberUsesOwnConnect(normalized.payoutMode)) return empty;

  const split = computeTeamPaymentSplit({
    memberSettings: normalized,
    paymentKind,
    serviceCents,
  });
  if (!split.splitApplied || split.studioServiceShareCents <= 0) {
    return { ...split, shouldCollectViaApplicationFee: false };
  }

  const tenantStripeId = (tenant.stripeAccountId || "").toString().trim();
  if (!tenantStripeId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Connect the studio Stripe account before collecting a studio payment share."
    );
  }

  return {
    ...split,
    shouldCollectViaApplicationFee: true,
    tenantStripeAccountId: tenantStripeId,
  };
}

function connectApplicationFeeCents(grossCents, studioShareCents, platformFeeCents) {
  const platform = platformFeeCents(grossCents);
  const studio = Math.max(0, Math.round(Number(studioShareCents) || 0));
  return platform + studio;
}

async function buildTeamSplitFeeAndMeta(deps) {
  const {
    platformFeeCents,
    normalizeSubscriptionPlan,
    normalizeMemberSettings,
    computeTeamPaymentSplit,
    tenant,
    tenantId,
    payCtx,
    paymentKind,
    serviceCents,
    grossCents,
    db,
  } = deps;
  const platformFee = platformFeeCents(grossCents);
  const share = await resolveIndependentStudioShareForCharge({
    db,
    tenant,
    tenantId,
    payCtx,
    paymentKind,
    serviceCents,
    normalizeSubscriptionPlan,
    normalizeMemberSettings,
    computeTeamPaymentSplit,
  });
  const studioShare = share.shouldCollectViaApplicationFee
    ? share.studioServiceShareCents
    : 0;
  return {
    applicationFeeCents: connectApplicationFeeCents(
      grossCents,
      studioShare,
      platformFeeCents
    ),
    platformFeeCents: platformFee,
    studioShareCents: studioShare,
    artistShareCents: share.shouldCollectViaApplicationFee
      ? share.artistShareCents
      : 0,
    splitPercentApplied: share.shouldCollectViaApplicationFee
      ? share.splitPercentApplied
      : 0,
    splitApplied: share.shouldCollectViaApplicationFee === true,
    splitMeta: {
      studioShareCents: String(studioShare),
      artistShareCents: String(
        share.shouldCollectViaApplicationFee ? share.artistShareCents : 0
      ),
      splitPercentApplied: String(
        share.shouldCollectViaApplicationFee ? share.splitPercentApplied : 0
      ),
      splitApplied: share.shouldCollectViaApplicationFee ? "true" : "false",
    },
  };
}

async function settleStudioPaymentSplit(
  stripe,
  {
    tenant,
    tenantId,
    ledgerRef,
    ledgerData,
    chargeStripeScope,
    paymentIntentId,
    chargeId,
    normalizeSubscriptionPlan,
  }
) {
  const studioShare = Math.max(
    0,
    Math.round(Number(ledgerData && ledgerData.studioServiceShareCents) || 0)
  );
  const needsTransfer =
    isTeamSplitPlan(tenant && tenant.subscriptionPlan, normalizeSubscriptionPlan) &&
    (chargeStripeScope || "").toString() === "user" &&
    ledgerData &&
    ledgerData.splitApplied === true &&
    studioShare > 0;

  if (!needsTransfer) {
    return {
      studioShareStatus: "not_applicable",
      studioShareTransferId: null,
    };
  }

  const existingTransferId = (ledgerData.studioShareTransferId || "")
    .toString()
    .trim();
  if (existingTransferId || ledgerData.studioShareStatus === "transferred") {
    return {
      studioShareStatus: "transferred",
      studioShareTransferId: existingTransferId || null,
    };
  }

  const destination = (tenant.stripeAccountId || "").toString().trim();
  if (!destination) {
    await ledgerRef.set(
      {
        studioShareStatus: "failed",
        studioShareError: "Studio Stripe account missing",
        studioShareUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { studioShareStatus: "failed", studioShareTransferId: null };
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: studioShare,
        currency: "usd",
        destination,
        description: "Studio share",
        transfer_group: paymentIntentId || undefined,
        metadata: {
          purpose: "studio_payment_split",
          tenantId: (tenantId || "").toString(),
          paymentIntentId: (paymentIntentId || "").toString(),
          chargeId: (chargeId || "").toString(),
          attributedMemberUid: (ledgerData.attributedMemberUid || "").toString(),
          studioServiceShareCents: String(studioShare),
        },
      },
      { idempotencyKey: `studio-share-${paymentIntentId}` }
    );
    await ledgerRef.set(
      {
        studioShareStatus: "transferred",
        studioShareTransferId: transfer.id,
        studioShareSettledAt: admin.firestore.FieldValue.serverTimestamp(),
        studioShareError: null,
      },
      { merge: true }
    );
    return {
      studioShareStatus: "transferred",
      studioShareTransferId: transfer.id,
    };
  } catch (err) {
    console.error("settleStudioPaymentSplit", paymentIntentId, err.message);
    await ledgerRef.set(
      {
        studioShareStatus: "failed",
        studioShareError: (err.message || "transfer_failed")
          .toString()
          .slice(0, 500),
        studioShareUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { studioShareStatus: "failed", studioShareTransferId: null };
  }
}

/**
 * Record ledger + settle studio share after a succeeded PaymentIntent.
 */
async function recordAndSettleTenantPayment(stripe, deps) {
  const {
    db,
    tenantId,
    tenant,
    pi,
    stripeAccountId,
    chargeStripeScopeHint = null,
    initiatedByUidFallback = null,
    platformFeeCents,
    normalizeSubscriptionPlan,
    normalizeMemberSettings,
    computeTeamPaymentSplit,
    resolveAttributedMemberUid,
    loadBookingRequestForPayment,
    confirmBookingAfterDepositPaid,
  } = deps;

  const meta = pi.metadata || {};
  if (pi.status !== "succeeded") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Payment is not complete yet."
    );
  }
  if ((meta.tenantId || "").toString() !== (tenantId || "").toString()) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Payment does not belong to this business."
    );
  }

  const paymentIntentId = pi.id;
  const serviceCents = parseInt(meta.serviceAmountCents, 10);
  const surchargeCents = parseInt(meta.surchargeCents, 10);
  const taxCentsMeta = parseInt(meta.taxCents, 10);
  const resolvedTax = Number.isNaN(taxCentsMeta) ? 0 : Math.max(0, taxCentsMeta);
  const paymentKind = (meta.paymentKind || "service").toString();
  const bookingRequestId = (meta.bookingRequestId || "").toString().trim();
  const resolvedService =
    Number.isNaN(serviceCents) || serviceCents <= 0
      ? Math.max(
          0,
          (pi.amount || 0) -
            (Number.isNaN(surchargeCents) ? 0 : surchargeCents) -
            resolvedTax
        )
      : serviceCents;
  const resolvedSurcharge = Number.isNaN(surchargeCents)
    ? 0
    : Math.max(0, surchargeCents);
  const grossCents =
    pi.amount || resolvedService + resolvedTax + resolvedSurcharge;

  let stripeFeeCents = 0;
  const chargeId =
    typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : pi.latest_charge && pi.latest_charge.id;
  if (chargeId) {
    try {
      const charge = await stripe.charges.retrieve(chargeId, {
        stripeAccount: stripeAccountId,
      });
      if (charge.balance_transaction) {
        const btId =
          typeof charge.balance_transaction === "string"
            ? charge.balance_transaction
            : charge.balance_transaction.id;
        const bt = await stripe.balanceTransactions.retrieve(btId, {
          stripeAccount: stripeAccountId,
        });
        stripeFeeCents = bt.fee || 0;
      }
    } catch (feeErr) {
      console.warn("recordAndSettleTenantPayment fee lookup", feeErr.message);
    }
  }
  const platformFee = platformFeeCents(grossCents);

  const booking = await loadBookingRequestForPayment(tenantId, bookingRequestId);
  const initiatedByUid = (
    meta.initiatedByUid ||
    initiatedByUidFallback ||
    ""
  ).toString();
  // Prefer charge-time attribution over live booking reassignment.
  const metaAttributed = (meta.attributedMemberUid || "").toString().trim();
  const attributedMemberUid =
    metaAttributed ||
    resolveAttributedMemberUid(tenant, booking, initiatedByUid);
  const ownerUid = (tenant.ownerUid || "").toString();
  let memberSettings = {};
  if (attributedMemberUid && attributedMemberUid !== ownerUid) {
    const memberSnap = await db.collection("users").doc(attributedMemberUid).get();
    if (memberSnap.exists && memberSnap.data().tenantId === tenantId) {
      memberSettings = memberSnap.data().memberSettings || {};
    }
  }

  const metaSplitFlag = (meta.splitApplied || "").toString();
  const metaSplitApplied = metaSplitFlag === "true";
  const metaStudioShare = parseInt(meta.studioShareCents, 10);
  const computed = computeTeamPaymentSplit({
    memberSettings,
    paymentKind,
    serviceCents: resolvedService,
  });
  // Charge-time metadata is source of truth for settlement. Never "upgrade" a
  // non-split charge into a transfer from live member settings.
  let split;
  if (metaSplitApplied && !Number.isNaN(metaStudioShare) && metaStudioShare >= 0) {
    const artistFromMeta = parseInt(meta.artistShareCents, 10);
    const pctFromMeta = parseInt(meta.splitPercentApplied, 10);
    split = {
      splitApplied: true,
      splitPercentApplied: Number.isNaN(pctFromMeta)
        ? computed.splitPercentApplied
        : pctFromMeta,
      artistShareCents: Number.isNaN(artistFromMeta)
        ? Math.max(0, resolvedService - metaStudioShare)
        : artistFromMeta,
      studioServiceShareCents: metaStudioShare,
    };
  } else {
    split = {
      ...computed,
      splitApplied: false,
      studioServiceShareCents: 0,
      artistShareCents:
        typeof computed.artistShareCents === "number"
          ? computed.artistShareCents
          : resolvedService,
    };
  }

  const chargeStripeScope = (
    meta.chargeStripeScope ||
    chargeStripeScopeHint ||
    "tenant"
  ).toString();

  const ledgerRef = db
    .collection("tenants")
    .doc(tenantId)
    .collection("paymentLedger")
    .doc(paymentIntentId);
  const existing = await ledgerRef.get();
  let ledgerData;
  let alreadyRecorded = false;

  if (existing.exists) {
    alreadyRecorded = true;
    ledgerData = existing.data() || {};
    // Do not rewrite splitApplied from live settings after the fact.
  } else {
    ledgerData = {
      paymentIntentId,
      chargeId: chargeId || null,
      bookingRequestId: bookingRequestId || null,
      attributedMemberUid: attributedMemberUid || ownerUid,
      paymentKind,
      serviceCents: resolvedService,
      taxCents: resolvedTax,
      surchargeCents: resolvedSurcharge,
      grossCents,
      stripeFeeCents,
      platformFeeCents: platformFee,
      splitApplied: split.splitApplied,
      splitPercentApplied: split.splitPercentApplied,
      artistShareCents: split.artistShareCents,
      studioServiceShareCents: split.studioServiceShareCents,
      initiatedByUid: initiatedByUid || null,
      chargeStripeScope,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ledgerRef.set(ledgerData);
  }

  const settle = await settleStudioPaymentSplit(stripe, {
    tenant,
    tenantId,
    ledgerRef,
    ledgerData,
    chargeStripeScope: ledgerData.chargeStripeScope || chargeStripeScope,
    paymentIntentId,
    chargeId: ledgerData.chargeId || chargeId,
    normalizeSubscriptionPlan,
  });

  if (paymentKind === "deposit" && bookingRequestId) {
    await confirmBookingAfterDepositPaid(tenantId, bookingRequestId);
  }

  return {
    ok: true,
    alreadyRecorded,
    ledgerId: paymentIntentId,
    serviceCents: resolvedService,
    surchargeCents: resolvedSurcharge,
    grossCents,
    artistShareCents: split.artistShareCents,
    studioServiceShareCents: split.studioServiceShareCents,
    studioShareStatus: settle.studioShareStatus,
    studioShareTransferId: settle.studioShareTransferId,
  };
}

function labelStudioShareBalanceTransaction(row) {
  const descLower = (row.description || "").toLowerCase();
  const reportingCategory = (row.reportingCategory || "").toString().toLowerCase();
  const type = (row.type || "unknown").toString();
  const purpose = (row.purpose || "").toString();
  const sourceId = (row.sourceId || "").toString().trim();
  const isStudioShareTransfer =
    purpose === "studio_payment_split" ||
    type === "studio_share" ||
    descLower.includes("studio share") ||
    (sourceId.startsWith("tr_") && purpose === "studio_payment_split") ||
    (type === "payment" &&
      reportingCategory === "transfer" &&
      (descLower.includes("studio") || purpose === "studio_payment_split"));
  if (!isStudioShareTransfer) return row;
  return {
    ...row,
    type: "studio_share",
    description: "Studio share",
    purpose: "studio_payment_split",
  };
}

function memberDisplayNameFromLedgerUser(userData, fallback) {
  if (!userData) return fallback || "Team member";
  const fn = (userData.firstName || "").toString().trim();
  const ln = (userData.lastName || "").toString().trim();
  const composed = `${fn} ${ln}`.trim();
  return (
    (userData.displayName || userData.name || composed || fallback || "Team member")
      .toString()
      .trim()
  );
}

/**
 * Loads transferred studio-share ledger rows for a tenant (for attribution / member debits).
 */
async function loadTransferredStudioShareLedger(db, tenantId, { limit = 80 } = {}) {
  const tid = (tenantId || "").toString().trim();
  if (!tid) return [];
  try {
    const snap = await db
      .collection("tenants")
      .doc(tid)
      .collection("paymentLedger")
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((d) => d.studioShareStatus === "transferred");
  } catch (err) {
    console.warn("loadTransferredStudioShareLedger", err.message);
    return [];
  }
}

async function resolveMemberNamesByUid(db, uids) {
  const unique = [...new Set((uids || []).map((u) => (u || "").toString().trim()).filter(Boolean))];
  const out = new Map();
  await Promise.all(
    unique.map(async (uid) => {
      try {
        const snap = await db.collection("users").doc(uid).get();
        out.set(
          uid,
          memberDisplayNameFromLedgerUser(snap.exists ? snap.data() : null, "Team member")
        );
      } catch (_) {
        out.set(uid, "Team member");
      }
    })
  );
  return out;
}

/**
 * Attach attributed team-member name onto studio-share balance rows (owner credits + member debits).
 */
async function attachStudioShareAttribution(db, payCtx, transactions) {
  const list = Array.isArray(transactions) ? transactions : [];
  if (!list.length) return list;
  const tenantId = (payCtx && payCtx.tenantId) || "";
  if (!tenantId) return list.map(labelStudioShareBalanceTransaction);

  const ledger = await loadTransferredStudioShareLedger(db, tenantId, { limit: 80 });
  const labeledOnly = () => list.map(labelStudioShareBalanceTransaction);

  let ownerUid = "";
  try {
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    ownerUid = tenantSnap.exists
      ? ((tenantSnap.data() || {}).ownerUid || "").toString().trim()
      : "";
  } catch (_) {
    ownerUid = "";
  }

  const byTransferId = new Map();
  const byPaymentIntentId = new Map();
  for (const d of ledger) {
    const share = Math.max(0, Math.round(Number(d.studioServiceShareCents) || 0));
    if (share <= 0) continue;
    if ((d.chargeStripeScope || "").toString() !== "user") continue;
    const transferId = (d.studioShareTransferId || "").toString().trim();
    const piId = (d.paymentIntentId || d.id || "").toString().trim();
    const memberUid = (d.attributedMemberUid || "").toString().trim();
    // Never treat the owner as the "member" side of a studio share.
    if (!memberUid || (ownerUid && memberUid === ownerUid)) continue;
    const entry = { ...d, studioServiceShareCents: share, attributedMemberUid: memberUid };
    if (transferId) byTransferId.set(transferId, entry);
    if (piId) byPaymentIntentId.set(piId, entry);
  }

  const uidsForNames = [
    ...[...byTransferId.values(), ...byPaymentIntentId.values()].map((e) => e.attributedMemberUid),
    ...list.map((row) => (row.attributedMemberUid || "").toString().trim()),
  ];
  const nameByUid = await resolveMemberNamesByUid(db, uidsForNames);

  if (!ledger.length && ![...nameByUid.keys()].length) {
    return labeledOnly();
  }

  function isLikelyStudioShareRow(row) {
    const labeled = labelStudioShareBalanceTransaction(row);
    if (labeled.type === "studio_share" || labeled.purpose === "studio_payment_split") {
      return true;
    }
    const sourceId = (row.sourceId || "").toString().trim();
    if (sourceId.startsWith("tr_")) return true;
    if (sourceId && byTransferId.has(sourceId)) return true;
    return false;
  }

  function lookupLedger(row) {
    const sourceId = (row.sourceId || "").toString().trim();
    const id = (row.id || "").toString().trim();
    if (sourceId && byTransferId.has(sourceId)) return byTransferId.get(sourceId);
    if (id && byTransferId.has(id)) return byTransferId.get(id);
    if (sourceId && byPaymentIntentId.has(sourceId)) return byPaymentIntentId.get(sourceId);
    // Do NOT match by amount alone — that mislabels the owner's own charges as studio share.
    return null;
  }

  return list.map((raw) => {
    let row = labelStudioShareBalanceTransaction(raw);
    if (!isLikelyStudioShareRow(raw) && row.type !== "studio_share") {
      return row;
    }
    const existingUid = (row.attributedMemberUid || "").toString().trim();
    const hit = lookupLedger(row);
    let memberUid = (hit && hit.attributedMemberUid) || existingUid || "";
    if (ownerUid && memberUid === ownerUid) memberUid = "";
    // Only enrich true studio-share rows; never rewrite ordinary payments.
    // Ledger transfer-id hit is enough to force studio_share on owner credits.
    if (row.type !== "studio_share" && !hit) {
      const sid = (raw.sourceId || "").toString().trim();
      if (!(sid.startsWith("tr_") && (raw.purpose || "") === "studio_payment_split")) {
        return raw;
      }
    }
    if (!memberUid) {
      // Still label the row even if we don't know the member yet.
      if (row.type === "studio_share" || (hit && hit.studioServiceShareCents > 0)) {
        return {
          ...row,
          type: "studio_share",
          purpose: "studio_payment_split",
          description: "Studio share",
          sourceGrossCents:
            Math.max(0, Math.round(Number((hit && hit.grossCents) || row.sourceGrossCents) || 0)) ||
            null,
          sourceServiceCents:
            Math.max(0, Math.round(Number((hit && hit.serviceCents) || row.sourceServiceCents) || 0)) ||
            null,
          sourceSurchargeCents:
            Math.max(
              0,
              Math.round(Number((hit && hit.surchargeCents) || row.sourceSurchargeCents) || 0)
            ) || null,
        };
      }
      return raw;
    }
    const memberName = nameByUid.get(memberUid) || "Team member";
    const isCredit = row.isCredit !== false && (Number(row.net) || 0) >= 0;
    const sourceGross = Math.max(
      0,
      Math.round(Number((hit && hit.grossCents) || row.sourceGrossCents) || 0)
    );
    const sourceService = Math.max(
      0,
      Math.round(Number((hit && hit.serviceCents) || row.sourceServiceCents) || 0)
    );
    const sourceSurcharge = Math.max(
      0,
      Math.round(Number((hit && hit.surchargeCents) || row.sourceSurchargeCents) || 0)
    );
    return {
      ...row,
      type: "studio_share",
      purpose: "studio_payment_split",
      description: "Studio share",
      attributedMemberUid: memberUid,
      attributedMemberName: memberName,
      studioShareDirection: isCredit ? "from_member" : "to_studio",
      sourceGrossCents: sourceGross || null,
      sourceServiceCents: sourceService || null,
      sourceSurchargeCents: sourceSurcharge || null,
    };
  });
}

async function ledgerStudioShareRowsForPayCtx(db, payCtx, { startTs, endTs, limit }) {
  const tenantId = (payCtx && payCtx.tenantId) || "";
  if (!tenantId) return [];
  const uid = (payCtx && payCtx.uid) || "";
  const scope = (payCtx && payCtx.scope) || "";
  const isOwner = payCtx && (payCtx.isOwner === true || scope === "tenant");

  // Owner: synthetic credits (Stripe BTs are often unlabeled "payment").
  // Member: synthetic debits (Stripe may not show the outbound transfer on their feed).
  if (!isOwner && (scope !== "user" || !uid)) return [];

  const ledger = await loadTransferredStudioShareLedger(db, tenantId, {
    limit: Math.min(Math.max(limit || 40, 1), 80),
  });

  let ownerUid = "";
  try {
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    ownerUid = tenantSnap.exists
      ? ((tenantSnap.data() || {}).ownerUid || "").toString().trim()
      : "";
  } catch (_) {
    ownerUid = "";
  }

  const memberUids = [
    ...new Set(
      ledger
        .map((d) => (d.attributedMemberUid || "").toString().trim())
        .filter((id) => id && (!ownerUid || id !== ownerUid))
    ),
  ];
  if (!isOwner && uid) memberUids.push(uid);
  const nameByUid = await resolveMemberNamesByUid(db, memberUids);

  const rows = [];
  for (const d of ledger) {
    const share = Math.max(0, Math.round(Number(d.studioServiceShareCents) || 0));
    if (share <= 0) continue;
    if ((d.chargeStripeScope || "").toString() !== "user") continue;
    const attributed = (d.attributedMemberUid || "").toString().trim();
    if (!attributed || (ownerUid && attributed === ownerUid)) continue;

    if (!isOwner && attributed !== uid) continue;

    let createdSec = 0;
    if (d.studioShareSettledAt && typeof d.studioShareSettledAt.toMillis === "function") {
      createdSec = Math.floor(d.studioShareSettledAt.toMillis() / 1000);
    } else if (d.createdAt && typeof d.createdAt.toMillis === "function") {
      createdSec = Math.floor(d.createdAt.toMillis() / 1000);
    }
    if (
      typeof startTs === "number" &&
      startTs > 0 &&
      createdSec > 0 &&
      createdSec < startTs
    ) {
      continue;
    }
    if (
      typeof endTs === "number" &&
      endTs > 0 &&
      createdSec > 0 &&
      createdSec > endTs
    ) {
      continue;
    }

    const transferId = (d.studioShareTransferId || d.id).toString();
    const memberName = nameByUid.get(attributed) || "Team member";
    const sourceGross = Math.max(0, Math.round(Number(d.grossCents) || 0)) || null;
    const sourceService = Math.max(0, Math.round(Number(d.serviceCents) || 0)) || null;
    const sourceSurcharge = Math.max(0, Math.round(Number(d.surchargeCents) || 0)) || null;

    if (isOwner) {
      rows.push({
        id: `studio_share_in_${transferId}`,
        type: "studio_share",
        amount: share,
        fee: 0,
        net: share,
        isCredit: true,
        created: createdSec,
        description: "Studio share",
        reportingCategory: "transfer",
        sourceId: d.studioShareTransferId || null,
        chargeId: d.chargeId || null,
        purpose: "studio_payment_split",
        attributedMemberUid: attributed,
        attributedMemberName: memberName,
        studioShareDirection: "from_member",
        sourceGrossCents: sourceGross,
        sourceServiceCents: sourceService,
        sourceSurchargeCents: sourceSurcharge,
      });
    } else {
      rows.push({
        id: `studio_share_out_${transferId}`,
        type: "studio_share",
        amount: -share,
        fee: 0,
        net: -share,
        isCredit: false,
        created: createdSec,
        description: "Studio share",
        reportingCategory: "transfer",
        sourceId: d.paymentIntentId || null,
        chargeId: d.chargeId || null,
        purpose: "studio_payment_split",
        attributedMemberUid: uid,
        attributedMemberName: nameByUid.get(uid) || "You",
        studioShareDirection: "to_studio",
        sourceGrossCents: sourceGross,
        sourceServiceCents: sourceService,
        sourceSurchargeCents: sourceSurcharge,
      });
    }
  }
  return rows;
}

/**
 * Reverse (pro-rata) a settled studio-share transfer after a customer refund.
 */
async function reverseStudioShareOnRefund(
  stripe,
  {
    db,
    tenantId,
    chargeId,
    paymentIntentId,
    refundCents,
    chargeCapturedCents,
    refundId,
  }
) {
  const tid = (tenantId || "").toString().trim();
  if (!tid || !stripe) return { reversed: false, reason: "missing_tenant" };

  let ledgerRef = null;
  let ledgerData = null;
  const piId = (paymentIntentId || "").toString().trim();
  if (piId) {
    ledgerRef = db.collection("tenants").doc(tid).collection("paymentLedger").doc(piId);
    const snap = await ledgerRef.get();
    if (snap.exists) ledgerData = snap.data() || {};
  }
  if (!ledgerData && chargeId) {
    const q = await db
      .collection("tenants")
      .doc(tid)
      .collection("paymentLedger")
      .where("chargeId", "==", chargeId)
      .limit(1)
      .get();
    if (!q.empty) {
      ledgerRef = q.docs[0].ref;
      ledgerData = q.docs[0].data() || {};
    }
  }
  if (!ledgerRef || !ledgerData) {
    return { reversed: false, reason: "no_ledger" };
  }
  if (ledgerData.studioShareStatus !== "transferred") {
    return { reversed: false, reason: "not_transferred" };
  }
  const transferId = (ledgerData.studioShareTransferId || "").toString().trim();
  if (!transferId) {
    return { reversed: false, reason: "no_transfer_id" };
  }

  const studioShare = Math.max(
    0,
    Math.round(Number(ledgerData.studioServiceShareCents) || 0)
  );
  const alreadyReversed = Math.max(
    0,
    Math.round(Number(ledgerData.studioShareReversedCents) || 0)
  );
  const remainingShare = Math.max(0, studioShare - alreadyReversed);
  if (remainingShare <= 0) {
    return { reversed: false, reason: "already_fully_reversed" };
  }

  const captured = Math.max(
    1,
    Math.round(Number(chargeCapturedCents) || 0) || studioShare
  );
  const refunded = Math.max(0, Math.round(Number(refundCents) || 0));
  let reverseCents = Math.round((remainingShare * refunded) / captured);
  if (refunded >= captured) reverseCents = remainingShare;
  reverseCents = Math.min(remainingShare, Math.max(0, reverseCents));
  if (reverseCents <= 0) {
    return { reversed: false, reason: "zero_reverse" };
  }

  const idempotencyKey = (
    `studio-share-rev-${refundId || chargeId || piId}-${reverseCents}`
  ).slice(0, 255);

  try {
    const reversal = await stripe.transfers.createReversal(
      transferId,
      {
        amount: reverseCents,
        metadata: {
          purpose: "studio_payment_split_refund",
          tenantId: tid,
          chargeId: (chargeId || "").toString(),
          paymentIntentId: piId,
          refundId: (refundId || "").toString(),
        },
      },
      { idempotencyKey }
    );
    const newReversed = alreadyReversed + reverseCents;
    await ledgerRef.set(
      {
        studioShareReversedCents: newReversed,
        studioShareStatus:
          newReversed >= studioShare ? "reversed" : "transferred",
        studioShareLastReversalId: reversal.id,
        studioShareReversedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      reversed: true,
      reverseCents,
      reversalId: reversal.id,
    };
  } catch (err) {
    console.error("reverseStudioShareOnRefund", transferId, err.message);
    await ledgerRef.set(
      {
        studioShareReverseError: (err.message || "reverse_failed")
          .toString()
          .slice(0, 500),
        studioShareUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { reversed: false, reason: "stripe_error", error: err.message };
  }
}

/**
 * Retry failed studio-share transfers (scheduled / manual).
 */
async function retryFailedStudioShareSettlements(
  stripe,
  {
    db,
    normalizeSubscriptionPlan,
    limit = 25,
  }
) {
  const snap = await db
    .collectionGroup("paymentLedger")
    .where("studioShareStatus", "==", "failed")
    .limit(Math.min(Math.max(limit, 1), 50))
    .get();

  const results = [];
  for (const doc of snap.docs) {
    const ledgerData = doc.data() || {};
    const tenantId = doc.ref.parent.parent && doc.ref.parent.parent.id;
    if (!tenantId) continue;
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) continue;
    const tenant = tenantSnap.data() || {};
    try {
      const settle = await settleStudioPaymentSplit(stripe, {
        tenant,
        tenantId,
        ledgerRef: doc.ref,
        ledgerData,
        chargeStripeScope: ledgerData.chargeStripeScope || "user",
        paymentIntentId: ledgerData.paymentIntentId || doc.id,
        chargeId: ledgerData.chargeId || null,
        normalizeSubscriptionPlan,
      });
      results.push({
        tenantId,
        ledgerId: doc.id,
        status: settle.studioShareStatus,
      });
    } catch (err) {
      results.push({
        tenantId,
        ledgerId: doc.id,
        status: "error",
        error: err.message,
      });
    }
  }
  return { attempted: results.length, results };
}

module.exports = {
  isTeamSplitPlan,
  memberUsesOwnConnect,
  buildTeamSplitFeeAndMeta,
  settleStudioPaymentSplit,
  recordAndSettleTenantPayment,
  reverseStudioShareOnRefund,
  retryFailedStudioShareSettlements,
  labelStudioShareBalanceTransaction,
  attachStudioShareAttribution,
  ledgerStudioShareRowsForPayCtx,
};
