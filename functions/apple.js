/**
 * App Store subscription sign-up and notifications.
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
  db,
  normalizeSubscriptionPlan,
  mirrorAppleSubscriptionStatus,
  getMemberAccessContext,
  claimAppleSmsExtraPurchase,
} = require("./core");

/**
 * Stable Apple appAccountToken for this login. Created once, then reused.
 * The purchase sheet must use this exact id so the signed receipt matches the account.
 */
exports.prepareAppleAccountToken = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const appleAppAccountToken = await appleSubscription.prepareAccountToken(context.auth.uid);
  return { appleAppAccountToken };
});

/**
 * Records an App Store subscription from Apple's signed transaction.
 * Introductory period stays trialing so texting stays off until Apple charges.
 * Cancels a Stripe trial so the website card is not also billed.
 */
exports.syncAppleSubscription = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can start the plan."
      );
    }
    const signedTransaction = ((data && data.signedTransaction) || "").toString().trim();
    if (!signedTransaction) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing App Store signature."
      );
    }
    let transaction;
    try {
      transaction = await appleSubscription.verifySignedTransaction(signedTransaction);
    } catch (error) {
      console.error("syncAppleSubscription verify", error.message || error);
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The App Store could not verify this purchase."
      );
    }
    if (!appleSubscription.planForProduct(transaction.productId)) {
      throw new functions.https.HttpsError("invalid-argument", "Unknown App Store plan.");
    }
    const userSnap = await db.collection("users").doc(context.auth.uid).get();
    const expectedToken = appleSubscription.normalizeAccountToken(
      userSnap.exists && userSnap.data().appleAppAccountToken
    );
    const receiptToken = appleSubscription.normalizeAccountToken(transaction.appAccountToken);
    if (!expectedToken || receiptToken !== expectedToken) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "This App Store purchase does not match this account."
      );
    }
    let applied;
    try {
      applied = await appleSubscription.applyVerifiedTransaction(
        ctx.tenantId,
        transaction,
        transaction.signedDate
      );
      await mirrorAppleSubscriptionStatus(ctx.tenantId, applied);
    } catch (error) {
      console.error("syncAppleSubscription apply", error.message || error);
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The App Store purchase could not be saved."
      );
    }
    const tenant = ctx.tenant || {};
    const stripeSubId = (tenant.stripeSubscriptionId || "").toString().trim();
    const stripeStatus = (tenant.subscriptionStatus || "").toString();
    if (stripeSubId && stripeStatus === "trialing") {
      try {
        const stripe = new Stripe(stripeSecretKey.value(), { apiVersion: "2024-11-20.acacia" });
        await stripe.subscriptions.cancel(stripeSubId);
      } catch (err) {
        console.warn("syncAppleSubscription cancel stripe trial", err.message || err);
      }
    }
    return {
      ok: true,
      subscriptionPlan: applied.subscriptionPlan,
      subscriptionStatus: applied.subscriptionStatus,
    };
  });

/**
 * App Store Server Notifications V2. Apple posts { signedPayload } when a
 * subscription renews, cancels, expires, or is refunded.
 */
exports.appStoreServerNotification = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POST required");
    return;
  }
  const signedPayload = ((req.body && req.body.signedPayload) || "").toString().trim();
  if (!signedPayload) {
    res.status(400).send("Missing signedPayload");
    return;
  }
  try {
    const notification = await appleSubscription.verifySignedNotification(signedPayload);
    if (notification.notificationType === appleSubscription.NotificationTypeV2.TEST) {
      res.status(200).send("ok");
      return;
    }
    const signedTransaction =
      notification.data && notification.data.signedTransactionInfo
        ? notification.data.signedTransactionInfo.toString()
        : "";
    if (!signedTransaction) {
      res.status(200).send("ok");
      return;
    }
    const transaction = await appleSubscription.verifySignedTransaction(signedTransaction);
    if (!appleSubscription.planForProduct(transaction.productId)) {
      res.status(200).send("ok");
      return;
    }
    const tenantDoc = await appleSubscription.findTenantForTransaction(transaction);
    if (!tenantDoc) {
      console.warn(
        "appStoreServerNotification tenant not ready",
        transaction.originalTransactionId || ""
      );
      res.status(500).send("tenant not ready");
      return;
    }
    const appleStatus = notification.data && notification.data.status;
    const applied = await appleSubscription.applyVerifiedTransaction(
      tenantDoc.id,
      transaction,
      notification.signedDate || transaction.signedDate,
      appleStatus
    );
    await mirrorAppleSubscriptionStatus(tenantDoc.id, applied);
    res.status(200).send("ok");
  } catch (error) {
    console.error("appStoreServerNotification", error.message || error);
    res.status(400).send("invalid");
  }
});

exports.recordAppleSmsExtraPurchase = functions.https.onCall(async (data, context) => {
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
  const memberUid = ((data && data.memberUid) || "").toString().trim();
  const signedTransaction = ((data && data.signedTransaction) || "").toString().trim();
  if (!memberUid || !signedTransaction) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Missing teammate or App Store purchase."
    );
  }
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  // A 3rd+ number is $12.99 today plus $12.99 a month. The App Store purchase is one-time only, so
  // those are added in billing; refuse before the receipt is reserved so nothing is spent.
  const planForLine = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
  const linesInUse = await sms.countOccupiedSmsLines(ctx.tenantId, ctx.tenant);
  if (sms.buildSmsLineSummary(ctx.tenant, planForLine, linesInUse).needsMonthlyExtraForNext) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Additional numbers are $12.99 today and $12.99 a month. Add them in billing."
    );
  }
  const claim = await claimAppleSmsExtraPurchase({
    uid: context.auth.uid,
    tenantId: ctx.tenantId,
    signedTransaction,
    purpose: "member_number",
    memberUid,
  });
  const appleInvoiceId = `apple:${claim.transactionId}`;
  const memberData = memberSnap.data() || {};
  const existingExpiresAt = memberData.smsPaidLinePurchaseExpiresAt;
  const existingExpiresMs =
    existingExpiresAt && typeof existingExpiresAt.toMillis === "function"
      ? existingExpiresAt.toMillis()
      : 0;
  const existingAuthorizationId = (memberData.smsPaidLinePurchaseAuthorizationId || "").toString();
  // A retry of the same purchase gets the authorization it was already given.
  if (
    claim.alreadyClaimed &&
    existingAuthorizationId &&
    (memberData.smsPaidLinePurchaseInvoiceId || "").toString() === appleInvoiceId &&
    existingExpiresMs > Date.now()
  ) {
    return { ok: true, smsPaidLinePurchaseAuthorizationId: existingAuthorizationId };
  }
  const authorizationId = crypto.randomBytes(24).toString("hex");
  await memberRef.set(
    {
      smsPaidLinePurchaseAuthorizationId: authorizationId,
      smsPaidLinePurchaseInvoiceId: appleInvoiceId,
      smsPaidLinePurchaseAuthorizedAt: admin.firestore.FieldValue.serverTimestamp(),
      smsPaidLinePurchaseExpiresAt: admin.firestore.Timestamp.fromMillis(
        Date.now() + 15 * 60 * 1000
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true, smsPaidLinePurchaseAuthorizationId: authorizationId };
});
