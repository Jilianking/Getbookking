/**
 * Booking requests, status changes, booking triggers.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  admin,
  Stripe,
  sms,
  stripeSecretKey,
  db,
  isUnsettledRefundError,
  refundBookingPaymentIfNeeded,
  cancelRefundPatchFromResult,
  collectDeviceTokensForUids,
  resolveBookingAlertRecipientUids,
  sendBookingAlertPush,
  bookingRequestAlertCopy,
  bookingCancelledAlertCopy,
  DEFAULT_TENANT_WORKFLOW,
  applyCharterBookingWorkflow,
  bookingRequiresApproval,
  canApproveRejectBookingRequests,
  managersApproveAppointments,
  getMemberAccessContext,
  SEED_CONFIRM,
  writeSeedBookingRequests,
  sendBookingClientStatusSms,
} = require("./core");

/**
 * FCM push to provider devices when a booking request is created (web or app).
 * iOS stores tokens under users/{uid}/deviceTokens/{hash} (see PushNotificationManager.swift).
 */
exports.onTenantBookingRequestCreated = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .firestore.document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onCreate(async (snap, context) => {
    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const data = snap.data() || {};
    const source = (data.source || "").toString().trim().toLowerCase();
    if (source === "seed") return null;

    const { title, body } = bookingRequestAlertCopy(data);

    const recipientUids = await resolveBookingAlertRecipientUids(
      tenantId,
      data,
      "onNewBooking"
    );
    const tokens = await collectDeviceTokensForUids(recipientUids);
    await sendBookingAlertPush({
      tokens,
      title,
      body,
      data: {
        type: "booking_request",
        tenantId: String(tenantId),
        requestId: String(requestId),
      },
    });
    const status = (data.status || "").toString().toLowerCase();
    if (status === "confirmed" || status === "declined" || status === "new") {
      await sendBookingClientStatusSms(tenantId, requestId, data, status);
    }
    return null;
  });

/**
 * FCM when a booking is cancelled (respects managerNotifications.onCancellation).
 */
exports.onTenantBookingRequestUpdated = functions.firestore
  .document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const prev = (before.status || "").toString().trim().toLowerCase();
    const next = (after.status || "").toString().trim().toLowerCase();
    if (prev === next) return null;
    if (next !== "cancelled" && next !== "canceled") return null;

    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const source = (after.source || "").toString().trim().toLowerCase();
    if (source === "seed") return null;

    const { title, body } = bookingCancelledAlertCopy(after);

    const recipientUids = await resolveBookingAlertRecipientUids(
      tenantId,
      after,
      "onCancellation"
    );
    const tokens = await collectDeviceTokensForUids(recipientUids);
    await sendBookingAlertPush({
      tokens,
      title,
      body,
      data: {
        type: "booking_cancelled",
        tenantId: String(tenantId),
        requestId: String(requestId),
      },
    });
    return null;
  });

/** Owner-only: business-wide booking mode + confirmation policy (Settings). */
exports.updateTenantBookingWorkflow = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can change booking confirmation settings."
    );
  }
  const existingWf =
    ctx.tenant && ctx.tenant.workflow && typeof ctx.tenant.workflow === "object"
      ? { ...ctx.tenant.workflow }
      : {};
  const managersApprove =
    data && data.managersApproveAppointments != null
      ? Boolean(data.managersApproveAppointments)
      : managersApproveAppointments(existingWf);

  const workflow = {
    ...existingWf,
    managersApproveAppointments: managersApprove,
  };

  if (data && data.bookingMode != null) {
    const modeRaw = (data.bookingMode || "").toString().trim().toLowerCase();
    const modeAllowed = [
      "form",
      "calendar_slots",
      "calendar",
      "slots",
      "slot_booking",
      "inquiry",
      "request",
    ];
    if (!modeAllowed.includes(modeRaw)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid booking mode.");
    }
    workflow.bookingMode =
      modeRaw === "form" || modeRaw === "inquiry" || modeRaw === "request"
        ? "form"
        : "calendar_slots";
  }

  if (data && data.confirmationType != null) {
    const confirmationType = (data.confirmationType || "").toString().trim().toLowerCase();
    const allowed = [
      "instant_book",
      "request_approve",
      "deposit_to_confirm",
      "approve_and_deposit",
      "consultation_first",
      "pay_in_full",
    ];
    if (!allowed.includes(confirmationType)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid confirmation type.");
    }
    // When owner does not set team type, still allow writing type for solo/calendar default policy.
    if (managersApprove || workflow.bookingMode === "calendar_slots" || data.bookingMode != null) {
      workflow.confirmationType = confirmationType;
    }
    if (data.depositAmount != null && !Number.isNaN(Number(data.depositAmount))) {
      const dep = Number(data.depositAmount);
      if (dep > 0) workflow.depositAmount = dep;
      else delete workflow.depositAmount;
    }
  }

  if (data && data.charterBookBy != null) {
    const bookBy = (data.charterBookBy || "").toString().trim().toLowerCase();
    if (bookBy === "boat" || bookBy === "boats" || bookBy === "fleet") {
      workflow.charterBookBy = "boat";
    } else if (bookBy === "location" || bookBy === "one_location" || bookBy === "") {
      workflow.charterBookBy = "location";
    } else {
      throw new functions.https.HttpsError("invalid-argument", "Invalid charter book-by mode.");
    }
  }

  if (data && data.charterBufferMinutes != null) {
    const buf = Number(data.charterBufferMinutes);
    if (!Number.isFinite(buf) || buf < 0) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid buffer between trips.");
    }
    workflow.charterBufferMinutes = Math.min(240, Math.round(buf));
  }

  if (data && data.charterLastBookingMin != null) {
    const lastBook = Number(data.charterLastBookingMin);
    if (!Number.isFinite(lastBook) || lastBook < 0) {
      delete workflow.charterLastBookingMin;
    } else {
      workflow.charterLastBookingMin = Math.min(24 * 60, Math.round(lastBook));
    }
  }

  applyCharterBookingWorkflow(ctx.tenant, workflow);

  const resolvedBookingMode =
    workflow.bookingMode || existingWf.bookingMode || DEFAULT_TENANT_WORKFLOW.bookingMode || "form";
  workflow.bookingMode = resolvedBookingMode;

  // workflow.bookingMode is authoritative for /book; top-level bookingMode mirrors for simple clients.
  await db.collection("tenants").doc(ctx.tenantId).update({
    workflow,
    bookingMode: resolvedBookingMode,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const userWorkflow = {
    managersApproveAppointments: managersApprove,
    bookingMode: resolvedBookingMode,
  };
  if (workflow.confirmationType) {
    userWorkflow.confirmationType = workflow.confirmationType;
  }
  if (workflow.depositAmount != null && !Number.isNaN(Number(workflow.depositAmount))) {
    userWorkflow.depositAmount = Number(workflow.depositAmount);
  }
  if (workflow.charterBookBy) {
    userWorkflow.charterBookBy = workflow.charterBookBy;
  }
  if (workflow.charterBufferMinutes != null) {
    userWorkflow.charterBufferMinutes = workflow.charterBufferMinutes;
  }
  if (workflow.charterLastBookingMin != null) {
    userWorkflow.charterLastBookingMin = workflow.charterLastBookingMin;
  }
  await db.collection("users").doc(uid).set(
    {
      workflow: userWorkflow,
    },
    { merge: true }
  );
  const effectiveType =
    workflow.confirmationType || DEFAULT_TENANT_WORKFLOW.confirmationType;
  return {
    ok: true,
    bookingRequiresApproval: bookingRequiresApproval(effectiveType),
    managersApproveAppointments: managersApprove,
    bookingMode: resolvedBookingMode,
    charterBookBy: workflow.charterBookBy || null,
    charterBufferMinutes:
      workflow.charterBufferMinutes != null ? workflow.charterBufferMinutes : null,
    charterLastBookingMin:
      workflow.charterLastBookingMin != null ? workflow.charterLastBookingMin : null,
  };
});

/** Approve / decline / cancel booking request status with permission checks. */
exports.updateBookingRequestStatus = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const requestId = ((data && data.requestId) || "").toString().trim();
  const status = ((data && data.status) || "").toString().trim().toLowerCase();
  if (!requestId || !status) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "requestId and status are required."
    );
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  let normalized = status.toLowerCase();
  if (normalized === "approved") normalized = "confirmed";
  if (normalized === "rejected") normalized = "declined";
  if (normalized === "canceled") normalized = "cancelled";

  const reqRef = db
    .collection("tenants")
    .doc(ctx.tenantId)
    .collection("bookingRequests")
    .doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Booking request not found.");
  }
  const reqData = reqSnap.data() || {};
  const assignedUid = (reqData.assignedMemberUid || "").toString().trim();
  const assignedToSelf = Boolean(assignedUid && assignedUid === ctx.uid);
  // View-all is visibility only — approve/reject uses explicit permission (or assignee).
  const canShopWide = ctx.isOwner || canApproveRejectBookingRequests(ctx);
  if (!canShopWide && !assignedToSelf) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to update this booking request."
    );
  }

  const patch = {
    status: normalized,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (data && data.notes != null) {
    patch.notes = (data.notes || "").toString().trim().slice(0, 4000);
  }
  await reqRef.set(patch, { merge: true });

  let refunded = false;
  let alreadyRefunded = false;
  let refundError = null;
  let refundCents = 0;
  if (normalized === "cancelled") {
    const secretKey = stripeSecretKey.value();
    if (secretKey) {
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const refundResult = await refundBookingPaymentIfNeeded({
        stripe,
        tenant: ctx.tenant,
        tenantId: ctx.tenantId,
        booking: reqData,
        requestId,
      });
      refunded = !!refundResult.refunded;
      alreadyRefunded = !!refundResult.alreadyRefunded;
      refundError = refundResult.refundError || null;
      refundCents = refundResult.refundCents || 0;
      const refundPending = !!refundResult.refundPending;
      const refundPatch = cancelRefundPatchFromResult(refundResult);
      if (refundPatch) {
        await reqRef.set(refundPatch, { merge: true });
      }
      return {
        ok: true,
        status: normalized,
        refunded,
        alreadyRefunded,
        refundPending,
        refundCents,
        refundError: refundPending ? null : refundError,
      };
    }
  }

  return {
    ok: true,
    status: normalized,
    refunded,
    alreadyRefunded,
    refundPending: false,
    refundCents,
    refundError,
  };
});

/** Retry queued cancel refunds once original charges have settled. */
exports.retryPendingBookingRefunds = functions
  .runWith({ secrets: [stripeSecretKey] })
  .pubsub.schedule("every 30 minutes")
  .onRun(async () => {
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      console.warn("retryPendingBookingRefunds: no Stripe secret");
      return null;
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const pendingSnap = await db
      .collectionGroup("bookingRequests")
      .where("cancelRefundStatus", "==", "pending")
      .limit(40)
      .get();
    const failedSnap = await db
      .collectionGroup("bookingRequests")
      .where("cancelRefundStatus", "==", "failed")
      .limit(40)
      .get();
    const seen = new Set();
    const docs = [];
    for (const doc of [...pendingSnap.docs, ...failedSnap.docs]) {
      if (seen.has(doc.ref.path)) continue;
      seen.add(doc.ref.path);
      docs.push(doc);
    }
    let retried = 0;
    let refunded = 0;
    let stillPending = 0;
    for (const doc of docs) {
      const d = doc.data() || {};
      const status = (d.status || "").toString().trim().toLowerCase();
      if (status !== "cancelled" && status !== "canceled") continue;
      const refundStatus = (d.cancelRefundStatus || "").toString().trim().toLowerCase();
      if (refundStatus === "pending" && !d.cancelRefundQueuedAt) {
        console.warn(
          "retryPendingBookingRefunds skip pending without queue timestamp",
          doc.ref.path
        );
        continue;
      }
      if (refundStatus === "failed" && !isUnsettledRefundError({ message: d.cancelRefundError })) {
        continue;
      }
      const tenantRef = doc.ref.parent.parent;
      const tenantId = tenantRef ? tenantRef.id : "";
      if (!tenantId) continue;
      retried += 1;
      let tenant = {};
      try {
        const tenantSnap = await tenantRef.get();
        tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};
      } catch (e) {
        console.error("retryPendingBookingRefunds tenant", doc.ref.path, e.message || e);
        continue;
      }
      const refundResult = await refundBookingPaymentIfNeeded({
        stripe,
        tenant,
        tenantId,
        booking: d,
        requestId: doc.id,
      });
      const patch = cancelRefundPatchFromResult(refundResult);
      if (patch) {
        await doc.ref.set(patch, { merge: true });
      }
      if (refundResult.refunded || refundResult.alreadyRefunded) refunded += 1;
      else if (refundResult.refundPending) stillPending += 1;
    }
    return { retried, refunded, stillPending };
  });

/**
 * Owner-only: bulk-insert test booking requests (source "seed", no FCM spam).
 * Callable from DEBUG UI or: confirm must be SEED_BOOKING_REQUESTS.
 */
exports.seedTenantBookingRequests = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const confirm = (data && data.confirm ? data.confirm : "").toString();
  if (confirm !== SEED_CONFIRM) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `confirm must be "${SEED_CONFIRM}".`
    );
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can seed test booking requests."
    );
  }
  const rawCount = data && data.count != null ? Number(data.count) : 100;
  const count = Number.isFinite(rawCount) ? rawCount : 100;
  const { written, tenantId } = await writeSeedBookingRequests(
    db,
    ctx.tenantId,
    count,
    admin
  );
  return { ok: true, written, tenantId };
});
