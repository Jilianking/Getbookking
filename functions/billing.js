/**
 * Plans, sign-up checkout, trials, billing portal, Stripe subscription webhook.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  platformFeeCents,
  admin,
  Stripe,
  sms,
  teamPaymentSplit,
  stripeSecretKey,
  stripeSubscriptionPriceIds,
  stripeWebhookSecret,
  stripeConnectWebhookSecret,
  stripePublishableKeyParam,
  db,
  normalizeSubscriptionPlan,
  parseStripeSubscriptionPriceIds,
  providerTrialEndUnixFromTenant,
  planListPriceCents,
  stripePriceIdForPlan,
  stripeSmsExtraPriceId,
  stripeSmsExtraPriceIds,
  reconcileSmsExtraPaidToUsage,
  normalizeSignupWizardPayload,
  provisionNewProviderFromWizard,
  finalizeFromCheckoutSession,
  finalizeResubscribeFromCheckoutSession,
  finalizeInitialSubscriptionFromCheckoutSession,
  planNormFromStripeSubscription,
  subscriptionPlanFromStripe,
  subscriptionPlanEntitlementPatch,
  syncStripeSubscriptionStatusToTenant,
  handleConnectRefundWebhook,
  recordShopTaxTransactionFromCalculation,
  markShopOrderPaidFromPaymentIntent,
  markCharterBookingPaidFromPaymentIntent,
  expectedStripeLivemode,
  isRetryableWebhookError,
  handleConnectDisputeWebhook,
  confirmBookingAfterDepositPaid,
  getMemberAccessContext,
  normalizeMemberSettings,
  computeTeamPaymentSplit,
  resolveAttributedMemberUid,
  loadBookingRequestForPayment,
  billingPortalReturnBase,
  stripeErrorMessage,
  resolvePaymentMethodForCustomer,
  linkAndSyncTenantStripeBilling,
  messagingFieldsWithLineCount,
  assertSignupTrialOwner,
} = require("./core");

/**
 * Marketing wizard: after Firebase Auth sign-up, stores pending data and returns a Stripe
 * Checkout Session client secret for embedded Checkout on signup.html.
 */
exports.createProviderSubscriptionCheckout = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const email = context.auth.token.email || "";
    if (!email) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Account must have an email."
      );
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists && userSnap.data().tenantId) {
      throw new functions.https.HttpsError(
        "already-exists",
        "This account already has a business. Log in to the app or sign up with a new email."
      );
    }

    const normalized = normalizeSignupWizardPayload(data);
    const priceId = stripePriceIdForPlan(normalized.plan);

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured."
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const pendingRef = db.collection("pendingProviderSignups").doc(uid);
    const pendingPayload = {
      ...normalized,
      email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await pendingRef.set(pendingPayload, { merge: true });

    const origin = (data.marketingOrigin || "")
      .toString()
      .trim()
      .replace(/\/$/, "");
    const base =
      origin && /^https:\/\//i.test(origin)
        ? origin
        : "https://getbookking.com";

    const returnUrl = `${base}/signup.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        ui_mode: "embedded",
        customer_email: email,
        client_reference_id: uid,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { firebaseUid: uid, plan: normalized.plan },
        subscription_data: {
          trial_period_days: 14,
          metadata: { firebaseUid: uid, plan: normalized.plan },
        },
        return_url: returnUrl,
      });
    } catch (stripeErr) {
      console.error("createProviderSubscriptionCheckout Stripe", stripeErr);
      const raw =
        stripeErr && stripeErr.message ? String(stripeErr.message) : String(stripeErr);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Stripe could not start checkout: ${raw}`
      );
    }

    if (!session.client_secret) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe did not return an embedded checkout client secret. Confirm Checkout supports ui_mode=embedded for this API version and account."
      );
    }

    const pkOut = stripePublishableKeyParam.value().trim();
    const out = { clientSecret: session.client_secret };
    if (pkOut) {
      out.publishableKey = pkOut;
    }
    return out;
  });

exports.completeProviderSignupWithoutCheckout = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const email = context.auth.token.email || "";
  if (!email) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Account must have an email."
    );
  }

  const userSnap = await db.collection("users").doc(uid).get();
  if (userSnap.exists && userSnap.data().tenantId) {
    throw new functions.https.HttpsError(
      "already-exists",
      "This account already has a business. Log in to the app or sign up with a new email."
    );
  }

  const normalized = normalizeSignupWizardPayload(data);
  const pendingRef = db.collection("pendingProviderSignups").doc(uid);
  await pendingRef.set(
    {
      ...normalized,
      email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const pendingSnap = await pendingRef.get();
  const pending = pendingSnap.data() || normalized;

  const result = await provisionNewProviderFromWizard(uid, email, pending, {
    subscriptionStatus: "trialing",
  });
  await pendingRef.delete().catch(() => {});
  // Marketing email choice from the sign-up checkbox (separate from the Terms). Kept as proof of consent.
  if (data && typeof data.marketingEmailOptIn === "boolean") {
    await db.collection("users").doc(uid).set(
      {
        marketingEmailOptIn: data.marketingEmailOptIn,
        marketingEmailOptInAt: admin.firestore.FieldValue.serverTimestamp(),
        marketingEmailOptInSource: "web_signup",
      },
      { merge: true }
    ).catch((e) => console.warn("marketingEmailOptIn save failed", e.message || e));
  }
  return result;
});

/**
 * After returning from Stripe Checkout, client passes sessionId; verifies payment then provisions tenant.
 */
exports.completeProviderSubscriptionCheckout = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const sessionId = ((data && data.sessionId) || "").toString().trim();
    if (!sessionId) {
      throw new functions.https.HttpsError("invalid-argument", "sessionId is required.");
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if ((session.metadata && session.metadata.firebaseUid) !== uid) {
      throw new functions.https.HttpsError("permission-denied", "Invalid checkout session.");
    }

    const result = await finalizeFromCheckoutSession(stripe, session);
    if (!result) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Payment is not complete or signup data expired. Start again or contact support."
      );
    }
    return result;
  });

exports.stripeSubscriptionWebhook = functions
  .runWith({
    secrets: [
      stripeSecretKey,
      stripeWebhookSecret,
      stripeConnectWebhookSecret,
      stripeSubscriptionPriceIds,
      require("./customDomain").namecheapApiKey,
    ],
  })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const secretKey = stripeSecretKey.value();
    const whSecret = stripeWebhookSecret.value();
    let connectWhSecret = "";
    try {
      connectWhSecret = (stripeConnectWebhookSecret.value() || "").trim();
    } catch (_) {
      connectWhSecret = "";
    }
    if (!secretKey || !whSecret) {
      console.error("stripeSubscriptionWebhook: missing secrets");
      res.status(503).send("Not configured");
      return;
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const sig = req.headers["stripe-signature"];
    let event;
    let verifiedWith = "";
    try {
      const payload = req.rawBody || req.body;
      if (!Buffer.isBuffer(payload)) {
        console.error("stripeSubscriptionWebhook: rawBody missing; verify webhook payload");
        res.status(400).send("Webhook payload error");
        return;
      }
      // Two Stripe destinations post to this URL with different signing secrets:
      // "Your account" (subscriptions / Checkout) and "Connected accounts" (customer charges).
      // Verify against each; reject only when neither matches.
      try {
        event = stripe.webhooks.constructEvent(payload, sig, whSecret);
        verifiedWith = "account";
      } catch (accountErr) {
        if (!connectWhSecret) throw accountErr;
        event = stripe.webhooks.constructEvent(payload, sig, connectWhSecret);
        verifiedWith = "connect";
      }
    } catch (err) {
      console.error("stripe webhook signature", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    console.log(
      "stripeSubscriptionWebhook",
      JSON.stringify({
        id: event.id,
        type: event.type,
        via: verifiedWith,
        account: event.account || null,
        livemode: !!event.livemode,
      })
    );

    if (!!event.livemode !== expectedStripeLivemode(secretKey)) {
      console.warn(
        "stripeSubscriptionWebhook livemode mismatch",
        JSON.stringify({
          id: event.id,
          type: event.type,
          livemode: !!event.livemode,
        })
      );
      res.json({ received: true, skipped: "livemode" });
      return;
    }

    const handlerErrors = [];
    const track = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        console.error(
          "stripeSubscriptionWebhook",
          name,
          e && e.message ? e.message : e
        );
        handlerErrors.push(e);
      }
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      await track("checkout.session.completed", async () => {
        const full = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ["subscription"],
        });
        await finalizeFromCheckoutSession(stripe, full);
      });
    }

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const meta = pi.metadata || {};
      if ((meta.paymentKind || "").toString() === "shop" && meta.shopOrderId && meta.tenantId) {
        await track("shop_order_paid", async () => {
          await markShopOrderPaidFromPaymentIntent(
            stripe,
            meta.tenantId.toString(),
            meta.shopOrderId.toString(),
            pi.id
          );
        });
      } else if (
        (meta.paymentKind || "").toString() === "domain_purchase" ||
        (meta.paymentKind || "").toString() === "domain_transfer"
      ) {
        await track("domain_fulfill", async () => {
          const { fulfillDomainPaymentIntent } = require("./customDomain");
          await fulfillDomainPaymentIntent(pi.id);
        });
      } else if (
        meta.tenantId &&
        ["deposit", "service"].includes((meta.paymentKind || "").toString())
      ) {
        await track("record_and_settle", async () => {
          const tenantId = meta.tenantId.toString();
          const tenantSnap = await db.collection("tenants").doc(tenantId).get();
          if (tenantSnap.exists) {
            const tenantData = tenantSnap.data() || {};
            const isCharterPayment =
              normalizeSubscriptionPlan(tenantData.subscriptionPlan) === "charter" &&
              !!meta.bookingRequestId;
            const chargeAccountId = (
              meta.chargeStripeAccountId ||
              event.account ||
              ""
            )
              .toString()
              .trim();
            if (isCharterPayment) {
              await markCharterBookingPaidFromPaymentIntent(
                stripe,
                tenantId,
                meta.bookingRequestId.toString(),
                pi.id,
                pi
              );
            }
            if (chargeAccountId) {
              const settled = await teamPaymentSplit.recordAndSettleTenantPayment(stripe, {
                db,
                tenantId,
                tenant: tenantData,
                pi,
                stripeAccountId: chargeAccountId,
                chargeStripeScopeHint:
                  (meta.chargeStripeScope || "").toString() || null,
                initiatedByUidFallback:
                  (meta.initiatedByUid || "").toString() || null,
                platformFeeCents,
                normalizeSubscriptionPlan,
                normalizeMemberSettings,
                computeTeamPaymentSplit,
                resolveAttributedMemberUid,
                loadBookingRequestForPayment,
                confirmBookingAfterDepositPaid,
              });
              console.log(
                "stripeSubscriptionWebhook ledger",
                JSON.stringify({
                  pi: pi.id,
                  tenantId,
                  account: chargeAccountId,
                  paymentKind: (meta.paymentKind || "").toString(),
                  grossCents: settled && settled.grossCents,
                  alreadyRecorded: !!(settled && settled.alreadyRecorded),
                  studioShareStatus: (settled && settled.studioShareStatus) || null,
                })
              );
            } else {
              console.warn(
                "stripeSubscriptionWebhook ledger skipped: no Connect account id",
                JSON.stringify({ pi: pi.id, tenantId, paymentKind: (meta.paymentKind || "").toString() })
              );
            }
            if (
              !chargeAccountId &&
              (meta.paymentKind || "").toString() === "deposit" &&
              meta.bookingRequestId
            ) {
              await confirmBookingAfterDepositPaid(
                tenantId,
                meta.bookingRequestId.toString(),
                pi
              );
            }
          }
        });
      }

      const taxCalculationId = (meta.taxCalculationId || "").toString().trim();
      const taxAccountId = (meta.chargeStripeAccountId || "").toString().trim();
      if (
        taxCalculationId &&
        taxAccountId &&
        (meta.paymentKind || "").toString() !== "shop"
      ) {
        await track("tax_transaction", async () => {
          await recordShopTaxTransactionFromCalculation(
            stripe,
            taxAccountId,
            taxCalculationId,
            pi.id
          );
        });
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await track("subscription_sync", async () => {
        const sub = event.data.object;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id;
        if (customerId) {
          let fullSub = sub;
          if (sub.id && (!sub.items || !sub.items.data)) {
            try {
              fullSub = await stripe.subscriptions.retrieve(sub.id, {
                expand: ["items.data.price"],
              });
            } catch (retrieveErr) {
              console.warn("stripeSubscriptionWebhook retrieve sub", retrieveErr.message);
            }
          }
          await syncStripeSubscriptionStatusToTenant(
            stripe,
            customerId,
            fullSub.status,
            fullSub
          );
        }
      });
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      await track("invoice_sync", async () => {
        const inv = event.data.object;
        const customerId =
          typeof inv.customer === "string" ? inv.customer : inv.customer && inv.customer.id;
        // Older API versions put the subscription on the invoice; newer ones (2025-03-31 onward,
        // including the live webhooks' 2026-03-25.dahlia) put it under parent.subscription_details.
        const invSub =
          inv.subscription ||
          (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
        if (customerId && invSub) {
          const subId = typeof invSub === "string" ? invSub : invSub.id;
          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ["items.data.price"],
          });
          await syncStripeSubscriptionStatusToTenant(stripe, customerId, sub.status, sub);
        }
      });
    }

    if (event.type === "refund.updated" || event.type === "charge.refunded") {
      await track("connect_refund", async () => {
        await handleConnectRefundWebhook(stripe, db, event);
      });
    }

    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
      await track("connect_dispute", async () => {
        await handleConnectDisputeWebhook(stripe, db, event);
      });
    }

    const retryable = handlerErrors.find(isRetryableWebhookError);
    if (retryable) {
      res.status(500).send("Webhook handler failed");
      return;
    }
    res.json({ received: true });
  });

/**
 * Marketing account page: Stripe Customer Portal (subscription, payment method, invoices).
 * Enable: Stripe Dashboard → Settings → Billing → Customer portal; allow return URL host there.
 */
exports.createBillingPortalSession = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const uid = context.auth.uid;
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No account profile found. Complete sign-up first."
        );
      }
      const userData = userSnap.data() || {};
      const tenantId = (userData.tenantId || "").toString().trim();
      if (!tenantId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No business linked to this account yet."
        );
      }
      const tenantSnap = await db.collection("tenants").doc(tenantId).get();
      if (!tenantSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Business not found.");
      }
      const tenantData = tenantSnap.data() || {};
      const stripeCustomerId = (tenantData.stripeCustomerId || "").toString().trim();
      if (!stripeCustomerId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Billing is not set up for this business yet. If you just subscribed, wait a minute and try again, or contact support."
        );
      }
      const secretKey = stripeSecretKey.value();
      if (!secretKey) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe is not configured. Run: firebase functions:secrets:set STRIPE_SECRET_KEY"
        );
      }
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const base = billingPortalReturnBase(data);
      const returnUrl = `${base}/billing.html?billing=portal`;

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
      });
      if (!session || !session.url) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe did not return a portal URL."
        );
      }
      // Invalidate cached card label so the next billing load re-resolves from Stripe.
      try {
        await db.collection("tenants").doc(tenantId).set(
          {
            billingPaymentMethodLabel: admin.firestore.FieldValue.delete(),
            billingPaymentMethodExpiry: admin.firestore.FieldValue.delete(),
            billingPaymentMethodCachedAt: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
      } catch (_) {
        /* non-fatal */
      }
      return { url: session.url };
    } catch (e) {
      if (e && typeof e.code === "string" && e.code.startsWith("functions/") && e.code !== "functions/ok") {
        throw e;
      }
      console.error("createBillingPortalSession", e);
      const raw = stripeErrorMessage(e);
      const baseHint = billingPortalReturnBase(data);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Could not open billing portal. In Stripe: enable Customer portal and allow return URL ${baseHint}/billing.html. ${raw}`
      );
    }
  });

/**
 * Marketing account page: read-only subscription status, plan label, renewal, card mask, recent invoices.
 */
exports.getBillingSummary = functions
  .runWith({
    secrets: [
      stripeSecretKey,
      stripeSubscriptionPriceIds,
      sms.twilioAccountSid,
      sms.twilioAuthToken,
    ],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const uid = context.auth.uid;
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No account profile found. Complete sign-up first."
        );
      }
      const userData = userSnap.data() || {};
      const tenantId = (userData.tenantId || "").toString().trim();
      const firestorePlanOnly = normalizeSubscriptionPlan(userData.subscriptionPlan);
      if (!tenantId) {
        return {
          ok: true,
          hasStripeCustomer: false,
          firestorePlan: firestorePlanOnly,
          message: "No business linked to this account yet.",
          subscriptionPaymentBypass: sms.isSubscriptionPaymentGateBypassed() === true,
        };
      }
      const tenantSnap = await db.collection("tenants").doc(tenantId).get();
      if (!tenantSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Business not found.");
      }
      const tenantData = tenantSnap.data() || {};
      const firestorePlan = normalizeSubscriptionPlan(
        userData.subscriptionPlan || tenantData.subscriptionPlan
      );
      const stripeCustomerId = (tenantData.stripeCustomerId || "").toString().trim();
      const firestoreSubscriptionStatus = (
        tenantData.subscriptionStatus || "trialing"
      ).toString();
      const trialEndUnix = providerTrialEndUnixFromTenant(tenantData);
      if (!stripeCustomerId) {
        // A plan bought in the iOS app is billed by Apple: never ask for it again here.
        const appleBilled = (tenantData.billingSource || "").toString() === "apple";
        const needsInitialCheckout = !appleBilled && firestoreSubscriptionStatus === "trialing";
        const appleExtras = appleBilled
          ? {
              messaging: await messagingFieldsWithLineCount(tenantId, tenantData, userData),
              smsAddOn: {
                hasCard: !!(tenantData.smsAddOnCardLabel || "").toString().trim(),
                cardLabel: (tenantData.smsAddOnCardLabel || "").toString(),
                monthlyLines: sms.smsExtraPaidQuantity(tenantData),
              },
            }
          : {};
        return {
          ok: true,
          hasStripeCustomer: false,
          ...appleExtras,
          billingSource: appleBilled ? "apple" : "",
          firestorePlan,
          firestoreSubscriptionStatus,
          trialEndUnix,
          listPriceCents: planListPriceCents(firestorePlan),
          needsInitialCheckout,
          message: appleBilled
            ? "Your plan is billed through the App Store."
            : needsInitialCheckout
            ? "Add a payment method to start or secure your plan."
            : "Billing is not set up for this business yet.",
          subscriptionPaymentBypass: sms.isSubscriptionPaymentGateBypassed() === true,
        };
      }
      const secretKey = stripeSecretKey.value();
      if (!secretKey) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe is not configured. Run: firebase functions:secrets:set STRIPE_SECRET_KEY"
        );
      }
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const stripeSubscriptionId = (tenantData.stripeSubscriptionId || "").toString().trim();

      let sub = null;
      if (stripeSubscriptionId) {
        try {
          sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
            expand: ["items.data.price.product", "default_payment_method"],
          });
        } catch (err) {
          console.warn("getBillingSummary retrieve subscription", stripeSubscriptionId, err.message);
        }
      }
      if (!sub) {
        const list = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: "all",
          limit: 12,
        });
        const prefer = new Set(["active", "trialing", "past_due", "paused"]);
        const ranked = [...list.data].sort((a, b) => {
          const aP = prefer.has(a.status) ? 0 : 1;
          const bP = prefer.has(b.status) ? 0 : 1;
          if (aP !== bP) return aP - bP;
          return b.created - a.created;
        });
        const pick = ranked[0];
        if (pick) {
          try {
            sub = await stripe.subscriptions.retrieve(pick.id, {
              expand: ["items.data.price.product", "default_payment_method"],
            });
          } catch (err) {
            console.warn("getBillingSummary retrieve picked subscription", pick.id, err.message);
            sub = pick;
          }
        }
      }

      let paymentMethodLabel = "";
      let paymentMethodExpiry = "";
      const cachedPm = {
        label: (tenantData.billingPaymentMethodLabel || "").toString().trim(),
        expiry: (tenantData.billingPaymentMethodExpiry || "").toString().trim(),
      };
      const invList = await stripe.invoices.list({ customer: stripeCustomerId, limit: 8 });
      const pmDetails = await resolvePaymentMethodForCustomer(
        stripe,
        stripeCustomerId,
        sub,
        invList.data,
        cachedPm.label ? cachedPm : null
      );
      paymentMethodLabel = pmDetails.label || "";
      paymentMethodExpiry = pmDetails.expiry || "";
      if (
        paymentMethodLabel &&
        (paymentMethodLabel !== cachedPm.label ||
          paymentMethodExpiry !== cachedPm.expiry)
      ) {
        db.collection("tenants")
          .doc(tenantId)
          .set(
            {
              billingPaymentMethodLabel: paymentMethodLabel,
              billingPaymentMethodExpiry: paymentMethodExpiry || "",
              billingPaymentMethodCachedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch((err) =>
            console.warn("getBillingSummary cache payment method", err.message || err)
          );
      }

      let subscriptionPayload = null;
      let tenantForMessaging = tenantData;
      if (sub) {
        const items = (sub.items && sub.items.data) || [];
        let planItem = items[0];
        try {
          const map = parseStripeSubscriptionPriceIds();
          const planIds = new Set(
            ["solo", "studio", "shop", "charter"]
              .map((k) => (map[k] || "").toString().trim())
              .filter(Boolean)
          );
          const extraIds = new Set(stripeSmsExtraPriceIds());
          const extraId = stripeSmsExtraPriceId();
          planItem =
            items.find((it) => {
              const price = it.price;
              const pid =
                (price && typeof price === "object" && price.id) ||
                (typeof price === "string" ? price : "");
              return planIds.has((pid || "").toString().trim());
            }) ||
            items.find((it) => {
              const price = it.price;
              const pid =
                (price && typeof price === "object" && price.id) ||
                (typeof price === "string" ? price : "");
              return !extraIds.has((pid || "").toString().trim());
            }) ||
            items[0];
          if (extraIds.size) {
            // Drop prepaid empty extras so 3rd+ always requires purchase when used >= free.
            const usedNow = await sms.countOccupiedSmsLines(tenantId, tenantForMessaging);
            try {
              const reconciled = await reconcileSmsExtraPaidToUsage(
                stripe,
                tenantId,
                tenantForMessaging,
                firestorePlan,
                usedNow
              );
              tenantForMessaging = reconciled.tenant;
            } catch (reconcileErr) {
              console.error(
                "getBillingSummary reconcileSmsExtra",
                tenantId,
                reconcileErr.message || reconcileErr
              );
            }
          }
        } catch (priceErr) {
          console.warn("getBillingSummary plan price map", priceErr.message || priceErr);
        }

        let planName = "";
        let unitAmount = null;
        let currency = "usd";
        let interval = "";
        if (planItem && planItem.price) {
          const price = planItem.price;
          const product = price.product;
          if (typeof product === "object" && product && product.name) {
            planName = String(product.name);
          } else {
            planName = (price.nickname || "").toString();
          }
          unitAmount = price.unit_amount;
          currency = (price.currency || "usd").toString();
          interval = price.recurring && price.recurring.interval ? String(price.recurring.interval) : "";
        }
        // Prefer canonical Firestore plan labels for marketing UI.
        if (firestorePlan) {
          planName =
            firestorePlan.charAt(0).toUpperCase() + firestorePlan.slice(1);
        }
        subscriptionPayload = {
          id: sub.id,
          status: sub.status,
          planName,
          unitAmount,
          currency,
          interval,
          currentPeriodEnd: sub.current_period_end || null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        };
      }

      const invoices = invList.data.map((inv) => ({
        id: inv.id,
        number: inv.number || inv.id,
        created: inv.created,
        amountPaid: inv.amount_paid,
        currency: (inv.currency || "usd").toString(),
        status: inv.status,
        hostedInvoiceUrl: inv.hosted_invoice_url || "",
      }));

      const messaging = await messagingFieldsWithLineCount(
        tenantId,
        tenantForMessaging,
        userData
      );

      return {
        ok: true,
        hasStripeCustomer: true,
        firestorePlan,
        paymentMethodLabel: paymentMethodLabel || "",
        paymentMethodExpiry: paymentMethodExpiry || "",
        subscription: subscriptionPayload,
        invoices,
        messaging,
        // Testing: when true, UI must not offer “start subscription today” (no charge path).
        subscriptionPaymentBypass: sms.isSubscriptionPaymentGateBypassed() === true,
      };
    } catch (e) {
      if (e && typeof e.code === "string" && e.code.startsWith("functions/") && e.code !== "functions/ok") {
        throw e;
      }
      console.error("getBillingSummary", e);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Could not load billing summary. ${stripeErrorMessage(e)}`
      );
    }
  });

/** Owner: pull Stripe customer/subscription into Firestore (fixes dashboard vs app mismatch). */
exports.syncTenantBillingFromStripe = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can sync billing."
      );
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const ownerEmail =
      (ctx.ownerUserData && ctx.ownerUserData.email) ||
      (ctx.userData && ctx.userData.email) ||
      context.auth.token.email ||
      "";
    const linked = await linkAndSyncTenantStripeBilling(
      stripe,
      ctx.tenantId,
      ctx.tenant,
      ownerEmail
    );
    const messaging = await messagingFieldsWithLineCount(
      ctx.tenantId,
      linked.tenant,
      ctx.ownerUserData
    );
    return {
      ok: true,
      stripeCustomerId: linked.stripeCustomerId,
      stripeSubscriptionId: linked.stripeSubscriptionId,
      subscriptionStatus: linked.subscriptionStatus,
      ...messaging,
    };
  });

/**
 * Owner: Stripe Checkout to restart a canceled/unpaid subscription (no free trial).
 */
exports.createResubscribeCheckout = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    // Testing: do not open Checkout that charges a card.
    if (sms.isSubscriptionPaymentGateBypassed()) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Paid checkout is temporarily disabled for testing. Features are unlocked without paying."
      );
    }
    const uid = context.auth.uid;
    const ctx = await getMemberAccessContext(uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can resubscribe."
      );
    }

    const status = sms.resolveSubscriptionStatus(ctx.tenant, ctx.ownerUserData);
    if (status === "active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your subscription is already active."
      );
    }
    if (status === "trialing") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Use Start subscription today during your free trial."
      );
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const ownerEmail =
      (ctx.ownerUserData && ctx.ownerUserData.email) ||
      (ctx.userData && ctx.userData.email) ||
      context.auth.token.email ||
      "";

    const linked = await linkAndSyncTenantStripeBilling(
      stripe,
      ctx.tenantId,
      ctx.tenant,
      ownerEmail
    );
    const customerId = (linked.stripeCustomerId || "").toString().trim();
    if (!customerId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No Stripe customer found for this business."
      );
    }

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
    const blocking = subs.data.find((s) => s.status === "active" || s.status === "trialing");
    if (blocking) {
      const msg =
        blocking.status === "trialing"
          ? "Use Start subscription today during your free trial."
          : "Your subscription is already active.";
      throw new functions.https.HttpsError("failed-precondition", msg);
    }

    const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
    const priceId = stripePriceIdForPlan(plan);
    const base = billingPortalReturnBase(data);
    const successUrl = `${base}/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${base}/billing.html?checkout=canceled`;

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: uid,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: {
          firebaseUid: uid,
          tenantId: ctx.tenantId,
          checkoutKind: "resubscribe",
        },
        subscription_data: {
          metadata: {
            firebaseUid: uid,
            tenantId: ctx.tenantId,
            checkoutKind: "resubscribe",
            plan,
          },
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
    } catch (stripeErr) {
      console.error("createResubscribeCheckout Stripe", stripeErr);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Stripe could not start checkout: ${stripeErrorMessage(stripeErr)}`
      );
    }

    if (!session.url) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe did not return a checkout URL."
      );
    }

    return { url: session.url };
  });

/**
 * Owner: first hosted Checkout after cardless signup (start today or charge at trial end).
 */
exports.createInitialSubscriptionCheckout = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    if (sms.isSubscriptionPaymentGateBypassed()) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Paid checkout is temporarily disabled for testing. Features are unlocked without paying."
      );
    }
    const uid = context.auth.uid;
    const ctx = await getMemberAccessContext(uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can manage billing."
      );
    }

    const stripeCustomerId = (ctx.tenant.stripeCustomerId || "").toString().trim();
    if (stripeCustomerId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Billing is already set up. Use billing settings to change your plan or payment method."
      );
    }

    const firestoreStatus = sms.resolveSubscriptionStatus(ctx.tenant, ctx.ownerUserData);
    if (firestoreStatus !== "trialing") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your trial has ended or billing is not available in this state. Contact support."
      );
    }

    const billingStartRaw = ((data && data.billingStart) || "today").toString().trim();
    const billingStart =
      billingStartRaw === "trial_end" || billingStartRaw === "trialEnd"
        ? "trial_end"
        : "today";
    const checkoutKind = billingStart === "trial_end" ? "initial_trial_end" : "initial_today";

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const ownerEmail =
      (ctx.ownerUserData && ctx.ownerUserData.email) ||
      (ctx.userData && ctx.userData.email) ||
      context.auth.token.email ||
      "";

    const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
    const priceId = stripePriceIdForPlan(plan);
    const base = billingPortalReturnBase(data);
    const returnUrl = `${base}/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const successUrl = returnUrl;
    const cancelUrl = `${base}/billing.html?checkout=canceled`;
    const uiModeRaw = ((data && data.uiMode) || "embedded").toString().trim().toLowerCase();
    const useEmbedded = uiModeRaw !== "hosted";

    const subscriptionData = {
      metadata: {
        firebaseUid: uid,
        tenantId: ctx.tenantId,
        checkoutKind,
        plan,
      },
    };
    if (billingStart === "trial_end") {
      subscriptionData.trial_end = providerTrialEndUnixFromTenant(ctx.tenant);
    }

    const sessionPayload = {
      mode: "subscription",
      customer_email: ownerEmail,
      client_reference_id: uid,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        firebaseUid: uid,
        tenantId: ctx.tenantId,
        checkoutKind,
        plan,
      },
      subscription_data: subscriptionData,
    };

    let session;
    try {
      if (useEmbedded) {
        session = await stripe.checkout.sessions.create({
          ...sessionPayload,
          ui_mode: "embedded",
          return_url: returnUrl,
        });
      } else {
        session = await stripe.checkout.sessions.create({
          ...sessionPayload,
          success_url: successUrl,
          cancel_url: cancelUrl,
        });
      }
    } catch (stripeErr) {
      console.error("createInitialSubscriptionCheckout Stripe", stripeErr);
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Stripe could not start checkout: ${stripeErrorMessage(stripeErr)}`
      );
    }

    if (useEmbedded) {
      if (!session.client_secret) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe did not return an embedded checkout client secret."
        );
      }
      const pkOut = stripePublishableKeyParam.value().trim();
      const out = {
        clientSecret: session.client_secret,
        billingStart,
        checkoutKind,
        uiMode: "embedded",
      };
      if (pkOut) out.publishableKey = pkOut;
      return out;
    }

    if (!session.url) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe did not return a checkout URL."
      );
    }

    return { url: session.url, billingStart, checkoutKind, uiMode: "hosted" };
  });

/** After initial billing Checkout, verify payment and sync Firestore billing. */
exports.completeInitialSubscriptionCheckout = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const sessionId = ((data && data.sessionId) || "").toString().trim();
    if (!sessionId) {
      throw new functions.https.HttpsError("invalid-argument", "sessionId is required.");
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const result = await finalizeInitialSubscriptionFromCheckoutSession(stripe, session, uid);
    if (!result) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Payment is not complete or this checkout session is invalid."
      );
    }
    return result;
  });

exports.createSignupCardSetup = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    if (sms.isSubscriptionPaymentGateBypassed()) {
      throw new functions.https.HttpsError("failed-precondition", "Paid checkout is temporarily disabled for testing. Features are unlocked without paying.");
    }
    const uid = context.auth.uid;
    const ctx = await assertSignupTrialOwner(uid);
    const secretKey = stripeSecretKey.value();
    if (!secretKey) throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    // Reuse the customer from an earlier try (e.g. a declined card) instead of making another.
    let customerId = (ctx.tenant.signupStripeCustomerId || "").toString().trim();
    if (!customerId) {
      const email =
        (ctx.ownerUserData && ctx.ownerUserData.email) || context.auth.token.email || undefined;
      const customer = await stripe.customers.create({
        email,
        name: (ctx.tenant.businessName || ctx.tenant.displayName || "").toString() || undefined,
        metadata: { firebaseUid: uid, tenantId: ctx.tenantId },
      });
      customerId = customer.id;
      await db.collection("tenants").doc(ctx.tenantId).set({ signupStripeCustomerId: customerId }, { merge: true });
    }
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: { firebaseUid: uid, tenantId: ctx.tenantId, purpose: "signup_trial" },
    });
    return {
      clientSecret: setupIntent.client_secret,
      publishableKey: stripePublishableKeyParam.value().trim() || null,
    };
  });

/**
 * Step 2: after the card is saved, start the plan. Default: a 14-day trial that charges that card when
 * the trial ends (same as "Start billing when the trial ends" in Plan & billing). With startToday, the
 * plan starts and is charged now (same as "Start today"), unlocking texting and payments right away.
 * Params: { setupIntentId, startToday? }.
 */
exports.startSignupTrialSubscription = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    const uid = context.auth.uid;
    const setupIntentId = ((data && data.setupIntentId) || "").toString().trim();
    if (!setupIntentId.startsWith("seti_")) {
      throw new functions.https.HttpsError("invalid-argument", "setupIntentId is required.");
    }
    const ctx = await assertSignupTrialOwner(uid);
    const secretKey = stripeSecretKey.value();
    if (!secretKey) throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const customerId = (ctx.tenant.signupStripeCustomerId || "").toString().trim();
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const siCustomer = typeof si.customer === "string" ? si.customer : si.customer && si.customer.id;
    if (!customerId || siCustomer !== customerId || (si.metadata && si.metadata.tenantId) !== ctx.tenantId) {
      throw new functions.https.HttpsError("permission-denied", "This card setup doesn't belong to your business.");
    }
    if (si.status !== "succeeded") {
      throw new functions.https.HttpsError("failed-precondition", "The card wasn't saved. Check the card and try again.");
    }
    const paymentMethodId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method && si.payment_method.id;
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });

    const startToday = !!(data && data.startToday);
    const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
    const meta = {
      firebaseUid: uid,
      tenantId: ctx.tenantId,
      checkoutKind: startToday ? "initial_today" : "initial_trial_end",
      plan,
    };
    const subParams = {
      customer: customerId,
      items: [{ price: stripePriceIdForPlan(plan) }],
      default_payment_method: paymentMethodId,
      metadata: meta,
      expand: ["items.data.price"],
    };
    if (startToday) {
      // Charge now; if the bank declines, nothing is created and the owner can fix the card or pick the trial.
      subParams.payment_behavior = "error_if_incomplete";
    } else {
      subParams.trial_end = providerTrialEndUnixFromTenant(ctx.tenant);
    }
    let sub;
    try {
      sub = await stripe.subscriptions.create(subParams, {
        idempotencyKey: `signup_${startToday ? "today" : "trial"}_${ctx.tenantId}_${setupIntentId}`,
      });
    } catch (stripeErr) {
      console.error("startSignupTrialSubscription Stripe", stripeErr);
      throw new functions.https.HttpsError("failed-precondition", `Stripe could not start your trial: ${stripeErrorMessage(stripeErr)}`);
    }

    const syncPatch = { stripeSubscriptionId: sub.id, stripeCustomerId: customerId };
    const planNorm = subscriptionPlanFromStripe(ctx.tenant && ctx.tenant.subscriptionPlan, planNormFromStripeSubscription(sub), sub);
    if (planNorm) {
      syncPatch.subscriptionPlan = planNorm;
      Object.assign(syncPatch, subscriptionPlanEntitlementPatch(ctx.tenant, planNorm));
    }
    await sms.syncSubscriptionStatusForTenant(ctx.tenantId, sub.status, syncPatch);
    return { ok: true, tenantId: ctx.tenantId, subscriptionStatus: sub.status };
  });

/** After resubscribe Checkout, verify payment and sync Firestore billing. */
exports.completeResubscribeCheckout = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const sessionId = ((data && data.sessionId) || "").toString().trim();
    if (!sessionId) {
      throw new functions.https.HttpsError("invalid-argument", "sessionId is required.");
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const result = await finalizeResubscribeFromCheckoutSession(stripe, session, uid);
    if (!result) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Payment is not complete or this checkout session is invalid."
      );
    }
    return result;
  });

/** Owner: end free trial now and charge subscription (unlocks client texting setup). */
exports.startSubscriptionToday = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can start the subscription."
      );
    }

    // Always end trial when owner confirms — needed to unlock client texting even if
    // testing paid-feature bypass is on. Coupons on the sub still apply to the invoice.
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured.");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    let tenant = ctx.tenant;
    let subId = (tenant.stripeSubscriptionId || "").toString().trim();
    if (!subId) {
      const ownerEmail =
        (ctx.ownerUserData && ctx.ownerUserData.email) ||
        context.auth.token.email ||
        "";
      const linked = await linkAndSyncTenantStripeBilling(
        stripe,
        ctx.tenantId,
        tenant,
        ownerEmail
      );
      tenant = linked.tenant;
      subId = linked.stripeSubscriptionId;
    }
    if (!subId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No subscription found. Add your plan at getbookking.com/billing.html."
      );
    }
    const sub = await stripe.subscriptions.retrieve(subId);
    if (sub.status === "active") {
      await sms.syncSubscriptionStatusForTenant(ctx.tenantId, "active");
      return { ok: true, subscriptionStatus: "active", alreadyActive: true };
    }
    if (sub.status !== "trialing") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Subscription is ${sub.status}. Update billing in the customer portal.`
      );
    }
    const updated = await stripe.subscriptions.update(subId, { trial_end: "now" });
    await sms.syncSubscriptionStatusForTenant(ctx.tenantId, updated.status);
    if (updated.status !== "active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe could not activate the subscription. Update your payment method and try again."
      );
    }
    return { ok: true, subscriptionStatus: updated.status };
  });
