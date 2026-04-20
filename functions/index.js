/**
 * Cloud Functions for GetBookKing.
 * Set secrets:
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set OPENAI_API_KEY
 */

const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Stripe = require("stripe");
const {
  formSchemaForIndustry,
  defaultServicesByIndustry,
  resolveWebThemeId,
  slugFromBusiness,
  normalizeIndustry,
} = require("./signupPayloads");

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const openaiApiKey = defineSecret("OPENAI_API_KEY");

admin.initializeApp();
const db = admin.firestore();

/** Canonical plan slug: `basic` | `studio` | `shop` (accepts legacy client values). */
function normalizeSubscriptionPlan(plan) {
  const p = (plan || "").toString().trim().toLowerCase();
  const legacy = {
    solo: "basic",
    free: "basic",
    starter: "basic",
    growth: "studio",
    pro: "studio",
    enterprise: "shop",
  };
  if (legacy[p]) return legacy[p];
  if (p === "basic" || p === "studio" || p === "shop") return p;
  return "basic";
}

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

    const baseUrl = data?.returnBaseUrl ?? "https://getbookking.com";
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

/** Helper: get stripeAccountId for authenticated user's tenant */
async function getStripeAccountIdForUser(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) return null;
  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  return tenantDoc.data()?.stripeAccountId ?? null;
}

/**
 * Generates a logo asset with OpenAI gpt-image-1.
 * Params: { prompt: string, businessName?: string }
 * Returns { imageBase64: string, mimeType: string }
 */
exports.generateTenantLogoWithOpenAI = functions
  .runWith({ secrets: [openaiApiKey], timeoutSeconds: 120, memory: "512MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const apiKey = openaiApiKey.value();
    if (!apiKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "OpenAI is not configured. Run: firebase functions:secrets:set OPENAI_API_KEY"
      );
    }
    const rawPrompt = (data?.prompt || "").toString().trim();
    if (rawPrompt.length < 3) {
      throw new functions.https.HttpsError("invalid-argument", "Describe your logo in at least a few words.");
    }
    if (rawPrompt.length > 2000) {
      throw new functions.https.HttpsError("invalid-argument", "Prompt is too long (max 2000 characters).");
    }
    const businessName = (data?.businessName || "").toString().trim();
    const fullPrompt = [
      businessName ? `Professional brand logo for "${businessName}".` : "Professional brand logo.",
      rawPrompt,
      "Flat vector style, simple recognizable mark, high contrast, readable at small sizes.",
      "No mockups, no photo backgrounds, single centered composition on a white background.",
    ].join(" ");

    const oaiResp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: fullPrompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
        response_format: "b64_json",
      }),
    });
    const oaiJson = await oaiResp.json();
    if (!oaiResp.ok) {
      const msg = (oaiJson.error && oaiJson.error.message) || oaiResp.statusText || "OpenAI request failed";
      console.error("OpenAI images error", oaiResp.status, msg);
      throw new functions.https.HttpsError(
        oaiResp.status === 429 ? "resource-exhausted" : "internal",
        msg
      );
    }
    const first = oaiJson.data && oaiJson.data[0] ? oaiJson.data[0] : null;
    const b64 = first && (first.b64_json || first.image_base64 || first.imageBase64);
    if (!b64) {
      console.error("OpenAI image payload missing base64", JSON.stringify(oaiJson).slice(0, 500));
      throw new functions.https.HttpsError("internal", "No base64 image data returned from OpenAI");
    }
    return { imageBase64: b64, mimeType: "image/png" };
  });

/**
 * Returns the Connect account balance. { availableCents, pendingCents }.
 */
exports.getConnectBalance = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
    if (!stripeAccountId) {
      return { availableCents: 0, pendingCents: 0 };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      return { availableCents: 0, pendingCents: 0 };
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: stripeAccountId }
    );
    const available = balance.available?.find((b) => b.currency === "usd");
    const pending = balance.pending?.find((b) => b.currency === "usd");
    return {
      availableCents: available?.amount ?? 0,
      pendingCents: pending?.amount ?? 0,
    };
  });

/**
 * Creates a payout to the connected account's bank. amountCents in USD cents.
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
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
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
    await stripe.payouts.create(
      { amount: Math.round(amountCents), currency: "usd" },
      { stripeAccount: stripeAccountId }
    );
    return { success: true };
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
    const amountCents = data?.amountCents ?? 500; // default $5
    if (typeof amountCents !== "number" || amountCents < 50) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Amount must be at least 50 cents ($0.50)"
      );
    }
    const productName = (data?.productName || "Deposit").toString().trim() || "Deposit";
    const productDescription = data?.productDescription
      ? data.productDescription.toString().trim()
      : undefined;
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
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
    const productData = { name: productName };
    if (productDescription) productData.description = productDescription;
    const link = await stripe.paymentLinks.create(
      {
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: productData,
              unit_amount: Math.round(amountCents),
            },
            quantity: 1,
          },
        ],
      },
      { stripeAccount: stripeAccountId }
    );
    return { url: link.url };
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
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
    if (!stripeAccountId) {
      return { transactions: [] };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      return { transactions: [] };
    }
    const startTs = data?.startTimestampSeconds;
    const endTs = data?.endTimestampSeconds;
    const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 100, 1), 100);

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
    const list = await stripe.balanceTransactions.list(
      params,
      { stripeAccount: stripeAccountId }
    );
    const transactions = (list.data || []).map((t) => ({
      id: t.id,
      type: t.type || "unknown",
      amount: t.amount ?? 0,
      fee: t.fee ?? 0,
      net: t.net ?? 0,
      created: t.created ?? 0,
      description: t.description || null,
      reportingCategory: t.reporting_category || null,
      sourceId: t.source || null,
    }));
    return { transactions };
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
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
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
 * Creates a refund for a charge on the Connect account.
 * Params: { chargeId: string, amountCents?: number, reason?: string }.
 * Omit amountCents for full refund.
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
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
    if (!stripeAccountId) {
      throw new functions.https.HttpsError("failed-precondition", "No Stripe account linked");
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new functions.https.HttpsError("failed-precondition", "Stripe is not configured");
    }
    const amountCents = data?.amountCents;
    const reason = (data?.reason || "requested_by_customer").toString().trim();
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const params = { charge: chargeId, reason: reason };
    if (typeof amountCents === "number" && amountCents > 0) {
      params.amount = Math.round(amountCents);
    }
    await stripe.refunds.create(params, { stripeAccount: stripeAccountId });
    return { success: true };
  });

/**
 * Creates a booking request from the public web form. No auth required.
 * Params: { tenantSlug, customerName, customerEmail, customerPhone?, serviceId?, serviceSlug?, serviceName?, preferredTime?, preferredDays?, notes? }
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

  const tenantSnap = await db
    .collection("tenants")
    .where("slug", "==", tenantSlug)
    .limit(1)
    .get();

  if (tenantSnap.empty) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenantDoc = tenantSnap.docs[0];
  const tenantId = tenantDoc.id;
  const tenantData = tenantDoc.data();
  if (tenantData.isActive === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting bookings"
    );
  }

  const customerPhone = data?.customerPhone ? data.customerPhone.toString().trim() : null;
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
  const notes = data?.notes ? data.notes.toString().trim() : null;

  const bookingData = {
    status: "NEW",
    source: "web",
    tenantId,
    customerName,
    customerEmail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (customerPhone) bookingData.customerPhone = customerPhone;
  if (serviceId) bookingData.serviceId = serviceId;
  if (serviceSlug) bookingData.serviceSlug = serviceSlug;
  if (serviceName) bookingData.serviceName = serviceName;
  if (preferredTime) bookingData.preferredTime = preferredTime;
  if (preferredDays) bookingData.preferredDays = preferredDays;
  if (notes) bookingData.notes = notes;
  if (data?.formResponses && typeof data.formResponses === "object") {
    bookingData.formResponses = data.formResponses;
  }

  const ref = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .add(bookingData);

  return { requestId: ref.id };
});

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
    const amountCents = data?.amountCents ?? 100; // default $1 for testing
    if (typeof amountCents !== "number" || amountCents < 50) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Amount must be at least 50 cents ($0.50)"
      );
    }
    const stripeAccountId = await getStripeAccountIdForUser(context.auth.uid);
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
    const pi = await stripe.paymentIntents.create(
      {
        amount: Math.round(amountCents),
        currency: "usd",
        capture_method: "automatic",
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
    };
  });

/**
 * FCM push to provider devices when a booking request is created (web or app).
 * iOS stores tokens under users/{uid}/deviceTokens/{hash} (see PushNotificationManager.swift).
 */
exports.onTenantBookingRequestCreated = functions.firestore
  .document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onCreate(async (snap, context) => {
    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const data = snap.data() || {};
    const customerName = data.customerName || "Someone";
    const serviceName = (data.serviceName || "").toString().trim();
    const body = serviceName
      ? `${customerName} — ${serviceName}`.slice(0, 200)
      : `New request from ${customerName}`.slice(0, 200);

    const usersSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .get();

    const tokens = [];
    for (const userDoc of usersSnap.docs) {
      const tokSnap = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("deviceTokens")
        .get();
      tokSnap.forEach((t) => {
        const token = t.data().token;
        if (token && typeof token === "string") tokens.push(token);
      });
    }

    if (tokens.length === 0) return null;

    const unique = [...new Set(tokens)];
    const chunkSize = 500;

    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: chunk,
          notification: {
            title: "New booking request",
            body,
          },
          data: {
            type: "booking_request",
            tenantId: String(tenantId),
            requestId: String(requestId),
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
              },
            },
          },
        });
      } catch (e) {
        console.error("onTenantBookingRequestCreated FCM error", e);
      }
    }
    return null;
  });

/**
 * Web sign-up wizard: creates Auth profile, tenant, and default services.
 * Called from marketing/signup.html after Firebase Auth createUser on the client.
 */
exports.finalizeProviderSignUp = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be signed in."
    );
  }

  const uid = context.auth.uid;
  const {
    teamSize,
    industry: rawIndustry,
    industryCustomLabel: rawIndustryLabel,
    businessName,
    city,
    phone,
    templatePreset,
    fullName,
    plan,
  } = data;

  if (!businessName || !rawIndustry) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "businessName and industry are required."
    );
  }

  const industry = normalizeIndustry(rawIndustry);
  const industryLabelTrim = (rawIndustryLabel || "").toString().trim().slice(0, 200);
  if (industry === "custom" && !industryLabelTrim) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Please describe your business type for Custom industry."
    );
  }
  const slug = slugFromBusiness(businessName);
  const webThemeId = resolveWebThemeId(industry, templatePreset || "portfolio");
  const formSchema = formSchemaForIndustry(industry);

  const nameParts = (fullName || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  const now = admin.firestore.FieldValue.serverTimestamp();

  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;

  const subscriptionPlan = normalizeSubscriptionPlan(plan);

  const tenantData = {
    ownerUid: uid,
    ownerId: uid,
    businessName: businessName,
    displayName: businessName,
    slug: slug,
    industry: industry,
    formSchema,
    teamSize: teamSize || "solo",
    city: city || "",
    serviceArea: city || "",
    contactPhone: phone || "",
    webThemeId: webThemeId,
    resolvedWebThemeId: webThemeId,
    templatePreset: templatePreset || "portfolio",
    subscriptionPlan,
    trialStartDate: now,
    createdAt: now,
    updatedAt: now,
    galleryGridLayout: "3x1",
    galleryLayoutStyle: "classic_grid",
    shopEnabled: false,
    aboutText: "",
    contactEmail: context.auth.token.email || "",
    contactAddress: "",
    heroTagline: "",
    heroSubtitle: "",
  };

  if (industry === "custom" && industryLabelTrim) {
    tenantData.industryCustomLabel = industryLabelTrim;
  }

  const userDoc = {
    email: context.auth.token.email || "",
    firstName: firstName,
    lastName: lastName,
    displayName: fullName || "",
    name: fullName || "",
    tenantId: tenantId,
    tenantSlug: slug,
    role: "owner",
    business: businessName,
    industry,
    profilePhotoUrl: "",
    subscriptionPlan,
    subscriptionStatus: "active",
    availability: {
      timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
      daysOpen: [1, 2, 3, 4, 5],
      timeZone: "America/New_York",
    },
    workflow: {
      confirmationType: "request_approve",
      responseTimeHours: 24,
    },
    createdAt: now,
  };

  const batch = db.batch();

  batch.set(tenantRef, tenantData);
  batch.set(db.collection("users").doc(uid), userDoc);

  const services = defaultServicesByIndustry[industry] || [];
  services.forEach((svc, idx) => {
    const svcSlug = svc.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const svcRef = tenantRef.collection("services").doc();
    batch.set(svcRef, {
      name: svc.name,
      slug: svcSlug,
      durationMinutes: svc.durationMinutes,
      price: 0,
      sortOrder: idx,
      isActive: true,
      createdAt: now,
    });
  });

  await batch.commit();

  return { tenantId, slug };
});

// ── Team invites (opaque token = Firestore doc id) ─────────────────────────

const TENANT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseInviteToken(data) {
  const token = ((data && data.token) || "").toString().trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return token;
}

/** Public preview for join page (business name only). */
exports.getTenantInvitePreview = functions.https.onCall(async (data) => {
  const token = parseInviteToken(data);
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invite link.");
  }
  const snap = await db.collection("tenantInvites").doc(token).get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
  }
  const inv = snap.data();
  if (inv.usedAt) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite was already used."
    );
  }
  const exp = inv.expiresAt;
  if (exp && exp.toMillis && exp.toMillis() < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This invite has expired.");
  }
  const tenantSnap = await db.collection("tenants").doc(inv.tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const t = tenantSnap.data();
  const businessName = t.displayName || t.businessName || "Business";
  return { businessName };
});

/** Owner-only: single-use invite; pass baseUrl for full join link. */
exports.createTenantInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const userData = userDoc.data();
  const tenantId = (data && data.tenantId) || userData.tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No tenant linked to this account."
    );
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data();
  if (tenant.ownerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can create team invites."
    );
  }
  const token = crypto.randomBytes(32).toString("hex");
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(
    now.toMillis() + TENANT_INVITE_TTL_MS
  );
  await db.collection("tenantInvites").doc(token).set({
    tenantId,
    createdByUid: uid,
    createdAt: now,
    expiresAt,
    role: "staff",
  });
  const baseUrl = ((data && data.baseUrl) || "")
    .toString()
    .trim()
    .replace(/\/+$/, "");
  const joinUrl = baseUrl ? `${baseUrl}/join?t=${encodeURIComponent(token)}` : null;
  return { token, joinUrl };
});

/** After Auth sign-in/up: attach user as staff and consume invite (transaction). */
exports.acceptTenantInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const token = parseInviteToken(data);
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invite link.");
  }
  const uid = context.auth.uid;
  const inviteRef = db.collection("tenantInvites").doc(token);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) {
    throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
  }
  const inv = inviteSnap.data();
  if (inv.usedAt) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite was already used."
    );
  }
  const exp = inv.expiresAt;
  if (exp && exp.toMillis && exp.toMillis() < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This invite has expired.");
  }
  const tenantId = inv.tenantId;
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data();
  if (tenant.ownerUid === uid) {
    return { ok: true, tenantId, alreadyOwner: true };
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  if (userData.tenantId && userData.tenantId !== tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This account already belongs to another business. Use a different account to accept this invite."
    );
  }
  if (userData.tenantId === tenantId && userData.role === "staff") {
    return { ok: true, tenantId, alreadyMember: true };
  }

  const slug = tenant.slug || "";
  const displayName = tenant.displayName || tenant.businessName || "";
  const industry = tenant.industry || "custom";
  const subscriptionPlan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  const email =
    (context.auth.token && context.auth.token.email) || userData.email || "";
  const tokenName =
    (context.auth.token && context.auth.token.name) ||
    (email ? email.split("@")[0] : "") ||
    "Team member";
  const nameParts = tokenName.trim().split(/\s+/);
  const defaultFirst = nameParts[0] || "Team";
  const defaultLast = nameParts.slice(1).join(" ") || "Member";

  const defaultAvailability = {
    timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
    daysOpen: [1, 2, 3, 4, 5],
    timeZone: "America/New_York",
  };
  const defaultWorkflow = {
    confirmationType: "request_approve",
    responseTimeHours: 24,
  };

  await db.runTransaction(async (tx) => {
    const invFresh = await tx.get(inviteRef);
    if (!invFresh.exists) {
      throw new functions.https.HttpsError("not-found", "Invite not found.");
    }
    const inv2 = invFresh.data();
    if (inv2.usedAt) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This invite was already used."
      );
    }
    tx.update(inviteRef, {
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      usedByUid: uid,
    });
    tx.set(
      userRef,
      {
        tenantId,
        tenantSlug: slug,
        role: "staff",
        business: displayName,
        industry,
        subscriptionPlan,
        subscriptionStatus: userData.subscriptionStatus || "active",
        email,
        firstName: userData.firstName || defaultFirst,
        lastName: userData.lastName || defaultLast,
        displayName: userData.displayName || tokenName.trim(),
        name: userData.name || tokenName.trim(),
        profilePhotoUrl: userData.profilePhotoUrl || "",
        availability: userData.availability || defaultAvailability,
        workflow: userData.workflow || defaultWorkflow,
        createdAt: userData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return { ok: true, tenantId };
});
