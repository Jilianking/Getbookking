/**
 * Tap to Pay on iPhone.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  platformFeeCents,
  Stripe,
  stripeSecretKey,
  db,
  computeInPersonCheckoutTotals,
  parseServiceAmountCents,
  assertCanTakePayments,
  ensureStripeAccountForTapToPayContext,
  resolveEffectivePaymentContext,
  assertCanTapToPayForBooking,
  getTenantIdForUser,
  assertTenantOwner,
  tapToPayTerminalDisplayNameForTenant,
  tapToPayTerminalDisplayNameForUser,
  parseTapToPayReceiptPreferencesInput,
  receiptPreferencesResponse,
  tapToPayPaymentSettingsForScope,
  ensureStripeTerminalLocationForTenant,
  ensureStripeTerminalLocationForUser,
  maybeCalculateInPersonSalesTax,
  buildTeamSplitFeeAndMetaForCharge,
} = require("./core");

/**
 * Creates a PaymentIntent for Tap to Pay. amountCents in USD cents.
 * Returns { clientSecret, paymentIntentId } for Stripe Terminal SDK.
 * Requires Stripe Terminal iOS SDK + Tap to Pay entitlement for full flow.
 */
exports.createPaymentIntentForTapToPay = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const serviceAmount = parseServiceAmountCents(data);
    if (serviceAmount == null) {
      throw new functions.https.HttpsError("invalid-argument", "Amount is required.");
    }
    if (serviceAmount < 50) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Amount must be at least 50 cents ($0.50)"
      );
    }
    const uid = context.auth.uid;
    const tenantId = await getTenantIdForUser(uid);
    const bookingRequestId = (data?.bookingRequestId || "").toString().trim();
    const payCtx = await assertCanTapToPayForBooking(
      uid,
      await resolveEffectivePaymentContext(uid, { bookingRequestId, tenantId })
    );
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No Stripe account linked"
      );
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const tenantDoc = tenantId
      ? await db.collection("tenants").doc(tenantId).get()
      : null;
    const tenantData = tenantDoc?.exists ? tenantDoc.data() || {} : {};
    const tax = await maybeCalculateInPersonSalesTax(
      stripe,
      stripeAccountId,
      tenantData,
      serviceAmount
    );
    const taxCents = tax.taxCents || 0;
    const priced = computeInPersonCheckoutTotals(serviceAmount, taxCents, "card_present");
    const totalCents = priced.totalCents;
    const splitFee = await buildTeamSplitFeeAndMetaForCharge({
      tenant: tenantData,
      tenantId,
      payCtx,
      paymentKind: "service",
      serviceCents: priced.serviceCents,
      grossCents: totalCents,
    });
    const feeCents = splitFee.applicationFeeCents;
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const pi = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        payment_method_types: ["card_present"],
        application_fee_amount: feeCents,
        capture_method: "automatic",
        metadata: {
          tenantId: tenantId || "",
          paymentKind: "service",
          serviceAmountCents: String(priced.serviceCents),
          taxCents: String(priced.taxCents),
          surchargeCents: String(priced.surchargeCents),
          ...(tax.taxCalculationId ? { taxCalculationId: tax.taxCalculationId } : {}),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
          checkoutChannel: "tap_to_pay",
          ...splitFee.splitMeta,
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      platformFeeCents: splitFee.platformFeeCents,
      studioShareCents: splitFee.studioShareCents,
      serviceCents: priced.serviceCents,
      taxCents: priced.taxCents,
      surchargeCents: priced.surchargeCents,
      totalCents,
      attributedMemberUid,
      chargeStripeScope: payCtx.scope || "tenant",
    };
  });

/**
 * Creates a Stripe Terminal connection token for Tap to Pay on iPhone.
 * iOS app uses this token (via Stripe Terminal iOS SDK) to connect to the phone-as-reader.
 */
exports.createTerminalConnectionTokenForTapToPay = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const payCtx = await ensureStripeAccountForTapToPayContext(context.auth.uid, stripe);
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No Stripe account linked"
      );
    }

    // Connection tokens can optionally be scoped to a location. For Tap to Pay on iPhone,
    // location scoping is provided at connect-time via `locationId` in the connection config.
    const token = await stripe.terminal.connectionTokens.create(
      {},
      { stripeAccount: stripeAccountId }
    );

    return { secret: token.secret };
  });

/**
 * Creates Connect account + Terminal location (if needed) so iOS can show Apple Tap to Pay T&C
 * before Stripe Connect onboarding in Safari. Does not require charges_enabled.
 */
exports.prepareTapToPayTermsAcceptance = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const uid = context.auth.uid;
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const payCtx = await ensureStripeAccountForTapToPayContext(uid, stripe);
    const tenantId = payCtx.tenantId;
    const tenantDoc = await db.collection("tenants").doc(tenantId).get();
    if (!tenantDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Business not found.");
    }
    const tenantData = tenantDoc.data() || {};
    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    try {
      const locationId =
        payCtx.scope === "user"
          ? await ensureStripeTerminalLocationForUser(
              uid,
              stripe,
              payCtx.stripeAccountId,
              userData,
              tenantData
            )
          : await ensureStripeTerminalLocationForTenant(
              tenantId,
              stripe,
              payCtx.stripeAccountId,
              tenantData
            );
      const displayName =
        payCtx.scope === "user"
          ? tapToPayTerminalDisplayNameForUser(userData, tenantData)
          : tapToPayTerminalDisplayNameForTenant(tenantData);
      return {
        locationId,
        displayName,
        paymentScope: payCtx.scope,
        hasAccount: true,
        chargesEnabled: payCtx.chargesEnabled,
        detailsSubmitted: payCtx.detailsSubmitted,
        pendingReview: payCtx.pendingReview,
        stripeAccountId: payCtx.stripeAccountId,
      };
    } catch (err) {
      console.error("prepareTapToPayTermsAcceptance", err);
      const msg =
        err && err.message
          ? String(err.message)
          : "Could not prepare Tap to Pay. Check your business address in Website Design.";
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/**
 * Creates (if needed) a Stripe Terminal Location and returns its id (tml_…).
 * Owner → tenants.stripeTerminalLocationId; independent member → users.stripeTerminalLocationId.
 */
exports.ensureTapToPayTerminalLocation = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const uid = context.auth.uid;
    const payCtx = await assertCanTakePayments(uid);
    const tenantId = payCtx.tenantId;
    const tenantDoc = await db.collection("tenants").doc(tenantId).get();
    if (!tenantDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Business not found.");
    }
    const tenantData = tenantDoc.data() || {};
    const stripeAccountId = (payCtx.stripeAccountId || "").toString().trim();
    if (!stripeAccountId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Connect Stripe before enabling Tap to Pay."
      );
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const account = await stripe.accounts.retrieve(stripeAccountId);
    if (!account.charges_enabled) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Finish Stripe setup before using Tap to Pay."
      );
    }
    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    try {
      const locationId =
        payCtx.scope === "user"
          ? await ensureStripeTerminalLocationForUser(
              uid,
              stripe,
              stripeAccountId,
              userData,
              tenantData
            )
          : await ensureStripeTerminalLocationForTenant(
              tenantId,
              stripe,
              stripeAccountId,
              tenantData
            );
      const displayName =
        payCtx.scope === "user"
          ? tapToPayTerminalDisplayNameForUser(userData, tenantData)
          : tapToPayTerminalDisplayNameForTenant(tenantData);
      return { locationId, displayName, paymentScope: payCtx.scope };
    } catch (err) {
      console.error("ensureTapToPayTerminalLocation", err);
      const msg =
        err && err.message
          ? String(err.message)
          : "Could not create a Terminal location. Check your business address in Website Design.";
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/**
 * Updates Tap to Pay settings (customer-facing name, signature, receipt prefs).
 * Params: { displayName?, requireSignature?, autoOfferReceipt? } — at least one field required.
 * Owner → tenants.*; independent member → users.*.
 */
exports.updateTapToPayDisplayName = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const uid = context.auth.uid;
    const payCtx = await assertCanTakePayments(uid);
    const hasDisplayName = data?.displayName !== undefined;
    const hasRequireSignature = data?.requireSignature !== undefined;
    const hasAutoOfferReceipt = data?.autoOfferReceipt !== undefined;
    const receiptPrefsInput = parseTapToPayReceiptPreferencesInput(data?.receiptPreferences);
    const hasReceiptPreferences = receiptPrefsInput != null;
    if (!hasDisplayName && !hasRequireSignature && !hasAutoOfferReceipt && !hasReceiptPreferences) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Provide displayName, requireSignature, autoOfferReceipt, and/or receiptPreferences"
      );
    }

    const rawName = hasDisplayName ? (data.displayName ?? "").toString().trim() : null;
    if (rawName !== null && rawName.length > 100) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Name must be 100 characters or fewer"
      );
    }

    const tenantId = payCtx.tenantId;
    const tenantRef = db.collection("tenants").doc(tenantId);
    const tenantDoc = await tenantRef.get();
    if (!tenantDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Business not found.");
    }
    let tenantData = tenantDoc.data() || {};

    const userRef = db.collection("users").doc(uid);
    const userPatch = {};
    const tenantPatch = {};

    if (hasDisplayName && rawName !== null) {
      if (payCtx.scope === "user") {
        userPatch.tapToPayDisplayName = rawName;
      } else {
        await assertTenantOwner(uid, tenantId);
        tenantPatch.tapToPayDisplayName = rawName;
      }
    } else if (payCtx.scope !== "user") {
      await assertTenantOwner(uid, tenantId);
    }

    if (hasRequireSignature) {
      const val = data.requireSignature === true;
      if (payCtx.scope === "user") {
        userPatch.tapToPayRequireSignature = val;
      } else {
        tenantPatch.tapToPayRequireSignature = val;
      }
    }

    if (hasAutoOfferReceipt) {
      const val = data.autoOfferReceipt !== false;
      const delivery = val ? "prompt" : "none";
      if (payCtx.scope === "user") {
        userPatch.tapToPayAutoOfferReceipt = val;
        userPatch.tapToPayReceiptDelivery = delivery;
      } else {
        tenantPatch.tapToPayAutoOfferReceipt = val;
        tenantPatch.tapToPayReceiptDelivery = delivery;
      }
    }

    if (receiptPrefsInput) {
      if (payCtx.scope === "user") {
        Object.assign(userPatch, receiptPrefsInput);
      } else {
        Object.assign(tenantPatch, receiptPrefsInput);
      }
    }

    if (Object.keys(userPatch).length) {
      await userRef.set(userPatch, { merge: true });
    }
    if (Object.keys(tenantPatch).length) {
      await tenantRef.set(tenantPatch, { merge: true });
      tenantData = { ...tenantData, ...tenantPatch };
    }

    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    if (payCtx.scope !== "user") {
      const freshTenant = await tenantRef.get();
      tenantData = freshTenant.exists ? freshTenant.data() || {} : tenantData;
    }

    const paymentSettings = tapToPayPaymentSettingsForScope(
      payCtx.scope,
      tenantData,
      userData
    );
    const resolvedName =
      payCtx.scope === "user"
        ? tapToPayTerminalDisplayNameForUser(userData, tenantData)
        : tapToPayTerminalDisplayNameForTenant(tenantData);

    if (!hasDisplayName) {
      return {
        locationId: payCtx.terminalLocationId || null,
        displayName: resolvedName,
        paymentScope: payCtx.scope,
        requireSignature: paymentSettings.tapToPayRequireSignature,
        ...receiptPreferencesResponse(payCtx.scope, tenantData, userData),
      };
    }

    const stripeAccountId = (payCtx.stripeAccountId || "").toString().trim();
    if (!stripeAccountId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Connect Stripe before setting a Tap to Pay name."
      );
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const account = await stripe.accounts.retrieve(stripeAccountId);
    if (!account.charges_enabled) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Finish Stripe setup before using Tap to Pay."
      );
    }

    const locationId =
      payCtx.scope === "user"
        ? await ensureStripeTerminalLocationForUser(
            uid,
            stripe,
            stripeAccountId,
            userData,
            tenantData
          )
        : await ensureStripeTerminalLocationForTenant(
            tenantId,
            stripe,
            stripeAccountId,
            tenantData
          );

    return {
      locationId,
      displayName: resolvedName,
      paymentScope: payCtx.scope,
      requireSignature: paymentSettings.tapToPayRequireSignature,
      ...receiptPreferencesResponse(payCtx.scope, tenantData, userData),
    };
  });
