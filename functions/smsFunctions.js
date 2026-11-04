/**
 * Texting numbers, sending, consent, Twilio webhooks.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  admin,
  crypto,
  Stripe,
  sms,
  appleSubscription,
  stripeSecretKey,
  stripeSubscriptionPriceIds,
  stripePublishableKeyParam,
  db,
  normalizeSubscriptionPlan,
  isSingleOperatorPlan,
  stripeSmsExtraPriceIds,
  smsExtraQuantityFromSubscription,
  syncSmsExtraLineQuantityToTenant,
  SMS_EXTRA_MONTHLY_CENTS,
  SMS_ADD_ON_PURPOSE,
  usesSmsAddOnBilling,
  smsLineBilling,
  applySmsExtraLineQuantity,
  chargeOneTimeSmsExtraFee,
  reconcileSmsExtraPaidToUsage,
  maybeReduceSmsExtraAfterReleasingOccupiedLine,
  stripeClientFromSecret,
  getMemberAccessContext,
  releaseTenantTextingNumbers,
  SMS_LAPSED_NUMBER_GRACE_DAYS,
  billingPortalReturnBase,
  stripeErrorMessage,
  messagingFieldsWithLineCount,
  claimAppleSmsExtraPurchase,
  chargeOneTimeSmsNumberReplacementFee,
  assertCanUseSmsThread,
  loadSmsThreadForCaller,
  provisionTenantSms,
  provisionMemberSms,
  sendBookingClientStatusSms,
} = require("./core");

/**
 * Daily: release numbers whose business has been suspended for an unpaid plan for 30 days.
 * Texting is already off for these (suspended when the plan lapsed); this stops the Twilio rent.
 */
exports.releaseLapsedSmsNumbers = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const cutoffMs = Date.now() - SMS_LAPSED_NUMBER_GRACE_DAYS * 86400000;
    const snap = await db.collection("tenants").where("smsStatus", "==", "suspended").get();
    let released = 0;
    for (const doc of snap.docs) {
      const tenant = doc.data() || {};
      const suspendedAt = tenant.smsSuspendedAt;
      const suspendedMs =
        suspendedAt && typeof suspendedAt.toMillis === "function" ? suspendedAt.toMillis() : 0;
      if (!suspendedMs || suspendedMs > cutoffMs) continue;
      // Only plan lapses. A number suspended for another reason is left for a person to review.
      if (!(tenant.smsSuspendReason || "").toString().startsWith("subscription_")) continue;
      if ((tenant.subscriptionStatus || "").toString().toLowerCase() === "active") continue;
      if (tenant.complimentaryPaidAccess === true) continue;
      const out = await releaseTenantTextingNumbers(doc.id, tenant);
      released += (out.studioReleased ? 1 : 0) + out.memberLinesReleased;
    }
    // Paid extra lines whose monthly add-on ended (card failed or cancelled).
    const lapsedLines = await db.collection("users").where("smsStatus", "==", "suspended").get();
    for (const doc of lapsedLines.docs) {
      const member = doc.data() || {};
      if ((member.smsSuspendReason || "").toString() !== "addon_ended") continue;
      const suspendedAt = member.smsSuspendedAt;
      const suspendedMs =
        suspendedAt && typeof suspendedAt.toMillis === "function" ? suspendedAt.toMillis() : 0;
      if (!suspendedMs || suspendedMs > cutoffMs) continue;
      if (!(member.smsPhoneNumberSid || "").toString().trim()) continue;
      try {
        const release = await sms.releaseMemberSms(member);
        if (release.released === true) {
          await doc.ref.set(sms.personalSmsClearedFields(), { merge: true });
          released += 1;
        } else {
          console.error("releaseLapsedSmsNumbers: member number NOT released", doc.id);
        }
      } catch (e) {
        console.warn("releaseLapsedSmsNumbers member", doc.id, e.message || e);
      }
    }
    console.log("releaseLapsedSmsNumbers", JSON.stringify({ suspended: snap.size, released }));
    return null;
  });

/**
 * App Store subscribers: start saving a card for extra texting lines ($12.99 today + $12.99/mo each).
 * The card lives on a Stripe customer used only for those lines; the plan stays with Apple.
 * Returns an embedded Checkout (setup mode) client secret for the billing page.
 */
exports.createSmsLinesCardSetup = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can manage billing."
      );
    }
    if (!usesSmsAddOnBilling(ctx.tenant)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Extra texting numbers are billed with your plan. Use Add a texting number."
      );
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const tenantRef = db.collection("tenants").doc(ctx.tenantId);
    let customerId = smsLineBilling(ctx.tenant).customerId;
    try {
      if (!customerId) {
        const ownerEmail =
          (ctx.ownerUserData && ctx.ownerUserData.email) ||
          (ctx.userData && ctx.userData.email) ||
          context.auth.token.email ||
          "";
        const customer = await stripe.customers.create({
          email: ownerEmail || undefined,
          name: (ctx.tenant.businessName || ctx.tenant.displayName || "").toString() || undefined,
          metadata: {
            tenantId: ctx.tenantId,
            firebaseUid: context.auth.uid,
            purpose: SMS_ADD_ON_PURPOSE,
          },
        });
        customerId = customer.id;
        await tenantRef.set(
          {
            smsAddOnStripeCustomerId: customerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      const base = billingPortalReturnBase(data);
      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        ui_mode: "embedded",
        customer: customerId,
        payment_method_types: ["card"],
        metadata: { tenantId: ctx.tenantId, purpose: SMS_ADD_ON_PURPOSE },
        return_url: `${base}/billing.html?sms_card=success&session_id={CHECKOUT_SESSION_ID}`,
      });
      if (!session.client_secret) {
        throw new Error("Stripe did not return a card form.");
      }
      const out = { clientSecret: session.client_secret };
      const pk = stripePublishableKeyParam.value().trim();
      if (pk) out.publishableKey = pk;
      return out;
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      console.error("createSmsLinesCardSetup", e);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Stripe could not start the card form: ${stripeErrorMessage(e)}`
      );
    }
  });

/** Finishes the card setup: makes the saved card the one Stripe charges for extra lines. */
exports.completeSmsLinesCardSetup = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can manage billing."
      );
    }
    const sessionId = ((data && data.sessionId) || "").toString().trim();
    const customerId = smsLineBilling(ctx.tenant).customerId;
    if (!sessionId || !usesSmsAddOnBilling(ctx.tenant) || !customerId) {
      throw new functions.https.HttpsError("invalid-argument", "Card setup was not started.");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["setup_intent.payment_method"],
      });
      const sessionCustomer =
        typeof session.customer === "string" ? session.customer : session.customer && session.customer.id;
      const intent = session.setup_intent;
      const paymentMethod = intent && intent.payment_method;
      if (
        session.mode !== "setup" ||
        sessionCustomer !== customerId ||
        session.status !== "complete" ||
        !intent ||
        intent.status !== "succeeded" ||
        !paymentMethod ||
        !paymentMethod.id
      ) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The card was not saved. Try again."
        );
      }
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethod.id },
      });
      const card = paymentMethod.card || {};
      const brand = (card.brand || "card").toString();
      const cardLabel =
        `${brand.charAt(0).toUpperCase()}${brand.slice(1)} ending ${card.last4 || "----"}`;
      await db.collection("tenants").doc(ctx.tenantId).set(
        {
          smsAddOnCardLabel: cardLabel,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { ok: true, cardLabel };
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      console.error("completeSmsLinesCardSetup", e);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Stripe could not confirm the card: ${stripeErrorMessage(e)}`
      );
    }
  });

exports.purchaseSmsExtraLine = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
    if (smsPurchaseBlock) {
      throw new functions.https.HttpsError("failed-precondition", smsPurchaseBlock);
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can purchase extra texting numbers."
      );
    }
    const tenant = ctx.tenant;
    const ownerData = ctx.ownerUserData || ctx.userData;
    const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
    const memberUid = ((data && data.memberUid) || "").toString().trim();
    if (isSingleOperatorPlan(plan)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This plan includes 1 texting number. Upgrade to Studio or Shop for team lines."
      );
    }
    if (!memberUid || memberUid === tenant.ownerUid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Choose an independent teammate for this texting number."
      );
    }
    const memberRef = db.collection("users").doc(memberUid);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const memberData = memberSnap.data() || {};
    if (sms.memberPayoutMode(memberData) !== "independent") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Personal texting numbers are for independent team members."
      );
    }
    if (
      sms.countsAsOccupiedSmsLine(memberData.smsStatus) ||
      (memberData.smsPhoneNumber || "").toString().trim()
    ) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This teammate already has a texting number."
      );
    }
    const paidBlock = sms.paidSubscriptionBlockReason(tenant, ownerData);
    // Allow purchase while active; trialing may still buy capacity for after start.
    // If not bypass and not active/trialing with customer, block.
    if (paidBlock && !sms.tenantIsTrialing(tenant, ownerData)) {
      throw new functions.https.HttpsError("failed-precondition", paidBlock);
    }

    // 3rd+ concurrent: $12.99 now + $12.99/mo subscription seat.
    // Under 2 concurrent with lifetime exhausted: $12.99 one-time only.
    const usedBefore = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
    const free = sms.freeIncludedSmsLinesForPlan(plan);
    const max = sms.maxSmsLinesForPlan(plan);
    const lifetime = sms.resolveLifetimeNumbersBought(tenant, usedBefore);
    const needsSubscriptionSeat = usedBefore >= free;

    if (usedBefore >= max) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Your ${plan} plan allows up to ${max} texting numbers.`
      );
    }
    if (lifetime < free) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "You still have an included texting number. Enable it under Messaging without purchasing."
      );
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const lineBilling = smsLineBilling(tenant);
    let currentQty;
    if (lineBilling.addOn) {
      // Plan is billed by Apple; extra lines bill to the card saved for them on the billing page.
      if (!lineBilling.customerId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Add a card for extra texting numbers first."
        );
      }
      currentQty = sms.smsExtraPaidQuantity(tenant);
    } else {
      const subId = lineBilling.subscriptionId;
      const customerId = lineBilling.customerId;
      if (!customerId || !subId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Billing is not set up. Complete subscription checkout first."
        );
      }
      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(subId, {
          expand: ["items.data.price"],
        });
      } catch (e) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Could not load subscription: ${stripeErrorMessage(e)}`
        );
      }
      if (!["active", "trialing", "past_due"].includes(sub.status)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Subscription is ${sub.status}. Update billing before adding a texting number.`
        );
      }
      currentQty = smsExtraQuantityFromSubscription(sub, stripeSmsExtraPriceIds());
    }
    let paidExtrasAfter = currentQty;
    let chargedInvoice;
    let freshTenant;

    if (needsSubscriptionSeat) {
      const floorQty = Math.max(0, usedBefore - free);
      const nextQty = floorQty + 1;
      if (free + nextQty > max) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Your ${plan} plan allows up to ${max} texting numbers.`
        );
      }

      if (currentQty !== floorQty) {
        try {
          await applySmsExtraLineQuantity(stripe, ctx.tenantId, tenant, floorQty, {
            prorationBehavior: "none",
          });
          currentQty = floorQty;
        } catch (e) {
          console.error("purchaseSmsExtraLine reset to floor", e);
          throw new functions.https.HttpsError(
            "failed-precondition",
            `Could not sync texting line billing: ${stripeErrorMessage(e)}`
          );
        }
      } else {
        await syncSmsExtraLineQuantityToTenant(ctx.tenantId, floorQty);
      }

      const tenantAtFloor = { ...tenant, smsExtraLineQuantity: floorQty };

      try {
        chargedInvoice = await chargeOneTimeSmsExtraFee(
          stripe,
          tenantAtFloor,
          "Get Bookking extra texting number ($12.99)"
        );
      } catch (e) {
        if (e instanceof functions.https.HttpsError) throw e;
        console.error("purchaseSmsExtraLine flat charge", e);
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Could not charge your card for the texting number: ${stripeErrorMessage(e)}`
        );
      }

      try {
        await applySmsExtraLineQuantity(stripe, ctx.tenantId, tenantAtFloor, nextQty, {
          prorationBehavior: "none",
        });
      } catch (e) {
        console.error("purchaseSmsExtraLine stripe +1 after paid", e);
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Payment succeeded but texting capacity could not be updated: ${stripeErrorMessage(e)}`
        );
      }

      paidExtrasAfter = nextQty;
      freshTenant = {
        ...tenantAtFloor,
        smsExtraLineQuantity: nextQty,
      };
    } else {
      try {
        chargedInvoice = await chargeOneTimeSmsExtraFee(
          stripe,
          tenant,
          "Get Bookking texting number ($12.99)"
        );
      } catch (e) {
        if (e instanceof functions.https.HttpsError) throw e;
        console.error("purchaseSmsExtraLine one-time charge", e);
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Could not charge your card for the texting number: ${stripeErrorMessage(e)}`
        );
      }
      // One-time replacement under the concurrent free cap — drop any stale
      // smsExtra qty left from when the tenant previously had 3+ lines.
      const reconciled = await reconcileSmsExtraPaidToUsage(
        stripe,
        ctx.tenantId,
        tenant,
        plan,
        usedBefore
      );
      freshTenant = reconciled.tenant;
      paidExtrasAfter = reconciled.paid;
    }

    const authorizationId = crypto.randomBytes(24).toString("hex");
    await memberRef.set(
      {
        smsPaidLinePurchaseAuthorizationId: authorizationId,
        smsPaidLinePurchaseInvoiceId: chargedInvoice.id,
        smsPaidLinePurchaseAuthorizedAt: admin.firestore.FieldValue.serverTimestamp(),
        smsPaidLinePurchaseExpiresAt: admin.firestore.Timestamp.fromMillis(
          Date.now() + 15 * 60 * 1000
        ),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const messaging = await messagingFieldsWithLineCount(
      ctx.tenantId,
      freshTenant,
      ownerData
    );
    return {
      ok: true,
      paidExtras: paidExtrasAfter,
      previousPaidExtras: currentQty,
      charged: true,
      addsSubscriptionSeat: needsSubscriptionSeat,
      smsPaidLinePurchaseAuthorizationId: authorizationId,
      stripeInvoiceId: chargedInvoice.id,
      messaging,
    };
  });

/** Owner: opt in to client texting (provisions Twilio after paid subscription). */
exports.requestTenantSmsProvisioning = functions
  .runWith({
    secrets: [sms.twilioAccountSid, sms.twilioAuthToken, stripeSecretKey],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can enable client texting."
      );
    }
    const ownerData = ctx.ownerUserData || ctx.userData;
    const tenant = ctx.tenant;
    const paidBlock = sms.paidSubscriptionBlockReason(tenant, ownerData);
    if (paidBlock) {
      throw new functions.https.HttpsError("failed-precondition", paidBlock);
    }
    const forceReprovision = !!(data && data.forceReprovision);
    if (tenant.smsStatus === "active" && tenant.smsPhoneNumber && !forceReprovision) {
      return {
        ok: true,
        smsStatus: "active",
        smsPhoneNumber: tenant.smsPhoneNumber,
        alreadyActive: true,
      };
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason(tenant);
    if (smsPurchaseBlock) {
      throw new functions.https.HttpsError("failed-precondition", smsPurchaseBlock);
    }
    if (forceReprovision) {
      const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
      const occupied = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
      if (sms.smsRefreshNeedsPurchase(tenant, plan, occupied)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Getting a new texting number after your included free numbers requires a $12.99 payment."
        );
      }
    }
    const consent = data && data.smsConsentAccepted === true;
    const hadPriorConsent = !!tenant.smsConsentAt;
    if (!consent && !(forceReprovision && hadPriorConsent)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Accept the client texting terms to continue."
      );
    }

    let soloReplacementInvoiceId = null;
    let soloReplacementAuthorizationId = null;
    const alreadyOccupiesSlot = sms.countsAsOccupiedSmsLine(tenant.smsStatus);
    if (!alreadyOccupiesSlot && !(forceReprovision && tenant.smsPhoneNumberSid)) {
      const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
      const lineCount = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
      const summary = sms.buildSmsLineSummary(tenant, plan, lineCount);
      // Solo: after the included lifetime number is used, authorize exactly one
      // $12.99 replacement before setting pending. The Firestore trigger verifies
      // this authorization before it may buy from Twilio.
      if (summary.canPurchaseSoloReplacement) {
        const tenantRef = db.collection("tenants").doc(ctx.tenantId);
        const authorization = await db.runTransaction(async (tx) => {
          const freshSnap = await tx.get(tenantRef);
          const fresh = freshSnap.data() || {};
          if (sms.countsAsOccupiedSmsLine(fresh.smsStatus)) {
            return {
              alreadyProvisioning: true,
              authorizationId: null,
              invoiceId: null,
            };
          }
          const reusableId = (fresh.smsSoloReplacementAuthorizationId || "").toString();
          const reusableInvoiceId = (
            fresh.smsSoloReplacementAuthorizationInvoiceId || ""
          ).toString();
          const expiresAt = fresh.smsSoloReplacementAuthorizationExpiresAt;
          const expiresMs =
            expiresAt && typeof expiresAt.toMillis === "function"
              ? expiresAt.toMillis()
              : 0;
          if (
            fresh.smsSoloReplacementAuthorizationState === "authorized" &&
            reusableId &&
            reusableInvoiceId &&
            expiresMs > Date.now()
          ) {
            return {
              alreadyProvisioning: false,
              authorizationId: reusableId,
              invoiceId: reusableInvoiceId,
            };
          }
          const inFlightAt = fresh.smsSoloReplacementInFlightAt;
          const inFlightMs =
            inFlightAt && typeof inFlightAt.toMillis === "function"
              ? inFlightAt.toMillis()
              : 0;
          if (inFlightMs > Date.now() - 5 * 60 * 1000) {
            throw new functions.https.HttpsError(
              "aborted",
              "Your texting-number purchase is already being processed. Please wait."
            );
          }
          const authorizationId = crypto.randomUUID();
          tx.set(
            tenantRef,
            {
              smsSoloReplacementAuthorizationId: authorizationId,
              smsSoloReplacementAuthorizationState: "charging",
              smsSoloReplacementInFlightAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return {
            alreadyProvisioning: false,
            authorizationId,
            invoiceId: null,
          };
        });

        if (authorization.alreadyProvisioning) {
          return { ok: true, smsStatus: "pending", alreadyProvisioning: true };
        }
        soloReplacementAuthorizationId = authorization.authorizationId;
        soloReplacementInvoiceId = authorization.invoiceId;
        const appleSignedTransaction = ((data && data.appleSignedTransaction) || "")
          .toString()
          .trim();
        // The iOS app already took this payment through the App Store; charging the Stripe
        // card as well would bill the number twice.
        if (!soloReplacementInvoiceId && appleSignedTransaction) {
          try {
            const claim = await claimAppleSmsExtraPurchase({
              uid: context.auth.uid,
              tenantId: ctx.tenantId,
              signedTransaction: appleSignedTransaction,
              purpose: "tenant_number",
            });
            soloReplacementInvoiceId = `apple:${claim.transactionId}`;
            await tenantRef.set(
              {
                smsLastSoloReplacementInvoiceId: soloReplacementInvoiceId,
                smsLastSoloReplacementAt: admin.firestore.FieldValue.serverTimestamp(),
                smsSoloReplacementAuthorizationInvoiceId: soloReplacementInvoiceId,
                smsSoloReplacementAuthorizationState: "authorized",
                smsSoloReplacementAuthorizationExpiresAt:
                  admin.firestore.Timestamp.fromMillis(Date.now() + 15 * 60 * 1000),
                smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          } catch (e) {
            await tenantRef.set(
              {
                smsSoloReplacementAuthorizationState: admin.firestore.FieldValue.delete(),
                smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            throw e;
          }
        }
        if (!soloReplacementInvoiceId) {
          try {
            const secretKey = stripeSecretKey.value();
            if (!secretKey) {
              throw new functions.https.HttpsError(
                "failed-precondition",
                "Stripe is not configured."
              );
            }
            const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
            const invoice = await chargeOneTimeSmsExtraFee(
              stripe,
              tenant,
              "Get Bookking Solo texting number replacement ($12.99)"
            );
            soloReplacementInvoiceId = invoice.id;
            await tenantRef.set(
              {
                smsLastSoloReplacementInvoiceId: invoice.id,
                smsLastSoloReplacementAt: admin.firestore.FieldValue.serverTimestamp(),
                smsSoloReplacementAuthorizationInvoiceId: invoice.id,
                smsSoloReplacementAuthorizationState: "authorized",
                smsSoloReplacementAuthorizationExpiresAt:
                  admin.firestore.Timestamp.fromMillis(Date.now() + 15 * 60 * 1000),
                smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          } catch (e) {
            await tenantRef.set(
              {
                smsSoloReplacementAuthorizationState: admin.firestore.FieldValue.delete(),
                smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            throw e;
          }
        }
      } else {
        const block = sms.newSmsLineBlockReason(tenant, plan, lineCount);
        if (block) {
          throw new functions.https.HttpsError("failed-precondition", block);
        }
      }
    }
    const tenantId = ctx.tenantId;
    const wasPending = (tenant.smsStatus || "").toString() === "pending";
    await db.collection("tenants").doc(tenantId).set(
      {
        smsEnabled: true,
        smsStatus: "pending",
        smsConsentAt: tenant.smsConsentAt || admin.firestore.FieldValue.serverTimestamp(),
        smsProvisionError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (forceReprovision && wasPending) {
      try {
        const fresh = (await db.collection("tenants").doc(tenantId).get()).data() || tenant;
        const result = await provisionTenantSms(tenantId, fresh);
        return {
          ok: true,
          smsStatus: "active",
          smsPhoneNumber: result.phoneNumber,
          reprovisioned: true,
        };
      } catch (e) {
        console.error("requestTenantSmsProvisioning forceReprovision", tenantId, e);
        await db.collection("tenants").doc(tenantId).set(
          {
            smsStatus: "failed",
            smsProvisionError: (e.message || String(e)).slice(0, 400),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        throw new functions.https.HttpsError(
          "failed-precondition",
          (e.message || String(e)).slice(0, 400)
        );
      }
    }
    return {
      ok: true,
      smsStatus: "pending",
      charged: !!soloReplacementInvoiceId,
      stripeInvoiceId: soloReplacementInvoiceId,
    };
  });

/** Independent member (or owner on their behalf): opt in to a personal texting line. */
exports.requestMemberSmsProvisioning = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    const targetUid = ((data && data.memberUid) || context.auth.uid).toString().trim();
    if (!targetUid) {
      throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
    }
    if (targetUid !== context.auth.uid && !ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can enable texting for another member."
      );
    }
    const tenant = ctx.tenant;
    const ownerData = ctx.ownerUserData || ctx.userData;
    const paidBlock = sms.paidSubscriptionBlockReason(tenant, ownerData);
    if (paidBlock) {
      throw new functions.https.HttpsError("failed-precondition", paidBlock);
    }
    if (!sms.tenantStudioSmsActive(tenant)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your studio must enable client texting before members can set up personal lines."
      );
    }
    const memberRef = db.collection("users").doc(targetUid);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const memberData = memberSnap.data();
    if (targetUid === tenant.ownerUid) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Owners use the studio texting line under Notifications."
      );
    }
    if (sms.memberPayoutMode(memberData) !== "independent") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Personal texting lines are for independent team members."
      );
    }
    const forceReprovision = !!(data && data.forceReprovision);
    if (
      memberData.smsStatus === "active" &&
      memberData.smsPhoneNumber &&
      !forceReprovision
    ) {
      return {
        ok: true,
        smsStatus: "active",
        smsPhoneNumber: memberData.smsPhoneNumber,
        alreadyActive: true,
      };
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
    if (smsPurchaseBlock) {
      throw new functions.https.HttpsError("failed-precondition", smsPurchaseBlock);
    }
    if (forceReprovision) {
      const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
      const occupied = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
      if (sms.smsRefreshNeedsPurchase(tenant, plan, occupied)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Getting a new texting number after your included free numbers requires a $12.99/mo payment. Use Refresh number in Messaging."
        );
      }
    }
    const alreadyOccupiesSlot = sms.countsAsOccupiedSmsLine(memberData.smsStatus);
    if (!alreadyOccupiesSlot && !(forceReprovision && memberData.smsPhoneNumberSid)) {
      const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
      const lineCount = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
      const freeIncluded = sms.freeIncludedSmsLinesForPlan(plan);
      // Legacy callable: it has no one-time Stripe authorization payload.
      // Never allow it to create the 3rd+ number; modern clients must use
      // purchaseSmsExtraLine → requestSmsPhoneNumber instead.
      if (lineCount >= freeIncluded) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "A paid texting number must be added through the current Messaging flow so Stripe can confirm payment first."
        );
      }
      const block = sms.newSmsLineBlockReason(tenant, plan, lineCount);
      if (block) {
        throw new functions.https.HttpsError("failed-precondition", block);
      }
    }
    const consent = data && data.smsConsentAccepted === true;
    const hadPriorConsent = !!memberData.smsConsentAt;
    if (!consent && !(forceReprovision && hadPriorConsent)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Accept the client texting terms to continue."
      );
    }
    const wasPending = (memberData.smsStatus || "").toString() === "pending";
    await memberRef.set(
      {
        smsEnabled: true,
        smsStatus: "pending",
        smsConsentAt:
          memberData.smsConsentAt || admin.firestore.FieldValue.serverTimestamp(),
        smsLineRequestPending: admin.firestore.FieldValue.delete(),
        smsLineRequestedAt: admin.firestore.FieldValue.delete(),
        smsProvisionError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (forceReprovision && wasPending) {
      try {
        const fresh = (await memberRef.get()).data() || memberData;
        const result = await provisionMemberSms(
          ctx.tenantId,
          tenant,
          targetUid,
          fresh
        );
        return {
          ok: true,
          smsStatus: "active",
          smsPhoneNumber: result.phoneNumber,
          reprovisioned: true,
        };
      } catch (e) {
        console.error("requestMemberSmsProvisioning forceReprovision", targetUid, e);
        await memberRef.set(
          {
            smsStatus: "failed",
            smsProvisionError: (e.message || String(e)).slice(0, 400),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        throw new functions.https.HttpsError(
          "failed-precondition",
          (e.message || String(e)).slice(0, 400)
        );
      }
    }
    return { ok: true, smsStatus: "pending" };
  });

/**
 * Independent member (or owner for a member): request a personal SMS number.
 * Free / already-paid capacity → starts provisioning.
 * Needs paid capacity → marks request pending for the owner.
 */
exports.requestSmsPhoneNumber = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    const targetUid = ((data && data.memberUid) || context.auth.uid).toString().trim();
    if (!targetUid) {
      throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
    }
    if (targetUid !== context.auth.uid && !ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can request a number for another member."
      );
    }
    const tenant = ctx.tenant;
    const ownerData = ctx.ownerUserData || ctx.userData;
    const paidBlock = sms.paidSubscriptionBlockReason(tenant, ownerData);
    if (paidBlock) {
      throw new functions.https.HttpsError("failed-precondition", paidBlock);
    }
    if (!sms.tenantStudioSmsActive(tenant)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your studio must enable client texting before members can request a personal number."
      );
    }
    const memberRef = db.collection("users").doc(targetUid);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const memberData = memberSnap.data();
    if (targetUid === tenant.ownerUid) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Owners use the studio texting line under Messaging."
      );
    }
    if (sms.memberPayoutMode(memberData) !== "independent") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Personal texting numbers are for independent team members."
      );
    }
    if (memberData.smsStatus === "active" && memberData.smsPhoneNumber) {
      return {
        ok: true,
        smsStatus: "active",
        smsPhoneNumber: memberData.smsPhoneNumber,
        alreadyActive: true,
      };
    }
    if (sms.countsAsOccupiedSmsLine(memberData.smsStatus)) {
      return {
        ok: true,
        smsStatus: (memberData.smsStatus || "pending").toString(),
        alreadyPending: true,
      };
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
    if (smsPurchaseBlock) {
      throw new functions.https.HttpsError("failed-precondition", smsPurchaseBlock);
    }

    const consent = data && data.smsConsentAccepted === true;
    const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
    const lineCount = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
    const summary = sms.buildSmsLineSummary(tenant, plan, lineCount);
    const purchaseAuthorizationId = (
      (data && data.smsPaidLinePurchaseAuthorizationId) ||
      ""
    )
      .toString()
      .trim();
    const authorizationExpiresAt = memberData.smsPaidLinePurchaseExpiresAt;
    const authorizationExpiresMs =
      authorizationExpiresAt && typeof authorizationExpiresAt.toMillis === "function"
        ? authorizationExpiresAt.toMillis()
        : 0;
    const requiresPaidPurchase = !summary.nextIsFree;
    const hasPaidPurchaseAuthorization =
      requiresPaidPurchase &&
      !!purchaseAuthorizationId &&
      purchaseAuthorizationId ===
        (memberData.smsPaidLinePurchaseAuthorizationId || "").toString() &&
      authorizationExpiresMs > Date.now();

    if (summary.atMax) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        `This studio has reached its maximum of ${summary.maxLines} texting numbers.`
      );
    }

    // Hard rule: once free included lines are used, never set pending (Twilio)
    // without a live one-time Stripe-paid authorization for this member.
    // Leftover subscription qty must not bypass this.
    if (requiresPaidPurchase && !hasPaidPurchaseAuthorization) {
      await memberRef.set(
        {
          smsLineRequestPending: true,
          smsLineRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
          smsLineRequestConsentAccepted: consent === true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return {
        ok: true,
        needsOwnerPurchase: true,
        smsLineRequestPending: true,
        message:
          targetUid === context.auth.uid
            ? (summary.needsMonthlyExtraForNext
                ? "Request sent. Your studio owner can add a number ($12.99 now + $12.99/mo) under Billing or Messaging."
                : "Request sent. Your studio owner can add a number ($12.99 one-time) under Billing or Messaging.")
            : (summary.needsMonthlyExtraForNext
                ? "This member needs a paid texting number ($12.99 now + $12.99/mo). Confirm the purchase, then enable their line."
                : "This member needs a texting number ($12.99 one-time). Confirm the purchase, then enable their line."),
      };
    }

    if (!requiresPaidPurchase && !summary.canAddWithoutPurchase) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        sms.newSmsLineBlockReason(tenant, plan, lineCount) ||
          "No free texting number available."
      );
    }

    if (!consent) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Accept the client texting terms to continue."
      );
    }
    await memberRef.set(
      {
        smsEnabled: true,
        smsStatus: "pending",
        smsConsentAt: memberData.smsConsentAt || admin.firestore.FieldValue.serverTimestamp(),
        smsLineRequestPending: admin.firestore.FieldValue.delete(),
        smsLineRequestedAt: admin.firestore.FieldValue.delete(),
        smsProvisionError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      ok: true,
      smsStatus: "pending",
      provisioned: true,
      usedIncluded: summary.nextIsFree === true,
    };
  });

/** Owner: clear a pending phone-number request without provisioning. */
exports.clearSmsLineRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can clear texting number requests."
    );
  }
  const targetUid = ((data && data.memberUid) || "").toString().trim();
  if (!targetUid) {
    throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
  }
  const memberRef = db.collection("users").doc(targetUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  await memberRef.set(
    {
      smsLineRequestPending: admin.firestore.FieldValue.delete(),
      smsLineRequestedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
});

/**
 * Owner: refresh a studio or personal texting number (release old Twilio SID, buy new).
 * Lifetime free buys: Solo 1 · Studio/Shop 2. Further refreshes charge $12.99 once, then buy.
 */
exports.refreshSmsPhoneNumber = functions
  .runWith({
    secrets: [
      sms.twilioAccountSid,
      sms.twilioAuthToken,
      stripeSecretKey,
      stripeSubscriptionPriceIds,
    ],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can refresh texting numbers."
      );
    }
    const ownerData = ctx.ownerUserData || ctx.userData;
    const tenant = ctx.tenant;
    const paidBlock = sms.paidSubscriptionBlockReason(tenant, ownerData);
    if (paidBlock) {
      throw new functions.https.HttpsError("failed-precondition", paidBlock);
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
    if (smsPurchaseBlock) {
      throw new functions.https.HttpsError("failed-precondition", smsPurchaseBlock);
    }

    const scopeRaw = ((data && data.scope) || "").toString().trim().toLowerCase();
    const memberUid = ((data && data.memberUid) || "").toString().trim();
    const isStudio =
      scopeRaw === "studio" || (!memberUid && scopeRaw !== "personal");
    if (!isStudio && !memberUid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Choose the studio line or a teammate to refresh."
      );
    }

    const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
    const occupied = await sms.countOccupiedSmsLines(ctx.tenantId, tenant);
    const lifetime = sms.resolveLifetimeNumbersBought(tenant, occupied);
    // Persist backfill so refresh gating stays consistent.
    if (sms.smsLifetimeNumbersBought(tenant) < lifetime) {
      await db.collection("tenants").doc(ctx.tenantId).set(
        {
          smsLifetimeNumbersBought: lifetime,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    const needsPurchase = sms.smsRefreshNeedsPurchase(tenant, plan, occupied);

    let chargedInvoiceId = null;
    let tenantAfterCharge = tenant;
    if (needsPurchase) {
      const secretKey = stripeSecretKey.value();
      if (!secretKey) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe is not configured."
        );
      }
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const invoice = await chargeOneTimeSmsNumberReplacementFee(stripe, tenant);
      chargedInvoiceId = invoice.id;
      if (plan === "studio" || plan === "shop") {
        try {
          const reconciled = await reconcileSmsExtraPaidToUsage(
            stripe,
            ctx.tenantId,
            tenant,
            plan,
            occupied
          );
          tenantAfterCharge = reconciled.tenant;
        } catch (e) {
          console.error("refreshSmsPhoneNumber reconcile after one-time", e);
          throw new functions.https.HttpsError(
            "failed-precondition",
            `The $12.99 charge succeeded but subscription billing could not be synced: ${stripeErrorMessage(e)}`
          );
        }
      }
    }

    if (isStudio) {
      if (!sms.occupiesSmsLineSlot(tenant)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Studio texting is not active."
        );
      }
      await sms.releaseTenantSms(tenant);
      await db.collection("tenants").doc(ctx.tenantId).set(
        {
          smsEnabled: true,
          smsStatus: "pending",
          smsPhoneNumber: admin.firestore.FieldValue.delete(),
          smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
          smsProvisionError: admin.firestore.FieldValue.delete(),
          smsConsentAt:
            tenant.smsConsentAt || admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      const memberRef = db.collection("users").doc(memberUid);
      const memberSnap = await memberRef.get();
      if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
        throw new functions.https.HttpsError("not-found", "Team member not found.");
      }
      const memberData = memberSnap.data() || {};
      if (memberUid === tenant.ownerUid) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Owners use the studio texting line."
        );
      }
      if (!sms.occupiesSmsLineSlot(memberData)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "This teammate does not have an active texting number."
        );
      }
      await sms.releaseMemberSms(memberData);
      await memberRef.set(
        {
          smsEnabled: true,
          smsStatus: "pending",
          smsPhoneNumber: admin.firestore.FieldValue.delete(),
          smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
          smsProvisionError: admin.firestore.FieldValue.delete(),
          smsConsentAt:
            memberData.smsConsentAt || admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const messaging = await messagingFieldsWithLineCount(
      ctx.tenantId,
      (await db.collection("tenants").doc(ctx.tenantId).get()).data() ||
        tenantAfterCharge,
      ownerData
    );
    return {
      ok: true,
      refreshing: true,
      charged: needsPurchase,
      stripeInvoiceId: chargedInvoiceId,
      messaging,
    };
  });

/**
 * Owner: permanently release a texting number (Twilio + Firestore).
 * Studio: no memberUid (or scope "studio"). Personal: memberUid set.
 * If the released line was past free included capacity, drops one Stripe paid-extra
 * so buying a number again charges $12.
 */
exports.releaseSmsPhoneNumber = functions
  .runWith({
    secrets: [
      sms.twilioAccountSid,
      sms.twilioAuthToken,
      stripeSecretKey,
      stripeSubscriptionPriceIds,
    ],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can remove texting numbers."
      );
    }
    const scopeRaw = ((data && data.scope) || "").toString().trim().toLowerCase();
    const memberUid = ((data && data.memberUid) || "").toString().trim();
    const isStudio =
      scopeRaw === "studio" || scopeRaw === "tenant" || (!memberUid && scopeRaw !== "personal");
    const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
    const stripe = stripeClientFromSecret();
    const ownerData = ctx.ownerUserData || ctx.userData;

    if (isStudio) {
      const tenant = ctx.tenant || {};
      const lineOccupied = sms.countsAsOccupiedSmsLine(tenant.smsStatus);
      const hadPhone =
        lineOccupied ||
        !!(tenant.smsPhoneNumber || "").toString().trim() ||
        !!(tenant.smsPhoneNumberSid || "").toString().trim();
      if (!hadPhone) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Studio texting is not set up."
        );
      }
      const usage = sms.smsMonthlyUsageForTenant(tenant);
      const release = await sms.releaseTenantSms(tenant);
      const cleared = sms.tenantSmsClearedFields();
      await db.collection("tenants").doc(ctx.tenantId).set(cleared, {
        merge: true,
      });
      const tenantAfter = {
        ...tenant,
        smsStatus: "off",
        smsPhoneNumber: "",
        smsPhoneNumberSid: "",
        smsEnabled: false,
      };
      const paidExtras = await maybeReduceSmsExtraAfterReleasingOccupiedLine(
        stripe,
        ctx.tenantId,
        tenantAfter,
        plan,
        hadPhone
      );
      const freshTenant =
        (await db.collection("tenants").doc(ctx.tenantId).get()).data() || tenantAfter;
      const messaging = await messagingFieldsWithLineCount(
        ctx.tenantId,
        { ...freshTenant, smsExtraLineQuantity: paidExtras != null ? paidExtras : 0 },
        ownerData
      );
      return {
        ok: true,
        scope: "studio",
        released: release.released === true,
        smsMonthlyUsageCount: usage.count,
        smsMonthlyLimit: usage.limit,
        smsExtraPaid:
          paidExtras != null ? paidExtras : sms.smsExtraPaidQuantity(tenantAfter),
        messaging,
      };
    }

    if (!memberUid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "memberUid is required to remove a personal line."
      );
    }
    if (memberUid === ctx.tenant.ownerUid) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Owners use the studio texting line. Remove it as Studio, not as a personal line."
      );
    }
    const memberRef = db.collection("users").doc(memberUid);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const memberData = memberSnap.data();
    const lineOccupied = sms.countsAsOccupiedSmsLine(memberData.smsStatus);
    const hadPhone =
      lineOccupied ||
      !!(memberData.smsPhoneNumber || "").toString().trim() ||
      !!(memberData.smsPhoneNumberSid || "").toString().trim() ||
      memberData.smsLineRequestPending === true;
    if (!hadPhone) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This member does not have a texting number."
      );
    }
    const usage = sms.smsMonthlyUsageForMember(memberData, ctx.tenant);
    const release = await sms.releaseMemberSms(memberData);
    await memberRef.set(sms.personalSmsClearedFields(), { merge: true });
    const paidExtras = await maybeReduceSmsExtraAfterReleasingOccupiedLine(
      stripe,
      ctx.tenantId,
      ctx.tenant,
      plan,
      hadPhone
    );
    const freshTenant =
      (await db.collection("tenants").doc(ctx.tenantId).get()).data() || ctx.tenant;
    const messaging = await messagingFieldsWithLineCount(
      ctx.tenantId,
      {
        ...freshTenant,
        smsExtraLineQuantity:
          paidExtras != null ? paidExtras : sms.smsExtraPaidQuantity(freshTenant),
      },
      ownerData
    );
    return {
      ok: true,
      scope: "personal",
      memberUid,
      released: release.released === true,
      smsMonthlyUsageCount: usage.count,
      smsMonthlyLimit: usage.limit,
      smsExtraPaid:
        paidExtras != null ? paidExtras : sms.smsExtraPaidQuantity(ctx.tenant),
      messaging,
    };
  });

/** Team: send an appointment-related SMS from the tenant number. */
/**
 * Permanently deletes text conversations and their messages (and any photos texted in them).
 * Owners and managers can delete any conversation in the business; a team member only those on
 * their own personal number. Consent and STOP opt-outs are stored separately and are kept.
 * Params: { threadIds: string[] } (up to 50)
 */
exports.deleteSmsThreads = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const raw = Array.isArray(data && data.threadIds) ? data.threadIds : [];
  const threadIds = [...new Set(raw.map((id) => (id || "").toString().trim()).filter(Boolean))];
  if (!threadIds.length || threadIds.length > 50) {
    throw new functions.https.HttpsError("invalid-argument", "Choose 1 to 50 conversations.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  const canDeleteAny = ctx.isOwner || ctx.accessRole === "manager";
  const tenantRef = db.collection("tenants").doc(ctx.tenantId);
  const bucket = admin.storage().bucket();
  const mediaPrefix = `tenants/${ctx.tenantId}/smsMedia/`;
  let deleted = 0;
  const skipped = [];

  for (const threadId of threadIds) {
    if (threadId.includes("/")) {
      skipped.push(threadId);
      continue;
    }
    const threadRef = tenantRef.collection("smsThreads").doc(threadId);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) {
      skipped.push(threadId);
      continue;
    }
    const thread = threadSnap.data() || {};
    const ownLine =
      (thread.smsLineScope || "").toString() === "member" &&
      (thread.assignedMemberUid || "").toString() === uid;
    if (!canDeleteAny && !ownLine) {
      skipped.push(threadId);
      continue;
    }

    const logs = await tenantRef.collection("smsLog").where("threadId", "==", threadId).get();
    const mediaPaths = new Set();
    for (const doc of logs.docs) {
      const urls = Array.isArray((doc.data() || {}).mediaUrls) ? doc.data().mediaUrls : [];
      for (const url of urls) {
        const match = /\/o\/([^?]+)/.exec((url || "").toString());
        const objectPath = match ? decodeURIComponent(match[1]) : "";
        if (objectPath.startsWith(mediaPrefix)) mediaPaths.add(objectPath);
      }
    }
    for (let i = 0; i < logs.docs.length; i += 400) {
      const batch = db.batch();
      logs.docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    await threadRef.delete();
    for (const objectPath of mediaPaths) {
      try {
        await bucket.file(objectPath).delete();
      } catch (e) {
        console.warn("deleteSmsThreads media", objectPath, e.message || e);
      }
    }
    deleted += 1;
  }

  return { ok: true, deleted, skipped };
});

exports.sendClientSms = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    const tenantId = ctx.tenantId;
    const tenant = ctx.tenant;
    const isOwner = ctx.isOwner;
    if (
      !sms.canSendClientSms({
        isOwner,
        accessRole: ctx.accessRole,
        managerPermissions: ctx.managerPermissions,
        senderUserData: ctx.userData,
      })
    ) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to send client texts."
      );
    }

    const to = sms.toE164US(data && data.to);
    const body = ((data && data.body) || "").toString().trim();
    const clientName = ((data && data.clientName) || "").toString().trim().slice(0, 120);
    const mediaUrls = sms.normalizeOutboundMediaUrls(data && data.mediaUrls);
    const paymentKindRaw = ((data && data.paymentKind) || "").toString().trim().toLowerCase();
    const paymentKind =
      paymentKindRaw === "deposit" || paymentKindRaw === "payment" ? paymentKindRaw : "";
    const amountCentsRaw = Number(data && data.amountCents);
    const amountCents =
      Number.isFinite(amountCentsRaw) && amountCentsRaw > 0
        ? Math.round(amountCentsRaw)
        : 0;
    const paymentUrl = ((data && data.paymentUrl) || "").toString().trim().slice(0, 500);
    const threadPreview = ((data && data.threadPreview) || "").toString().trim().slice(0, 120);
    if (!to) {
      throw new functions.https.HttpsError("invalid-argument", "A valid client phone is required.");
    }
    if (!body && !mediaUrls.length) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Message body or photo is required."
      );
    }
    if (body.length > 1600) {
      throw new functions.https.HttpsError("invalid-argument", "Message body is too long.");
    }

    const ownerData = ctx.ownerUserData || ctx.userData;
    const requestedThreadId = ((data && data.threadId) || "").toString().trim();
    let threadData = null;
    if (requestedThreadId) {
      const threadSnap = await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsThreads")
        .doc(requestedThreadId)
        .get();
      if (threadSnap.exists) {
        threadData = threadSnap.data() || {};
      }
    }

    assertCanUseSmsThread(ctx, context.auth.uid, requestedThreadId, threadData);

    try {
      const sent = await sms.sendOutboundClientSms({
        tenantId,
        tenant,
        toE164: to,
        body,
        meta: {
          threadId: requestedThreadId || undefined,
          threadData: threadData || undefined,
          clientName,
          paymentKind: paymentKind || undefined,
          amountCents: amountCents || undefined,
          paymentUrl: paymentUrl || undefined,
          threadPreview: threadPreview || undefined,
          mediaUrls: mediaUrls.length ? mediaUrls : undefined,
        },
        ownerUserData: ownerData,
        senderUid: context.auth.uid,
        senderUserData: ctx.userData,
        isOwner,
        accessRole: ctx.accessRole,
        managerPermissions: ctx.managerPermissions,
      });
      return {
        ok: true,
        sid: sent.msg.sid,
        status: sent.msg.status || "",
        threadId: sent.threadId,
        from: sent.from,
      };
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).slice(0, 400);
      if (msg.includes("Monthly SMS limit reached")) {
        throw new functions.https.HttpsError("resource-exhausted", msg);
      }
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/** Texting consent for one conversation: drives the status line above the message box. */
exports.getSmsConsentStatus = functions.https.onCall(async (data, context) => {
  const { ctx, threadId, threadData, clientPhone } = await loadSmsThreadForCaller(context, data);
  const status = await sms.smsConsentStatusForThread(ctx.tenantId, {
    threadId,
    clientPhone,
    threadData,
  });
  return { ok: true, ...status };
});

/**
 * Resend the "Reply YES" opt-in text. Only when the client texted first, never after STOP,
 * and at most once every 24 hours per conversation.
 */
exports.resendSmsConsentPrompt = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    const { ctx, threadId, threadRef, threadData, clientPhone } =
      await loadSmsThreadForCaller(context, data);
    if (!clientPhone) {
      throw new functions.https.HttpsError("failed-precondition", "This conversation has no phone number.");
    }
    const status = await sms.smsConsentStatusForThread(ctx.tenantId, {
      threadId,
      clientPhone,
      threadData,
    });
    if (status.state === "opted_in") {
      throw new functions.https.HttpsError("failed-precondition", "This client is already opted in.");
    }
    if (status.state === "opted_out") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This client replied STOP. They can opt back in by texting YES or START."
      );
    }
    if (status.state !== "waiting") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The client needs to text you first, or opt in when booking."
      );
    }
    if (status.canResendAtMs) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The opt-in text was sent in the last 24 hours. Try again tomorrow."
      );
    }

    const tenant = ctx.tenant || {};
    const businessName = (tenant.businessName || tenant.displayName || "us").toString();
    try {
      const sent = await sms.sendOutboundClientSms({
        tenantId: ctx.tenantId,
        tenant,
        toE164: clientPhone,
        body: sms.inboundConsentPromptBody(businessName),
        meta: {
          threadId,
          threadData,
          clientName: (threadData.clientName || "").toString(),
          consentPrompt: true,
        },
        ownerUserData: ctx.ownerUserData || ctx.userData,
        senderUid: context.auth.uid,
        senderUserData: ctx.userData,
        isOwner: ctx.isOwner,
        accessRole: ctx.accessRole,
        managerPermissions: ctx.managerPermissions,
      });
      await threadRef.set(
        { smsConsentPromptSentAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      return { ok: true, sid: sent.msg.sid };
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).slice(0, 400);
      if (msg.includes("Monthly SMS limit reached")) {
        throw new functions.https.HttpsError("resource-exhausted", msg);
      }
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/** Twilio delivery updates: marks texts that never reached the client as not delivered. */
exports.twilioSmsStatus = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const tenantId = ((req.query && req.query.t) || "").toString().trim();
    const authToken = (sms.twilioAuthToken.value() || "").toString().trim();
    const sig = (req.headers["x-twilio-signature"] || "").toString().trim();
    const url = sms.statusCallbackUrl(tenantId);
    const params = req.body || {};
    if (!tenantId || tenantId.includes("/") || !authToken || !sig || !url) {
      res.status(403).send("Forbidden");
      return;
    }
    // eslint-disable-next-line global-require
    const twilio = require("twilio");
    if (!twilio.validateRequest(authToken, sig, url, params)) {
      console.warn("twilioSmsStatus: invalid signature");
      res.status(403).send("Forbidden");
      return;
    }
    const messageSid = (params.MessageSid || params.SmsSid || "").toString().trim();
    const status = (params.MessageStatus || params.SmsStatus || "").toString().trim().toLowerCase();
    if (!messageSid || messageSid.includes("/") || !status) {
      res.status(200).send("");
      return;
    }
    const patch = {
      status,
      statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const errorCode = (params.ErrorCode || "").toString().trim();
    if (errorCode) patch.errorCode = errorCode;
    try {
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsLog")
        .doc(messageSid)
        .update(patch);
    } catch (e) {
      // Not one of ours (or already deleted): nothing to update.
      if (!(e && (e.code === 5 || String(e.message || "").includes("NOT_FOUND")))) {
        console.warn("twilioSmsStatus", tenantId, messageSid, e.message || e);
      }
    }
    if (status === "failed" || status === "undelivered") {
      console.warn("twilioSmsStatus: not delivered", tenantId, messageSid, errorCode);
    }
    res.status(200).send("");
  });

/** Firestore: provision Twilio when smsStatus becomes pending. */
exports.onTenantSmsProvisionRequested = functions
  .runWith({
    secrets: [sms.twilioAccountSid, sms.twilioAuthToken, stripeSecretKey],
  })
  .firestore.document("tenants/{tenantId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    if (before.smsStatus === after.smsStatus) return null;
    if ((after.smsStatus || "").toString() !== "pending") return null;
    if (after.smsEnabled !== true) return null;

    const tenantId = context.params.tenantId;
    const ownerUid = after.ownerUid;
    let ownerData = null;
    if (ownerUid) {
      const o = await db.collection("users").doc(ownerUid).get();
      if (o.exists) ownerData = o.data();
    }
    if (!sms.tenantHasPaidSubscription(after, ownerData)) {
      await db.collection("tenants").doc(tenantId).set(
        {
          smsStatus: "off",
          smsProvisionError: "Paid subscription required.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason(after);
    if (smsPurchaseBlock) {
      await db.collection("tenants").doc(tenantId).set(
        {
          smsStatus: "failed",
          smsProvisionError: smsPurchaseBlock,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }
    try {
      const plan = normalizeSubscriptionPlan(after.subscriptionPlan);
      // A Solo replacement needs the existing $12.99 invoice authorization.
      // Calculate from the pre-pending record: after is already pending and
      // therefore occupies the only Solo slot.
      const beforeLineCount = await sms.countOccupiedSmsLines(tenantId, before);
      const beforeSummary = sms.buildSmsLineSummary(before, plan, beforeLineCount);
      if (beforeSummary.canPurchaseSoloReplacement) {
        const authorizationId = (after.smsSoloReplacementAuthorizationId || "")
          .toString()
          .trim();
        const invoiceId = (after.smsSoloReplacementAuthorizationInvoiceId || "")
          .toString()
          .trim();
        const expiresAt = after.smsSoloReplacementAuthorizationExpiresAt;
        const expiresMs =
          expiresAt && typeof expiresAt.toMillis === "function"
            ? expiresAt.toMillis()
            : 0;
        if (
          after.smsSoloReplacementAuthorizationState !== "authorized" ||
          !authorizationId ||
          !invoiceId ||
          expiresMs <= Date.now()
        ) {
          await db.collection("tenants").doc(tenantId).set(
            {
              smsStatus: "failed",
              smsProvisionError:
                "A completed $12.99 texting-number payment is required before setup.",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return null;
        }
        let paymentVerified = false;
        if (invoiceId.startsWith("apple:")) {
          paymentVerified = await appleSubscription.smsExtraPurchaseIsUnspent(
            invoiceId.slice("apple:".length),
            tenantId,
            "tenant_number"
          );
        } else {
          const secretKey = stripeSecretKey.value();
          if (!secretKey) {
            throw new Error("Stripe is not configured.");
          }
          const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
          const invoice = await stripe.invoices.retrieve(invoiceId);
          const customerMatches =
            (invoice.customer || "").toString() === smsLineBilling(after).customerId;
          const paidAmount = Math.max(
            Number(invoice.amount_paid) || 0,
            Number(invoice.total) || 0
          );
          paymentVerified = invoice.status === "paid" && customerMatches && paidAmount >= SMS_EXTRA_MONTHLY_CENTS;
        }
        if (!paymentVerified) {
          await db.collection("tenants").doc(tenantId).set(
            {
              smsStatus: "failed",
              smsProvisionError:
                "Your $12.99 texting-number payment could not be verified. Please try again.",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return null;
        }
      }
      const lineCount = await sms.countOccupiedSmsLines(tenantId, after);
      // Line is already pending (included in count). Capacity must cover used lines.
      const summary = sms.buildSmsLineSummary(after, plan, lineCount);
      if (lineCount > summary.capacity) {
        await db.collection("tenants").doc(tenantId).set(
          {
            smsStatus: "failed",
            smsProvisionError: sms.newSmsLineBlockReason(after, plan, lineCount - 1) ||
              "No texting line capacity remaining.",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return null;
      }
      await provisionTenantSms(tenantId, after, { isPaidExtra: false });
      if (beforeSummary.canPurchaseSoloReplacement) {
        const paidInvoiceId = (after.smsSoloReplacementAuthorizationInvoiceId || "").toString();
        if (paidInvoiceId.startsWith("apple:")) {
          await appleSubscription.consumeSmsExtraPurchase(paidInvoiceId.slice("apple:".length));
        }
        await db.collection("tenants").doc(tenantId).set(
          {
            smsSoloReplacementAuthorizationState: "consumed",
            smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (e) {
      console.error("onTenantSmsProvisionRequested", tenantId, e);
      await db.collection("tenants").doc(tenantId).set(
        {
          smsStatus: "failed",
          smsProvisionError: (e.message || String(e)).slice(0, 400),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return null;
  });

/** Firestore: provision personal line when member smsStatus becomes pending. */
exports.onUserMemberSmsProvisionRequested = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .firestore.document("users/{memberUid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    if (before.smsStatus === after.smsStatus) return null;
    if ((after.smsStatus || "").toString() !== "pending") return null;
    if (after.smsEnabled !== true) return null;

    const memberUid = context.params.memberUid;
    const tenantId = (after.tenantId || "").toString().trim();
    if (!tenantId) return null;
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) return null;
    const tenant = tenantSnap.data();
    const ownerUid = tenant.ownerUid;
    let ownerData = null;
    if (ownerUid) {
      const o = await db.collection("users").doc(ownerUid).get();
      if (o.exists) ownerData = o.data();
    }
    if (!sms.tenantHasPaidSubscription(tenant, ownerData)) {
      await db.collection("users").doc(memberUid).set(
        {
          smsStatus: "off",
          smsProvisionError: "Paid subscription required.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }
    if (!sms.tenantStudioSmsActive(tenant)) {
      await db.collection("users").doc(memberUid).set(
        {
          smsStatus: "failed",
          smsProvisionError: "Studio client texting must be enabled first.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }
    if (sms.memberPayoutMode(after) !== "independent") {
      await db.collection("users").doc(memberUid).set(
        {
          smsStatus: "failed",
          smsProvisionError: "Personal lines are for independent members.",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
    if (smsPurchaseBlock) {
      await db.collection("users").doc(memberUid).set(
        {
          smsStatus: "failed",
          smsProvisionError: smsPurchaseBlock,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return null;
    }

    try {
      const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
      const lineCount = await sms.countOccupiedSmsLines(tenantId, tenant);
      const summary = sms.buildSmsLineSummary(tenant, plan, lineCount);
      const authorizationExpiresAt = after.smsPaidLinePurchaseExpiresAt;
      const authorizationExpiresMs =
        authorizationExpiresAt &&
        typeof authorizationExpiresAt.toMillis === "function"
          ? authorizationExpiresAt.toMillis()
          : 0;
      // This trigger sees the new line already counted as pending. Charge rule
      // uses other occupied lines: if free allotment is already used, Twilio
      // requires a live Stripe-paid authorization for this member.
      const occupiedExcludingSelf = Math.max(0, lineCount - 1);
      const previewSummary = sms.buildSmsLineSummary(tenant, plan, occupiedExcludingSelf);
      const requiresPaidPurchase = !previewSummary.nextIsFree;
      const isPaidExtraLine = occupiedExcludingSelf >= previewSummary.freeIncluded;
      const hasPaidPurchaseAuthorization =
        !!(after.smsPaidLinePurchaseAuthorizationId || "").toString().trim() &&
        !!(after.smsPaidLinePurchaseInvoiceId || "").toString().trim() &&
        authorizationExpiresMs > Date.now();
      if (requiresPaidPurchase && !hasPaidPurchaseAuthorization) {
        await db.collection("users").doc(memberUid).set(
          {
            smsStatus: "failed",
            smsProvisionError:
              "Stripe payment confirmation is required before setting up this texting number.",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return null;
      }
      if (lineCount > summary.maxLines) {
        await db.collection("users").doc(memberUid).set(
          {
            smsStatus: "failed",
            smsProvisionError:
              sms.newSmsLineBlockReason(tenant, plan, lineCount - 1) ||
              "No texting line capacity remaining.",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return null;
      }
      await provisionMemberSms(tenantId, tenant, memberUid, after, {
        isPaidExtra: isPaidExtraLine,
      });
      // Consume the authorization only after Twilio successfully provisions.
      if (requiresPaidPurchase) {
        const paidInvoiceId = (after.smsPaidLinePurchaseInvoiceId || "").toString();
        if (paidInvoiceId.startsWith("apple:")) {
          await appleSubscription.consumeSmsExtraPurchase(paidInvoiceId.slice("apple:".length));
        }
        await db.collection("users").doc(memberUid).set(
          {
            smsPaidLinePurchaseAuthorizationId: admin.firestore.FieldValue.delete(),
            smsPaidLinePurchaseInvoiceId: admin.firestore.FieldValue.delete(),
            smsPaidLinePurchaseAuthorizedAt: admin.firestore.FieldValue.delete(),
            smsPaidLinePurchaseExpiresAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (e) {
      console.error("onUserMemberSmsProvisionRequested", memberUid, e);
      await db.collection("users").doc(memberUid).set(
        {
          smsStatus: "failed",
          smsProvisionError: (e.message || String(e)).slice(0, 400),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return null;
  });

/** Booking status → client SMS (confirmed / declined). */
exports.onTenantBookingRequestSms = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .firestore.document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const prev = (before.status || "").toString().toLowerCase();
    const next = (after.status || "").toString().toLowerCase();
    if (prev === next) return null;
    return sendBookingClientStatusSms(
      context.params.tenantId,
      context.params.requestId,
      after,
      next
    );
  });

/** Twilio inbound SMS (STOP/HELP + inbound consent YES). */
exports.twilioInboundSms = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const authToken = (sms.twilioAuthToken.value() || "").toString().trim();
    const sig = (req.headers["x-twilio-signature"] || "").toString().trim();
    const url = (sms.inboundWebhookUrl() || "").toString().trim();
    const params = req.body || {};
    // Fail closed: never process inbound SMS without a verified Twilio signature.
    if (!authToken || !sig || !url) {
      console.warn("twilioInboundSms: missing auth token, signature, or webhook URL");
      res.status(403).send("Forbidden");
      return;
    }
    // eslint-disable-next-line global-require
    const twilio = require("twilio");
    const valid = twilio.validateRequest(authToken, sig, url, params);
    if (!valid) {
      console.warn("twilioInboundSms: invalid signature");
      res.status(403).send("Forbidden");
      return;
    }

    const from = (params.From || "").toString();
    const to = (params.To || "").toString();
    const rawBody = (params.Body || "").toString();
    const body = rawBody.trim().toUpperCase();

    let tenantId = null;
    let assignedMemberUid = null;
    let smsLineScope = "tenant";
    let tenantData = null;

    const tenantSnap = await db
      .collection("tenants")
      .where("smsPhoneNumber", "==", to)
      .limit(1)
      .get();
    if (!tenantSnap.empty) {
      tenantId = tenantSnap.docs[0].id;
      tenantData = tenantSnap.docs[0].data() || {};
    } else {
      const memberSnap = await db
        .collection("users")
        .where("smsPhoneNumber", "==", to)
        .limit(1)
        .get();
      if (!memberSnap.empty) {
        const memberDoc = memberSnap.docs[0];
        assignedMemberUid = memberDoc.id;
        tenantId = (memberDoc.data().tenantId || "").toString().trim() || null;
        smsLineScope = "member";
        if (tenantId) {
          const tSnap = await db.collection("tenants").doc(tenantId).get();
          tenantData = tSnap.exists ? tSnap.data() || {} : {};
        }
      }
    }
    if (!tenantId) {
      res.type("text/xml").send("<Response></Response>");
      return;
    }

    const businessName =
      (tenantData && (tenantData.businessName || tenantData.displayName)) ||
      "us";

    if (body === "STOP" || body === "UNSUBSCRIBE" || body === "CANCEL") {
      const optE164 = sms.toE164US(from) || from;
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsOptOuts")
        .doc(optE164.replace(/\W/g, "_"))
        .set({
          phone: optE164,
          optedOutAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      // Clear opted-in so profile reflects opt-out until they reply YES/START again.
      const last10 = (from || "").replace(/\D/g, "").slice(-10);
      if (last10.length === 10) {
        await db
          .collection("tenants")
          .doc(tenantId)
          .collection("customers")
          .doc(last10)
          .set(
            {
              smsOptedIn: false,
              smsOptedOutAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }
      // So the next inbound (e.g. "can I restart?") can get a fresh consent prompt.
      await sms.clearSmsConsentPromptSent(tenantId, from, {
        linePhone: to,
        lineScope: smsLineScope,
        memberUid: assignedMemberUid,
      });
      // Show the STOP and the unsubscribe reply in the conversation, so the app
      // picks up the change and turns off the message box right away.
      const stopThreadId = sms.lineScopedThreadId({
        linePhone: to,
        clientPhone: from,
        lineScope: smsLineScope,
        memberUid: assignedMemberUid,
      });
      const unsubscribed =
        "You have been unsubscribed. Reply YES or START to opt back in for appointment texts.";
      try {
        await sms.recordInboundTenantSms(tenantId, {
          from,
          to,
          body: rawBody,
          mediaUrls: [],
          threadId: stopThreadId,
          assignedMemberUid,
          smsLineScope,
        });
        await sms.recordSystemOutboundSms(tenantId, {
          from: to,
          to: from,
          body: unsubscribed,
          threadId: stopThreadId,
          assignedMemberUid,
          smsLineScope,
        });
      } catch (e) {
        console.warn("twilioInboundSms: STOP log", e.message || e);
      }
      res.type("text/xml").send(sms.twimlMessage(unsubscribed));
      return;
    }

    if (body === "HELP") {
      res
        .type("text/xml")
        .send(
          sms.twimlMessage(
            "Get Bookking client texting: appointment updates only. Reply STOP to opt out."
          )
        );
      return;
    }

    const inboundThreadId = sms.lineScopedThreadId({
      linePhone: to,
      clientPhone: from,
      lineScope: smsLineScope,
      memberUid: assignedMemberUid,
    });

    if (sms.isInboundConsentAffirmation(body)) {
      await sms.grantInboundSmsConsent(tenantId, from);
      const consentMedia = await sms.persistInboundTwilioMedia(tenantId, params);
      await sms.recordInboundTenantSms(tenantId, {
        from,
        to,
        body: rawBody,
        mediaUrls: consentMedia,
        threadId: inboundThreadId,
        assignedMemberUid,
        smsLineScope,
      });
      const confirmed = sms.inboundConsentConfirmedBody();
      try {
        await sms.recordSystemOutboundSms(tenantId, {
          from: to,
          to: from,
          body: confirmed,
          threadId: inboundThreadId,
          assignedMemberUid,
          smsLineScope,
        });
      } catch (e) {
        console.warn("twilioInboundSms: consent confirm log", e.message || e);
      }
      res.type("text/xml").send(sms.twimlMessage(confirmed));
      return;
    }

    const inboundMedia = await sms.persistInboundTwilioMedia(tenantId, params);
    await sms.recordInboundTenantSms(tenantId, {
      from,
      to,
      body: rawBody,
      mediaUrls: inboundMedia,
      threadId: inboundThreadId,
      assignedMemberUid,
      smsLineScope,
    });

    const consentTwiml = await sms.maybeSendInboundConsentPrompt(tenantId, {
      from,
      to,
      businessName,
      assignedMemberUid,
      smsLineScope,
    });
    res.type("text/xml").send(consentTwiml || "<Response></Response>");
  });
