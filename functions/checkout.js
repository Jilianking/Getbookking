/**
 * Website bookings, shop orders, deposit and charter checkout, shipping.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  shippoShop,
  platformFeeCents,
  computeCardCheckoutAmounts,
  checkoutMethodId,
  admin,
  Stripe,
  charterOccupancy,
  stripeSecretKey,
  stripePublishableKeyParam,
  db,
  normalizeCustomerPhone,
  customerDocIdForTenant,
  normalizeSubscriptionPlan,
  isSingleOperatorPlan,
  createCustomerCheckoutPaymentIntent,
  pricedCustomerCheckoutFromMetadata,
  stripeAccountIdForCheckout,
  assertPublicPaymentAccessForTenant,
  terminalAddressFromTenant,
  charterParseTimeToMin,
  reserveCharterSlot,
  fetchTenantProductsById,
  validatedCharterAddons,
  calculateShopSalesTax,
  buildValidatedShopLineItems,
  resolvePublicShopTenant,
  assertTenantShopStripeReady,
  upsertShopCheckoutCustomer,
  markShopOrderPaidFromPaymentIntent,
  publicWebCallableOptions,
  checkoutMethodFromPaymentMethod,
  publicShopCallableOptions,
  readShippoTokenOrThrow,
  resolvePublicCharterTenant,
  charterServicePriceCents,
  charterPayModeFromTenant,
  loadCharterServiceDoc,
  markCharterBookingPaidFromPaymentIntent,
  getMemberAccessContext,
  normalizeMemberSlugInput,
  attachAssignedMemberToBookingData,
  pickMemberForFirstAvailable,
  resolveTenantBySlug,
  stripeErrorMessage,
} = require("./core");

/**
 * Creates a booking request from the public web form. No auth required.
 * Params: { tenantSlug, memberSlug?, customerName, customerEmail, customerPhone?, serviceId?, serviceSlug?, serviceName?, preferredTime?, preferredDays?, notes? }
 */
exports.createBookingRequestFromWeb = functions.https.onCall(async (data, context) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  const customerName = (data?.customerName || "").toString().trim();
  const customerEmail = (data?.customerEmail || "").toString().trim().toLowerCase();

  if (!tenantSlug || !customerName || !customerEmail) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "tenantSlug, customerName, and customerEmail are required"
    );
  }
  if (customerName.length > 200 || customerEmail.length > 320) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Name or email is too long"
    );
  }
  if (customerEmail.indexOf("@") <= 0) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "A valid customerEmail is required"
    );
  }

  const resolvedTenant = await resolveTenantBySlug(tenantSlug);
  if (!resolvedTenant) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenantId = resolvedTenant.id;
  const tenantData = resolvedTenant.data;
  if (tenantData.isActive === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting bookings"
    );
  }
  if (tenantData.isDemoAccount === true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This demo site is read-only. Sign up for your own account to accept bookings."
    );
  }

  const customerPhone = normalizeCustomerPhone(data?.customerPhone);
  const smsConsentAccepted = data?.smsConsentAccepted === true;
  const isCharterPlan = normalizeSubscriptionPlan(tenantData.subscriptionPlan) === "charter";
  if (isCharterPlan && (!customerPhone || !smsConsentAccepted)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "A mobile number and SMS consent are required for charter bookings."
    );
  }
  if (customerPhone && !smsConsentAccepted) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "SMS consent is required when providing a phone number."
    );
  }
  const serviceId = data?.serviceId ? data.serviceId.toString() : null;
  const serviceSlug = data?.serviceSlug ? data.serviceSlug.toString() : null;
  const serviceName = data?.serviceName ? data.serviceName.toString() : null;
  const preferredTime = data?.preferredTime ? data.preferredTime.toString().trim() : null;
  const preferredDays = (() => {
    if (Array.isArray(data?.preferredDays)) {
      const arr = data.preferredDays
        .map((d) => (d || "").toString().trim())
        .filter(Boolean);
      return arr.length ? arr : null;
    }
    if (typeof data?.preferredDays === "string") {
      const parts = data.preferredDays
        .split(",")
        .map((x) => (x || "").toString().trim())
        .filter(Boolean);
      return parts.length ? parts : null;
    }
    return null;
  })();
  const notes = data?.notes ? data.notes.toString().trim().slice(0, 4000) : null;

  const bookingData = {
    status: "NEW",
    source: "web",
    tenantId,
    customerName,
    customerEmail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (customerPhone) bookingData.customerPhone = customerPhone;
  if (customerPhone && smsConsentAccepted) {
    bookingData.smsConsentAccepted = true;
    bookingData.smsConsentAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (serviceId) bookingData.serviceId = serviceId;
  if (serviceSlug) bookingData.serviceSlug = serviceSlug;
  if (serviceName) bookingData.serviceName = serviceName;
  if (preferredTime) bookingData.preferredTime = preferredTime;
  const startMin = charterParseTimeToMin(preferredTime);
  if (startMin != null) bookingData.scheduledStartMin = startMin;
  if (preferredDays) bookingData.preferredDays = preferredDays;
  if (notes) bookingData.notes = notes;
  const partySize = parseInt(String(data?.partySize ?? ""), 10);
  if (Number.isFinite(partySize) && partySize > 0) bookingData.partySize = partySize;
  const durationMinutes = parseInt(String(data?.durationMinutes ?? ""), 10);
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
    bookingData.durationMinutes = durationMinutes;
  }
  const scheduledDate = (data?.scheduledDate || "").toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) bookingData.scheduledDate = scheduledDate;

  const memberSlug = normalizeMemberSlugInput(data?.memberSlug);
  if (memberSlug) {
    const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
    if (isSingleOperatorPlan(plan)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Team member booking pages are not available on this plan."
      );
    }
    const memberSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .where("memberSlug", "==", memberSlug)
      .limit(1)
      .get();
    if (memberSnap.empty) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const memberDoc = memberSnap.docs[0];
    const memberData = memberDoc.data();
    if (memberData.isBookable === false) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This team member is not accepting bookings online."
      );
    }
    attachAssignedMemberToBookingData(bookingData, memberDoc);
  } else {
    const assignmentPreference = (data?.assignmentPreference || "")
      .toString()
      .trim()
      .toLowerCase();
    const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
    if (assignmentPreference === "first_available" && !isSingleOperatorPlan(plan)) {
      const picked = await pickMemberForFirstAvailable(tenantId, tenantData);
      if (picked) {
        attachAssignedMemberToBookingData(bookingData, picked);
        bookingData.assignmentPreference = "first_available";
      }
    }
  }

  if (data?.formResponses && typeof data.formResponses === "object") {
    const fr = { ...data.formResponses };
    if (fr.phone != null) {
      const normalized = normalizeCustomerPhone(fr.phone);
      if (normalized) fr.phone = normalized;
    }
    bookingData.formResponses = fr;
  }

  const boatFilterId = (data?.boatId || data?.boat || "").toString().trim();
  let ref;
  if (isCharterPlan) {
    const responseHoursRaw = Number(
      tenantData.workflow && tenantData.workflow.responseTimeHours
    );
    const responseHours =
      Number.isFinite(responseHoursRaw) && responseHoursRaw > 0
        ? Math.min(168, Math.max(1, responseHoursRaw))
        : 24;
    bookingData.requestExpiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + responseHours * 60 * 60 * 1000
    );
    bookingData.requestResponseHours = responseHours;
    ref = await reserveCharterSlot(tenantId, tenantData, bookingData, {
      paymentHold: false,
      boatFilterId,
    });
  } else {
    ref = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .add(bookingData);
  }

  const customerRef = db
    .collection("tenants")
    .doc(tenantId)
    .collection("customers")
    .doc(customerDocIdForTenant(customerName, customerEmail, customerPhone));
  await customerRef.set(
    {
      name: customerName,
      email: customerEmail,
      ...(customerPhone ? { phone: customerPhone } : {}),
      ...(customerPhone && smsConsentAccepted
        ? {
            smsOptedIn: true,
            smsConsentAt: admin.firestore.FieldValue.serverTimestamp(),
            smsConsentSource: "web_booking",
          }
        : {}),
      source: "booking_request_web",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { requestId: ref.id };
});

/**
 * App walk-in / confirm / reschedule: same hull occupancy as the website.
 * Charter plan only. Writes scheduledDate, scheduledStartMin, boatId, occ window, requestedStartTime.
 */
exports.syncCharterBookingSlot = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan) !== "charter") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Charter occupancy is only for Boat / Fishing charter."
    );
  }
  const requestId = ((data && data.requestId) || "").toString().trim();
  const col = db.collection("tenants").doc(ctx.tenantId).collection("bookingRequests");
  let existing = {};
  let bookingRef;
  if (requestId) {
    bookingRef = col.doc(requestId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Booking not found.");
    }
    existing = snap.data() || {};
  } else {
    bookingRef = col.doc();
  }

  const preferredTime = (
    (data && data.preferredTime) ||
    existing.preferredTime ||
    ""
  )
    .toString()
    .trim();
  let startMin =
    data && data.scheduledStartMin != null && Number.isFinite(Number(data.scheduledStartMin))
      ? Number(data.scheduledStartMin)
      : charterParseTimeToMin(preferredTime);
  if (startMin == null && existing.scheduledStartMin != null) {
    startMin = Number(existing.scheduledStartMin);
  }
  let scheduledDate = ((data && data.scheduledDate) || existing.scheduledDate || "")
    .toString()
    .trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    throw new functions.https.HttpsError("invalid-argument", "Pick a date and departure time.");
  }
  const durRaw = data && data.durationMinutes != null ? Number(data.durationMinutes) : Number(existing.durationMinutes);
  const dur = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 240;

  const bookingData = { ...existing };
  delete bookingData.id;
  bookingData.tenantId = ctx.tenantId;
  bookingData.source = existing.source || "admin_app";
  bookingData.scheduledDate = scheduledDate;
  bookingData.scheduledStartMin = startMin;
  bookingData.durationMinutes = dur;
  bookingData.preferredDays = [scheduledDate];
  if (preferredTime) bookingData.preferredTime = preferredTime;
  const startDate = charterOccupancy.instantFromIsoAndMin(
    scheduledDate,
    startMin,
    charterOccupancy.tenantTimeZone(ctx.tenant)
  );
  if (startDate) {
    bookingData.requestedStartTime = admin.firestore.Timestamp.fromDate(startDate);
  }
  const customerName = data && data.customerName != null ? String(data.customerName).trim() : "";
  if (customerName) bookingData.customerName = customerName;
  const customerEmail = data && data.customerEmail != null ? String(data.customerEmail).trim() : "";
  if (customerEmail) bookingData.customerEmail = customerEmail;
  if (data && data.customerPhone != null) {
    const phone = normalizeCustomerPhone(data.customerPhone);
    if (phone) bookingData.customerPhone = phone;
  }
  if (data && data.serviceId) bookingData.serviceId = String(data.serviceId).trim();
  if (data && data.serviceSlug) bookingData.serviceSlug = String(data.serviceSlug).trim();
  if (data && data.serviceName) bookingData.serviceName = String(data.serviceName).trim();
  if (data && data.notes != null) {
    const notes = String(data.notes).trim();
    if (notes) bookingData.notes = notes.slice(0, 4000);
  }
  if (data && data.partySize != null && Number.isFinite(Number(data.partySize))) {
    bookingData.partySize = Number(data.partySize);
  }
  if (data && data.status) {
    bookingData.status = String(data.status).trim().toLowerCase() || bookingData.status;
  }
  if (!bookingData.status) bookingData.status = requestId ? "NEW" : "confirmed";
  if (data && data.assignedMemberUid) {
    bookingData.assignedMemberUid = String(data.assignedMemberUid).trim();
    if (data.assignedMemberName) bookingData.assignedMemberName = String(data.assignedMemberName).trim();
    if (data.assignedMemberEmail) bookingData.assignedMemberEmail = String(data.assignedMemberEmail).trim();
  }
  if (!bookingData.createdAt) {
    bookingData.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await reserveCharterSlot(ctx.tenantId, ctx.tenant, bookingData, {
    paymentHold: false,
    boatFilterId: ((data && (data.boatId || data.boat)) || "").toString().trim(),
    bookingRef,
  });

  return {
    ok: true,
    requestId: bookingRef.id,
    boatId: bookingData.boatId || "",
  };
});

/** Public occupancy for charter search (no PII). Slots by trip date + assigned boat. */
exports.listPublicCharterOccupancy = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required");
  }
  const resolvedTenant = await resolveTenantBySlug(tenantSlug);
  if (!resolvedTenant) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenantDocId = resolvedTenant.id;
  const tenantData = resolvedTenant.data || {};
  const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
  if (plan !== "charter") return { slots: [], holdMinutes: charterOccupancy.CHARTER_PAYMENT_HOLD_MINUTES };

  const now = new Date();
  const tz = charterOccupancy.tenantTimeZone(tenantData);
  const fromIso = charterOccupancy.isoDateInTz(now, tz);
  const toIso = charterOccupancy.addDaysToIso(
    fromIso,
    charterOccupancy.CHARTER_OCCUPANCY_HORIZON_DAYS
  );
  const queryFromIso = charterOccupancy.addDaysToIso(fromIso, -1) || fromIso;

  const col = db.collection("tenants").doc(tenantDocId).collection("bookingRequests");
  const nowMs = now.getTime();
  const slots = [];
  let lastDoc = null;
  let truncated = false;
  for (let page = 0; page < 20; page++) {
    let q = col
      .where("scheduledDate", ">=", queryFromIso)
      .where("scheduledDate", "<=", toIso)
      .orderBy("scheduledDate")
      .limit(400);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const d = doc.data() || {};
      d.id = doc.id;
      if (!charterOccupancy.rowStillOccupies(d, nowMs)) return;
      const pub = charterOccupancy.publicSlotsFromRow(
        d,
        charterOccupancy.charterBufferMinutes(tenantData)
      );
      for (let i = 0; i < pub.length; i++) {
        if (pub[i] && pub[i].date) slots.push(pub[i]);
      }
    });
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
    if (page === 19) truncated = true;
  }
  return {
    slots,
    holdMinutes: charterOccupancy.CHARTER_PAYMENT_HOLD_MINUTES,
    serverNowMs: nowMs,
    occupancyUntilIso: toIso,
    truncated,
  };
});

/** Drop unpaid charter checkout holds after CHARTER_PAYMENT_HOLD_MINUTES. */
exports.expireCharterPaymentHolds = functions
  .runWith({ secrets: [stripeSecretKey] })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collectionGroup("bookingRequests")
      .where("holdUntil", "<=", now)
      .limit(80)
      .get();
    let n = 0;
    const secretKey = stripeSecretKey.value();
    const stripe = secretKey ? new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" }) : null;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (!charterOccupancy.isPaymentHoldStatus(d.status)) continue;
      const piId = (d.stripePaymentIntentId || "").toString().trim();
      const acct = (d.chargeStripeAccountId || "").toString().trim();
      const tenantRef = doc.ref.parent.parent;
      const tenantId = tenantRef ? tenantRef.id : "";
      let pi = null;
      if (piId.startsWith("pi_")) {
        if (!stripe || !tenantId) {
          console.error("expireCharterPaymentHolds: cannot verify payment", doc.ref.path);
          continue;
        }
        try {
          const opts = acct ? { stripeAccount: acct } : undefined;
          pi = await stripe.paymentIntents.retrieve(piId, opts);
        } catch (retrieveErr) {
          console.error(
            "expireCharterPaymentHolds retrieve",
            piId,
            retrieveErr.message || retrieveErr
          );
          continue;
        }
        if (pi.status === "succeeded") {
          await markCharterBookingPaidFromPaymentIntent(
            stripe,
            tenantId,
            doc.id,
            piId,
            pi
          );
          continue;
        }
        if (pi.status === "processing") {
          await doc.ref.set(
            {
              holdUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
              holdExtendedForProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          continue;
        }
        if (pi.status !== "canceled") {
          try {
            const opts = acct ? { stripeAccount: acct } : undefined;
            pi = await stripe.paymentIntents.cancel(piId, opts);
          } catch (cancelErr) {
            try {
              const opts = acct ? { stripeAccount: acct } : undefined;
              pi = await stripe.paymentIntents.retrieve(piId, opts);
            } catch (_) {
              pi = null;
            }
            if (pi && pi.status === "succeeded") {
              await markCharterBookingPaidFromPaymentIntent(
                stripe,
                tenantId,
                doc.id,
                piId,
                pi
              );
            } else if (pi && pi.status === "processing") {
              await doc.ref.set(
                {
                  holdUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
                  holdExtendedForProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            } else {
              console.error(
                "expireCharterPaymentHolds cancel",
                piId,
                cancelErr.message || cancelErr
              );
            }
            continue;
          }
        }
      }
      let cancelled = false;
      await db.runTransaction(async (tx) => {
        const latestSnap = await tx.get(doc.ref);
        if (!latestSnap.exists) return;
        const latest = latestSnap.data() || {};
        if (!charterOccupancy.isPaymentHoldStatus(latest.status)) return;
        if (charterOccupancy.holdUntilMillis(latest) > Date.now()) return;
        const latestPi = (latest.stripePaymentIntentId || "").toString().trim();
        if (latestPi !== piId) return;
        tx.set(
          doc.ref,
          {
            status: "cancelled",
            cancelReason: "hold_expired",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            holdUntil: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
        cancelled = true;
      });
      if (cancelled) n += 1;
    }
    if (n) console.log("expireCharterPaymentHolds", n);
    return null;
  });

/** Release unanswered no-card charter requests after their configured response window. */
exports.expireCharterBookingRequests = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collectionGroup("bookingRequests")
      .where("requestExpiresAt", "<=", now)
      .limit(100)
      .get();
    let expired = 0;
    for (const doc of snap.docs) {
      let didExpire = false;
      await db.runTransaction(async (tx) => {
        const latestSnap = await tx.get(doc.ref);
        if (!latestSnap.exists) return;
        const latest = latestSnap.data() || {};
        const status = (latest.status || "").toString().trim().toLowerCase();
        if (status !== "new") return;
        const expiresAtMs =
          latest.requestExpiresAt && typeof latest.requestExpiresAt.toMillis === "function"
            ? latest.requestExpiresAt.toMillis()
            : 0;
        if (!expiresAtMs || expiresAtMs > Date.now()) return;
        tx.set(
          doc.ref,
          {
            status: "cancelled",
            cancelReason: "request_expired",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            requestExpiresAt: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
        didExpire = true;
      });
      if (didExpire) expired += 1;
    }
    if (expired) console.log("expireCharterBookingRequests", expired);
    return null;
  });

/**
 * Public web: create a shop order at checkout (cart + customer contact).
 * Params: { tenantSlug, lineItems, customerName, customerEmail, customerPhone?, notes? }
 */
exports.createShopOrderFromWeb = functions.https.onCall(async (data, context) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  const customerName = (data?.customerName || "").toString().trim();
  const customerEmail = (data?.customerEmail || "").toString().trim().toLowerCase();

  if (!tenantSlug || !customerName || !customerEmail) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "tenantSlug, customerName, and customerEmail are required"
    );
  }
  if (customerName.length > 200 || customerEmail.length > 320) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Name or email is too long"
    );
  }
  if (customerEmail.indexOf("@") <= 0) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "A valid customerEmail is required"
    );
  }

  const resolvedTenant = await resolveTenantBySlug(tenantSlug);
  if (!resolvedTenant) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenantId = resolvedTenant.id;
  const tenantData = resolvedTenant.data || {};
  if (tenantData.isActive === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting orders"
    );
  }
  if (tenantData.isDemoAccount === true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This demo site is read-only. Sign up for your own account to accept orders."
    );
  }
  if (tenantData.shopEnabled !== true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Shop is not enabled for this business"
    );
  }
  await assertPublicPaymentAccessForTenant(tenantId, tenantData);

  const rawLines = Array.isArray(data?.lineItems) ? data.lineItems : [];
  const productsById = await fetchTenantProductsById(tenantId);
  const { lineItems, subtotalCents } = buildValidatedShopLineItems(rawLines, productsById);

  const notes = data?.notes ? data.notes.toString().trim().slice(0, 4000) : null;
  const customerPhone = normalizeCustomerPhone(data?.customerPhone);
  const orderData = {
    status: "pending",
    source: "shop",
    tenantId,
    customerName,
    customerEmail,
    lineItems,
    subtotalCents,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (customerPhone) orderData.customerPhone = customerPhone;
  if (notes) orderData.notes = notes;

  const ref = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("shopOrders")
    .add(orderData);

  await upsertShopCheckoutCustomer(tenantId, customerName, customerEmail, customerPhone);

  return { orderId: ref.id, subtotalCents };
});

/**
 * Public checkout page for a deposit or manual payment link.
 * Params: { tenantSlug, paymentIntentId }
 */
exports.getDepositCheckout = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  const paymentIntentId = (data.paymentIntentId || "").toString().trim();
  if (!tenantSlug || !paymentIntentId.startsWith("pi_")) {
    throw new HttpsError("invalid-argument", "tenantSlug and paymentIntentId are required");
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) throw new HttpsError("not-found", "Business not found");
  const tenantData = resolved.data || {};
  const secretKey = stripeSecretKey.value();
  if (!secretKey) throw new HttpsError("failed-precondition", "Stripe is not configured");
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  const stripeAccountId = await stripeAccountIdForCheckout(resolved.id, tenantData, paymentIntentId);
  if (!stripeAccountId) {
    throw new HttpsError("failed-precondition", "This business is not accepting payments yet.");
  }
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    stripeAccount: stripeAccountId,
  });
  const meta = pi.metadata || {};
  if ((meta.tenantId || "") !== resolved.id) {
    throw new HttpsError("permission-denied", "This payment link is not for this business.");
  }
  const priced = pricedCustomerCheckoutFromMetadata(meta, meta.checkoutMethod || "card");
  const businessName = (tenantData.businessName || tenantData.displayName || "Payment").toString();
  const pk = stripePublishableKeyParam.value().trim();
  const paid = pi.status === "succeeded";
  return {
    paid,
    status: pi.status,
    businessName,
    productName: (meta.productName || "Payment").toString(),
    clientSecret: paid ? "" : pi.client_secret,
    publishableKey: pk,
    stripeAccountId,
    paymentIntentId: pi.id,
    serviceCents: priced ? priced.serviceCents : 0,
    surchargeCents: priced ? priced.surchargeCents : 0,
    totalCents: paid ? pi.amount : priced ? priced.totalCents : pi.amount,
    rateLabel: priced ? priced.rateLabel : "2.9% + 30¢",
    method: priced ? priced.method : "card",
  };
});

/**
 * Reprice an open customer PaymentIntent when they pick card, Klarna, Affirm, or a Link bank.
 * Params: { tenantSlug, paymentIntentId, method, paymentMethodId? }
 */
exports.repriceCustomerCheckout = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  const paymentIntentId = (data.paymentIntentId || "").toString().trim();
  const requested = checkoutMethodId(data.method);
  if (!tenantSlug || !paymentIntentId.startsWith("pi_")) {
    throw new HttpsError("invalid-argument", "tenantSlug and paymentIntentId are required");
  }
  if (requested === "card_present" || requested === "klarna" || requested === "affirm") {
    throw new HttpsError("invalid-argument", "That payment method cannot be repriced here.");
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) throw new HttpsError("not-found", "Business not found");
  const tenantData = resolved.data || {};
  const secretKey = stripeSecretKey.value();
  if (!secretKey) throw new HttpsError("failed-precondition", "Stripe is not configured");
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  const stripeAccountId = await stripeAccountIdForCheckout(resolved.id, tenantData, paymentIntentId);
  if (!stripeAccountId) {
    throw new HttpsError("failed-precondition", "This business is not accepting payments yet.");
  }
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    stripeAccount: stripeAccountId,
  });
  const meta = pi.metadata || {};
  if ((meta.tenantId || "") !== resolved.id) {
    throw new HttpsError("permission-denied", "This payment is not for this business.");
  }
  if (pi.status === "succeeded" || pi.status === "canceled") {
    throw new HttpsError("failed-precondition", "This payment can no longer be updated.");
  }
  const classified = await checkoutMethodFromPaymentMethod(
    stripe,
    stripeAccountId,
    data.paymentMethodId
  );
  const method = classified || requested;
  if (method === "klarna" || method === "affirm") {
    throw new HttpsError("invalid-argument", "That payment method cannot be repriced here.");
  }
  const priced = pricedCustomerCheckoutFromMetadata(meta, method);
  if (!priced) {
    throw new HttpsError("failed-precondition", "This payment is missing its service amount.");
  }
  const nextMeta = {
    ...meta,
    surchargeCents: String(priced.surchargeCents),
    checkoutMethod: priced.method,
    platformFeeCents: String(priced.platformFeeCents),
  };
  await stripe.paymentIntents.update(
    paymentIntentId,
    {
      amount: priced.totalCents,
      application_fee_amount: priced.applicationFeeCents,
      metadata: nextMeta,
    },
    { stripeAccount: stripeAccountId }
  );
  const shopOrderId = (meta.shopOrderId || "").toString().trim();
  if (shopOrderId && meta.paymentKind === "shop") {
    await db.collection("tenants").doc(resolved.id).collection("shopOrders").doc(shopOrderId).set(
      {
        surchargeCents: priced.surchargeCents,
        totalCents: priced.totalCents,
        checkoutMethod: priced.method,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  return priced;
});

/**
 * Public web: live Shippo rates for cart + destination address.
 * Params: { tenantSlug, lineItems, addressTo: { name, street1, street2?, city, state, zip, country?, phone?, email? } }
 */
exports.getShopShippingRates = onCall(publicShopCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new HttpsError("invalid-argument", "tenantSlug is required");
  }
  const { tenantId, tenantData } = await resolvePublicShopTenant(tenantSlug);
  if (tenantData.shopShippingEnabled !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Shipping is not enabled for this shop. Choose pickup or ask the studio to enable shipping."
    );
  }
  const token = readShippoTokenOrThrow();
  const rawLines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const productsById = await fetchTenantProductsById(tenantId);
  const { lineItems } = buildValidatedShopLineItems(rawLines, productsById);
  const defaults = tenantData.shopDefaultParcel && typeof tenantData.shopDefaultParcel === "object"
    ? tenantData.shopDefaultParcel
    : {};
  const parcel = shippoShop.buildParcelFromProducts(lineItems, productsById, defaults);
  const addressFrom = shippoShop.shipFromAddressFromTenant(tenantData, terminalAddressFromTenant);
  let addressTo;
  try {
    addressTo = shippoShop.normalizeShipAddress(
      data.addressTo,
      (data.customerName || "").toString().trim() || "Customer"
    );
  } catch (addrErr) {
    throw new HttpsError("invalid-argument", addrErr.message || "Invalid shipping address");
  }
  try {
    const result = await shippoShop.createShipmentRates(token, {
      addressFrom,
      addressTo,
      parcel,
    });
    if (!result.rates.length) {
      throw new HttpsError(
        "failed-precondition",
        "No shipping rates available for this address. Try a different address or choose pickup."
      );
    }
    return {
      shipmentId: result.shipmentId,
      rates: result.rates,
      parcel,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("getShopShippingRates", err);
    throw new HttpsError(
      "failed-precondition",
      err.message || "Could not get shipping rates"
    );
  }
});

/**
 * Public web: create shop order + Stripe PaymentIntent for embedded checkout.
 * Params: { tenantSlug, lineItems, customerName, customerEmail, customerPhone?, notes?,
 *   fulfillmentMethod?: 'pickup'|'shipping', shippoRateId?, shippoShipmentId?, shippingAddress? }
 */
exports.createShopCheckoutPayment = onCall(publicShopCallableOptions, async (request) => {
    const data = request.data;
    try {
    const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();

    if (!tenantSlug) {
      throw new HttpsError("invalid-argument", "tenantSlug is required");
    }

    const { tenantId, tenantData } = await resolvePublicShopTenant(tenantSlug);
    const rawLines = Array.isArray(data?.lineItems) ? data.lineItems : [];
    const productsById = await fetchTenantProductsById(tenantId);
    const { lineItems, subtotalCents } = buildValidatedShopLineItems(rawLines, productsById);

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const stripeAccountId = await assertTenantShopStripeReady(stripe, tenantData);

    const pickupEnabled = tenantData.shopPickupEnabled !== false;
    const shippingEnabled = tenantData.shopShippingEnabled === true;
    let fulfillmentMethod = (data?.fulfillmentMethod || "pickup").toString().trim().toLowerCase();
    if (fulfillmentMethod !== "shipping") fulfillmentMethod = "pickup";
    if (fulfillmentMethod === "pickup" && !pickupEnabled) {
      if (shippingEnabled) fulfillmentMethod = "shipping";
      else {
        throw new HttpsError("failed-precondition", "This shop is not accepting orders right now.");
      }
    }
    if (fulfillmentMethod === "shipping" && !shippingEnabled) {
      throw new HttpsError(
        "failed-precondition",
        "Shipping is not enabled. Choose pickup instead."
      );
    }

    let shippingCents = 0;
    let shippoRateId = null;
    let shippoShipmentId = null;
    let shippingAddress = null;
    let shippingProvider = null;
    let shippingService = null;

    if (fulfillmentMethod === "shipping") {
      shippoRateId = (data?.shippoRateId || "").toString().trim();
      shippoShipmentId = (data?.shippoShipmentId || "").toString().trim() || null;
      if (!shippoRateId) {
        throw new HttpsError("invalid-argument", "Select a shipping rate before paying.");
      }
      const token = readShippoTokenOrThrow();
      try {
        shippingAddress = shippoShop.normalizeShipAddress(
          data?.shippingAddress,
          (data?.customerName || "").toString().trim() || "Customer"
        );
      } catch (addrErr) {
        throw new HttpsError("invalid-argument", addrErr.message || "Invalid shipping address");
      }
      let rate;
      try {
        rate = await shippoShop.retrieveRate(token, shippoRateId);
      } catch (rateErr) {
        console.error("createShopCheckoutPayment shippo rate", rateErr);
        throw new HttpsError(
          "failed-precondition",
          "That shipping rate expired. Get new rates and try again."
        );
      }
      shippingCents = Math.max(0, rate.amountCents || 0);
      shippingProvider = rate.provider || null;
      shippingService = rate.service || null;
    }

    const shopTaxEnabled = tenantData.shopTaxEnabled === true;
    let taxCents = 0;
    let taxCalculationId = null;
    if (shopTaxEnabled) {
      try {
        const tax = await calculateShopSalesTax(
          stripe,
          stripeAccountId,
          tenantData,
          lineItems
        );
        taxCents = tax.taxCents;
        taxCalculationId = tax.taxCalculationId;
      } catch (taxErr) {
        console.warn("createShopCheckoutPayment tax", taxErr.message || taxErr);
        throw new HttpsError(
          "failed-precondition",
          "Could not calculate sales tax. Complete tax setup in Stripe, or turn off Online sales tax in Payment settings."
        );
      }
    }

    const merchandiseCents = subtotalCents + shippingCents;
    const checkout = computeCardCheckoutAmounts(merchandiseCents, "online");
    const piAmount = merchandiseCents + taxCents + checkout.surchargeCents;
    if (piAmount < 50) {
      throw new HttpsError(
        "failed-precondition",
        "Order total must be at least $0.50 to pay by card."
      );
    }
    const feeCents = platformFeeCents(piAmount);

    const notes = data?.notes ? data.notes.toString().trim().slice(0, 4000) : null;
    const customerPhone = normalizeCustomerPhone(data?.customerPhone);
    const orderRef = db.collection("tenants").doc(tenantId).collection("shopOrders").doc();
    const orderId = orderRef.id;
    const customerName = (data?.customerName || "").toString().trim() || "Customer";
    const customerEmail =
      (data?.customerEmail || "").toString().trim().toLowerCase() ||
      `guest+${orderId}@checkout.pending`;
    const isPlaceholderCustomer = customerEmail.endsWith("@checkout.pending");

    const pi = await createCustomerCheckoutPaymentIntent(stripe, stripeAccountId, {
      amount: piAmount,
      currency: "usd",
      application_fee_amount: feeCents,
      receipt_email: customerEmail,
      metadata: {
        tenantId,
        paymentKind: "shop",
        shopOrderId: orderId,
        serviceAmountCents: String(subtotalCents),
        feeBaseCents: String(merchandiseCents),
        taxOutsideFeeBase: "1",
        shippingCents: String(shippingCents),
        taxCents: String(taxCents),
        surchargeCents: String(checkout.surchargeCents),
        checkoutMethod: "card",
        fulfillmentMethod,
        ...(shippoRateId ? { shippoRateId } : {}),
        ...(taxCalculationId ? { taxCalculationId } : {}),
        chargeStripeAccountId: stripeAccountId,
        chargeStripeScope: "tenant",
      },
    });

    const orderData = {
      status: "pending_payment",
      source: "shop",
      tenantId,
      customerName,
      customerEmail,
      lineItems,
      subtotalCents,
      shippingCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: piAmount,
      fulfillmentMethod,
      stripePaymentIntentId: pi.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (shippoRateId) orderData.shippoRateId = shippoRateId;
    if (shippoShipmentId) orderData.shippoShipmentId = shippoShipmentId;
    if (shippingAddress) orderData.shippingAddress = shippingAddress;
    if (shippingProvider) orderData.shippingProvider = shippingProvider;
    if (shippingService) orderData.shippingService = shippingService;
    if (taxCalculationId) orderData.taxCalculationId = taxCalculationId;
    if (customerPhone) orderData.customerPhone = customerPhone;
    if (notes) orderData.notes = notes;
    await orderRef.set(orderData);
    if (!isPlaceholderCustomer) {
      await upsertShopCheckoutCustomer(tenantId, customerName, customerEmail, customerPhone);
    }

    const pkOut = stripePublishableKeyParam.value().trim();
    const out = {
      orderId,
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeAccountId,
      subtotalCents,
      shippingCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      platformFeeCents: feeCents,
      totalCents: piAmount,
      fulfillmentMethod,
    };
    if (pkOut) out.publishableKey = pkOut;
    return out;
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      if (err instanceof functions.https.HttpsError) throw err;
      console.error("createShopCheckoutPayment", err);
      throw new HttpsError("internal", stripeErrorMessage(err));
    }
  });

/**
 * Public web: attach real customer contact to a pending shop order before payment confirm.
 * Params: { tenantSlug, orderId, customerName, customerEmail, customerPhone?, notes? }
 */
exports.updateShopCheckoutContact = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data;
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  const orderId = (data?.orderId || "").toString().trim();
  const customerName = (data?.customerName || "").toString().trim();
  const customerEmail = (data?.customerEmail || "").toString().trim().toLowerCase();

  if (!tenantSlug || !orderId || !customerName || !customerEmail) {
    throw new HttpsError(
      "invalid-argument",
      "tenantSlug, orderId, customerName, and customerEmail are required"
    );
  }
  if (customerEmail.indexOf("@") <= 0) {
    throw new HttpsError("invalid-argument", "A valid customerEmail is required");
  }

  const { tenantId, tenantData } = await resolvePublicShopTenant(tenantSlug);
  const orderRef = db.collection("tenants").doc(tenantId).collection("shopOrders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new HttpsError("not-found", "Order not found");
  }
  const order = orderSnap.data() || {};
  if ((order.status || "").toString() !== "pending_payment") {
    throw new HttpsError(
      "failed-precondition",
      "This order can no longer be updated."
    );
  }

  const secretKey = stripeSecretKey.value();
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "Stripe is not configured");
  }
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  const stripeAccountId = await assertTenantShopStripeReady(stripe, tenantData);
  const paymentIntentId = (order.stripePaymentIntentId || "").toString().trim();
  if (!paymentIntentId) {
    throw new HttpsError("failed-precondition", "Payment is not ready for this order");
  }

  await stripe.paymentIntents.update(
    paymentIntentId,
    { receipt_email: customerEmail },
    { stripeAccount: stripeAccountId }
  );

  const customerPhone = normalizeCustomerPhone(data?.customerPhone);
  const notes = data?.notes ? data.notes.toString().trim().slice(0, 4000) : null;
  const patch = {
    customerName,
    customerEmail,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (customerPhone) patch.customerPhone = customerPhone;
  if (notes) patch.notes = notes;
  await orderRef.set(patch, { merge: true });
  await upsertShopCheckoutCustomer(tenantId, customerName, customerEmail, customerPhone);

  return { ok: true, orderId };
});

/**
 * Public web: mark shop order paid after Stripe PaymentIntent succeeds.
 * Params: { tenantSlug, orderId, paymentIntentId }
 */
exports.finalizeShopOrderPayment = onCall(publicShopCallableOptions, async (request) => {
    const data = request.data;
    const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
    const orderId = (data?.orderId || "").toString().trim();
    const paymentIntentId = (data?.paymentIntentId || "").toString().trim();

    if (!tenantSlug || !orderId || !paymentIntentId || !paymentIntentId.startsWith("pi_")) {
      throw new HttpsError(
        "invalid-argument",
        "tenantSlug, orderId, and paymentIntentId are required"
      );
    }

    const { tenantId } = await resolvePublicShopTenant(tenantSlug);
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    return markShopOrderPaidFromPaymentIntent(stripe, tenantId, orderId, paymentIntentId);
  });

/**
 * Public web: create charter booking + Stripe PaymentIntent (deposit or trip total).
 */
exports.createCharterCheckoutPayment = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  try {
    const { tenantId, tenantData } = await resolvePublicCharterTenant(data.tenantSlug);
    const payMode = charterPayModeFromTenant(tenantData);
    if (payMode === "request") {
      throw new HttpsError(
        "failed-precondition",
        "This charter does not collect a card at checkout."
      );
    }
    const customerName = (data.customerName || "").toString().trim();
    const customerEmail = (data.customerEmail || "").toString().trim().toLowerCase();
    if (!customerName || !customerEmail) {
      throw new HttpsError("invalid-argument", "Name and email are required.");
    }
    const svc = await loadCharterServiceDoc(tenantId, data.serviceId, data.serviceSlug);
    if (!svc) {
      throw new HttpsError("not-found", "Trip not found.");
    }
    const tripCents = charterServicePriceCents(svc);
    const { addonItems, addonCents } = await validatedCharterAddons(
      tenantId,
      data.addonProductIds
    );
    const tripTotalCents = tripCents + addonCents;
    const depositRaw = Number(tenantData.workflow && tenantData.workflow.depositAmount);
    const depositCents =
      Number.isFinite(depositRaw) && depositRaw > 0 ? Math.round(depositRaw * 100) : 0;
    // Deposit mode: the deposit (never more than a priced trip) plus add-ons, paid today.
    // The rest of the trip price is the balance due before departure. A trip with no price
    // keeps the full deposit and has no balance shown (the captain sets it).
    let depositPartCents = 0;
    let balanceDueCents = 0;
    let chargeCents = tripTotalCents;
    if (payMode === "deposit") {
      const configuredDeposit = depositCents || Math.round(tripCents * 0.2);
      depositPartCents = tripCents > 0 ? Math.min(configuredDeposit, tripCents) : configuredDeposit;
      balanceDueCents = tripCents > 0 ? tripCents - depositPartCents : 0;
      chargeCents = depositPartCents + addonCents;
    }
    if (chargeCents < 50) {
      throw new HttpsError(
        "failed-precondition",
        payMode === "deposit"
          ? "Set a deposit amount in Booking settings (at least $0.50)."
          : "This trip needs a price of at least $0.50 to pay by card."
      );
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const stripeAccountId = await assertTenantShopStripeReady(stripe, tenantData);
    const checkout = computeCardCheckoutAmounts(chargeCents, "online");
    const piAmount = checkout.totalCents;
    const feeCents = platformFeeCents(piAmount);
    const paymentKind = payMode === "deposit" ? "deposit" : "service";
    const bookingStatus = payMode === "deposit" ? "pending_deposit" : "pending_payment";

    const customerPhone = normalizeCustomerPhone(data.customerPhone);
    const smsConsentAccepted = data.smsConsentAccepted === true;
    if (!customerPhone || !smsConsentAccepted) {
      throw new HttpsError(
        "invalid-argument",
        "A mobile number and SMS consent are required for charter bookings."
      );
    }
    const bookingRef = db.collection("tenants").doc(tenantId).collection("bookingRequests").doc();
    const requestId = bookingRef.id;
    const bookingData = {
      status: bookingStatus,
      source: "web",
      tenantId,
      customerName,
      customerEmail,
      serviceId: svc.id,
      serviceSlug: (svc.slug || data.serviceSlug || "").toString() || null,
      serviceName: (svc.name || data.serviceName || "").toString() || null,
      charterPayMode: payMode,
      tripCents,
      addonCents,
      addonItems,
      chargeCents,
      depositPartCents,
      balanceDueCents,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    bookingData.customerPhone = customerPhone;
    bookingData.smsConsentAccepted = true;
    bookingData.smsConsentAt = admin.firestore.FieldValue.serverTimestamp();
    const preferredTime = data.preferredTime ? data.preferredTime.toString().trim() : "";
    if (preferredTime) bookingData.preferredTime = preferredTime;
    const startMin = charterParseTimeToMin(preferredTime);
    if (startMin != null) bookingData.scheduledStartMin = startMin;
    const scheduledDate = (data.scheduledDate || "").toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
      bookingData.scheduledDate = scheduledDate;
      bookingData.preferredDays = [scheduledDate];
    }
    const partySize = parseInt(String(data.partySize ?? ""), 10);
    if (Number.isFinite(partySize) && partySize > 0) bookingData.partySize = partySize;
    const durationMinutes = parseInt(String(data.durationMinutes ?? svc.durationMinutes ?? ""), 10);
    if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
      bookingData.durationMinutes = durationMinutes;
    }
    const notes = data.notes ? data.notes.toString().trim() : "";
    if (notes) bookingData.notes = notes;
    bookingData.chargeStripeAccountId = stripeAccountId;
    const charterOwnerUid = (tenantData.ownerUid || "").toString().trim();

    const boatFilterId = (data.boatId || data.boat || "").toString().trim();
    await reserveCharterSlot(tenantId, tenantData, bookingData, {
      paymentHold: true,
      boatFilterId,
      service: svc,
      bookingRef,
    });

    const tripName = (svc.name || data.serviceName || "Charter").toString().trim() || "Charter";
    // The app shows the trip and the add-ons as separate lines on the payment.
    const serviceLabel = payMode === "deposit" ? `${tripName} deposit` : tripName;
    const serviceCents = payMode === "deposit" ? depositPartCents : tripCents;
    const addonsLabel = addonItems.map((a) => a.name).filter(Boolean).join(", ").slice(0, 450);
    let pi;
    try {
      pi = await createCustomerCheckoutPaymentIntent(stripe, stripeAccountId, {
        amount: piAmount,
        currency: "usd",
        application_fee_amount: feeCents,
        receipt_email: customerEmail,
        description: `${customerName} · ${serviceLabel}${addonCents > 0 ? " + add-ons" : ""}`,
        metadata: {
          tenantId,
          paymentKind,
          bookingRequestId: requestId,
          charterPayMode: payMode,
          customerName,
          serviceLabel,
          serviceCents: String(serviceCents),
          ...(addonCents > 0 ? { addonsLabel, addonCents: String(addonCents) } : {}),
          serviceAmountCents: String(chargeCents),
          feeBaseCents: String(chargeCents),
          surchargeCents: String(checkout.surchargeCents),
          checkoutMethod: "card",
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: "tenant",
          checkoutChannel: "charter_web_checkout",
          initiatedByUid: charterOwnerUid,
          attributedMemberUid: charterOwnerUid,
        },
      });
    } catch (piErr) {
      await bookingRef.set(
        {
          status: "cancelled",
          cancelReason: "payment_intent_failed",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          holdUntil: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      throw piErr;
    }
    await bookingRef.set(
      { stripePaymentIntentId: pi.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    const customerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("customers")
      .doc(customerDocIdForTenant(customerName, customerEmail, customerPhone));
    await customerRef.set(
      {
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
        smsOptedIn: true,
        smsConsentAt: admin.firestore.FieldValue.serverTimestamp(),
        smsConsentSource: "web_booking",
        source: "booking_request_web",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const pkOut = stripePublishableKeyParam.value().trim();
    const out = {
      requestId,
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeAccountId,
      tripCents,
      addonCents,
      addonItems,
      chargeCents,
      depositPartCents,
      balanceDueCents,
      surchargeCents: checkout.surchargeCents,
      platformFeeCents: feeCents,
      totalCents: piAmount,
      payMode,
    };
    if (pkOut) out.publishableKey = pkOut;
    return out;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("createCharterCheckoutPayment", err);
    throw new HttpsError("internal", stripeErrorMessage(err));
  }
});

exports.finalizeCharterBookingPayment = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  const requestId = (data.requestId || "").toString().trim();
  const paymentIntentId = (data.paymentIntentId || "").toString().trim();
  if (!tenantSlug || !requestId || !paymentIntentId || !paymentIntentId.startsWith("pi_")) {
    throw new HttpsError(
      "invalid-argument",
      "tenantSlug, requestId, and paymentIntentId are required"
    );
  }
  const { tenantId } = await resolvePublicCharterTenant(tenantSlug);
  const secretKey = stripeSecretKey.value();
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "Stripe is not configured");
  }
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  return markCharterBookingPaidFromPaymentIntent(stripe, tenantId, requestId, paymentIntentId);
});
