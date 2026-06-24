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
 *
 * Customer payments (Connect): 1% platform application fee on createDepositLink and
 * createPaymentIntentForTapToPay — grossed up to the customer at checkout (with estimated
 * Stripe card fees). Not on subscription checkout.
 *
 * Client texting (Twilio): set secrets TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
 * Paid subscription (active) required; free trial (trialing) cannot enable SMS.
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
const sms = require("./sms");
const {
  isDemoShowcaseStripeAccountId,
  loadDemoShowcaseForPayCtx,
  demoConnectAccountStatusResponse,
  demoConnectBalanceResponse,
  demoConnectTransactionsResponse,
} = require("./demoShowcasePayments");
const {
  ALLOWED_DEMO_APP_SLUGS,
  buildDemoAppSnapshot,
} = require("./demoAppSnapshot");

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

/** US display (xxx) xxx-xxxx; matches iOS `PhoneFormatting` / web booking submit. */
function normalizeCustomerPhone(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return null;
  const hasPlus = s.charAt(0) === "+";
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  const formatUS10 = (d10) =>
    `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6, 10)}`;
  if (digits.length === 10) return formatUS10(digits);
  if (digits.length === 11 && digits.charAt(0) === "1") return formatUS10(digits.slice(1));
  if (hasPlus) return `+${digits}`;
  if (digits.length >= 7) return `+${digits}`;
  return digits;
}

function customerDocIdForTenant(name, email, phone) {
  const digits = (phone || "").toString().replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  const normalizedEmail = (email || "").toString().trim().toLowerCase();
  if (normalizedEmail) {
    return normalizedEmail
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120);
  }
  const fallback = (name || "").toString().trim().toLowerCase() || "customer";
  const safe = fallback.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${safe || "customer"}_${Date.now()}`;
}

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
    const pendingRef = db.collection("pendingProviderSignups").doc(uid);
    const pendingSnap = await pendingRef.get();
    if (pendingSnap.exists) {
      throw new functions.https.HttpsError(
        "already-exists",
        "This account already has a business. Log in to the app or sign up with a new email."
      );
    }
    const tid = existingUser.data().tenantId;
    const tSnap = await db.collection("tenants").doc(tid).get();
    const slug = tSnap.exists ? tSnap.data().slug || "" : "";
    return { tenantId: tid, slug, alreadyProvisioned: true };
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
    contactAddressSuite: "",
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
  if (billing.subscriptionStatus) {
    tenantData.subscriptionStatus = billing.subscriptionStatus;
  }

  if (industry === "custom" && industryCustomLabel) {
    tenantData.industryCustomLabel = industryCustomLabel;
  }

  const ownerMemberSlug = slugFromPersonName(firstName, lastName) || "owner";

  const userDoc = {
    email: email || "",
    firstName,
    lastName,
    displayName,
    name: displayName,
    tenantId,
    tenantSlug: slug,
    role: "owner",
    memberSlug: ownerMemberSlug,
    isBookable: true,
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

function planNormFromPriceId(priceId) {
  const pid = (priceId || "").toString().trim();
  if (!pid) return null;
  try {
    const map = parseStripeSubscriptionPriceIds();
    for (const [plan, id] of Object.entries(map)) {
      if ((id || "").toString().trim() === pid) {
        return normalizeSubscriptionPlan(plan);
      }
    }
  } catch (_) {
    /* secrets unavailable in some contexts */
  }
  return null;
}

function planNormFromStripeSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const metaPlan = sub.metadata && sub.metadata.plan;
  if (metaPlan) return normalizeSubscriptionPlan(metaPlan);
  const item0 = sub.items && sub.items.data && sub.items.data[0];
  if (!item0) return null;
  const price = item0.price;
  const priceId =
    (price && typeof price === "object" && price.id) ||
    (typeof price === "string" ? price : null);
  return planNormFromPriceId(priceId);
}

/** Find tenant by Stripe customer id and sync subscription + plan to Firestore. */
async function syncStripeSubscriptionStatusToTenant(stripe, stripeCustomerId, status, sub) {
  const cid = (stripeCustomerId || "").toString().trim();
  if (!cid) return;
  const snap = await db
    .collection("tenants")
    .where("stripeCustomerId", "==", cid)
    .limit(1)
    .get();
  if (snap.empty) return;
  const tenantId = snap.docs[0].id;
  const normalized = (status || "").toString().trim().toLowerCase();
  const patch = {};
  if (sub && sub.id) patch.stripeSubscriptionId = sub.id;
  patch.stripeCustomerId = cid;
  const planNorm = planNormFromStripeSubscription(sub);
  if (planNorm) patch.subscriptionPlan = planNorm;
  await sms.syncSubscriptionStatusForTenant(tenantId, normalized, patch);
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

    try {
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
          "No tenant linked to this provider. Finish signup first."
        );
      }

      const payCtx = await resolvePaymentStripeContext(uid);
      if (!payCtx?.canConnect) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Your studio collects payments for you. Ask your admin to enable independent payouts."
        );
      }

      const tenantRef = db.collection("tenants").doc(tenantId);
      const tenantDoc = await tenantRef.get();
      const tenantData = tenantDoc.exists ? tenantDoc.data() : {};
      const accountRef =
        payCtx.scope === "user"
          ? db.collection("users").doc(uid)
          : tenantRef;
      let stripeAccountId = payCtx.stripeAccountId;

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
        await accountRef.set({ stripeAccountId }, { merge: true });
      }

      const account = await stripe.accounts.retrieve(stripeAccountId);
      if (account.charges_enabled) {
        return {
          alreadyConnected: true,
          chargesEnabled: true,
          hasAccount: true,
          detailsSubmitted: account.details_submitted ?? false,
        };
      }

      const currentlyDue =
        (account.requirements && account.requirements.currently_due) || [];
      if (account.details_submitted && currentlyDue.length === 0) {
        return {
          pendingReview: true,
          hasAccount: true,
          detailsSubmitted: true,
          chargesEnabled: false,
        };
      }

      const baseUrl = (data?.returnBaseUrl ?? "https://getbookking.com").toString().replace(/\/$/, "");
      const returnUrl = data?.returnUrl ?? `${baseUrl}/account.html?stripe=success`;
      const refreshUrl = data?.refreshUrl ?? `${baseUrl}/account.html?stripe=refresh`;
      const linkType = account.details_submitted ? "account_update" : "account_onboarding";
      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: linkType,
      });

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
        payoutMode: payCtx?.payoutMode || "studio_payroll",
        studioPayroll: true,
      };
    }

    const demoShowcase = await loadDemoShowcaseForPayCtx(db, payCtx);
    if (demoShowcase) {
      return demoConnectAccountStatusResponse(demoShowcase.payCtx);
    }

    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      return {
        hasAccount: false,
        canTakePayments: true,
        usesOwnPayments: payCtx.scope === "user",
        payoutMode: payCtx.payoutMode,
        paymentScope: payCtx.scope,
      };
    }

    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return demoConnectAccountStatusResponse(payCtx);
    }

    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-11-20.acacia",
    });
    const account = await stripe.accounts.retrieve(stripeAccountId);

    const terminalLocationId = payCtx.terminalLocationId || null;

    return {
      hasAccount: true,
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      terminalLocationId,
      canTakePayments: true,
      usesOwnPayments: payCtx.scope === "user",
      payoutMode: payCtx.payoutMode,
      paymentScope: payCtx.scope,
    };
  });

/**
 * Platform fee on customer payments (Tap to Pay, deposit links, future checkout).
 * Not applied to provider subscriptions. 100 bps = 1%.
 */
const PLATFORM_FEE_BPS = 100;

/** Application fee in USD cents (min 1¢). Collected via Connect; grossed up to customer at checkout. */
function platformFeeCents(amountCents) {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round((n * PLATFORM_FEE_BPS) / 10000));
}

/** Estimated Stripe card rates used to gross-up customer checkout (USD). */
const STRIPE_ONLINE_BPS = 290;
const STRIPE_ONLINE_FIXED_CENTS = 30;
const STRIPE_CARD_PRESENT_BPS = 270;
const STRIPE_CARD_PRESENT_FIXED_CENTS = 5;

/**
 * Gross-up checkout so provider nets the quoted service/deposit after Stripe + platform fees.
 * @param {number} serviceCents
 * @param {"online"|"card_present"} channel
 */
function computeCardCheckoutAmounts(serviceCents, channel = "online") {
  const service = Math.max(0, Math.round(Number(serviceCents)));
  if (service <= 0) {
    return {
      serviceCents: 0,
      surchargeCents: 0,
      totalCents: 0,
      platformFeeCents: 0,
    };
  }
  const isCardPresent = channel === "card_present";
  const stripeBps = isCardPresent ? STRIPE_CARD_PRESENT_BPS : STRIPE_ONLINE_BPS;
  const stripeFixed = isCardPresent
    ? STRIPE_CARD_PRESENT_FIXED_CENTS
    : STRIPE_ONLINE_FIXED_CENTS;
  const combinedBps = stripeBps + PLATFORM_FEE_BPS;
  const totalCents = Math.ceil(
    (service + stripeFixed) / (1 - combinedBps / 10000)
  );
  const surchargeCents = totalCents - service;
  return {
    serviceCents: service,
    surchargeCents,
    totalCents,
    platformFeeCents: platformFeeCents(totalCents),
  };
}

function parseServiceAmountCents(data) {
  if (typeof data?.serviceAmountCents === "number") {
    return Math.round(data.serviceAmountCents);
  }
  if (typeof data?.amountCents === "number") {
    return Math.round(data.amountCents);
  }
  return null;
}

/** Helper: resolve Stripe Connect account + Terminal location for a user. */
async function resolvePaymentStripeContext(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  const userData = userDoc.data();
  const tenantId = userData.tenantId;
  if (!tenantId) return null;

  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) return null;
  const tenant = tenantDoc.data();
  const ownerUid = (tenant.ownerUid || "").toString().trim();
  const isOwner = ownerUid === uid;

  if (isOwner) {
    const stripeAccountId = (tenant.stripeAccountId || "").toString().trim() || null;
    const terminalLocationId =
      (tenant.stripeTerminalLocationId || "").toString().trim() || null;
    return {
      scope: "tenant",
      tenantId,
      stripeAccountId,
      terminalLocationId,
      canConnect: true,
      canTakePayments: true,
      payoutMode: null,
      isOwner: true,
    };
  }

  const payoutMode = normalizeMemberSettings(userData.memberSettings).payoutMode;
  const usesOwnPayments = payoutMode === "independent";

  if (usesOwnPayments) {
    const stripeAccountId = (userData.stripeAccountId || "").toString().trim() || null;
    const terminalLocationId =
      (userData.stripeTerminalLocationId || "").toString().trim() || null;
    return {
      scope: "user",
      tenantId,
      stripeAccountId,
      terminalLocationId,
      canConnect: true,
      canTakePayments: true,
      payoutMode,
      isOwner: false,
    };
  }

  return {
    scope: "tenant",
    tenantId,
    stripeAccountId: null,
    terminalLocationId: null,
    canConnect: false,
    canTakePayments: false,
    payoutMode,
    isOwner: false,
  };
}

/** Helper: get stripeAccountId for authenticated user's effective payment account */
async function getStripeAccountIdForUser(uid) {
  const ctx = await resolvePaymentStripeContext(uid);
  return ctx?.stripeAccountId ?? null;
}

async function assertCanTakePayments(uid) {
  const ctx = await resolvePaymentStripeContext(uid);
  if (!ctx?.canTakePayments) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio collects payments for you. Ask your admin to enable independent payouts."
    );
  }
  return ctx;
}

function memberDisplayNameFromUserData(userData, fallback) {
  if (!userData) return fallback || "Team member";
  const fn = (userData.firstName || "").toString().trim();
  const ln = (userData.lastName || "").toString().trim();
  const composed = `${fn} ${ln}`.trim();
  return (
    (userData.displayName || userData.name || composed || fallback || "Team member")
      .toString()
      .trim()
  );
}

/**
 * Stripe account for a charge/deposit, optionally routed to the booking's assigned provider.
 * Independent members receive customer payments on their Connect account; studio payroll uses the tenant account.
 */
async function resolveEffectivePaymentContext(uid, options = {}) {
  const callerCtx = await resolvePaymentStripeContext(uid);
  if (!callerCtx) return null;

  const bookingRequestId = (options.bookingRequestId || "").toString().trim();
  const tenantId =
    (options.tenantId || callerCtx.tenantId || "").toString().trim() || null;
  if (!bookingRequestId || !tenantId) {
    return { ...callerCtx, attributedMemberUid: null, chargeOnBehalfOfMemberUid: null };
  }

  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    return { ...callerCtx, attributedMemberUid: null, chargeOnBehalfOfMemberUid: null };
  }
  const tenant = tenantSnap.data();
  const ownerUid = (tenant.ownerUid || "").toString().trim();
  const booking = await loadBookingRequestForPayment(tenantId, bookingRequestId);
  if (!booking) {
    return { ...callerCtx, attributedMemberUid: null, chargeOnBehalfOfMemberUid: null };
  }

  const attributedMemberUid = resolveAttributedMemberUid(tenant, booking, uid);

  if (!attributedMemberUid || attributedMemberUid === ownerUid) {
    const stripeAccountId = (tenant.stripeAccountId || "").toString().trim() || null;
    const terminalLocationId =
      (tenant.stripeTerminalLocationId || "").toString().trim() || null;
    return {
      scope: "tenant",
      tenantId,
      stripeAccountId,
      terminalLocationId,
      canConnect: callerCtx.isOwner,
      canTakePayments: callerCtx.isOwner || callerCtx.canTakePayments,
      payoutMode: null,
      isOwner: callerCtx.isOwner,
      attributedMemberUid: ownerUid,
      chargeOnBehalfOfMemberUid: null,
    };
  }

  const memberSnap = await db.collection("users").doc(attributedMemberUid).get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    return { ...callerCtx, attributedMemberUid, chargeOnBehalfOfMemberUid: null };
  }
  const memberData = memberSnap.data();
  const memberSettings = normalizeMemberSettings(memberData.memberSettings);
  const memberName = memberDisplayNameFromUserData(memberData, "This provider");

  if (memberSettings.payoutMode === "independent") {
    const stripeAccountId = (memberData.stripeAccountId || "").toString().trim() || null;
    const terminalLocationId =
      (memberData.stripeTerminalLocationId || "").toString().trim() || null;
    return {
      scope: "user",
      tenantId,
      stripeAccountId,
      terminalLocationId,
      canConnect: uid === attributedMemberUid,
      canTakePayments: true,
      payoutMode: "independent",
      isOwner: false,
      attributedMemberUid,
      chargeOnBehalfOfMemberUid: attributedMemberUid,
      attributedMemberName: memberName,
    };
  }

  const stripeAccountId = (tenant.stripeAccountId || "").toString().trim() || null;
  const terminalLocationId =
    (tenant.stripeTerminalLocationId || "").toString().trim() || null;
  return {
    scope: "tenant",
    tenantId,
    stripeAccountId,
    terminalLocationId,
    canConnect: callerCtx.isOwner,
    canTakePayments: callerCtx.isOwner,
    payoutMode: "studio_payroll",
    isOwner: callerCtx.isOwner,
    attributedMemberUid,
    chargeOnBehalfOfMemberUid: null,
  };
}

async function assertCanInitiateBookingPayment(uid, payCtx) {
  if (!payCtx) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No business linked to this account."
    );
  }
  if (payCtx.chargeOnBehalfOfMemberUid && payCtx.chargeOnBehalfOfMemberUid !== uid) {
    const ctx = await getMemberAccessContext(uid);
    const isOwner = ctx.isOwner || ctx.tenant.ownerUid === uid;
    const isManager = ctx.accessRole === "manager";
    if (!isOwner && !isManager) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the studio owner or a manager can collect payment for this provider."
      );
    }
  } else if (!payCtx.canTakePayments) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio collects payments for you. Ask your admin to enable independent payouts."
    );
  }
  if (!payCtx.stripeAccountId) {
    const who =
      payCtx.chargeOnBehalfOfMemberUid && payCtx.attributedMemberName
        ? payCtx.attributedMemberName
        : payCtx.chargeOnBehalfOfMemberUid
          ? "assigned provider"
          : "business";
    throw new functions.https.HttpsError(
      "failed-precondition",
      payCtx.chargeOnBehalfOfMemberUid
        ? `${who} must connect Stripe before you can collect payment for this booking.`
        : "Connect your studio Stripe account before collecting payment."
    );
  }
  return payCtx;
}

async function assertCanTapToPayForBooking(uid, payCtx) {
  if (!payCtx) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No business linked to this account."
    );
  }
  if (payCtx.chargeOnBehalfOfMemberUid && payCtx.chargeOnBehalfOfMemberUid !== uid) {
    const name = payCtx.attributedMemberName || "The assigned provider";
    throw new functions.https.HttpsError(
      "failed-precondition",
      `${name} must use Tap to Pay on their device for this booking.`
    );
  }
  if (!payCtx.canTakePayments) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio collects payments for you. Ask your admin to enable independent payouts."
    );
  }
  if (!payCtx.stripeAccountId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No Stripe account linked"
    );
  }
  return payCtx;
}

async function retrievePaymentIntentOnConnectAccounts(stripe, paymentIntentId, accountIds) {
  const tried = [];
  for (const accountId of accountIds) {
    const acct = (accountId || "").toString().trim();
    if (!acct || tried.includes(acct)) continue;
    tried.push(acct);
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        stripeAccount: acct,
      });
      return { pi, stripeAccountId: acct };
    } catch (e) {
      /* try next connected account */
    }
  }
  return null;
}

async function getTenantIdForUser(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  return userDoc.data().tenantId || null;
}

async function assertTenantOwner(uid, tenantId) {
  const tenantDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const ownerUid = (tenantDoc.data().ownerUid || "").toString();
  if (!ownerUid || ownerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the studio owner can manage Tap to Pay."
    );
  }
  return tenantDoc;
}

/** Build Stripe Terminal address from tenant profile fields. */
function terminalAddressFromTenant(tenant) {
  const line1 =
    (tenant.contactAddress || tenant.address || "").toString().trim() || "1 Main Street";
  const serviceArea = (tenant.serviceArea || "").toString().trim();
  let city = "Tampa";
  let state = "FL";
  let postal_code = "33602";
  if (serviceArea) {
    const parts = serviceArea.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts[0]) city = parts[0];
    if (parts[1]) {
      const tail = parts[1].split(/\s+/).filter(Boolean);
      if (tail[0] && tail[0].length <= 3) state = tail[0].toUpperCase();
      if (tail[1] && /^\d{5}/.test(tail[1])) postal_code = tail[1];
    }
  }
  return { line1, city, state, postal_code, country: "US" };
}

/**
 * Ensures tenants/{tenantId}.stripeTerminalLocationId exists (Stripe Terminal Location on Connect account).
 */
async function ensureStripeTerminalLocationForTenant(tenantId, stripe, stripeAccountId, tenantData) {
  const existing = (tenantData.stripeTerminalLocationId || "").toString().trim();
  if (existing) {
    return existing;
  }
  const displayName =
    (tenantData.displayName || tenantData.businessName || "Studio").toString().trim() ||
    "Studio";
  const address = terminalAddressFromTenant(tenantData);
  const location = await stripe.terminal.locations.create(
    {
      display_name: displayName.slice(0, 100),
      address,
    },
    { stripeAccount: stripeAccountId }
  );
  const locationId = location.id;
  await db.collection("tenants").doc(tenantId).set(
    { stripeTerminalLocationId: locationId },
    { merge: true }
  );
  return locationId;
}

/**
 * Ensures users/{uid}.stripeTerminalLocationId exists (Terminal Location on member Connect account).
 */
async function ensureStripeTerminalLocationForUser(uid, stripe, stripeAccountId, userData, tenantData) {
  const existing = (userData.stripeTerminalLocationId || "").toString().trim();
  if (existing) {
    return existing;
  }
  const displayName =
    (userData.displayName || userData.name || "Provider").toString().trim() || "Provider";
  const address = terminalAddressFromTenant(tenantData);
  const location = await stripe.terminal.locations.create(
    {
      display_name: displayName.slice(0, 100),
      address,
    },
    { stripeAccount: stripeAccountId }
  );
  const locationId = location.id;
  await db.collection("users").doc(uid).set(
    { stripeTerminalLocationId: locationId },
    { merge: true }
  );
  return locationId;
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
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const demoShowcase = await loadDemoShowcaseForPayCtx(db, payCtx);
    if (demoShowcase) {
      return demoConnectBalanceResponse(demoShowcase.payments);
    }
    const stripeAccountId = payCtx.stripeAccountId;
    if (!stripeAccountId) {
      return { availableCents: 0, pendingCents: 0 };
    }
    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
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
    const serviceAmount = parseServiceAmountCents(data) ?? 500;
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
    const feeCents = platformFeeCents(checkout.totalCents);
    const lineItems = [
      {
        price_data: {
          currency: "usd",
          product_data: { name: productName, ...(productDescription ? { description: productDescription } : {}) },
          unit_amount: checkout.serviceCents,
        },
        quantity: 1,
      },
    ];
    if (checkout.surchargeCents > 0) {
      const cardProcessingCents = Math.max(
        0,
        checkout.surchargeCents - checkout.platformFeeCents
      );
      if (cardProcessingCents > 0) {
        lineItems.push({
          price_data: {
            currency: "usd",
            product_data: { name: "Card processing" },
            unit_amount: cardProcessingCents,
          },
          quantity: 1,
        });
      }
      if (checkout.platformFeeCents > 0) {
        lineItems.push({
          price_data: {
            currency: "usd",
            product_data: { name: "Platform fee (1%)" },
            unit_amount: checkout.platformFeeCents,
          },
          quantity: 1,
        });
      }
    }
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const link = await stripe.paymentLinks.create(
      {
        line_items: lineItems,
        application_fee_amount: feeCents,
        metadata: {
          tenantId: tenantId || "",
          paymentKind: "deposit",
          serviceAmountCents: String(checkout.serviceCents),
          surchargeCents: String(checkout.surchargeCents),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      url: link.url,
      platformFeeCents: feeCents,
      serviceCents: checkout.serviceCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: checkout.totalCents,
      attributedMemberUid,
      chargeStripeScope: payCtx.scope || "tenant",
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
    const payCtx = await assertCanTakePayments(context.auth.uid);
    const stripeAccountId = payCtx.stripeAccountId;
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
    const params = {
      charge: chargeId,
      reason: reason,
      refund_application_fee: true,
    };
    if (typeof amountCents === "number" && amountCents > 0) {
      params.amount = Math.round(amountCents);
    }
    await stripe.refunds.create(params, { stripeAccount: stripeAccountId });
    return { success: true };
  });

/**
 * Public read-only snapshot for iOS "Try demo" (salon / gym personas). No auth.
 * Params: { slug: "gilded-palm" | "iron-district-gym" }
 */
exports.getDemoAppSnapshot = functions.https.onCall(async (data) => {
  const slug = (data?.slug || "").toString().trim().toLowerCase();
  if (!ALLOWED_DEMO_APP_SLUGS.has(slug)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid demo slug"
    );
  }
  try {
    return await buildDemoAppSnapshot(db, slug);
  } catch (err) {
    const msg = (err && err.message) || "Demo unavailable";
    if (msg.includes("No tenant")) {
      throw new functions.https.HttpsError("not-found", msg);
    }
    throw new functions.https.HttpsError("internal", msg);
  }
});

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
  if (tenantData.isDemoAccount === true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This demo site is read-only. Sign up for your own account to accept bookings."
    );
  }

  const customerPhone = normalizeCustomerPhone(data?.customerPhone);
  const smsConsentAccepted = data?.smsConsentAccepted === true;
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
  if (customerPhone && smsConsentAccepted) {
    bookingData.smsConsentAccepted = true;
    bookingData.smsConsentAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (serviceId) bookingData.serviceId = serviceId;
  if (serviceSlug) bookingData.serviceSlug = serviceSlug;
  if (serviceName) bookingData.serviceName = serviceName;
  if (preferredTime) bookingData.preferredTime = preferredTime;
  if (preferredDays) bookingData.preferredDays = preferredDays;
  if (notes) bookingData.notes = notes;

  const memberSlug = normalizeMemberSlugInput(data?.memberSlug);
  if (memberSlug) {
    const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
    if (plan === "solo") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Provider booking links are not available on this plan."
      );
    }
    const memberSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .where("memberSlug", "==", memberSlug)
      .limit(1)
      .get();
    if (memberSnap.empty) {
      throw new functions.https.HttpsError("not-found", "Provider not found.");
    }
    const memberDoc = memberSnap.docs[0];
    const memberData = memberDoc.data();
    if (memberData.isBookable === false) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This provider is not accepting bookings online."
      );
    }
    const mFn = (memberData.firstName || "").toString().trim();
    const mLn = (memberData.lastName || "").toString().trim();
    const memberName =
      (memberData.displayName || memberData.name || `${mFn} ${mLn}`.trim() || "Provider")
        .toString()
        .slice(0, 120);
    bookingData.assignedMemberUid = memberDoc.id;
    bookingData.assignedMemberName = memberName;
    const memberEmail = (memberData.email || "").toString().trim().toLowerCase();
    if (memberEmail) bookingData.assignedMemberEmail = memberEmail;
  }

  if (data?.formResponses && typeof data.formResponses === "object") {
    const fr = { ...data.formResponses };
    if (fr.phone != null) {
      const normalized = normalizeCustomerPhone(fr.phone);
      if (normalized) fr.phone = normalized;
    }
    bookingData.formResponses = fr;
  }

  const ref = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .add(bookingData);

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
  const tenantData = tenantDoc.data() || {};
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

  const rawLines = Array.isArray(data?.lineItems) ? data.lineItems : [];
  if (!rawLines.length) {
    throw new functions.https.HttpsError("invalid-argument", "lineItems is required");
  }
  if (rawLines.length > 50) {
    throw new functions.https.HttpsError("invalid-argument", "Too many line items");
  }

  const productSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("products")
    .get();
  const productsById = new Map();
  productSnap.docs.forEach((doc) => {
    productsById.set(doc.id, doc.data());
  });

  const lineItems = [];
  let subtotalCents = 0;
  for (const raw of rawLines) {
    const productId = (raw?.productId || "").toString().trim();
    if (!productId) continue;
    const prod = productsById.get(productId);
    if (!prod || prod.isActive === false) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "One or more products are no longer available"
      );
    }
    const qty = Math.min(999, Math.max(1, parseInt(raw?.qty, 10) || 1));
    const price = Number(prod.price) || 0;
    let effective = price;
    const sale = prod.salePrice != null ? Number(prod.salePrice) : NaN;
    if (!isNaN(sale) && sale >= 0 && sale < price) effective = sale;
    const unitPriceCents = Math.round(effective * 100);
    const lineTotalCents = unitPriceCents * qty;
    subtotalCents += lineTotalCents;
    const fallbackName = (prod.name || "Item").toString().trim();
    const clientName = (raw?.name || "").toString().trim();
    lineItems.push({
      productId,
      name: (clientName || fallbackName).slice(0, 200),
      qty,
      unitPriceCents,
      lineTotalCents,
    });
  }

  if (!lineItems.length) {
    throw new functions.https.HttpsError("invalid-argument", "No valid line items");
  }

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
      source: "shop_checkout_web",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { orderId: ref.id, subtotalCents };
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
    const serviceAmount = parseServiceAmountCents(data) ?? 100;
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
    const checkout = computeCardCheckoutAmounts(serviceAmount, "card_present");
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
    const feeCents = platformFeeCents(checkout.totalCents);
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const pi = await stripe.paymentIntents.create(
      {
        amount: checkout.totalCents,
        currency: "usd",
        payment_method_types: ["card_present"],
        application_fee_amount: feeCents,
        capture_method: "automatic",
        metadata: {
          tenantId: tenantId || "",
          paymentKind: "service",
          serviceAmountCents: String(checkout.serviceCents),
          surchargeCents: String(checkout.surchargeCents),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      platformFeeCents: feeCents,
      serviceCents: checkout.serviceCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: checkout.totalCents,
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

    // Connection tokens can optionally be scoped to a location. For Tap to Pay on iPhone,
    // location scoping is provided at connect-time via `locationId` in the connection config.
    const token = await stripe.terminal.connectionTokens.create(
      {},
      { stripeAccount: stripeAccountId }
    );

    return { secret: token.secret };
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
      return { locationId, paymentScope: payCtx.scope };
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
 * FCM push to provider devices when a booking request is created (web or app).
 * iOS stores tokens under users/{uid}/deviceTokens/{hash} (see PushNotificationManager.swift).
 */
exports.onTenantBookingRequestCreated = functions.firestore
  .document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onCreate(async (snap, context) => {
    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const data = snap.data() || {};
    const source = (data.source || "").toString().trim().toLowerCase();
    if (source === "seed") return null;

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

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      try {
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
      } catch (e) {
        console.error("stripeSubscriptionWebhook subscription sync", e);
      }
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      try {
        const inv = event.data.object;
        const customerId =
          typeof inv.customer === "string" ? inv.customer : inv.customer && inv.customer.id;
        if (customerId && inv.subscription) {
          const subId =
            typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ["items.data.price"],
          });
          await syncStripeSubscriptionStatusToTenant(stripe, customerId, sub.status, sub);
        }
      } catch (e) {
        console.error("stripeSubscriptionWebhook invoice sync", e);
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

function managersApproveAppointments(workflow) {
  if (!workflow || typeof workflow !== "object") return true;
  return workflow.managersApproveAppointments !== false;
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
      managersApproveAppointments: managersApproveAppointments(tenant.workflow),
    };
  }
  if (ownerUserData && ownerUserData.workflow && ownerUserData.workflow.confirmationType) {
    return {
      confirmationType: ownerUserData.workflow.confirmationType,
      responseTimeHours: ownerUserData.workflow.responseTimeHours || 24,
      depositAmount: ownerUserData.workflow.depositAmount,
      managersApproveAppointments: managersApproveAppointments(ownerUserData.workflow),
    };
  }
  return { ...DEFAULT_TENANT_WORKFLOW, managersApproveAppointments: true };
}

function resolveEffectiveBookingWorkflow(tenant, userData, ownerUserData, memberUid) {
  const tenantWf = resolveTenantWorkflow(tenant, ownerUserData || null);
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString();
  const uid = (memberUid || "").toString();
  const isOwner = Boolean(ownerUid && uid && ownerUid === uid);
  const ownerControlsTeam =
    !isOwner && managersApproveAppointments(tenantWf);

  if (ownerControlsTeam) {
    return {
      confirmationType: tenantWf.confirmationType,
      responseTimeHours: tenantWf.responseTimeHours,
      depositAmount: tenantWf.depositAmount,
      usesStudioBookingPolicy: true,
    };
  }

  const personalWf =
    userData && userData.workflow && typeof userData.workflow === "object"
      ? userData.workflow
      : {};
  let confirmationType = (personalWf.confirmationType || "").toString().trim();
  if (!confirmationType) {
    confirmationType =
      tenantWf.confirmationType || DEFAULT_TENANT_WORKFLOW.confirmationType;
  }

  return {
    confirmationType,
    responseTimeHours:
      personalWf.responseTimeHours != null
        ? personalWf.responseTimeHours
        : tenantWf.responseTimeHours,
    depositAmount:
      personalWf.depositAmount != null
        ? personalWf.depositAmount
        : tenantWf.depositAmount,
    usesStudioBookingPolicy: false,
  };
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
  const workflow = resolveEffectiveBookingWorkflow(
    tenant,
    userData,
    isOwner ? userData : ownerUserData,
    uid
  );
  const accessRole = isOwner ? "owner" : parseAccessRole(userData.role || userData.accessRole);
  const managerPermissions = tenant.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  return {
    tenantId,
    tenant,
    userData,
    ownerUserData,
    isOwner,
    accessRole,
    workflow,
    tenantWorkflow: resolveTenantWorkflow(tenant, isOwner ? userData : ownerUserData),
    managerPermissions,
    bookingRequiresApproval: bookingRequiresApproval(workflow.confirmationType),
    managersApproveAppointments: managersApproveAppointments(
      resolveTenantWorkflow(tenant, isOwner ? userData : ownerUserData)
    ),
    usesStudioBookingPolicy: workflow.usesStudioBookingPolicy === true,
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
const PAYOUT_MODES = new Set(["studio_payroll", "independent"]);

function normalizeMemberSettings(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const useStudio = d.useStudioBookingPolicy === true;
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
  let paymentSplitEnabled = d.paymentSplitEnabled === true;
  if (d.paymentSplitEnabled === undefined && paymentSplitPercent > 0) {
    paymentSplitEnabled = true;
  }
  let payoutMode = (d.payoutMode || "independent").toString().trim().toLowerCase();
  if (!PAYOUT_MODES.has(payoutMode)) payoutMode = "independent";
  const out = {
    useStudioBookingPolicy: useStudio,
    paymentSplitEnabled,
    paymentSplitPercent,
    paymentSplitAppliesTo,
    payoutMode,
  };
  if (!useStudio && bookingConfirmationOverride) {
    out.bookingConfirmationOverride = bookingConfirmationOverride;
  }
  return out;
}

function paymentKindMatchesSplit(settings, paymentKind) {
  const normalized = normalizeMemberSettings(settings);
  if (!normalized.paymentSplitEnabled || normalized.paymentSplitPercent <= 0) {
    return false;
  }
  const kind = (paymentKind || "service").toString().trim().toLowerCase();
  const applies = normalized.paymentSplitAppliesTo;
  if (applies === "both") return true;
  if (kind === "deposit") return applies === "deposit";
  return applies === "service";
}

/** Split on service/deposit amount; pass-through checkout fees stay with studio. */
function computeTeamPaymentSplit({
  memberSettings,
  paymentKind,
  serviceCents,
}) {
  const service = Math.max(0, Math.round(Number(serviceCents)));
  if (!paymentKindMatchesSplit(memberSettings, paymentKind)) {
    return {
      splitApplied: false,
      splitPercentApplied: 0,
      artistShareCents: 0,
      studioServiceShareCents: service,
    };
  }
  const normalized = normalizeMemberSettings(memberSettings);
  const percent = normalized.paymentSplitPercent;
  const artistShareCents = Math.round((service * percent) / 100);
  return {
    splitApplied: true,
    splitPercentApplied: percent,
    artistShareCents,
    studioServiceShareCents: service - artistShareCents,
  };
}

function resolveAttributedMemberUid(tenant, bookingRequest, initiatedByUid) {
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const assigned = ((bookingRequest && bookingRequest.assignedMemberUid) || "")
    .toString()
    .trim();
  if (assigned) return assigned;
  const initiator = (initiatedByUid || "").toString().trim();
  if (initiator && initiator !== ownerUid) return initiator;
  return ownerUid;
}

async function loadBookingRequestForPayment(tenantId, requestId) {
  const rid = (requestId || "").toString().trim();
  if (!tenantId || !rid) return null;
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .doc(rid)
    .get();
  return snap.exists ? snap.data() : null;
}

/**
 * Records payment + team split for reporting after a successful card charge.
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
        "Payment not found on this business or provider account."
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
    if (pi.status !== "succeeded") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Payment is not complete yet."
      );
    }
    if ((meta.tenantId || "").toString() !== tenantId) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Payment does not belong to this business."
      );
    }
    const serviceCents = parseInt(meta.serviceAmountCents, 10);
    const surchargeCents = parseInt(meta.surchargeCents, 10);
    const paymentKind = (meta.paymentKind || "service").toString();
    const bookingRequestId = (meta.bookingRequestId || "").toString().trim();
    const resolvedService =
      Number.isNaN(serviceCents) || serviceCents <= 0
        ? Math.max(0, (pi.amount || 0) - (Number.isNaN(surchargeCents) ? 0 : surchargeCents))
        : serviceCents;
    const resolvedSurcharge = Number.isNaN(surchargeCents) ? 0 : Math.max(0, surchargeCents);
    const grossCents = pi.amount || resolvedService + resolvedSurcharge;

    let stripeFeeCents = 0;
    const chargeId =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : pi.latest_charge && pi.latest_charge.id;
    if (chargeId) {
      try {
        const charge = await stripe.charges.retrieve(chargeId, {
          stripeAccount: stripeAccountId,
        });
        if (charge.balance_transaction) {
          const btId =
            typeof charge.balance_transaction === "string"
              ? charge.balance_transaction
              : charge.balance_transaction.id;
          const bt = await stripe.balanceTransactions.retrieve(btId, {
            stripeAccount: stripeAccountId,
          });
          stripeFeeCents = bt.fee || 0;
        }
      } catch (feeErr) {
        console.warn("recordTenantPayment fee lookup", feeErr.message);
      }
    }
    const platformFee = platformFeeCents(grossCents);

    const booking = await loadBookingRequestForPayment(tenantId, bookingRequestId);
    const initiatedByUid = (meta.initiatedByUid || uid).toString();
    const attributedMemberUid = resolveAttributedMemberUid(tenant, booking, initiatedByUid);
    const ownerUid = (tenant.ownerUid || "").toString();
    let memberSettings = {};
    if (attributedMemberUid && attributedMemberUid !== ownerUid) {
      const memberSnap = await db.collection("users").doc(attributedMemberUid).get();
      if (memberSnap.exists && memberSnap.data().tenantId === tenantId) {
        memberSettings = memberSnap.data().memberSettings || {};
      }
    }

    const split = computeTeamPaymentSplit({
      memberSettings,
      paymentKind,
      serviceCents: resolvedService,
    });

    const ledgerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("paymentLedger")
      .doc(paymentIntentId);
    const existing = await ledgerRef.get();
    if (existing.exists) {
      return { ok: true, alreadyRecorded: true, ledgerId: paymentIntentId };
    }

    await ledgerRef.set({
      paymentIntentId,
      chargeId: chargeId || null,
      bookingRequestId: bookingRequestId || null,
      attributedMemberUid: attributedMemberUid || ownerUid,
      paymentKind,
      serviceCents: resolvedService,
      surchargeCents: resolvedSurcharge,
      grossCents,
      stripeFeeCents,
      platformFeeCents: platformFee,
      splitApplied: split.splitApplied,
      splitPercentApplied: split.splitPercentApplied,
      artistShareCents: split.artistShareCents,
      studioServiceShareCents: split.studioServiceShareCents,
      initiatedByUid,
      chargeStripeScope: chargeCtx?.scope || "tenant",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      ledgerId: paymentIntentId,
      serviceCents: resolvedService,
      surchargeCents: resolvedSurcharge,
      grossCents,
      artistShareCents: split.artistShareCents,
      studioServiceShareCents: split.studioServiceShareCents,
    };
  });

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

const RESERVED_PROVIDER_SLUGS = new Set([
  "book",
  "gallery",
  "shop",
  "about",
  "home",
  "join",
  "checkout",
]);

function slugFromPersonName(firstName, lastName) {
  const parts = [
    (firstName || "").toString().trim(),
    (lastName || "").toString().trim(),
  ].filter(Boolean);
  const base = parts.join(" ") || "member";
  return base
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-")
    .slice(0, 48);
}

function normalizeMemberSlugInput(raw) {
  const s = (raw || "").toString().trim().toLowerCase();
  if (!s) return "";
  const slug = s
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (!slug || RESERVED_PROVIDER_SLUGS.has(slug)) return "";
  return slug;
}

async function allocateMemberSlug(tenantId, firstName, lastName, excludeUid) {
  let base = slugFromPersonName(firstName, lastName);
  if (!base || RESERVED_PROVIDER_SLUGS.has(base)) base = "member";
  let candidate = base;
  let n = 0;
  while (n < 100) {
    const snap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .where("memberSlug", "==", candidate)
      .limit(2)
      .get();
    const taken = snap.docs.some((doc) => doc.id !== (excludeUid || ""));
    if (!taken) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

async function ensureUserMemberSlug(uid, userData, tenantId) {
  const existing = normalizeMemberSlugInput(userData.memberSlug);
  if (existing) return existing;
  const slug = await allocateMemberSlug(
    tenantId,
    userData.firstName,
    userData.lastName,
    uid
  );
  await db.collection("users").doc(uid).set({ memberSlug: slug }, { merge: true });
  return slug;
}

function resolveMemberIsBookable(d, ownerUid, uid) {
  if (d.isBookable === true) return true;
  if (d.isBookable === false) return false;
  if (uid === ownerUid) return true;
  const accessRole = parseAccessRole(d.role || d.accessRole);
  return accessRole === "member";
}

function defaultMemberSettingsForInvite(accessRole) {
  const role = parseAccessRole(accessRole);
  if (role === "manager") {
    return normalizeMemberSettings({
      payoutMode: "studio_payroll",
      useStudioBookingPolicy: true,
    });
  }
  return normalizeMemberSettings({
    payoutMode: "independent",
    useStudioBookingPolicy: false,
  });
}

function serializePublicProvider(doc, tenant) {
  const d = doc.data();
  const uid = doc.id;
  const ownerUid = (tenant.ownerUid || "").toString();
  const memberSlug = normalizeMemberSlugInput(d.memberSlug);
  const isBookable = resolveMemberIsBookable(d, ownerUid, uid);
  if (!memberSlug || !isBookable) return null;
  const fn = (d.firstName || "").toString().trim();
  const ln = (d.lastName || "").toString().trim();
  return {
    uid,
    memberSlug,
    displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Provider").toString(),
    jobTitle: (d.jobTitle || "").toString(),
    profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
    providerAboutText: (d.providerAboutText || "").toString(),
    isOwner: uid === ownerUid,
  };
}

async function resolveTenantBySlug(tenantSlug) {
  const slug = (tenantSlug || "").toString().trim().toLowerCase();
  if (!slug) return null;
  const snap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

function serializeTeamMember(doc, ownerUid, tenant, ownerUserData) {
  const d = doc.data();
  const uid = doc.id;
  const fn = (d.firstName || "").toString().trim();
  const ln = (d.lastName || "").toString().trim();
  let accessRole = parseAccessRole(d.role || d.accessRole);
  if (uid === ownerUid) accessRole = "owner";
  const effective = resolveEffectiveBookingWorkflow(
    tenant,
    d,
    ownerUserData || null,
    uid
  );
  const personalRaw =
    d.workflow && d.workflow.confirmationType
      ? String(d.workflow.confirmationType).trim()
      : "";
  return {
    uid,
    firstName: fn,
    lastName: ln,
    displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Member").toString(),
    email: (d.email || "").toString(),
    phone: (d.phone || "").toString(),
    profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
    accessRole,
    role: accessRole,
    jobTitle: (d.jobTitle || "").toString(),
    memberSlug: normalizeMemberSlugInput(d.memberSlug),
    isBookable: resolveMemberIsBookable(d, ownerUid, uid),
    providerAboutText: (d.providerAboutText || "").toString(),
    memberSettings: normalizeMemberSettings(d.memberSettings),
    personalConfirmationType: personalRaw,
    effectiveConfirmationType: (effective.confirmationType || "").toString(),
  };
}

/** Seat caps: Solo 1, Studio 2–5, Shop 6–10. */
function maxSeatsForPlanNormalized(plan) {
  const p = normalizeSubscriptionPlan(plan);
  if (p === "solo") return 1;
  if (p === "studio") return 5;
  return 10;
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
  const jobTitle = normalizeJobTitle(
    inv.jobTitle || defaultJobTitleForIndustry(t.industry || "custom")
  );
  return { businessName, jobTitle };
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
  const memberSlug = await allocateMemberSlug(tenantId, firstName, lastName, uid);
  const isBookable = inviteAccessRole !== "manager";
  const inviteMemberSettings = defaultMemberSettingsForInvite(inviteAccessRole);

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
      memberSlug,
      isBookable,
      memberSettings: inviteMemberSettings,
      availability: userData.availability || defaultAvailability,
      workflow: userData.workflow || defaultWorkflow,
      createdAt: userData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(userRef, userPatch, { merge: true });
  });

  return { ok: true, tenantId };
});

/** Public: bookable providers for a studio/shop site (team cards + provider pages). */
exports.listPublicProviders = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required.");
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = resolved.data;
  const tenantId = resolved.id;
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (plan === "solo") {
    return { providers: [], subscriptionPlan: plan, tenantSlug };
  }
  if (tenant.isActive === false || tenant.isDemoAccount === true) {
    return { providers: [], subscriptionPlan: plan, tenantSlug };
  }
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const providers = [];
  for (const doc of snap.docs) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      const pub = serializePublicProvider(fresh, tenant);
      if (pub) providers.push(pub);
    } else {
      const pub = serializePublicProvider(doc, tenant);
      if (pub) providers.push(pub);
    }
  }
  providers.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  return { providers, subscriptionPlan: plan, tenantSlug };
});

/** Public: one provider profile for /{studio}/{member} pages. */
exports.getPublicProvider = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  const memberSlug = normalizeMemberSlugInput(data?.memberSlug);
  if (!tenantSlug || !memberSlug) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "tenantSlug and memberSlug are required."
    );
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = resolved.data;
  const tenantId = resolved.id;
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (plan === "solo") {
    throw new functions.https.HttpsError("not-found", "Provider not found.");
  }
  if (tenant.isActive === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting bookings right now."
    );
  }
  const snap = await db
    .collection("users")
    .where("tenantId", "==", tenantId)
    .where("memberSlug", "==", memberSlug)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new functions.https.HttpsError("not-found", "Provider not found.");
  }
  const doc = snap.docs[0];
  let provider = serializePublicProvider(doc, tenant);
  if (!provider) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      provider = serializePublicProvider(fresh, tenant);
    }
  }
  if (!provider) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This provider is not available for online booking."
    );
  }
  return {
    provider,
    tenant: {
      slug: tenant.slug || tenantSlug,
      displayName: tenant.displayName || tenant.businessName || "",
      businessName: tenant.businessName || "",
      subscriptionPlan: plan,
    },
  };
});

/** Signed-in member: role, effective manager toggles, tenant booking workflow. */
exports.getMyTeamAccess = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  const isOwner = ctx.isOwner || ctx.tenant.ownerUid === context.auth.uid;
  const memberSettings = normalizeMemberSettings(ctx.userData.memberSettings);
  const usesOwnPayments = !isOwner && memberSettings.payoutMode === "independent";
  return {
    tenantId: ctx.tenantId,
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    subscriptionPlan: normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan),
    managerPermissions: ctx.managerPermissions,
    confirmationType: ctx.workflow.confirmationType,
    responseTimeHours: ctx.workflow.responseTimeHours,
    bookingRequiresApproval: ctx.bookingRequiresApproval,
    managersApproveAppointments: ctx.managersApproveAppointments,
    usesStudioBookingPolicy: ctx.usesStudioBookingPolicy === true,
    tenantConfirmationType: ctx.tenantWorkflow.confirmationType,
    payoutMode: isOwner ? null : memberSettings.payoutMode,
    usesOwnPayments,
    canTakePayments: isOwner || usesOwnPayments,
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

  if (managersApprove && data && data.confirmationType != null) {
    const confirmationType = (data.confirmationType || "").toString().trim().toLowerCase();
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
    workflow.confirmationType = confirmationType;
    if (data.depositAmount != null && !Number.isNaN(Number(data.depositAmount))) {
      const dep = Number(data.depositAmount);
      if (dep > 0) workflow.depositAmount = dep;
      else delete workflow.depositAmount;
    }
  }

  await db.collection("tenants").doc(ctx.tenantId).update({
    workflow,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("users").doc(uid).set(
    {
      workflow: {
        managersApproveAppointments: managersApprove,
      },
    },
    { merge: true }
  );
  const effectiveType =
    workflow.confirmationType || DEFAULT_TENANT_WORKFLOW.confirmationType;
  return {
    ok: true,
    bookingRequiresApproval: bookingRequiresApproval(effectiveType),
    managersApproveAppointments: managersApprove,
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
      (ctx.managersApproveAppointments &&
        ctx.accessRole === "manager" &&
        ctx.managerPermissions.approveRejectRequests);
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

const {
  SEED_CONFIRM,
  MAX_SEED_COUNT,
  writeSeedBookingRequests,
} = require("./seedBookingRequestsLib");

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
  const ownerSnap = tenant.ownerUid
    ? await db.collection("users").doc(tenant.ownerUid).get()
    : null;
  const ownerData =
    ownerSnap && ownerSnap.exists ? ownerSnap.data() : null;
  const members = snap.docs.map((doc) =>
    serializeTeamMember(doc, tenant.ownerUid, tenant, ownerData)
  );
  members.sort((a, b) => {
    const rank = { owner: 0, manager: 1, member: 2 };
    const ra = rank[a.accessRole] ?? 3;
    const rb = rank[b.accessRole] ?? 3;
    if (ra !== rb) return ra - rb;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  const perms = tenant.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  const notifs = tenant.managerNotifications || DEFAULT_MANAGER_NOTIFICATIONS;
  const workflow = resolveTenantWorkflow(tenant, ownerData);
  const confirmationType = workflow.confirmationType;
  const messaging = serializeMessagingFields(tenant, ownerData);
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
    managersApproveAppointments: managersApproveAppointments(workflow),
    members,
    ...messaging,
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
  if (data && data.isBookable != null) {
    patch.isBookable = Boolean(data.isBookable);
  }
  if (data && data.providerAboutText != null) {
    patch.providerAboutText = (data.providerAboutText || "")
      .toString()
      .trim()
      .slice(0, 2000);
  }
  if (data && data.memberSlug != null) {
    const nextSlug = normalizeMemberSlugInput(data.memberSlug);
    if (!nextSlug) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Provider URL must use letters, numbers, and hyphens only."
      );
    }
    const clashSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .where("memberSlug", "==", nextSlug)
      .limit(2)
      .get();
    const taken = clashSnap.docs.some((doc) => doc.id !== memberUid);
    if (taken) {
      throw new functions.https.HttpsError(
        "already-exists",
        "That provider URL is already in use on your team."
      );
    }
    patch.memberSlug = nextSlug;
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

const TENANT_SUBCOLLECTIONS = [
  "services",
  "products",
  "customers",
  "bookingRequests",
  "smsThreads",
  "smsLog",
  "smsOptOuts",
];

function parseLifecycleConfirmPhrase(data, expected) {
  const phrase = ((data && data.confirmPhrase) || "").toString().trim().toUpperCase();
  if (phrase !== expected) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `Type ${expected} to confirm.`
    );
  }
}

async function deleteFirestoreQueryInBatches(query, batchSize = 300) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

async function deleteCollectionRef(collectionRef) {
  await deleteFirestoreQueryInBatches(collectionRef);
}

async function deleteUserDeviceTokens(uid) {
  await deleteCollectionRef(db.collection("users").doc(uid).collection("deviceTokens"));
}

async function deleteStoragePrefix(prefix) {
  try {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map((file) => file.delete().catch(() => null)));
  } catch (err) {
    console.warn("deleteStoragePrefix", prefix, err.message || err);
  }
}

async function deleteUserProfileStorage(uid) {
  try {
    const bucket = admin.storage().bucket();
    await bucket.file(`users/${uid}/profile.jpg`).delete();
  } catch (_) {
    /* optional */
  }
}

const UNLINK_TENANT_USER_PATCH = {
  tenantId: admin.firestore.FieldValue.delete(),
  tenantSlug: admin.firestore.FieldValue.delete(),
  role: admin.firestore.FieldValue.delete(),
  accessRole: admin.firestore.FieldValue.delete(),
  jobTitle: admin.firestore.FieldValue.delete(),
};

async function unlinkUsersFromTenant(tenantId, excludeUid) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const batch = db.batch();
  let count = 0;
  snap.docs.forEach((doc) => {
    if (excludeUid && doc.id === excludeUid) return;
    batch.set(doc.ref, UNLINK_TENANT_USER_PATCH, { merge: true });
    count += 1;
  });
  if (count > 0) await batch.commit();
  return count;
}

async function countOtherTeamMembers(tenantId, uid) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  return snap.docs.filter((doc) => doc.id !== uid).length;
}

async function cancelTenantStripeSubscription(tenantData) {
  const stripeSubscriptionId = (tenantData.stripeSubscriptionId || "").toString().trim();
  if (!stripeSubscriptionId) return;
  const secretKey = stripeSecretKey.value();
  if (!secretKey) return;
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId);
  } catch (err) {
    console.warn("cancelTenantStripeSubscription", stripeSubscriptionId, err.message || err);
  }
}

async function deleteTenantInvitesForTenant(tenantId) {
  const snap = await db.collection("tenantInvites").where("tenantId", "==", tenantId).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

async function deleteTenantData(tenantId) {
  const tenantRef = db.collection("tenants").doc(tenantId);
  for (const sub of TENANT_SUBCOLLECTIONS) {
    await deleteCollectionRef(tenantRef.collection(sub));
  }
  await deleteTenantInvitesForTenant(tenantId);
  await deleteStoragePrefix(`tenants/${tenantId}/`);
  await tenantRef.delete();
}

async function deleteUserFirestoreAndAuth(uid) {
  await deleteUserDeviceTokens(uid);
  await deleteUserProfileStorage(uid);
  await db.collection("pendingProviderSignups").doc(uid).delete().catch(() => null);
  await db.collection("users").doc(uid).delete().catch(() => null);
  await admin.auth().deleteUser(uid);
}

function memberIndependentStripeAccountId(userData) {
  const accountId = (userData.stripeAccountId || "").toString().trim();
  if (!accountId) return null;
  const payoutMode = normalizeMemberSettings(userData.memberSettings).payoutMode;
  return payoutMode === "independent" ? accountId : null;
}

async function getConnectUsdBalanceCents(stripeAccountId) {
  const secretKey = stripeSecretKey.value();
  if (!secretKey || !stripeAccountId) {
    return { availableCents: 0, pendingCents: 0 };
  }
  try {
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
  } catch (err) {
    console.warn("getConnectUsdBalanceCents", stripeAccountId, err.message || err);
    return { availableCents: 0, pendingCents: 0 };
  }
}

/** Only blocks deletion when an independent Connect account still holds funds. */
async function assessMemberStripeDeletionBlock(userData) {
  const accountId = memberIndependentStripeAccountId(userData);
  if (!accountId) {
    return {
      hasStripeConnectAccount: false,
      stripeBalanceBlocksDeletion: false,
      stripeBalanceBlockMessage: "",
    };
  }
  const { availableCents, pendingCents } = await getConnectUsdBalanceCents(accountId);
  const blocks = availableCents > 0 || pendingCents > 0;
  return {
    hasStripeConnectAccount: true,
    stripeBalanceBlocksDeletion: blocks,
    stripeBalanceBlockMessage: blocks
      ? "Withdraw your Stripe payout balance in Payments before deleting your account."
      : "",
  };
}

/** Read-only: whether Delete account is allowed and if transfer is required first. */
exports.getAccountDeletionEligibility = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    return {
      ok: true,
      hasProfile: false,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const userData = userSnap.data() || {};
  const tenantId = (userData.tenantId || "").toString().trim();
  if (!tenantId) {
    return {
      ok: true,
      hasProfile: true,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    return {
      ok: true,
      hasProfile: true,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const tenant = tenantSnap.data() || {};
  const isOwner = tenant.ownerUid === uid;
  const teamMemberCount = await countUsersForTenant(tenantId);
  const otherTeamMemberCount = await countOtherTeamMembers(tenantId, uid);
  const requiresTransfer = isOwner && otherTeamMemberCount > 0;
  const businessName = (
    tenant.displayName ||
    tenant.businessName ||
    userData.business ||
    ""
  ).toString();
  const stripeAssessment = await assessMemberStripeDeletionBlock(userData);
  return {
    ok: true,
    hasProfile: true,
    isOwner,
    teamMemberCount,
    otherTeamMemberCount,
    requiresTransfer,
    requiresShutdownConfirm: requiresTransfer,
    canDelete: !stripeAssessment.stripeBalanceBlocksDeletion,
    businessName,
    hasStripeConnectAccount: stripeAssessment.hasStripeConnectAccount,
    stripeBalanceBlocksDeletion: stripeAssessment.stripeBalanceBlocksDeletion,
    stripeBalanceBlockMessage: stripeAssessment.stripeBalanceBlockMessage,
  };
});

/** Owner-only: transfer business ownership to an existing team member. */
exports.transferTenantOwnership = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    parseLifecycleConfirmPhrase(data, "TRANSFER");
    const uid = context.auth.uid;
    const newOwnerUid = ((data && data.newOwnerUid) || "").toString().trim();
    if (!newOwnerUid) {
      throw new functions.https.HttpsError("invalid-argument", "newOwnerUid is required.");
    }
    if (newOwnerUid === uid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Choose a different team member."
      );
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
    const newOwnerRef = db.collection("users").doc(newOwnerUid);
    const newOwnerSnap = await newOwnerRef.get();
    if (!newOwnerSnap.exists || newOwnerSnap.data().tenantId !== tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const batch = db.batch();
    batch.set(
      db.collection("tenants").doc(tenantId),
      {
        ownerUid: newOwnerUid,
        ownerId: newOwnerUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(
      newOwnerRef,
      {
        role: "owner",
        accessRole: "owner",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(
      db.collection("users").doc(uid),
      {
        role: "manager",
        accessRole: "manager",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();

    const newOwnerEmail = (newOwnerSnap.data().email || "").toString().trim();
    const stripeCustomerId = (tenant.stripeCustomerId || "").toString().trim();
    if (stripeCustomerId && newOwnerEmail) {
      const secretKey = stripeSecretKey.value();
      if (secretKey) {
        try {
          const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
          await stripe.customers.update(stripeCustomerId, { email: newOwnerEmail });
        } catch (err) {
          console.warn("transferTenantOwnership stripe customer email", err.message || err);
        }
      }
    }

    return {
      ok: true,
      tenantId,
      newOwnerUid,
      billingUpdateRecommended: Boolean(stripeCustomerId),
    };
  });

/** Delete the signed-in user's account. Owners with team may shut down the business (SHUTDOWN) or transfer first. */
exports.deleteMyAccount = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    parseLifecycleConfirmPhrase(data, "DELETE");
    const uid = context.auth.uid;
    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};
    const tenantId = (userData.tenantId || "").toString().trim();

    const stripeAssessment = await assessMemberStripeDeletionBlock(userData);
    if (stripeAssessment.stripeBalanceBlocksDeletion) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        stripeAssessment.stripeBalanceBlockMessage ||
          "Withdraw your Stripe payout balance in Payments before deleting your account."
      );
    }

    if (!tenantId) {
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: false };
    }

    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) {
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: false };
    }

    const tenant = tenantSnap.data() || {};
    const isOwner = tenant.ownerUid === uid;
    const otherMembers = await countOtherTeamMembers(tenantId, uid);

    if (isOwner && otherMembers > 0) {
      const shutdownPhrase = ((data && data.shutdownConfirmPhrase) || "")
        .toString()
        .trim()
        .toUpperCase();
      if (shutdownPhrase !== "SHUTDOWN") {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Type SHUTDOWN to confirm shutting down the business for your team."
        );
      }
      await cancelTenantStripeSubscription(tenant);
      await deleteTenantData(tenantId);
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: true, shutDownBusiness: true };
    }

    if (isOwner) {
      await cancelTenantStripeSubscription(tenant);
      await deleteTenantData(tenantId);
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: true };
    }

    await deleteUserFirestoreAndAuth(uid);
    return { ok: true, deletedTenant: false, leftTenant: true };
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

function formatPaymentMethodExpiry(pm) {
  if (!pm || typeof pm !== "object" || !pm.card) return "";
  const month = pm.card.exp_month;
  const year = pm.card.exp_year;
  if (!month || !year) return "";
  const mm = String(month).padStart(2, "0");
  const yy = String(year).slice(-2);
  return `${mm} / ${yy}`;
}

function paymentMethodDisplayFromPm(pm) {
  return {
    label: formatPaymentMethodLabel(pm),
    expiry: formatPaymentMethodExpiry(pm),
  };
}

function paymentMethodDisplayFromCard(card) {
  if (!card || !card.last4) return { label: "", expiry: "" };
  const b = (card.brand || "Card").toString();
  const brand = b.charAt(0).toUpperCase() + b.slice(1).replace(/_/g, " ");
  const label = `${brand} ···· ${card.last4}`;
  let expiry = "";
  if (card.exp_month && card.exp_year) {
    const mm = String(card.exp_month).padStart(2, "0");
    const yy = String(card.exp_year).slice(-2);
    expiry = `${mm} / ${yy}`;
  }
  return { label, expiry };
}

async function retrievePaymentMethod(stripe, id) {
  const pmId = (id || "").toString().trim();
  if (!pmId) return null;
  try {
    return await stripe.paymentMethods.retrieve(pmId);
  } catch (_) {
    return null;
  }
}

function paymentMethodDisplayFromCharge(charge) {
  if (!charge || typeof charge !== "object") return { label: "", expiry: "" };
  const pmd = charge.payment_method_details;
  if (pmd && pmd.card) return paymentMethodDisplayFromCard(pmd.card);
  return { label: "", expiry: "" };
}

async function paymentMethodDisplayFromChargeAsync(stripe, charge) {
  const fromDetails = paymentMethodDisplayFromCharge(charge);
  if (fromDetails.label) return fromDetails;
  if (!charge || typeof charge !== "object") return { label: "", expiry: "" };
  const pmRef = charge.payment_method;
  const pmId =
    typeof pmRef === "string" ? pmRef : pmRef && typeof pmRef === "object" ? pmRef.id : "";
  if (!pmId) return { label: "", expiry: "" };
  const pm = await retrievePaymentMethod(stripe, pmId);
  return paymentMethodDisplayFromPm(pm);
}

function paymentMethodDisplayIfPresent(pm) {
  const display = paymentMethodDisplayFromPm(pm);
  return display.label ? display : null;
}

async function paymentMethodFromRef(stripe, ref) {
  if (!ref) return null;
  if (typeof ref === "object") return ref;
  return retrievePaymentMethod(stripe, ref);
}

async function paymentMethodFromPaidInvoice(stripe, invoiceId) {
  const full = await stripe.invoices.retrieve(invoiceId, {
    expand: ["payment_intent.payment_method", "charge"],
  });

  let pi = full.payment_intent;
  if (typeof pi === "string") {
    try {
      pi = await stripe.paymentIntents.retrieve(pi, { expand: ["payment_method"] });
    } catch (_) {
      pi = null;
    }
  }
  if (pi && typeof pi === "object" && pi.payment_method) {
    const pipm = await paymentMethodFromRef(stripe, pi.payment_method);
    const fromPi = paymentMethodDisplayIfPresent(pipm);
    if (fromPi) return fromPi;
  }

  let charge = full.charge;
  if (typeof charge === "string") {
    try {
      charge = await stripe.charges.retrieve(charge);
    } catch (_) {
      charge = null;
    }
  }
  return paymentMethodDisplayFromChargeAsync(stripe, charge);
}

async function resolvePaymentMethodForCustomer(stripe, stripeCustomerId, sub, invoices) {
  const tryPm = (pm) => paymentMethodDisplayIfPresent(pm);

  let pm = await paymentMethodFromRef(stripe, sub && sub.default_payment_method);
  let display = tryPm(pm);
  if (display) return display;

  if (sub && sub.id) {
    try {
      const subFresh = await stripe.subscriptions.retrieve(sub.id, {
        expand: ["default_payment_method"],
      });
      pm = await paymentMethodFromRef(stripe, subFresh.default_payment_method);
      display = tryPm(pm);
      if (display) return display;
    } catch (_) {}
  }

  const cust = await stripe.customers.retrieve(stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method", "default_source"],
  });
  if (!cust.deleted) {
    pm = await paymentMethodFromRef(
      stripe,
      cust.invoice_settings && cust.invoice_settings.default_payment_method
    );
    display = tryPm(pm);
    if (display) return display;

    if (cust.default_source && typeof cust.default_source === "object") {
      const src = cust.default_source;
      if (src.object === "card" && src.last4) {
        return paymentMethodDisplayFromCard(src);
      }
      if (src.card && src.card.last4) {
        return paymentMethodDisplayFromCard(src.card);
      }
    }
  }

  const listed = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    limit: 10,
  });
  for (const item of listed.data || []) {
    display = tryPm(item);
    if (display) return display;
  }

  if (invoices && invoices.length) {
    const paid = invoices.find((inv) => inv.status === "paid" && inv.amount_paid > 0);
    if (paid && paid.id) {
      try {
        const fromInvoice = await paymentMethodFromPaidInvoice(stripe, paid.id);
        if (fromInvoice.label) return fromInvoice;
      } catch (err) {
        console.warn("getBillingSummary invoice payment method", err.message);
      }
    }
  }

  return { label: "", expiry: "" };
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
      let paymentMethodExpiry = "";
      const invList = await stripe.invoices.list({ customer: stripeCustomerId, limit: 8 });
      const pmDetails = await resolvePaymentMethodForCustomer(
        stripe,
        stripeCustomerId,
        sub,
        invList.data
      );
      paymentMethodLabel = pmDetails.label || "";
      paymentMethodExpiry = pmDetails.expiry || "";

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
        paymentMethodExpiry: paymentMethodExpiry || "",
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

// ── Client texting (Twilio) ───────────────────────────────────────────────────

/**
 * Link tenant to Stripe customer/subscription (by stored ids or owner email) and sync Firestore status.
 */
async function linkAndSyncTenantStripeBilling(stripe, tenantId, tenant, ownerEmail) {
  let customerId = (tenant.stripeCustomerId || "").toString().trim();
  let subscriptionId = (tenant.stripeSubscriptionId || "").toString().trim();
  const email = (ownerEmail || "").toString().trim().toLowerCase();

  if (!customerId && email) {
    const listed = await stripe.customers.list({ email, limit: 10 });
    const match =
      listed.data.find(
        (c) => (c.email || "").toString().trim().toLowerCase() === email
      ) || listed.data[0];
    if (match) customerId = match.id;
  }

  if (!customerId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No Stripe customer found. Complete checkout at getbookking.com/signup.html."
    );
  }

  let status = "trialing";
  let planNorm = null;
  let sub = null;
  if (subscriptionId) {
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price"],
      });
      status = sub.status;
      planNorm = planNormFromStripeSubscription(sub);
    } catch (e) {
      console.warn("linkAndSyncTenantStripeBilling retrieve", e.message || e);
    }
  }
  if (!sub) {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
    const preferred =
      subs.data.find((s) => s.status === "active") ||
      subs.data.find((s) => s.status === "trialing") ||
      subs.data[0];
    if (preferred) {
      subscriptionId = preferred.id;
      status = preferred.status;
      try {
        sub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        planNorm = planNormFromStripeSubscription(sub);
      } catch (e) {
        console.warn("linkAndSyncTenantStripeBilling plan", e.message || e);
      }
    }
  }

  const syncPatch = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId || undefined,
  };
  if (planNorm) syncPatch.subscriptionPlan = planNorm;
  await sms.syncSubscriptionStatusForTenant(tenantId, status, syncPatch);

  const refreshed = await db.collection("tenants").doc(tenantId).get();
  return {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId || "",
    subscriptionStatus: status,
    tenant: refreshed.exists ? refreshed.data() : tenant,
  };
}

function serializeMessagingFields(tenant, ownerUserData) {
  const subscriptionStatus = sms.resolveSubscriptionStatus(tenant, ownerUserData);
  const paid = sms.tenantHasPaidSubscription(tenant, ownerUserData);
  const trialing = sms.tenantIsTrialing(tenant, ownerUserData);
  const canUse = sms.tenantCanUseSms(tenant, ownerUserData, tenant.managerPermissions);
  const usage = sms.smsMonthlyUsageForTenant(tenant);
  return {
    subscriptionStatus,
    subscriptionPaid: paid,
    subscriptionTrialing: trialing,
    smsEnabled: tenant.smsEnabled === true,
    smsStatus: (tenant.smsStatus || "off").toString(),
    smsPhoneNumber: (tenant.smsPhoneNumber || "").toString(),
    smsCanEnable: paid && (tenant.smsStatus || "off") !== "active",
    smsCanUse: canUse,
    smsProvisionError: (tenant.smsProvisionError || "").toString(),
    smsMonthlyLimit: usage.limit,
    smsMonthlyUsageCount: usage.count,
    smsMonthlyUsageRemaining: usage.remaining,
    smsUsagePeriod: usage.period,
    ...sms.tenantSmsPresets(tenant),
  };
}

/** Owner: SMS message presets (confirm / decline / quick replies). */
exports.updateTenantMessagingPresets = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can update messaging presets."
    );
  }
  const confirmed = (data && data.smsPresetConfirmed != null
    ? data.smsPresetConfirmed
    : ""
  )
    .toString()
    .trim()
    .slice(0, sms.SMS_PRESET_MAX_LEN);
  const declined = (data && data.smsPresetDeclined != null ? data.smsPresetDeclined : "")
    .toString()
    .trim()
    .slice(0, sms.SMS_PRESET_MAX_LEN);
  const quick = sms.normalizeSmsQuickPresets(data && data.smsQuickPresets);
  await db.collection("tenants").doc(ctx.tenantId).set(
    {
      smsPresetConfirmed: confirmed || sms.defaultSmsPresetConfirmed(),
      smsPresetDeclined: declined || sms.defaultSmsPresetDeclined(),
      smsQuickPresets: quick,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    ok: true,
    smsPresetConfirmed: confirmed || sms.defaultSmsPresetConfirmed(),
    smsPresetDeclined: declined || sms.defaultSmsPresetDeclined(),
    smsQuickPresets: quick,
  };
});

/** Owner: pull Stripe customer/subscription into Firestore (fixes dashboard vs app mismatch). */
exports.syncTenantBillingFromStripe = functions
  .runWith({ secrets: [stripeSecretKey] })
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
    const messaging = serializeMessagingFields(linked.tenant, ctx.ownerUserData);
    return {
      ok: true,
      stripeCustomerId: linked.stripeCustomerId,
      stripeSubscriptionId: linked.stripeSubscriptionId,
      subscriptionStatus: linked.subscriptionStatus,
      ...messaging,
    };
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
        "No subscription found. Complete sign-up billing at getbookking.com/signup.html."
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
    return { ok: true, subscriptionStatus: updated.status };
  });

/** Owner: opt in to client texting (provisions Twilio after paid subscription). */
exports.requestTenantSmsProvisioning = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
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
    const consent = data && data.smsConsentAccepted === true;
    const hadPriorConsent = !!tenant.smsConsentAt;
    if (!consent && !(forceReprovision && hadPriorConsent)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Accept the client texting terms to continue."
      );
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
    return { ok: true, smsStatus: "pending" };
  });

/** Team: send an appointment-related SMS from the tenant number. */
exports.sendClientSms = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    const tenantId = ctx.tenantId;
    const tenant = ctx.tenant;
    const roleCanSend =
      ctx.isOwner || (ctx.accessRole === "manager" && ctx.managerPermissions.sendClientNotifications);
    if (!roleCanSend) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to send client texts."
      );
    }

    const to = sms.toE164US(data && data.to);
    const body = ((data && data.body) || "").toString().trim();
    const clientName = ((data && data.clientName) || "").toString().trim().slice(0, 120);
    if (!to) {
      throw new functions.https.HttpsError("invalid-argument", "A valid client phone is required.");
    }
    if (!body) {
      throw new functions.https.HttpsError("invalid-argument", "Message body is required.");
    }
    if (body.length > 1600) {
      throw new functions.https.HttpsError("invalid-argument", "Message body is too long.");
    }

    const ownerData = ctx.ownerUserData || ctx.userData;
    try {
      const sent = await sms.sendTenantSms(
        tenantId,
        tenant,
        to,
        body,
        {
          threadId: sms.threadIdFromPhone(to),
          clientName,
        },
        ownerData
      );
      return { ok: true, sid: sent.sid, status: sent.status || "" };
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).slice(0, 400);
      if (msg.includes("Monthly SMS limit reached")) {
        throw new functions.https.HttpsError("resource-exhausted", msg);
      }
      throw new functions.https.HttpsError("failed-precondition", msg);
    }
  });

/** Firestore: provision Twilio when smsStatus becomes pending. */
exports.onTenantSmsProvisionRequested = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
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

    try {
      await provisionTenantSms(tenantId, after);
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

async function provisionTenantSms(tenantId, tenant) {
  return sms.provisionTenantSms(tenantId, tenant);
}

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
    if ((after.source || "").toString().toLowerCase() === "seed") return null;

    const tenantId = context.params.tenantId;
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) return null;
    const tenant = tenantSnap.data();
    const ownerUid = tenant.ownerUid;
    let ownerData = null;
    if (ownerUid) {
      const o = await db.collection("users").doc(ownerUid).get();
      if (o.exists) ownerData = o.data();
    }
    if (!sms.tenantCanUseSms(tenant, ownerData, tenant.managerPermissions)) {
      return null;
    }

    const to = sms.extractCustomerPhone(after);
    if (!to) return null;

    const body = sms.bookingStatusSmsBody(tenant, next, after);
    if (!body) return null;

    const optId = to.replace(/\W/g, "_");
    const optSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("smsOptOuts")
      .doc(optId)
      .get();
    if (optSnap.exists) return null;

    try {
      await sms.sendTenantSms(
        tenantId,
        tenant,
        to,
        body,
        {
          bookingRequestId: context.params.requestId,
          threadId: sms.threadIdFromPhone(to),
          clientName: (after.customerName || "").toString(),
        },
        ownerData
      );
    } catch (e) {
      console.error("onTenantBookingRequestSms", context.params.requestId, e);
    }
    return null;
  });

/** Twilio inbound SMS (STOP/HELP). */
exports.twilioInboundSms = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const authToken = sms.twilioAuthToken.value();
    const sig = req.headers["x-twilio-signature"];
    const url = sms.inboundWebhookUrl();
    const params = req.body || {};
    if (authToken && sig && url) {
      // eslint-disable-next-line global-require
      const twilio = require("twilio");
      const valid = twilio.validateRequest(authToken, sig, url, params);
      if (!valid) {
        console.warn("twilioInboundSms: invalid signature");
        res.status(403).send("Forbidden");
        return;
      }
    }

    const from = (params.From || "").toString();
    const to = (params.To || "").toString();
    const body = (params.Body || "").toString().trim().toUpperCase();

    const tenantSnap = await db
      .collection("tenants")
      .where("smsPhoneNumber", "==", to)
      .limit(1)
      .get();
    if (tenantSnap.empty) {
      res.type("text/xml").send("<Response></Response>");
      return;
    }
    const tenantDoc = tenantSnap.docs[0];
    const tenantId = tenantDoc.id;

    if (body === "STOP" || body === "UNSUBSCRIBE" || body === "CANCEL") {
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsOptOuts")
        .doc(from.replace(/\W/g, "_"))
        .set({
          phone: from,
          optedOutAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      res
        .type("text/xml")
        .send(
          "<Response><Message>You have been unsubscribed. Reply START to resubscribe.</Message></Response>"
        );
      return;
    }

    if (body === "START") {
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsOptOuts")
        .doc(from.replace(/\W/g, "_"))
        .delete()
        .catch(() => {});
      res
        .type("text/xml")
        .send(
          "<Response><Message>You are resubscribed to appointment-related texts. Reply STOP to opt out.</Message></Response>"
        );
      return;
    }

    if (body === "HELP") {
      res
        .type("text/xml")
        .send(
          "<Response><Message>Bookking client texting: appointment updates only. Reply STOP to opt out.</Message></Response>"
        );
      return;
    }

    await sms.recordInboundTenantSms(tenantId, {
      from,
      to,
      body: (params.Body || "").toString(),
      threadId: sms.threadIdFromPhone(from),
    });

    res.type("text/xml").send("<Response></Response>");
  });
