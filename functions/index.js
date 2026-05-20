/**
 * Cloud Functions for Get Bookking.
 * Set secrets:
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set OPENAI_API_KEY
 *   firebase functions:secrets:set STRIPE_SUBSCRIPTION_PRICE_IDS
 *     (JSON map solo/studio/shop → price_…; copy from stripe-subscription-price-ids.example.json or Stripe Dashboard)
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 *     (Signing secret from Stripe webhook endpoint → https://us-central1-<PROJECT>.cloudfunctions.net/stripeSubscriptionWebhook)
 *
 * Optional: set string param STRIPE_PUBLISHABLE_KEY (pk_test_… / pk_live_…) via Firebase
 * params / functions .env so createProviderSubscriptionCheckout can return it to signup.html.
 *
 * Optional: MARKETING_ORIGIN (https://getbookking.com or your marketing host) for Stripe Billing
 * Portal return_url → …/account.html. Enable the portal in Stripe Dashboard → Billing → Customer portal.
 * Callable getBillingSummary: read-only Stripe subscription + invoices for account.html.
 */

const functions = require("firebase-functions");
const { defineSecret, defineString } = require("firebase-functions/params");
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
/** JSON map: solo, studio, shop → Stripe Price id (recurring subscription). */
const stripeSubscriptionPriceIds = defineSecret("STRIPE_SUBSCRIPTION_PRICE_IDS");
/** Stripe Dashboard → Webhooks → Signing secret (whsec_…). */
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
/** Publishable key (pk_…) returned to signup.html when set; safe to expose in the browser. */
const stripePublishableKeyParam = defineString("STRIPE_PUBLISHABLE_KEY", { default: "" });
const marketingOriginParam = defineString("MARKETING_ORIGIN", { default: "https://getbookking.com" });

admin.initializeApp();
const db = admin.firestore();

/** Canonical plan slug: `solo` | `studio` | `shop` (accepts legacy `basic` and older aliases). */
function normalizeSubscriptionPlan(plan) {
  const p = (plan || "").toString().trim().toLowerCase();
  const legacy = {
    basic: "solo",
    free: "solo",
    starter: "solo",
    solo: "solo",
    growth: "studio",
    pro: "studio",
    enterprise: "shop",
  };
  if (legacy[p]) return legacy[p];
  if (p === "solo" || p === "studio" || p === "shop") return p;
  return "solo";
}

const US_STATE_ABBRS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

function titleCaseCityWords(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function composeServiceArea(city, stateAbbr) {
  const c = titleCaseCityWords(city);
  const st = (stateAbbr || "").trim().toUpperCase();
  if (!c && !st) return "";
  if (!st) return c;
  if (!c) return st;
  return `${c}, ${st}`;
}

function parseStripeSubscriptionPriceIds() {
  const raw = stripeSubscriptionPriceIds.value();
  if (!raw || !String(raw).trim()) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Set secret STRIPE_SUBSCRIPTION_PRICE_IDS to JSON: " +
        '{"solo":"price_...","studio":"price_...","shop":"price_..."}'
    );
  }
  let map;
  try {
    map = JSON.parse(String(raw).trim());
  } catch (e) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Invalid STRIPE_SUBSCRIPTION_PRICE_IDS (must be JSON)."
    );
  }
  return map;
}

function stripePriceIdForPlan(planNorm) {
  const map = parseStripeSubscriptionPriceIds();
  const id = map[planNorm];
  if (!id || typeof id !== "string") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `No Stripe price id for plan "${planNorm}" in STRIPE_SUBSCRIPTION_PRICE_IDS.`
    );
  }
  return id.trim();
}

/**
 * Validates marketing wizard payload and returns a plain object safe to store in `pendingProviderSignups`.
 */
function normalizeSignupWizardPayload(data) {
  const teamSize = (data.teamSize || "").toString().trim() || "solo";
  const rawIndustry = data.industry;
  const industryCustomLabel = (data.industryCustomLabel || "").toString().trim().slice(0, 200);
  const businessName = (data.businessName || "").toString().trim();
  const city = (data.city || "").toString().trim();
  const stateAbbr = (data.stateAbbr || data.state || "").toString().trim().toUpperCase();
  const phone = (data.phone || "").toString().trim();
  const templatePreset = (data.templatePreset || "portfolio").toString().trim();
  const firstName = (data.firstName || "").toString().trim();
  const lastName = (data.lastName || "").toString().trim();
  const planRaw = (data.plan || "").toString().trim();
  if (!planRaw) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Choose a subscription plan."
    );
  }
  const plan = normalizeSubscriptionPlan(planRaw);

  if (!businessName || !rawIndustry) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "businessName and industry are required."
    );
  }
  const industry = normalizeIndustry(rawIndustry);
  if (industry === "custom" && !industryCustomLabel) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Please describe your business type for Custom industry."
    );
  }
  if (!firstName || !lastName) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "First and last name are required."
    );
  }
  if (!city || !stateAbbr || !US_STATE_ABBRS.has(stateAbbr)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "City and a valid US state are required."
    );
  }
  if (!phone) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Phone number is required."
    );
  }

  return {
    teamSize,
    industry,
    industryCustomLabel,
    businessName,
    city,
    stateAbbr,
    phone,
    templatePreset,
    firstName,
    lastName,
    plan,
  };
}

/**
 * Creates tenant + user profile + default services (idempotent if user already has tenantId).
 */
async function provisionNewProviderFromWizard(uid, email, pending, billing) {
  const userRef = db.collection("users").doc(uid);
  const existingUser = await userRef.get();
  if (existingUser.exists && existingUser.data().tenantId) {
    const tid = existingUser.data().tenantId;
    const tSnap = await db.collection("tenants").doc(tid).get();
    const slug = tSnap.exists ? tSnap.data().slug || "" : "";
    await db.collection("pendingProviderSignups").doc(uid).delete().catch(() => {});
    return { tenantId: tid, slug };
  }

  const {
    teamSize,
    industry,
    industryCustomLabel,
    businessName,
    city,
    stateAbbr,
    phone,
    templatePreset,
    firstName,
    lastName,
    plan,
  } = pending;

  const slug = slugFromBusiness(businessName);
  const webThemeId = resolveWebThemeId(industry, templatePreset || "portfolio");
  const formSchema = formSchemaForIndustry(industry);
  const cityDisplay = titleCaseCityWords(city);
  const serviceArea = composeServiceArea(cityDisplay, stateAbbr);
  const displayName = `${firstName} ${lastName}`.trim();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const subscriptionPlan = normalizeSubscriptionPlan(plan);

  const subscriptionStatus =
    billing.subscriptionStatus &&
    ["active", "trialing", "past_due"].includes(billing.subscriptionStatus)
      ? billing.subscriptionStatus
      : "trialing";

  const tenantData = {
    ownerUid: uid,
    ownerId: uid,
    businessName,
    displayName: businessName,
    slug,
    industry,
    formSchema,
    teamSize: teamSize || "solo",
    city: cityDisplay,
    contactState: stateAbbr,
    serviceArea,
    contactPhone: phone,
    webThemeId,
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
    contactEmail: email || "",
    contactAddress: "",
    heroTagline: "",
    heroSubtitle: "",
    managerPermissions: DEFAULT_MANAGER_PERMISSIONS,
    managerNotifications: DEFAULT_MANAGER_NOTIFICATIONS,
    workflow: DEFAULT_TENANT_WORKFLOW,
  };

  if (billing.stripeCustomerId) {
    tenantData.stripeCustomerId = billing.stripeCustomerId;
  }
  if (billing.stripeSubscriptionId) {
    tenantData.stripeSubscriptionId = billing.stripeSubscriptionId;
  }

  if (industry === "custom" && industryCustomLabel) {
    tenantData.industryCustomLabel = industryCustomLabel;
  }

  const userDoc = {
    email: email || "",
    firstName,
    lastName,
    displayName,
    name: displayName,
    tenantId,
    tenantSlug: slug,
    role: "owner",
    business: businessName,
    industry,
    profilePhotoUrl: "",
    subscriptionPlan,
    subscriptionStatus,
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
  batch.set(userRef, userDoc);

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
}

async function finalizeFromCheckoutSession(stripe, session) {
  const uid = (session.metadata && session.metadata.firebaseUid) || session.client_reference_id;
  if (!uid || typeof uid !== "string") {
    console.error("checkout.session missing firebase uid metadata");
    return null;
  }

  const paidOk =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  if (!paidOk || session.mode !== "subscription") {
    console.warn("checkout session not paid / not subscription", session.id);
    return null;
  }

  const pendingRef = db.collection("pendingProviderSignups").doc(uid);
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists) {
    const u = await db.collection("users").doc(uid).get();
    if (u.exists && u.data().tenantId) {
      const tid = u.data().tenantId;
      const tSnap = await db.collection("tenants").doc(tid).get();
      return { tenantId: tid, slug: tSnap.exists ? tSnap.data().slug || "" : "" };
    }
    console.warn("no pending signup for uid", uid);
    return null;
  }

  const pending = pendingSnap.data();
  const email =
    session.customer_details && session.customer_details.email
      ? session.customer_details.email
      : session.customer_email || "";

  let subStatus = "active";
  if (session.subscription && typeof session.subscription === "object") {
    const st = session.subscription.status;
    if (st === "trialing" || st === "active") {
      subStatus = st;
    }
  } else if (session.subscription) {
    const subId = String(session.subscription);
    const sub = await stripe.subscriptions.retrieve(subId);
    if (sub.status === "trialing" || sub.status === "active") {
      subStatus = sub.status;
    }
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && session.customer.id;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription && session.subscription.id;

  const result = await provisionNewProviderFromWizard(uid, email, pending, {
    stripeCustomerId: customerId || null,
    stripeSubscriptionId: subscriptionId || null,
    subscriptionStatus: subStatus,
  });

  await pendingRef.delete().catch(() => {});
  return result;
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
        "This account already has a business set up."
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
    await pendingRef.set(
      {
        ...normalized,
        email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

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
        metadata: { firebaseUid: uid },
        subscription_data: {
          trial_period_days: 30,
          metadata: { firebaseUid: uid },
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

/**
 * Stripe webhook: completes provisioning when Checkout succeeds (backup if user closes tab before client completes).
 */
exports.stripeSubscriptionWebhook = functions
  .runWith({ secrets: [stripeSecretKey, stripeWebhookSecret] })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const secretKey = stripeSecretKey.value();
    const whSecret = stripeWebhookSecret.value();
    if (!secretKey || !whSecret) {
      console.error("stripeSubscriptionWebhook: missing secrets");
      res.status(503).send("Not configured");
      return;
    }

    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      const payload = req.rawBody || req.body;
      if (!Buffer.isBuffer(payload)) {
        console.error("stripeSubscriptionWebhook: rawBody missing; verify webhook payload");
        res.status(400).send("Webhook payload error");
        return;
      }
      event = stripe.webhooks.constructEvent(payload, sig, whSecret);
    } catch (err) {
      console.error("stripe webhook signature", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      try {
        const full = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ["subscription"],
        });
        await finalizeFromCheckoutSession(stripe, full);
      } catch (e) {
        console.error("stripeSubscriptionWebhook finalize", e);
      }
    }

    res.json({ received: true });
  });

// ── Team invites (opaque token = Firestore doc id) ─────────────────────────

const TENANT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_MANAGER_PERMISSIONS = {
  viewAllBookings: true,
  approveRejectRequests: true,
  editServicesPricing: false,
  manageBookingFormStyle: false,
  manageArtistSchedules: true,
  accessClientList: true,
  viewEarningsReports: false,
  sendClientNotifications: true,
};

const DEFAULT_TENANT_WORKFLOW = {
  confirmationType: "request_approve",
  responseTimeHours: 24,
};

function bookingRequiresApproval(confirmationType) {
  const t = (confirmationType || "").toString().trim().toLowerCase();
  return (
    t === "request_approve" ||
    t === "approve_and_deposit" ||
    t === "consultation_first"
  );
}

function resolveTenantWorkflow(tenant, ownerUserData) {
  if (tenant && tenant.workflow && tenant.workflow.confirmationType) {
    return {
      confirmationType: tenant.workflow.confirmationType,
      responseTimeHours:
        tenant.workflow.responseTimeHours != null
          ? tenant.workflow.responseTimeHours
          : 24,
      depositAmount: tenant.workflow.depositAmount,
    };
  }
  if (ownerUserData && ownerUserData.workflow && ownerUserData.workflow.confirmationType) {
    return {
      confirmationType: ownerUserData.workflow.confirmationType,
      responseTimeHours: ownerUserData.workflow.responseTimeHours || 24,
      depositAmount: ownerUserData.workflow.depositAmount,
    };
  }
  return { ...DEFAULT_TENANT_WORKFLOW };
}

async function getMemberAccessContext(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const userData = userDoc.data();
  const tenantId = userData.tenantId;
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
  const isOwner = tenant.ownerUid === uid;
  let ownerUserData = userData;
  if (!isOwner && tenant.ownerUid) {
    const ownerSnap = await db.collection("users").doc(tenant.ownerUid).get();
    if (ownerSnap.exists) ownerUserData = ownerSnap.data();
  }
  const workflow = resolveTenantWorkflow(tenant, isOwner ? userData : ownerUserData);
  const accessRole = isOwner ? "owner" : parseAccessRole(userData.role || userData.accessRole);
  const managerPermissions = tenant.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  return {
    tenantId,
    tenant,
    userData,
    isOwner,
    accessRole,
    workflow,
    managerPermissions,
    bookingRequiresApproval: bookingRequiresApproval(workflow.confirmationType),
  };
}

const DEFAULT_MANAGER_NOTIFICATIONS = {
  onNewBooking: true,
  onCancellation: true,
  dailySummaryEmail: false,
};

function parseAccessRole(raw) {
  const r = (raw || "").toString().trim().toLowerCase();
  if (r === "owner") return "owner";
  if (r === "manager") return "manager";
  return "member";
}

/** Invites always create team members; manager is set later by the owner in Team. */
function parseInviteAccessRole(_data) {
  return "member";
}

function normalizeJobTitle(title) {
  return (title || "").toString().trim().slice(0, 60);
}

const PAYMENT_SPLIT_APPLIES = new Set(["service", "deposit", "both"]);

function normalizeMemberSettings(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const useStudio = d.useStudioBookingPolicy !== false;
  let bookingConfirmationOverride = (d.bookingConfirmationOverride || "")
    .toString()
    .trim();
  if (useStudio) bookingConfirmationOverride = "";
  let paymentSplitPercent = parseInt(d.paymentSplitPercent, 10);
  if (Number.isNaN(paymentSplitPercent)) paymentSplitPercent = 0;
  paymentSplitPercent = Math.min(100, Math.max(0, paymentSplitPercent));
  let paymentSplitAppliesTo = (d.paymentSplitAppliesTo || "service")
    .toString()
    .trim()
    .toLowerCase();
  if (!PAYMENT_SPLIT_APPLIES.has(paymentSplitAppliesTo)) {
    paymentSplitAppliesTo = "service";
  }
  const out = {
    useStudioBookingPolicy: useStudio,
    paymentSplitPercent,
    paymentSplitAppliesTo,
  };
  if (!useStudio && bookingConfirmationOverride) {
    out.bookingConfirmationOverride = bookingConfirmationOverride;
  }
  return out;
}

function defaultJobTitleForIndustry(industry) {
  const map = {
    tattoos: "Artist",
    hair: "Stylist",
    barber: "Barber",
    nails: "Nail technician",
    custom: "Team member",
  };
  const key = (industry || "custom").toString().trim().toLowerCase();
  return map[key] || "Team member";
}

async function assertTenantOwnerUid(uid, tenantId) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data();
  if (tenant.ownerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can perform this action."
    );
  }
  return tenant;
}

function serializeTeamMember(doc, ownerUid) {
  const d = doc.data();
  const uid = doc.id;
  const fn = (d.firstName || "").toString().trim();
  const ln = (d.lastName || "").toString().trim();
  let accessRole = parseAccessRole(d.role || d.accessRole);
  if (uid === ownerUid) accessRole = "owner";
  return {
    uid,
    firstName: fn,
    lastName: ln,
    displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Member").toString(),
    email: (d.email || "").toString(),
    profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
    accessRole,
    role: accessRole,
    jobTitle: (d.jobTitle || "").toString(),
    memberSettings: normalizeMemberSettings(d.memberSettings),
  };
}

/** Seat caps: Solo 1 employee, Studio 2–5 employees, Shop 6+ (large cap). */
function maxSeatsForPlanNormalized(plan) {
  const p = normalizeSubscriptionPlan(plan);
  if (p === "solo") return 1;
  if (p === "studio") return 5;
  return 500;
}

async function countUsersForTenant(tenantId) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  return snap.size;
}

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
  const plan = normalizeSubscriptionPlan(t.subscriptionPlan);
  if (plan === "solo") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting team invites on its current plan."
    );
  }
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
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (plan === "solo") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Solo plan is owner only. Upgrade to Studio or Shop to invite team members."
    );
  }
  const memberCount = await countUsersForTenant(tenantId);
  const maxSeats = maxSeatsForPlanNormalized(plan);
  if (memberCount >= maxSeats) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      plan === "studio"
        ? "Studio plan allows up to 5 team members."
        : "Team member limit reached for this plan."
    );
  }
  const inviteAccessRole = parseInviteAccessRole(data);
  const industry = (tenant.industry || "custom").toString();
  const jobTitleRaw = normalizeJobTitle((data && data.jobTitle) || "");
  const jobTitle = jobTitleRaw || defaultJobTitleForIndustry(industry);

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
    role: inviteAccessRole,
    accessRole: inviteAccessRole,
    jobTitle,
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
  const existingRole = parseAccessRole(userData.role || userData.accessRole);
  if (userData.tenantId === tenantId && existingRole !== "owner") {
    return { ok: true, tenantId, alreadyMember: true };
  }

  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (plan === "solo") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is on the Solo plan (owner only) and cannot add team members."
    );
  }
  const memberCount = await countUsersForTenant(tenantId);
  const maxSeats = maxSeatsForPlanNormalized(plan);
  if (memberCount >= maxSeats) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      plan === "studio"
        ? "Studio plan allows up to 5 team members."
        : "Team member limit reached for this plan."
    );
  }

  const slug = tenant.slug || "";
  const tenantBusinessLabel = tenant.displayName || tenant.businessName || "";
  const industry = tenant.industry || "custom";
  const subscriptionPlan = plan;
  const email =
    (context.auth.token && context.auth.token.email) || userData.email || "";

  const rawJoinFirst = ((data && data.firstName) || "").toString().trim().slice(0, 80);
  const rawJoinLast = ((data && data.lastName) || "").toString().trim().slice(0, 80);
  const rawJoinPhone = ((data && data.phone) || "").toString().trim().slice(0, 40);
  const phoneDigits = rawJoinPhone.replace(/\D/g, "");
  if (!rawJoinFirst || !rawJoinLast || !rawJoinPhone) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "First name, last name, and phone are required."
    );
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Enter a valid phone number (at least 10 digits)."
    );
  }

  const firstName = rawJoinFirst;
  const lastName = rawJoinLast;
  const personName = `${rawJoinFirst} ${rawJoinLast}`.trim();
  const personDisplay = personName;

  const defaultAvailability = {
    timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
    daysOpen: [1, 2, 3, 4, 5],
    timeZone: "America/New_York",
  };
  const defaultWorkflow = {
    confirmationType: "request_approve",
    responseTimeHours: 24,
  };

  const inviteAccessRole = parseAccessRole(inv.accessRole || inv.role);
  const inviteJobTitle = normalizeJobTitle(
    inv.jobTitle || defaultJobTitleForIndustry(industry)
  );

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
    const userPatch = {
      tenantId,
      tenantSlug: slug,
      role: inviteAccessRole,
      accessRole: inviteAccessRole,
      jobTitle: inviteAccessRole === "manager" ? "Manager" : inviteJobTitle,
      business: tenantBusinessLabel,
      industry,
      subscriptionPlan,
      subscriptionStatus: userData.subscriptionStatus || "active",
      email,
      firstName,
      lastName,
      displayName: personDisplay,
      name: personName,
      phone: rawJoinPhone,
      profilePhotoUrl: userData.profilePhotoUrl || "",
      availability: userData.availability || defaultAvailability,
      workflow: userData.workflow || defaultWorkflow,
      createdAt: userData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(userRef, userPatch, { merge: true });
  });

  return { ok: true, tenantId };
});

/** Signed-in member: role, effective manager toggles, tenant booking workflow. */
exports.getMyTeamAccess = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  const isOwner = ctx.isOwner || ctx.tenant.ownerUid === context.auth.uid;
  return {
    tenantId: ctx.tenantId,
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    managerPermissions: ctx.managerPermissions,
    confirmationType: ctx.workflow.confirmationType,
    responseTimeHours: ctx.workflow.responseTimeHours,
    bookingRequiresApproval: ctx.bookingRequiresApproval,
  };
});

/** Owner-only: business-wide booking confirmation policy (Settings). */
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
  const confirmationType = ((data && data.confirmationType) || "")
    .toString()
    .trim()
    .toLowerCase();
  const allowed = [
    "instant_book",
    "request_approve",
    "deposit_to_confirm",
    "approve_and_deposit",
    "consultation_first",
  ];
  if (!allowed.includes(confirmationType)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid confirmation type.");
  }
  const responseTimeHours = Math.min(
    168,
    Math.max(1, parseInt((data && data.responseTimeHours) || 24, 10) || 24)
  );
  const workflow = {
    confirmationType,
    responseTimeHours,
  };
  if (data && data.depositAmount != null && !Number.isNaN(Number(data.depositAmount))) {
    const dep = Number(data.depositAmount);
    if (dep > 0) workflow.depositAmount = dep;
  }
  await db.collection("tenants").doc(ctx.tenantId).update({
    workflow,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("users").doc(uid).set({ workflow }, { merge: true });
  return {
    ok: true,
    bookingRequiresApproval: bookingRequiresApproval(confirmationType),
  };
});

/** Approve / decline / update booking request status with permission checks. */
exports.updateBookingRequestStatus = functions.https.onCall(async (data, context) => {
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
  const approvalStatuses = new Set(["confirmed", "declined", "approved", "rejected"]);
  const isApprovalAction = approvalStatuses.has(status);

  if (isApprovalAction) {
    if (!ctx.bookingRequiresApproval) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This business does not use request approval for bookings."
      );
    }
    const canApprove =
      ctx.isOwner ||
      (ctx.accessRole === "manager" && ctx.managerPermissions.approveRejectRequests);
    if (!canApprove) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to approve or reject booking requests."
      );
    }
  } else if (!ctx.isOwner && ctx.accessRole !== "manager") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to update booking requests."
    );
  } else if (
    !ctx.isOwner &&
    ctx.accessRole === "manager" &&
    !ctx.managerPermissions.viewAllBookings
  ) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to update booking requests."
    );
  }

  const reqRef = db
    .collection("tenants")
    .doc(ctx.tenantId)
    .collection("bookingRequests")
    .doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Booking request not found.");
  }

  let normalized = status.toLowerCase();
  if (normalized === "approved") normalized = "confirmed";
  if (normalized === "rejected") normalized = "declined";
  const patch = {
    status: normalized,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (data && data.notes != null) {
    patch.notes = (data.notes || "").toString().trim().slice(0, 4000);
  }
  await reqRef.set(patch, { merge: true });
  return { ok: true, status: normalized };
});

/** Tenant members: roster (+ owner-only policy fields for Team screen). */
exports.listTenantMembers = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  const tenantId = ctx.tenantId;
  const tenant = ctx.tenant;
  const isOwner = ctx.isOwner;
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const members = snap.docs.map((doc) => serializeTeamMember(doc, tenant.ownerUid));
  members.sort((a, b) => {
    const rank = { owner: 0, manager: 1, member: 2 };
    const ra = rank[a.accessRole] ?? 3;
    const rb = rank[b.accessRole] ?? 3;
    if (ra !== rb) return ra - rb;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  const perms = tenant.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  const notifs = tenant.managerNotifications || DEFAULT_MANAGER_NOTIFICATIONS;
  const ownerSnap = tenant.ownerUid
    ? await db.collection("users").doc(tenant.ownerUid).get()
    : null;
  const workflow = resolveTenantWorkflow(
    tenant,
    ownerSnap && ownerSnap.exists ? ownerSnap.data() : null
  );
  const confirmationType = workflow.confirmationType;
  return {
    tenantId,
    industry: tenant.industry || "custom",
    subscriptionPlan: normalizeSubscriptionPlan(tenant.subscriptionPlan),
    ownerUid: tenant.ownerUid,
    isOwner,
    managerPermissions: perms,
    managerNotifications: notifs,
    confirmationType,
    bookingRequiresApproval: bookingRequiresApproval(confirmationType),
    members,
  };
});

/** Owner-only: save manager permission toggles and notification prefs on tenant. */
exports.updateTenantManagerPolicy = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  await assertTenantOwnerUid(uid, tenantId);
  const incomingPerms = (data && data.managerPermissions) || {};
  const incomingNotifs = (data && data.managerNotifications) || {};
  const managerPermissions = { ...DEFAULT_MANAGER_PERMISSIONS };
  const managerNotifications = { ...DEFAULT_MANAGER_NOTIFICATIONS };
  for (const key of Object.keys(DEFAULT_MANAGER_PERMISSIONS)) {
    if (typeof incomingPerms[key] === "boolean") managerPermissions[key] = incomingPerms[key];
  }
  for (const key of Object.keys(DEFAULT_MANAGER_NOTIFICATIONS)) {
    if (typeof incomingNotifs[key] === "boolean") managerNotifications[key] = incomingNotifs[key];
  }
  await db.collection("tenants").doc(tenantId).update({
    managerPermissions,
    managerNotifications,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** Owner-only: change member access role and/or job title. */
exports.updateTenantMember = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const memberUid = ((data && data.memberUid) || "").toString().trim();
  if (!memberUid) {
    throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
  }
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const tenant = await assertTenantOwnerUid(uid, tenantId);
  if (memberUid === tenant.ownerUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot change the owner's role."
    );
  }
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  const patch = {};
  if (data && data.accessRole != null) {
    const next = parseAccessRole(data.accessRole);
    if (next === "owner") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Cannot assign owner role."
      );
    }
    patch.role = next;
    patch.accessRole = next;
  }
  if (data && data.jobTitle != null) {
    patch.jobTitle = normalizeJobTitle(data.jobTitle);
  }
  if (data && data.memberSettings != null) {
    patch.memberSettings = normalizeMemberSettings(data.memberSettings);
  }
  if (!Object.keys(patch).length) {
    throw new functions.https.HttpsError("invalid-argument", "Nothing to update.");
  }
  await memberRef.set(patch, { merge: true });
  return { ok: true };
});

/** Owner-only: remove a team member from the business. */
exports.removeTenantMember = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const memberUid = ((data && data.memberUid) || "").toString().trim();
  if (!memberUid) {
    throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
  }
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const tenant = await assertTenantOwnerUid(uid, tenantId);
  if (memberUid === tenant.ownerUid || memberUid === uid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot remove the owner."
    );
  }
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  await memberRef.set(
    {
      tenantId: admin.firestore.FieldValue.delete(),
      tenantSlug: admin.firestore.FieldValue.delete(),
      role: admin.firestore.FieldValue.delete(),
      accessRole: admin.firestore.FieldValue.delete(),
      jobTitle: admin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );
  return { ok: true };
});

/** Allowed origins for Stripe Billing Portal `return_url` (marketing + staging). */
const BILLING_PORTAL_RETURN_ORIGINS = new Set([
  "https://getbookking.com",
  "https://www.getbookking.com",
  "https://getbooking.com",
  "https://www.getbooking.com",
  "https://test-app-96812.web.app",
  "http://localhost:5000",
  "http://localhost:5050",
  "http://127.0.0.1:5000",
]);

function isAllowedReturnOrigin(origin) {
  const o = (origin || "").toString().trim().replace(/\/$/, "");
  if (!o) return false;
  if (BILLING_PORTAL_RETURN_ORIGINS.has(o)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return true;
  return false;
}

function billingPortalReturnBase(data) {
  const fromClient =
    (data && data.returnOrigin && String(data.returnOrigin).trim().replace(/\/$/, "")) || "";
  if (fromClient && isAllowedReturnOrigin(fromClient)) {
    return fromClient;
  }
  let base = marketingOriginParam.value().trim().replace(/\/$/, "");
  if (!base || !/^https:\/\//i.test(base)) {
    base = "https://getbookking.com";
  }
  return base;
}

function stripeErrorMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
  if (err.raw && typeof err.raw.message === "string") return err.raw.message.trim();
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch (_) {
    return String(err);
  }
}

function formatPaymentMethodLabel(pm) {
  if (!pm || typeof pm !== "object") return "";
  if (pm.card && pm.card.last4) {
    const b = (pm.card.brand || "Card").toString();
    const brand = b.charAt(0).toUpperCase() + b.slice(1).replace(/_/g, " ");
    return `${brand} ···· ${pm.card.last4}`;
  }
  if (pm.us_bank_account && pm.us_bank_account.last4) {
    return `Bank ···· ${pm.us_bank_account.last4}`;
  }
  return "";
}

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
      const returnUrl = `${base}/account.html`;

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
        `Could not open billing portal. In Stripe: enable Customer portal and allow return URL ${baseHint}/account.html. ${raw}`
      );
    }
  });

/**
 * Marketing account page: read-only subscription status, plan label, renewal, card mask, recent invoices.
 */
exports.getBillingSummary = functions
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
      const firestorePlanOnly = normalizeSubscriptionPlan(userData.subscriptionPlan);
      if (!tenantId) {
        return {
          ok: true,
          hasStripeCustomer: false,
          firestorePlan: firestorePlanOnly,
          message: "No business linked to this account yet.",
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
      if (!stripeCustomerId) {
        return {
          ok: true,
          hasStripeCustomer: false,
          firestorePlan,
          message: "Billing is not set up for this business yet.",
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
      const dpm = sub && sub.default_payment_method;
      if (dpm && typeof dpm === "object") {
        paymentMethodLabel = formatPaymentMethodLabel(dpm);
      } else if (typeof dpm === "string" && dpm) {
        try {
          const pm = await stripe.paymentMethods.retrieve(dpm);
          paymentMethodLabel = formatPaymentMethodLabel(pm);
        } catch (_) {}
      }
      if (!paymentMethodLabel) {
        const cust = await stripe.customers.retrieve(stripeCustomerId, {
          expand: ["invoice_settings.default_payment_method"],
        });
        if (!cust.deleted && cust.invoice_settings && cust.invoice_settings.default_payment_method) {
          const pm = cust.invoice_settings.default_payment_method;
          if (typeof pm === "object") paymentMethodLabel = formatPaymentMethodLabel(pm);
        }
      }

      let subscriptionPayload = null;
      if (sub) {
        const item0 = sub.items && sub.items.data && sub.items.data[0];
        let planName = "";
        let unitAmount = null;
        let currency = "usd";
        let interval = "";
        if (item0 && item0.price) {
          const price = item0.price;
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

      const invList = await stripe.invoices.list({ customer: stripeCustomerId, limit: 8 });
      const invoices = invList.data.map((inv) => ({
        id: inv.id,
        number: inv.number || inv.id,
        created: inv.created,
        amountPaid: inv.amount_paid,
        currency: (inv.currency || "usd").toString(),
        status: inv.status,
        hostedInvoiceUrl: inv.hosted_invoice_url || "",
      }));

      return {
        ok: true,
        hasStripeCustomer: true,
        firestorePlan,
        paymentMethodLabel: paymentMethodLabel || "",
        subscription: subscriptionPayload,
        invoices,
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
