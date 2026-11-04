/**
 * Stripe account setup, balance, payouts, receipts, refunds, statement name.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  platformFeeCents,
  computeCardCheckoutAmounts,
  admin,
  Stripe,
  teamPaymentSplit,
  isDemoShowcaseStripeAccountId,
  loadDemoShowcaseForPayCtx,
  demoConnectAccountStatusResponse,
  demoConnectBalanceResponse,
  demoConnectTransactionsResponse,
  stripeSecretKey,
  stripePublishableKeyParam,
  db,
  normalizeSubscriptionPlan,
  reconcileConnectAccountId,
  ensureConnectAccountId,
  ensureNoNegativeBalanceBankDebits,
  connectAccountPendingReview,
  createConnectAccountLinkWithFallback,
  connectAccountStatusUrl,
  computeInPersonCheckoutTotals,
  createCustomerCheckoutPaymentIntent,
  pricedCustomerCheckoutFromMetadata,
  parseServiceAmountCents,
  paidFeatureAccessForTenant,
  resolvePaymentStripeContext,
  assertCanTakePayments,
  resolveEffectivePaymentContext,
  assertCanInitiateBookingPayment,
  retrievePaymentIntentOnConnectAccounts,
  getTenantIdForUser,
  assertTenantOwner,
  tapToPayTerminalDisplayNameForTenant,
  tapToPayTerminalDisplayNameForUser,
  tapToPayPaymentSettingsForScope,
  instantAvailableCentsFromBalance,
  loadPayoutDestinationLabels,
  enrichConnectBalanceTransaction,
  loadCancelRefundBlockForCharge,
  stripeHasRefundForPendingRow,
  applyCancelRefundBlocksToTransactions,
  loadCancelRefundBookingRows,
  pendingCancelRefundTransactionRows,
  receiptServiceLabel,
  receiptLineItemsFromAmounts,
  findPaymentLedgerEntry,
  refundConnectCharge,
  maybeCalculateInPersonSalesTax,
  checkoutMethodFromPaymentMethod,
  confirmBookingAfterDepositPaid,
  normalizeMemberSettings,
  computeTeamPaymentSplit,
  buildTeamSplitFeeAndMetaForCharge,
  resolveAttributedMemberUid,
  loadBookingRequestForPayment,
} = require("./core");

/**
 * Creates a Stripe Connect Account Link for the authenticated provider.
 * If the tenant has no Connect account, creates one first and saves stripeAccountId to Firestore.
 * Returns { url: string } to open in a browser for onboarding.
 */
exports.createConnectAccountLink = functions
  .runWith({ secrets: [stripeSecretKey], timeoutSeconds: 120 })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const uid = context.auth.uid;
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured. Run: firebase functions:secrets:set STRIPE_SECRET_KEY"
      );
    }

    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-11-20.acacia",
    });

    try {
      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Account not found");
      }
      const userData = userDoc.data();
      const tenantId = userData.tenantId;
      const email = userData.email || context.auth.token?.email;
      if (!tenantId) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No business linked to this account. Finish signup first."
        );
      }

      const payCtx = await resolvePaymentStripeContext(uid);
      if (!payCtx?.canConnect) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Connect your Stripe account in Payments to take payments."
        );
      }

      const tenantRef = db.collection("tenants").doc(tenantId);
      const accountRef =
        payCtx.scope === "user"
          ? db.collection("users").doc(uid)
          : tenantRef;
      const ensured = await ensureConnectAccountId(
        stripe,
        accountRef,
        email,
        payCtx.stripeAccountId
      );
      const stripeAccountId = ensured.stripeAccountId;
      const account = ensured.account;

      if (account.charges_enabled) {
        return {
          alreadyConnected: true,
          chargesEnabled: true,
          hasAccount: true,
          detailsSubmitted: account.details_submitted ?? false,
          stripeAccountId,
        };
      }

      // Waiting on Stripe with nothing currently due — open dashboard so they can check status.
      if (connectAccountPendingReview(account)) {
        const status = await connectAccountStatusUrl(stripe, account, stripeAccountId);
        return {
          pendingReview: true,
          hasAccount: true,
          detailsSubmitted: true,
          chargesEnabled: false,
          stripeAccountId,
          url: status.url,
          linkType: "dashboard",
        };
      }

      const baseUrl = (data?.returnBaseUrl ?? "https://getbookking.com").toString().replace(/\/$/, "");
      const returnUrl = data?.returnUrl ?? `${baseUrl}/account.html?stripe=success`;
      const refreshUrl = data?.refreshUrl ?? `${baseUrl}/account.html?stripe=refresh`;
      const preferUpdate = !!account.details_submitted;
      const { accountLink, linkType } = await createConnectAccountLinkWithFallback(
        stripe,
        stripeAccountId,
        { returnUrl, refreshUrl, preferUpdate }
      );

      if (!accountLink?.url) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe did not return an onboarding link."
        );
      }

      return {
        url: accountLink.url,
        linkType,
        hasAccount: true,
        detailsSubmitted: account.details_submitted ?? false,
        chargesEnabled: false,
        paymentScope: payCtx.scope,
      };
    } catch (err) {
      if (err instanceof functions.https.HttpsError) {
        throw err;
      }
      console.error("createConnectAccountLink", err);
      const msg =
        err && err.message
          ? String(err.message)
          : "Stripe Connect failed. Enable Connect in the Stripe Dashboard and verify STRIPE_SECRET_KEY.";
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/**
 * Opens the connected account's Stripe dashboard.
 * - Express (legacy): one-time createLoginLink URL
 * - Standard (current): Stripe Dashboard login (full Dashboard)
 * Callable name kept for mobile/web clients.
 */
exports.createExpressDashboardLink = functions
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
    const payCtx = await resolvePaymentStripeContext(uid);
    if (!payCtx?.canConnect && !payCtx?.canTakePayments) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to manage payments for this business."
      );
    }
    const stripeAccountId = (payCtx.stripeAccountId || "").toString().trim();
    if (!stripeAccountId || isDemoShowcaseStripeAccountId(stripeAccountId)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Connect Stripe before opening the dashboard."
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const account = await stripe.accounts.retrieve(stripeAccountId);
    if (!account.details_submitted) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Finish Stripe setup before opening the dashboard."
      );
    }

    const accountType = (account.type || "").toString();
    // Standard accounts use the full Stripe Dashboard (no Express login links).
    if (accountType === "standard") {
      return {
        url: "https://dashboard.stripe.com/login",
        accountType: "standard",
      };
    }

    try {
      const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
      if (!loginLink?.url) {
        throw new Error("Stripe did not return a dashboard link.");
      }
      return { url: loginLink.url, accountType: accountType || "express" };
    } catch (err) {
      console.warn(
        "createExpressDashboardLink login link failed; using Stripe Dashboard",
        stripeAccountId,
        err?.message || err
      );
      return {
        url: "https://dashboard.stripe.com/login",
        accountType: accountType || "unknown",
      };
    }
  });

/**
 * Returns the Stripe Connect account status for the authenticated provider's tenant.
 * Used to show "approval pending" vs "fully connected" on the payments screen.
 * Returns { hasAccount, detailsSubmitted, chargesEnabled, payoutsEnabled }.
 */
exports.getConnectAccountStatus = functions
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

    const payCtx = await resolvePaymentStripeContext(uid);
    if (!payCtx?.canTakePayments) {
      return {
        hasAccount: false,
        canTakePayments: false,
        usesOwnPayments: false,
        payoutMode: payCtx?.payoutMode || "independent",
        studioPayroll: false,
      };
    }

    const demoShowcase = await loadDemoShowcaseForPayCtx(db, payCtx);
    if (demoShowcase) {
      return demoConnectAccountStatusResponse(demoShowcase.payCtx);
    }
    const paidFeatureAccess = await paidFeatureAccessForTenant(payCtx.tenantId);

    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-11-20.acacia",
    });

    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const email =
      userData.email || context.auth.token?.email || null;
    const accountRef =
      payCtx.scope === "user"
        ? db.collection("users").doc(uid)
        : db.collection("tenants").doc(payCtx.tenantId);

    let account = null;
    let stripeAccountId = payCtx.stripeAccountId;
    if (!isDemoShowcaseStripeAccountId(stripeAccountId)) {
      const reconciled = await reconcileConnectAccountId(
        stripe,
        accountRef,
        stripeAccountId,
        email
      );
      if (reconciled) {
        stripeAccountId = reconciled.stripeAccountId;
        account = reconciled.account;
      }
    }

    if (!stripeAccountId) {
      return {
        hasAccount: false,
        canTakePayments: true,
        usesOwnPayments: payCtx.scope === "user",
        payoutMode: payCtx.payoutMode,
        paymentScope: payCtx.scope,
        subscriptionPaid: paidFeatureAccess.paid,
        subscriptionTrialing: paidFeatureAccess.trialing,
        subscriptionStatus: paidFeatureAccess.status,
        paidFeatureUpgradeMessage: paidFeatureAccess.message,
      };
    }

    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return demoConnectAccountStatusResponse(payCtx);
    }

    if (!account) {
      account = await stripe.accounts.retrieve(stripeAccountId);
    }
    account = await ensureNoNegativeBalanceBankDebits(stripe, account);

    const terminalLocationId = payCtx.terminalLocationId || null;
    const tenantDoc = await db.collection("tenants").doc(payCtx.tenantId).get();
    const tenantData = tenantDoc.exists ? tenantDoc.data() : {};
    const tapToPayDisplayName =
      payCtx.scope === "user"
        ? tapToPayTerminalDisplayNameForUser(userData, tenantData)
        : tapToPayTerminalDisplayNameForTenant(tenantData);
    const tapToPaySettings = tapToPayPaymentSettingsForScope(
      payCtx.scope,
      tenantData,
      userData
    );

    return {
      hasAccount: true,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      terminalLocationId,
      tapToPayDisplayName,
      tapToPayRequireSignature: tapToPaySettings.tapToPayRequireSignature,
      tapToPayAutoOfferReceipt: tapToPaySettings.tapToPayAutoOfferReceipt,
      tapToPayReceiptDelivery: tapToPaySettings.tapToPayReceiptDelivery,
      tapToPayReceiptShowBusinessName: tapToPaySettings.tapToPayReceiptShowBusinessName,
      tapToPayReceiptItemized: tapToPaySettings.tapToPayReceiptItemized,
      tapToPayReceiptCustomFooter: tapToPaySettings.tapToPayReceiptCustomFooter,
      tapToPayReceiptFooterMessage: tapToPaySettings.tapToPayReceiptFooterMessage,
      statementDescriptor:
        (account.settings?.payments?.statement_descriptor || "").toString().trim() ||
        null,
      statementDescriptorPrefix:
        (account.settings?.card_payments?.statement_descriptor_prefix || "")
          .toString()
          .trim() || null,
      canTakePayments: true,
      usesOwnPayments: payCtx.scope === "user",
      payoutMode: payCtx.payoutMode,
      paymentScope: payCtx.scope,
      subscriptionPaid: paidFeatureAccess.paid,
      subscriptionTrialing: paidFeatureAccess.trialing,
      subscriptionStatus: paidFeatureAccess.status,
      paidFeatureUpgradeMessage: paidFeatureAccess.message,
    };
  });

/**
 * Updates the connected account statement descriptor (bank/card statement text).
 * Params: { statementDescriptor: string, statementDescriptorPrefix?: string }
 * Owner → tenant Connect account; independent member → user Connect account.
 */
exports.updateStatementDescriptor = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const uid = context.auth.uid;
    const payCtx = await assertCanTakePayments(uid);
    if (payCtx.scope !== "user") {
      await assertTenantOwner(uid, payCtx.tenantId);
    }

    const stripeAccountId = (payCtx.stripeAccountId || "").toString().trim();
    if (!stripeAccountId || isDemoShowcaseStripeAccountId(stripeAccountId)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Connect Stripe before setting a statement descriptor."
      );
    }

    const descriptor = (data?.statementDescriptor ?? "")
      .toString()
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
    if (descriptor.length < 5 || descriptor.length > 22) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Statement descriptor must be 5–22 characters."
      );
    }
    if (!/^[A-Z0-9. ]+$/.test(descriptor)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Use letters, numbers, periods, and spaces only."
      );
    }

    // Periods are valid Stripe statement characters (e.g. BLEUSTATTOOS.COM).

    let prefix;
    if (data?.statementDescriptorPrefix !== undefined) {
      prefix = (data.statementDescriptorPrefix ?? "")
        .toString()
        .trim()
        .toUpperCase()
        .replace(/\s+/g, " ");
    } else {
      prefix = descriptor.slice(0, 10);
    }
    if (prefix.length < 2 || prefix.length > 10) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Card prefix must be 2–10 characters."
      );
    }
    if (!/^[A-Z0-9. ]+$/.test(prefix)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Card prefix: use letters, numbers, periods, and spaces only."
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
    if (!account.details_submitted) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Finish Stripe setup before setting a statement descriptor."
      );
    }

    const currentDescriptor = (
      account.settings?.payments?.statement_descriptor || ""
    )
      .toString()
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
    const currentPrefix = (
      account.settings?.card_payments?.statement_descriptor_prefix || ""
    )
      .toString()
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
    if (currentDescriptor === descriptor) {
      return {
        statementDescriptor: currentDescriptor,
        statementDescriptorPrefix: currentPrefix || prefix,
        prefixOnly: false,
      };
    }

    let updated;
    let prefixOnly = false;
    try {
      updated = await stripe.accounts.update(stripeAccountId, {
        settings: {
          payments: { statement_descriptor: descriptor },
          card_payments: { statement_descriptor_prefix: prefix },
        },
      });
    } catch (err) {
      const paymentsLocked = /required permissions for the parameter ['"]payments['"]/i.test(
        String((err && err.message) || "")
      );
      if (!paymentsLocked) {
        console.error("updateStatementDescriptor", err);
        const msg =
          (err && err.message) ||
          "Could not update statement descriptor. Try a name closer to your business.";
        throw new functions.https.HttpsError("invalid-argument", msg);
      }
      try {
        updated = await stripe.accounts.update(stripeAccountId, {
          settings: {
            card_payments: { statement_descriptor_prefix: prefix },
          },
        });
        prefixOnly = true;
      } catch (prefixErr) {
        console.error("updateStatementDescriptor prefix", prefixErr);
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Stripe manages the full statement name on this account. Open Stripe dashboard to change it."
        );
      }
    }

    return {
      statementDescriptor:
        (updated.settings?.payments?.statement_descriptor || "").toString().trim() ||
        descriptor,
      statementDescriptorPrefix:
        (updated.settings?.card_payments?.statement_descriptor_prefix || "")
          .toString()
          .trim() || prefix,
      prefixOnly,
    };
  });

/**
 * Returns the Connect account balance.
 * { availableCents, pendingCents, instantAvailableCents, instantPayoutEligible,
 *   standardPayoutDestinationLabel, instantPayoutDestinationLabel }.
 * instantAvailableCents uses net_available (after platform Instant fees) when present.
 */
exports.getConnectBalance = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const demoShowcase = await loadDemoShowcaseForPayCtx(db, payCtx);
    if (demoShowcase) {
      return demoConnectBalanceResponse(demoShowcase.payments);
    }
    const emptyDest = {
      standardPayoutDestinationLabel: null,
      instantPayoutDestinationLabel: null,
    };
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
        ...emptyDest,
      };
    }
    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
        ...emptyDest,
      };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
        ...emptyDest,
      };
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const balance = await stripe.balance.retrieve(
      { expand: ["instant_available.net_available"] },
      { stripeAccount: stripeAccountId }
    );
    const available = balance.available?.find((b) => b.currency === "usd");
    const pending = balance.pending?.find((b) => b.currency === "usd");
    const instantAvailableCents = instantAvailableCentsFromBalance(balance);

    let standardPayoutDestinationLabel = null;
    let instantPayoutDestinationLabel = null;
    let hasInstantDestination = false;
    let destinationsLoaded = false;
    try {
      const dest = await loadPayoutDestinationLabels(stripe, stripeAccountId);
      standardPayoutDestinationLabel = dest.standardPayoutDestinationLabel;
      instantPayoutDestinationLabel = dest.instantPayoutDestinationLabel;
      hasInstantDestination = dest.instantPayoutEligible;
      destinationsLoaded = true;
    } catch (e) {
      console.warn("payout destination labels failed", e?.message || e);
    }

    let instantPayoutEligible = false;
    if (instantAvailableCents >= 50) {
      instantPayoutEligible = destinationsLoaded
        ? hasInstantDestination
        : true;
    }

    return {
      availableCents: available?.amount ?? 0,
      pendingCents: pending?.amount ?? 0,
      instantAvailableCents,
      instantPayoutEligible,
      standardPayoutDestinationLabel,
      instantPayoutDestinationLabel,
    };
  });

/**
 * Creates a payout to the connected account's bank.
 * amountCents in USD cents. method: "standard" (default) | "instant".
 */
exports.createPayout = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const amountCents = data?.amountCents;
    if (typeof amountCents !== "number" || amountCents < 50) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Amount must be at least 50 cents ($0.50)"
      );
    }
    const methodRaw = (data?.method || "standard").toString().trim().toLowerCase();
    const method = methodRaw === "instant" ? "instant" : "standard";
    if (method === "instant" && amountCents > 999900) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Instant payouts are limited to $9,999.00 per payout."
      );
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
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
    try {
      await stripe.payouts.create(
        {
          amount: Math.round(amountCents),
          currency: "usd",
          method,
        },
        { stripeAccount: stripeAccountId }
      );
    } catch (err) {
      const msg =
        (err && err.message) ||
        (method === "instant"
          ? "Instant payout failed. Your bank may not support Instant Payouts, or funds aren’t eligible yet."
          : "Payout failed. Try again or check Stripe setup.");
      console.error("createPayout", method, err);
      throw new functions.https.HttpsError(
        "failed-precondition",
        msg
      );
    }
    return { success: true, method };
  });

/**
 * Creates a Payment Link for deposits. amountCents in USD cents.
 * Optional: productName, productDescription for customization.
 * Returns { url: string } to share with customers.
 */
exports.createDepositLink = functions
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
    const payCtx = await assertCanInitiateBookingPayment(
      uid,
      await resolveEffectivePaymentContext(uid, { bookingRequestId, tenantId })
    );
    const checkout = computeCardCheckoutAmounts(serviceAmount, "online");
    const productName = (data?.productName || "Deposit").toString().trim() || "Deposit";
    const productDescription = data?.productDescription
      ? data.productDescription.toString().trim()
      : undefined;
    const paymentKind = (data?.paymentKind || "deposit").toString().trim() || "deposit";
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
    const splitFee = await buildTeamSplitFeeAndMetaForCharge({
      tenant: tenantData,
      tenantId,
      payCtx,
      paymentKind,
      serviceCents: checkout.serviceCents,
      grossCents: checkout.totalCents,
    });
    const feeCents = splitFee.applicationFeeCents;
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const paymentMeta = {
      tenantId: tenantId || "",
      paymentKind,
      productName,
      serviceAmountCents: String(checkout.serviceCents),
      feeBaseCents: String(checkout.serviceCents),
      surchargeCents: String(checkout.surchargeCents),
      checkoutMethod: "card",
      bookingRequestId,
      initiatedByUid: uid,
      attributedMemberUid,
      chargeStripeAccountId: stripeAccountId,
      chargeStripeScope: payCtx.scope || "tenant",
      checkoutChannel: "deposit_link",
      ...splitFee.splitMeta,
    };
    const pi = await createCustomerCheckoutPaymentIntent(stripe, stripeAccountId, {
      amount: checkout.totalCents,
      currency: "usd",
      application_fee_amount: feeCents,
      metadata: paymentMeta,
      description: productDescription ? `${productName} — ${productDescription}` : productName,
    });
    if (tenantId) {
      await db.collection("tenants").doc(tenantId).collection("paymentCheckouts").doc(pi.id).set({
        stripeAccountId,
        paymentIntentId: pi.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    const slug = (tenantData.slug || "").toString().trim().toLowerCase();
    if (!slug) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This business has no public link yet."
      );
    }
    const customDomain = (tenantData.customDomain || "").toString().trim().toLowerCase();
    const domainStatus = (tenantData.customDomainStatus || "").toString().trim().toLowerCase();
    const host =
      customDomain && (domainStatus === "active" || domainStatus === "connected")
        ? customDomain
        : `${slug}.getbookking.com`;
    return {
      url: `https://${host}/pay?pi=${encodeURIComponent(pi.id)}`,
      paymentIntentId: pi.id,
      platformFeeCents: splitFee.platformFeeCents,
      studioShareCents: splitFee.studioShareCents,
      serviceCents: checkout.serviceCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: checkout.totalCents,
      attributedMemberUid,
      chargeStripeScope: payCtx.scope || "tenant",
    };
  });

/**
 * In-app manual checkout: set the PaymentIntent amount to the method the customer
 * actually confirmed (card vs Link bank) so the business nets the service amount.
 * Params: { paymentIntentId, paymentMethodId }
 */
exports.repriceInAppCheckout = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const paymentIntentId = (data?.paymentIntentId || "").toString().trim();
    const paymentMethodId = (data?.paymentMethodId || "").toString().trim();
    if (!paymentIntentId.startsWith("pi_") || !paymentMethodId.startsWith("pm_")) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "paymentIntentId and paymentMethodId are required"
      );
    }
    const uid = context.auth.uid;
    const tenantId = await getTenantIdForUser(uid);
    const bookingRequestId = (data?.bookingRequestId || "").toString().trim();
    const payCtx = await assertCanInitiateBookingPayment(
      uid,
      await resolveEffectivePaymentContext(uid, { bookingRequestId, tenantId })
    );
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      stripeAccount: stripeAccountId,
    });
    const meta = pi.metadata || {};
    if ((meta.checkoutChannel || "") !== "manual_in_app") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This payment cannot be repriced here."
      );
    }
    if ((meta.tenantId || "") !== (tenantId || "") && (meta.initiatedByUid || "") !== uid) {
      throw new functions.https.HttpsError("permission-denied", "This payment is not for this account.");
    }
    if ((meta.chargeStripeAccountId || "") !== stripeAccountId) {
      throw new functions.https.HttpsError("permission-denied", "This payment is not for this account.");
    }
    if (pi.status === "succeeded" || pi.status === "canceled") {
      throw new functions.https.HttpsError("failed-precondition", "This payment can no longer be updated.");
    }
    const classified = await checkoutMethodFromPaymentMethod(
      stripe,
      stripeAccountId,
      paymentMethodId
    );
    if (!classified) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Could not price this payment method."
      );
    }
    let pricingMeta = meta;
    if (!(parseInt(meta.feeBaseCents, 10) > 0)) {
      const service = parseInt(meta.serviceAmountCents, 10) || 0;
      const tax = parseInt(meta.taxCents, 10) || 0;
      pricingMeta = { ...meta, feeBaseCents: String(service + tax) };
    }
    const priced = pricedCustomerCheckoutFromMetadata(pricingMeta, classified);
    if (!priced) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This payment is missing its service amount."
      );
    }
    await stripe.paymentIntents.update(
      paymentIntentId,
      {
        amount: priced.totalCents,
        application_fee_amount: priced.applicationFeeCents,
        metadata: {
          ...meta,
          feeBaseCents: pricingMeta.feeBaseCents,
          surchargeCents: String(priced.surchargeCents),
          checkoutMethod: priced.method,
          platformFeeCents: String(priced.platformFeeCents),
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      method: priced.method,
      rateLabel: priced.rateLabel,
      serviceCents: priced.serviceCents,
      taxCents: Math.max(0, parseInt(meta.taxCents, 10) || 0),
      surchargeCents: priced.surchargeCents,
      totalCents: priced.totalCents,
      platformFeeCents: priced.platformFeeCents,
    };
  });

/**
 * Creates a PaymentIntent for in-app manual card entry (Stripe Payment Sheet).
 * Same pricing as createDepositLink; returns clientSecret for iOS.
 */
exports.createPaymentIntentForManualCheckout = functions
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
    const payCtx = await assertCanInitiateBookingPayment(
      uid,
      await resolveEffectivePaymentContext(uid, { bookingRequestId, tenantId })
    );
    const paymentKind = (data?.paymentKind || "service").toString().trim() || "service";
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
    const priced = computeInPersonCheckoutTotals(serviceAmount, taxCents, "online");
    const totalCents = priced.totalCents;
    const splitFee = await buildTeamSplitFeeAndMetaForCharge({
      tenant: tenantData,
      tenantId,
      payCtx,
      paymentKind,
      serviceCents: priced.serviceCents,
      grossCents: totalCents,
    });
    const feeCents = splitFee.applicationFeeCents;
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const pi = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        payment_method_types: ["card"],
        application_fee_amount: feeCents,
        capture_method: "automatic",
        metadata: {
          tenantId: tenantId || "",
          paymentKind,
          serviceAmountCents: String(priced.serviceCents),
          feeBaseCents: String(priced.serviceCents + priced.taxCents),
          taxCents: String(priced.taxCents),
          surchargeCents: String(priced.surchargeCents),
          ...(tax.taxCalculationId ? { taxCalculationId: tax.taxCalculationId } : {}),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
          checkoutChannel: "manual_in_app",
          ...splitFee.splitMeta,
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeAccountId,
      // The app uses this key, not one built into it, so switching Stripe to live mode never
      // leaves an older app version holding a test key.
      publishableKey: stripePublishableKeyParam.value().trim() || null,
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
 * Preview in-person sales tax for manual / Tap to Pay amount entry UI.
 * Params: { serviceAmountCents: number }
 * Returns: { enabled, taxCents }
 */
exports.previewInPersonSalesTax = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const serviceAmount = parseServiceAmountCents(data) ?? 0;
    if (serviceAmount < 50) {
      return { enabled: false, taxCents: 0 };
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = (payCtx.stripeAccountId || "").toString().trim();
    if (!stripeAccountId || isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return { enabled: false, taxCents: 0 };
    }
    const tenantDoc = await db.collection("tenants").doc(payCtx.tenantId).get();
    const tenantData = tenantDoc.exists ? tenantDoc.data() || {} : {};
    if (tenantData.inPersonTaxEnabled !== true) {
      return { enabled: false, taxCents: 0 };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const tax = await maybeCalculateInPersonSalesTax(
      stripe,
      stripeAccountId,
      tenantData,
      serviceAmount
    );
    return {
      enabled: true,
      taxCents: tax.taxCents || 0,
    };
  });

/**
 * Returns balance transactions for the Connect account within a date range.
 * Params: { startTimestampSeconds?: number, endTimestampSeconds?: number, limit?: number }
 * Returns { transactions: Array<{ id, type, amount, fee, net, created, description, reportingCategory }> }.
 */
exports.getConnectBalanceTransactions = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const startTs = data?.startTimestampSeconds;
    const endTs = data?.endTimestampSeconds;
    const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 100, 1), 100);

    const demoShowcase = await loadDemoShowcaseForPayCtx(db, payCtx);
    if (demoShowcase) {
      return demoConnectTransactionsResponse(demoShowcase.payments, {
        startTimestampSeconds: startTs,
        endTimestampSeconds: endTs,
        limit,
      });
    }

    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      return { transactions: [] };
    }
    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return { transactions: [] };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      return { transactions: [] };
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const params = { limit };
    if (typeof startTs === "number" && startTs > 0) {
      params.created = params.created || {};
      params.created.gte = startTs;
    }
    if (typeof endTs === "number" && endTs > 0) {
      params.created = params.created || {};
      params.created.lte = endTs;
    }
    params.expand = ["data.source"];
    const list = await stripe.balanceTransactions.list(
      params,
      { stripeAccount: stripeAccountId }
    );
    const transactions = await Promise.all(
      (list.data || []).map((t) =>
        enrichConnectBalanceTransaction(stripe, t, stripeAccountId)
      )
    );
    payCtx.uid = context.auth.uid;
    const ledgerRows = await teamPaymentSplit.ledgerStudioShareRowsForPayCtx(
      db,
      payCtx,
      { startTs, endTs, limit }
    );
    const ledgerTransferIds = new Set(
      ledgerRows
        .map((r) => (r.sourceId || "").toString().trim())
        .filter((id) => id.startsWith("tr_"))
    );
    const ledgerCreditAmounts = new Map();
    for (const r of ledgerRows) {
      if (r.isCredit === false) continue;
      const amt = Math.abs(Math.round(Number(r.net) || Number(r.amount) || 0));
      if (amt <= 0) continue;
      ledgerCreditAmounts.set(amt, (ledgerCreditAmounts.get(amt) || 0) + 1);
    }
    const isOwnerFeed = payCtx.isOwner === true || payCtx.scope === "tenant";
    const stripeRows = transactions.filter((t) => {
      const sid = (t.sourceId || "").toString().trim();
      if (sid && ledgerTransferIds.has(sid)) return false;
      if (!isOwnerFeed || !ledgerRows.length) return true;
      // Drop unlabeled Connect transfer credits that duplicate a unique ledger share.
      const amt = Math.abs(Math.round(Number(t.net) || Number(t.amount) || 0));
      const ch = (t.chargeId || "").toString();
      const looksLikeCharge = ch.startsWith("ch_") || sid.startsWith("pi_") || sid.startsWith("ch_");
      if (
        t.isCredit !== false &&
        amt > 0 &&
        ledgerCreditAmounts.get(amt) === 1 &&
        !looksLikeCharge &&
        ((t.type || "") === "payment" || (t.reportingCategory || "") === "transfer")
      ) {
        return false;
      }
      return true;
    });
    for (const row of ledgerRows) {
      stripeRows.push(row);
    }
    const attributed = await teamPaymentSplit.attachStudioShareAttribution(
      db,
      payCtx,
      stripeRows
    );
    let pendingCancelRows = [];
    let issuedCancelRows = [];
    try {
      pendingCancelRows = await pendingCancelRefundTransactionRows(
        db,
        payCtx.tenantId
      );
      const [refundedRows, alreadyRows] = await Promise.all([
        loadCancelRefundBookingRows(db, payCtx.tenantId, "refunded"),
        loadCancelRefundBookingRows(db, payCtx.tenantId, "already_refunded"),
      ]);
      issuedCancelRows = [...refundedRows, ...alreadyRows];
    } catch (err) {
      console.warn(
        "pendingCancelRefundTransactionRows",
        (err && err.message) || err
      );
    }
    const pendingToShow = pendingCancelRows.filter(
      (row) => !stripeHasRefundForPendingRow(attributed, row)
    );
    const pendingAlreadyIssued = pendingCancelRows.filter((row) =>
      stripeHasRefundForPendingRow(attributed, row)
    );
    applyCancelRefundBlocksToTransactions(attributed, {
      pendingRows: pendingToShow,
      issuedRows: [...issuedCancelRows, ...pendingAlreadyIssued],
    });
    for (const row of pendingToShow) {
      attributed.push(row);
    }
    attributed.sort((a, b) => (b.created || 0) - (a.created || 0));
    return { transactions: attributed.slice(0, limit) };
  });

/**
 * Returns receipt URL for a charge. Params: { chargeId: string }.
 * Returns { url: string } (Stripe receipt page).
 */
exports.getReceiptUrl = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const chargeId = (data?.chargeId || "").toString().trim();
    if (!chargeId || !chargeId.startsWith("ch_")) {
      throw new functions.https.HttpsError("invalid-argument", "Valid chargeId required");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const charge = await stripe.charges.retrieve(
      chargeId,
      { stripeAccount: stripeAccountId }
    );
    const url = charge.receipt_url || null;
    if (!url) {
      throw new functions.https.HttpsError("not-found", "Receipt not available for this charge");
    }
    return { url };
  });

/**
 * Returns structured receipt data for in-app display, PDF export, and sharing.
 * Params: { chargeId: string }
 */
exports.getPaymentReceiptDetail = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const chargeId = (data?.chargeId || "").toString().trim();
    if (!chargeId || !chargeId.startsWith("ch_")) {
      throw new functions.https.HttpsError("invalid-argument", "Valid chargeId required");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const charge = await stripe.charges.retrieve(
      chargeId,
      { expand: ["payment_intent"] },
      { stripeAccount: stripeAccountId }
    );
    const pi =
      charge.payment_intent && typeof charge.payment_intent === "object"
        ? charge.payment_intent
        : null;
    const meta = {
      ...(pi?.metadata || {}),
      ...(charge.metadata || {}),
    };
    const tenantId = (meta.tenantId || payCtx.tenantId || "").toString().trim();
    if (!tenantId) {
      throw new functions.https.HttpsError("failed-precondition", "No business linked to this payment.");
    }

    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    const tenant = tenantSnap.exists ? tenantSnap.data() : {};
    const businessName =
      (tenant.businessName || tenant.displayName || "Receipt").toString().trim() ||
      "Receipt";

    const paymentIntentId =
      pi?.id ||
      (typeof charge.payment_intent === "string" ? charge.payment_intent : null);
    const ledger = await findPaymentLedgerEntry(tenantId, {
      paymentIntentId,
      chargeId,
    });

    const bookingRequestId = (meta.bookingRequestId || "").toString().trim();
    let customerName =
      (charge.billing_details?.name || "").toString().trim() || null;
    let customerEmail =
      (charge.billing_details?.email || "").toString().trim() || null;
    let serviceName = null;
    if (bookingRequestId) {
      const booking = await loadBookingRequestForPayment(tenantId, bookingRequestId);
      if (booking) {
        customerName =
          (booking.customerName || customerName || "").toString().trim() || customerName;
        customerEmail =
          (booking.customerEmail || customerEmail || "").toString().trim() || customerEmail;
        serviceName = (booking.serviceName || "").toString().trim() || null;
      }
    }

    const paymentKind = (meta.paymentKind || ledger?.paymentKind || "deposit").toString();
    let serviceCents = parseInt(meta.serviceAmountCents, 10);
    let surchargeCents = parseInt(meta.surchargeCents, 10);
    let taxCents = parseInt(meta.taxCents, 10);
    let grossCents = charge.amount || 0;

    if (ledger) {
      if (ledger.serviceCents > 0) serviceCents = ledger.serviceCents;
      if (ledger.surchargeCents >= 0) surchargeCents = ledger.surchargeCents;
      if (ledger.taxCents >= 0) taxCents = ledger.taxCents;
      if (ledger.grossCents > 0) grossCents = ledger.grossCents;
    }
    if (Number.isNaN(taxCents) || taxCents < 0) taxCents = 0;
    if (Number.isNaN(serviceCents) || serviceCents <= 0) {
      serviceCents = Math.max(
        0,
        grossCents -
          (Number.isNaN(surchargeCents) ? 0 : surchargeCents) -
          taxCents
      );
    }
    if (Number.isNaN(surchargeCents)) {
      surchargeCents = Math.max(0, grossCents - serviceCents - taxCents);
    }

    const lineItems = receiptLineItemsFromAmounts({
      serviceCents,
      surchargeCents,
      taxCents,
      paymentKind,
      grossCents,
    });

    // Charter checkouts record the trip and the add-ons separately; show them as their own lines.
    const metaServiceCents = parseInt(meta.serviceCents, 10);
    const metaAddonCents = parseInt(meta.addonCents, 10) || 0;
    const metaServiceLabel = (meta.serviceLabel || "").toString().trim();
    if (
      metaServiceLabel &&
      Number.isFinite(metaServiceCents) &&
      metaServiceCents + metaAddonCents === serviceCents &&
      lineItems.length
    ) {
      const split = [{ name: metaServiceLabel, quantity: 1, amountCents: metaServiceCents }];
      if (metaAddonCents > 0) {
        const addonsLabel = (meta.addonsLabel || "").toString().trim();
        split.push({
          name: addonsLabel ? `Add-ons: ${addonsLabel}` : "Add-ons",
          quantity: 1,
          amountCents: metaAddonCents,
        });
      }
      lineItems.splice(0, 1, ...split);
    }
    if (!customerName && meta.customerName) {
      customerName = String(meta.customerName).trim() || null;
    }

    const serviceLabel = metaServiceLabel || serviceName || receiptServiceLabel(paymentKind);

    return {
      businessName,
      receiptNumber: charge.receipt_number || null,
      paidAt: charge.created || null,
      customerName,
      customerEmail,
      serviceLabel,
      paymentKind,
      lineItems,
      totalPaidCents: grossCents,
      serviceCents,
      taxCents,
      providerReceivedCents: serviceCents,
      stripeReceiptUrl: charge.receipt_url || null,
    };
  });

/**
 * Remaining refundable amount for a Connect charge (includes Dashboard/API refunds).
 * Params: { chargeId: string }.
 * Returns { amountCents, amountCapturedCents, amountRefundedCents, remainingRefundableCents }.
 */
exports.getChargeRefundStatus = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const chargeId = (data?.chargeId || "").toString().trim();
    if (!chargeId || !chargeId.startsWith("ch_")) {
      throw new functions.https.HttpsError("invalid-argument", "Valid chargeId required");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    let charge;
    try {
      charge = await stripe.charges.retrieve(chargeId, {
        stripeAccount: stripeAccountId,
      });
    } catch (err) {
      const msg =
        (err && err.message) || "Could not load this payment. Try again.";
      console.error("getChargeRefundStatus", err);
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
    const amountCents = charge.amount || 0;
    const amountCapturedCents =
      typeof charge.amount_captured === "number" && charge.amount_captured > 0
        ? charge.amount_captured
        : amountCents;
    const amountRefundedCents = charge.amount_refunded || 0;
    const remainingRefundableCents = Math.max(
      0,
      amountCapturedCents - amountRefundedCents
    );
    const paymentIntentId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent && charge.payment_intent.id;
    let refundBlocked = false;
    let refundBlockedReason = null;
    try {
      const block = await loadCancelRefundBlockForCharge(db, payCtx.tenantId, {
        chargeId,
        paymentIntentId,
      });
      if (block) {
        refundBlocked = true;
        refundBlockedReason = block.message;
      }
    } catch (err) {
      console.warn("getChargeRefundStatus cancel block", err && err.message);
    }
    return {
      amountCents,
      amountCapturedCents,
      amountRefundedCents,
      remainingRefundableCents,
      refundBlocked,
      refundBlockedReason,
    };
  });

/**
 * Creates a refund for a charge on the Connect account.
 * Params: {
 *   chargeId: string,
 *   amountCents?: number,
 *   reason?: string,
 *   idempotencyKey?: string  // client UUID per refund attempt; prevents duplicate refunds on retry
 * }.
 * Omit amountCents for full refund of remaining (amount_captured - amount_refunded).
 */
exports.createRefund = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const chargeId = (data?.chargeId || "").toString().trim();
    if (!chargeId || !chargeId.startsWith("ch_")) {
      throw new functions.https.HttpsError("invalid-argument", "Valid chargeId required");
    }
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const amountCentsRaw = data?.amountCents;
    if (
      amountCentsRaw !== undefined &&
      amountCentsRaw !== null &&
      typeof amountCentsRaw !== "number"
    ) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "amountCents must be a number (integer cents)."
      );
    }
    const amountCents =
      typeof amountCentsRaw === "number" && Number.isFinite(amountCentsRaw)
        ? Math.round(amountCentsRaw)
        : null;
    const allowedReasons = new Set([
      "duplicate",
      "fraudulent",
      "requested_by_customer",
    ]);
    const reasonRaw = (data?.reason || "requested_by_customer").toString().trim();
    const reason = allowedReasons.has(reasonRaw)
      ? reasonRaw
      : "requested_by_customer";
    const clientIdempotencyKey = (data?.idempotencyKey || "").toString().trim();
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const idempotencyKey = (
      clientIdempotencyKey ||
      `refund_${stripeAccountId}_${chargeId}_${amountCents || "full"}_${context.auth.uid}`
    ).slice(0, 255);

    let paymentIntentId = "";
    try {
      const charge = await stripe.charges.retrieve(chargeId, {
        stripeAccount: stripeAccountId,
      });
      const pi = charge.payment_intent;
      paymentIntentId = typeof pi === "string" ? pi : (pi && pi.id) || "";
    } catch (err) {
      console.warn("createRefund retrieve charge for cancel block", err && err.message);
    }
    const cancelBlock = await loadCancelRefundBlockForCharge(db, payCtx.tenantId, {
      chargeId,
      paymentIntentId,
    });
    if (cancelBlock) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        cancelBlock.message
      );
    }

    const result = await refundConnectCharge({
      stripe,
      stripeAccountId,
      tenantId: payCtx.tenantId,
      chargeId,
      amountCents,
      reason,
      idempotencyKey,
    });
    if (result.alreadyRefunded) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This payment has already been fully refunded."
      );
    }
    return {
      success: true,
      refundCents: result.refundCents,
      remainingRefundableCents: result.remainingRefundableCents,
    };
  });

/**
 * Retries failed studio-share transfers and failed studio-share reversals.
 * A transfer retry will not send a share already covered by a refund or lost dispute.
 * Runs every hour.
 */
exports.retryFailedStudioShareSettlements = functions
  .runWith({ secrets: [stripeSecretKey] })
  .pubsub.schedule("every 60 minutes")
  .onRun(async () => {
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      console.warn("retryFailedStudioShareSettlements: no Stripe secret");
      return null;
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const out = await teamPaymentSplit.retryFailedStudioShareSettlements(stripe, {
      db,
      normalizeSubscriptionPlan,
      limit: 25,
    });
    console.log(
      "retryFailedStudioShareSettlements",
      JSON.stringify({ attempted: out.attempted })
    );
    return null;
  });

/**
 * Records payment + team split after a successful card charge; transfers studio share when due.
 * Params: { paymentIntentId: string }
 */
exports.recordTenantPayment = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const paymentIntentId = (data?.paymentIntentId || "").toString().trim();
    if (!paymentIntentId || !paymentIntentId.startsWith("pi_")) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Valid paymentIntentId required"
      );
    }
    const uid = context.auth.uid;
    const tenantId = await getTenantIdForUser(uid);
    if (!tenantId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No business linked to this account."
      );
    }
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Business not found.");
    }
    const tenant = tenantSnap.data();
    const callerCtx = await resolvePaymentStripeContext(uid);
    const bookingRequestIdHint = (data?.bookingRequestId || "").toString().trim();
    const effectiveCtx = await resolveEffectivePaymentContext(uid, {
      bookingRequestId: bookingRequestIdHint,
      tenantId,
    });
    const accountCandidates = [];
    if (effectiveCtx?.stripeAccountId) accountCandidates.push(effectiveCtx.stripeAccountId);
    if (callerCtx?.stripeAccountId) accountCandidates.push(callerCtx.stripeAccountId);
    const tenantStripeId = (tenant.stripeAccountId || "").toString().trim();
    if (tenantStripeId) accountCandidates.push(tenantStripeId);

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe is not configured"
      );
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    let retrieved = await retrievePaymentIntentOnConnectAccounts(
      stripe,
      paymentIntentId,
      accountCandidates
    );
    if (!retrieved) {
      throw new functions.https.HttpsError(
        "not-found",
        "Payment not found on this business or team member account."
      );
    }
    const pi = retrieved.pi;
    const stripeAccountId = retrieved.stripeAccountId;
    const meta = pi.metadata || {};
    const metaBookingId = (meta.bookingRequestId || bookingRequestIdHint || "").toString().trim();
    const chargeCtx = metaBookingId
      ? await resolveEffectivePaymentContext(uid, {
          bookingRequestId: metaBookingId,
          tenantId,
        })
      : callerCtx;
    if (chargeCtx?.stripeAccountId && chargeCtx.stripeAccountId !== stripeAccountId) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Payment account does not match this booking."
      );
    }

    return teamPaymentSplit.recordAndSettleTenantPayment(stripe, {
      db,
      tenantId,
      tenant,
      pi,
      stripeAccountId,
      chargeStripeScopeHint: chargeCtx?.scope || meta.chargeStripeScope || null,
      initiatedByUidFallback: uid,
      platformFeeCents,
      normalizeSubscriptionPlan,
      normalizeMemberSettings,
      computeTeamPaymentSplit,
      resolveAttributedMemberUid,
      loadBookingRequestForPayment,
      confirmBookingAfterDepositPaid,
    });
  });
