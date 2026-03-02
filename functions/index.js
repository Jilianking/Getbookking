/**
 * Cloud Functions for GetBookKing payments (Stripe Connect).
 * Set secret: firebase functions:secrets:set STRIPE_SECRET_KEY
 */

const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

admin.initializeApp();
const db = admin.firestore();

/**
 * Creates a Stripe Connect Account Link for the authenticated provider.
 * If the tenant has no Connect account, creates one first and saves stripeAccountId to Firestore.
 * Returns { url: string } to open in a browser for onboarding.
 */
exports.createConnectAccountLink = functions
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
        "Stripe is not configured. Run: firebase functions:secrets:set STRIPE_SECRET_KEY"
      );
    }

    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-11-20.acacia",
    });

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Provider profile not found");
    }
    const userData = userDoc.data();
    const tenantId = userData.tenantId;
    const email = userData.email || context.auth.token?.email;
    if (!tenantId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No tenant linked to this provider"
      );
    }

    const tenantRef = db.collection("tenants").doc(tenantId);
    const tenantDoc = await tenantRef.get();
    const tenantData = tenantDoc.exists ? tenantDoc.data() : {};
    let stripeAccountId = tenantData.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      stripeAccountId = account.id;
      await tenantRef.set({ stripeAccountId }, { merge: true });
    }

    const baseUrl = data?.returnBaseUrl ?? "https://test-app-96812.web.app";
    const returnUrl = data?.returnUrl ?? `${baseUrl}/payments?success=1`;
    const refreshUrl = data?.refreshUrl ?? `${baseUrl}/payments?refresh=1`;
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });

    return { url: accountLink.url };
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

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return { hasAccount: false };
    }
    const tenantId = userDoc.data().tenantId;
    if (!tenantId) {
      return { hasAccount: false };
    }

    const tenantDoc = await db.collection("tenants").doc(tenantId).get();
    const stripeAccountId = tenantDoc.data()?.stripeAccountId;
    if (!stripeAccountId) {
      return { hasAccount: false };
    }

    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-11-20.acacia",
    });
    const account = await stripe.accounts.retrieve(stripeAccountId);

    return {
      hasAccount: true,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
    };
  });
