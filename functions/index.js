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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
    shopTaxEnabled: false,
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
    onboarding: {
      appTourPending: false,
      tapToPayDashboardTipPending: true,
    },
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

  // Apple req 6.1: partner Tap to Pay launch email to eligible merchants (Resend).
  try {
    const { scheduleTapToPayLaunchEmailAfterSignup } = require("./tapToPayLaunchEmail");
    scheduleTapToPayLaunchEmailAfterSignup({
      uid,
      email,
      firstName,
    });
  } catch (err) {
    console.error("scheduleTapToPayLaunchEmailAfterSignup", err);
  }

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
      const checkoutKind = (session.metadata && session.metadata.checkoutKind) || "";
      if (checkoutKind === "resubscribe") {
        return finalizeResubscribeFromCheckoutSession(stripe, session, uid);
      }
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

async function finalizeResubscribeFromCheckoutSession(stripe, session, uid) {
  const sessionUid =
    (session.metadata && session.metadata.firebaseUid) || session.client_reference_id;
  if (!sessionUid || sessionUid !== uid) {
    console.warn("resubscribe checkout uid mismatch", session.id);
    return null;
  }
  const checkoutKind = (session.metadata && session.metadata.checkoutKind) || "";
  if (checkoutKind !== "resubscribe") {
    return null;
  }

  const paidOk =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  if (!paidOk || session.mode !== "subscription") {
    console.warn("resubscribe checkout not paid / not subscription", session.id);
    return null;
  }

  const ctx = await getMemberAccessContext(uid);
  const metaTenantId = ((session.metadata && session.metadata.tenantId) || "").toString().trim();
  if (metaTenantId && metaTenantId !== ctx.tenantId) {
    console.warn("resubscribe checkout tenant mismatch", session.id);
    return null;
  }

  let sub = session.subscription;
  if (typeof sub === "string") {
    sub = await stripe.subscriptions.retrieve(sub, { expand: ["items.data.price"] });
  } else if (sub && sub.id && (!sub.items || !sub.items.data)) {
    sub = await stripe.subscriptions.retrieve(sub.id, { expand: ["items.data.price"] });
  }
  if (!sub || !sub.id) {
    console.warn("resubscribe checkout missing subscription", session.id);
    return null;
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && session.customer.id;

  const syncPatch = {
    stripeSubscriptionId: sub.id,
  };
  if (customerId) syncPatch.stripeCustomerId = customerId;
  const planNorm = planNormFromStripeSubscription(sub);
  if (planNorm) syncPatch.subscriptionPlan = planNorm;

  await sms.syncSubscriptionStatusForTenant(ctx.tenantId, sub.status, syncPatch);

  return {
    ok: true,
    tenantId: ctx.tenantId,
    subscriptionStatus: sub.status,
    resubscribed: true,
  };
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

/** Score Connect accounts so we prefer fully enabled over incomplete duplicates. */
function connectAccountPriority(account) {
  if (!account) return -1;
  let score = 0;
  if (account.charges_enabled) score += 1000;
  if (account.details_submitted) score += 100;
  if (account.payouts_enabled) score += 10;
  const currentlyDue =
    (account.requirements && account.requirements.currently_due) || [];
  if (currentlyDue.length === 0) score += 5;
  return score;
}

/** Find the best Express Connect account for an email (handles duplicate onboarding attempts). */
async function findBestConnectAccountForEmail(stripe, email) {
  const normalized = (email || "").toString().trim().toLowerCase();
  if (!normalized) return null;

  let best = null;
  let bestScore = -1;
  let startingAfter = undefined;

  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.accounts.list(params);
    for (const acct of page.data) {
      const acctEmail = (acct.email || "").toString().trim().toLowerCase();
      if (acctEmail !== normalized) continue;
      const score = connectAccountPriority(acct);
      if (score > bestScore) {
        bestScore = score;
        best = acct;
      }
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return best;
}

/**
 * Prefer the best Connect account for this email and persist stripeAccountId on accountRef.
 * Fixes Firestore pointing at an abandoned duplicate while a completed account exists in Stripe.
 * Skips the slow platform-wide account list when there is no saved id (new tenants).
 */
async function reconcileConnectAccountId(stripe, accountRef, storedId, email) {
  const storedIdTrimmed = (storedId || "").toString().trim();
  if (!storedIdTrimmed) {
    return null;
  }

  let storedAccount = null;
  try {
    storedAccount = await stripe.accounts.retrieve(storedIdTrimmed);
  } catch (err) {
    console.warn(
      "reconcileConnectAccountId retrieve failed",
      storedIdTrimmed,
      err.message || err
    );
    storedAccount = null;
  }

  // Fast path: saved account is submitted or fully enabled — skip listing all Connect accounts.
  if (storedAccount) {
    if (storedAccount.charges_enabled || storedAccount.details_submitted) {
      return { stripeAccountId: storedIdTrimmed, account: storedAccount };
    }
  }

  // Slow path: incomplete or missing stored account — search by email for a better match.
  const storedScore = connectAccountPriority(storedAccount);
  const bestByEmail = await findBestConnectAccountForEmail(stripe, email);
  const emailScore = connectAccountPriority(bestByEmail);

  let chosenId = storedIdTrimmed;
  let chosenAccount = storedAccount;

  if (bestByEmail && emailScore > storedScore) {
    chosenId = bestByEmail.id;
    chosenAccount = bestByEmail;
  } else if (!storedAccount && bestByEmail) {
    chosenId = bestByEmail.id;
    chosenAccount = bestByEmail;
  }

  if (chosenId && chosenId !== storedIdTrimmed) {
    await accountRef.set({ stripeAccountId: chosenId }, { merge: true });
    console.log("reconcileConnectAccountId linked account", {
      from: storedIdTrimmed,
      to: chosenId,
      email: (email || "").toString().trim(),
    });
  }

  if (!chosenAccount && chosenId) {
    chosenAccount = await stripe.accounts.retrieve(chosenId);
  }

  if (!chosenId || !chosenAccount) return null;
  return { stripeAccountId: chosenId, account: chosenAccount };
}

/** Resolve or create the Connect account id, reconciling duplicates before creating a new one. */
async function ensureConnectAccountId(stripe, accountRef, email, storedId) {
  const storedIdTrimmed = (storedId || "").toString().trim();
  if (storedIdTrimmed) {
    const reconciled = await reconcileConnectAccountId(
      stripe,
      accountRef,
      storedIdTrimmed,
      email
    );
    if (reconciled) return reconciled;
  }

  const freshDoc = await accountRef.get();
  const raceId = (freshDoc.data()?.stripeAccountId || "").toString().trim();
  if (raceId) {
    const account = await stripe.accounts.retrieve(raceId);
    return { stripeAccountId: raceId, account };
  }

  const account = await stripe.accounts.create({
    type: "express",
    email: email || undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    settings: {
      // Recover negative balances (refunds/disputes) from future payouts,
      // never by debiting the business's bank account.
      payouts: { debit_negative_balances: false },
    },
  });
  await accountRef.set({ stripeAccountId: account.id }, { merge: true });
  return { stripeAccountId: account.id, account };
}

/**
 * Best-effort: turn off automatic bank debits for negative balances on an
 * existing Express account. Runs lazily from getConnectAccountStatus so
 * accounts created before this policy get migrated.
 */
async function ensureNoNegativeBalanceBankDebits(stripe, account) {
  try {
    if (!account || account.settings?.payouts?.debit_negative_balances !== true) {
      return account;
    }
    return await stripe.accounts.update(account.id, {
      settings: { payouts: { debit_negative_balances: false } },
    });
  } catch (err) {
    console.warn(
      "ensureNoNegativeBalanceBankDebits",
      account?.id,
      err.message || err
    );
    return account;
  }
}

function connectAccountPendingReview(account) {
  if (!account || account.charges_enabled || !account.details_submitted) {
    return false;
  }
  const currentlyDue =
    (account.requirements && account.requirements.currently_due) || [];
  const pendingVerification =
    (account.requirements && account.requirements.pending_verification) || [];
  if (currentlyDue.length === 0) return true;
  return pendingVerification.length > 0;
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

      if (connectAccountPendingReview(account)) {
        return {
          pendingReview: true,
          hasAccount: true,
          detailsSubmitted: true,
          chargesEnabled: false,
          stripeAccountId,
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
 * One-time login link to the connected account's Stripe Express dashboard
 * (tax documents, payouts, tax registrations).
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
    const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
    if (!loginLink?.url) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe did not return a dashboard link."
      );
    }
    return { url: loginLink.url };
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

    let stripeAccountId = payCtx.stripeAccountId;
    if (stripeAccountId && !isDemoShowcaseStripeAccountId(stripeAccountId)) {
      const reconciled = await reconcileConnectAccountId(
        stripe,
        accountRef,
        stripeAccountId,
        email
      );
      if (reconciled) {
        stripeAccountId = reconciled.stripeAccountId;
      }
    }

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

    let account = await stripe.accounts.retrieve(stripeAccountId);
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

const PROCESSING_SERVICE_FEE_LABEL = "Processing & service fees";
const PROCESSING_SERVICE_FEE_DESCRIPTION =
  "Includes Stripe card processing (2.9% + 30¢) and a 1% platform fee.";

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

/**
 * Ensures a Connect account exists for Tap to Pay (creates Express account if needed).
 * Does not require charges_enabled — used before Apple T&C and Stripe onboarding.
 */
async function ensureStripeAccountForTapToPayContext(uid, stripe) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Account not found");
  }
  const userData = userDoc.data();
  const tenantId = userData.tenantId;
  const email = userData.email || "";
  if (!tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No business linked to this account. Finish signup first."
    );
  }
  const payCtx = await resolvePaymentStripeContext(uid);
  if (!payCtx?.canTakePayments) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio collects payments for you. Ask your admin to enable independent payouts."
    );
  }
  const tenantRef = db.collection("tenants").doc(tenantId);
  const accountRef =
    payCtx.scope === "user" ? db.collection("users").doc(uid) : tenantRef;
  const ensured = await ensureConnectAccountId(
    stripe,
    accountRef,
    email,
    payCtx.stripeAccountId
  );
  const account = ensured.account;
  return {
    ...payCtx,
    stripeAccountId: ensured.stripeAccountId,
    hasAccount: true,
    chargesEnabled: !!account.charges_enabled,
    detailsSubmitted: !!account.details_submitted,
    pendingReview: connectAccountPendingReview(account),
  };
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
  const memberName = memberDisplayNameFromUserData(memberData, "This team member");

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
        "Only the studio owner or a manager can collect payment for this team member."
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
          ? "assigned team member"
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
    const name = payCtx.attributedMemberName || "The assigned team member";
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

/** Tap to Pay customer-facing name (Settings). Never uses website `displayName`. */
function tapToPayTerminalDisplayNameForTenant(tenantData) {
  const custom = (tenantData?.tapToPayDisplayName ?? "").toString().trim();
  if (custom) return custom.slice(0, 100);
  const biz = (tenantData?.businessName ?? "").toString().trim();
  if (biz) return biz.slice(0, 100);
  return "Studio";
}

/** Independent member Tap to Pay name; falls back to tenant business name, not website brand. */
function tapToPayTerminalDisplayNameForUser(userData, tenantData) {
  const custom = (userData?.tapToPayDisplayName ?? "").toString().trim();
  if (custom) return custom.slice(0, 100);
  const personal = (userData?.displayName || userData?.name || "").toString().trim();
  if (personal) return personal.slice(0, 100);
  return tapToPayTerminalDisplayNameForTenant(tenantData);
}

function tapToPayRequireSignatureForTenant(tenantData) {
  return tenantData?.tapToPayRequireSignature === true;
}

function tapToPayRequireSignatureForUser(userData) {
  return userData?.tapToPayRequireSignature === true;
}

/** Default true — offer receipt share after Tap to Pay approval. */
function tapToPayAutoOfferReceiptForTenant(tenantData) {
  return tenantData?.tapToPayAutoOfferReceipt !== false;
}

function tapToPayAutoOfferReceiptForUser(userData) {
  return userData?.tapToPayAutoOfferReceipt !== false;
}

const TAP_TO_PAY_RECEIPT_DELIVERY = new Set(["prompt", "text", "none"]);

function tapToPayReceiptDeliveryForTenant(tenantData) {
  const raw = (tenantData?.tapToPayReceiptDelivery ?? "").toString().trim();
  if (TAP_TO_PAY_RECEIPT_DELIVERY.has(raw)) return raw;
  if (tenantData?.tapToPayAutoOfferReceipt === false) return "none";
  return "prompt";
}

function tapToPayReceiptDeliveryForUser(userData) {
  const raw = (userData?.tapToPayReceiptDelivery ?? "").toString().trim();
  if (TAP_TO_PAY_RECEIPT_DELIVERY.has(raw)) return raw;
  if (userData?.tapToPayAutoOfferReceipt === false) return "none";
  return "prompt";
}

function tapToPayReceiptPreferencesForScope(scope, tenantData, userData) {
  const source = scope === "user" ? userData : tenantData;
  const delivery =
    scope === "user"
      ? tapToPayReceiptDeliveryForUser(userData)
      : tapToPayReceiptDeliveryForTenant(tenantData);
  return {
    tapToPayReceiptDelivery: delivery,
    tapToPayReceiptShowBusinessName: source?.tapToPayReceiptShowBusinessName !== false,
    tapToPayReceiptItemized: source?.tapToPayReceiptItemized === true,
    tapToPayReceiptCustomFooter: source?.tapToPayReceiptCustomFooter === true,
    tapToPayReceiptFooterMessage: (source?.tapToPayReceiptFooterMessage ?? "")
      .toString()
      .trim()
      .slice(0, 200),
    tapToPayAutoOfferReceipt: delivery !== "none",
  };
}

function parseTapToPayReceiptPreferencesInput(raw) {
  if (!raw || typeof raw !== "object") return null;
  const delivery = (raw.delivery ?? "").toString().trim();
  if (delivery && !TAP_TO_PAY_RECEIPT_DELIVERY.has(delivery)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Receipt delivery must be prompt, text, or none"
    );
  }
  const footerMessage = (raw.footerMessage ?? "").toString().trim();
  if (footerMessage.length > 200) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Footer message must be 200 characters or fewer"
    );
  }
  const patch = {};
  if (delivery) {
    patch.tapToPayReceiptDelivery = delivery;
    patch.tapToPayAutoOfferReceipt = delivery !== "none";
  }
  if (raw.showBusinessName !== undefined) {
    patch.tapToPayReceiptShowBusinessName = raw.showBusinessName === true;
  }
  if (raw.itemized !== undefined) {
    patch.tapToPayReceiptItemized = raw.itemized === true;
  }
  if (raw.customFooter !== undefined) {
    patch.tapToPayReceiptCustomFooter = raw.customFooter === true;
  }
  if (raw.footerMessage !== undefined) {
    patch.tapToPayReceiptFooterMessage = footerMessage.slice(0, 200);
  }
  return Object.keys(patch).length ? patch : null;
}

function receiptPreferencesResponse(scope, tenantData, userData) {
  const prefs = tapToPayReceiptPreferencesForScope(scope, tenantData, userData);
  return {
    receiptDelivery: prefs.tapToPayReceiptDelivery,
    receiptShowBusinessName: prefs.tapToPayReceiptShowBusinessName,
    receiptItemized: prefs.tapToPayReceiptItemized,
    receiptCustomFooter: prefs.tapToPayReceiptCustomFooter,
    receiptFooterMessage: prefs.tapToPayReceiptFooterMessage,
    autoOfferReceipt: prefs.tapToPayAutoOfferReceipt,
  };
}

function tapToPayPaymentSettingsForScope(scope, tenantData, userData) {
  const receipt = tapToPayReceiptPreferencesForScope(scope, tenantData, userData);
  if (scope === "user") {
    return {
      tapToPayRequireSignature: tapToPayRequireSignatureForUser(userData),
      tapToPayAutoOfferReceipt: receipt.tapToPayAutoOfferReceipt,
      ...receipt,
    };
  }
  return {
    tapToPayRequireSignature: tapToPayRequireSignatureForTenant(tenantData),
    tapToPayAutoOfferReceipt: receipt.tapToPayAutoOfferReceipt,
    ...receipt,
  };
}

function isStripeResourceMissing(err) {
  const code = (err?.code || err?.raw?.code || "").toString();
  if (code === "resource_missing") return true;
  const msg = (err?.message || "").toString();
  return /no such (location|account|customer|payment_intent)/i.test(msg);
}

async function retrieveTerminalLocationOrNull(stripe, stripeAccountId, locationId) {
  const locId = (locationId || "").toString().trim();
  if (!locId) return null;
  try {
    return await stripe.terminal.locations.retrieve(locId, {
      stripeAccount: stripeAccountId,
    });
  } catch (err) {
    if (isStripeResourceMissing(err)) return null;
    throw err;
  }
}

async function syncTerminalLocationDisplayNameIfNeeded(
  stripe,
  stripeAccountId,
  locationId,
  displayName,
  existingLoc
) {
  const locId = (locationId || "").toString().trim();
  const next = (displayName || "").toString().trim().slice(0, 100);
  if (!locId || !next) return;
  try {
    const loc =
      existingLoc ||
      (await stripe.terminal.locations.retrieve(locId, {
        stripeAccount: stripeAccountId,
      }));
    const current = (loc.display_name || "").toString().trim();
    if (current !== next) {
      await stripe.terminal.locations.update(
        locId,
        { display_name: next },
        { stripeAccount: stripeAccountId }
      );
    }
  } catch (err) {
    console.warn("syncTerminalLocationDisplayNameIfNeeded", locId, err?.message || err);
  }
}

/**
 * Ensures tenants/{tenantId}.stripeTerminalLocationId exists (Stripe Terminal Location on Connect account).
 * Recreates the location when a stored id is missing (e.g. test→live key switch).
 */
async function ensureStripeTerminalLocationForTenant(tenantId, stripe, stripeAccountId, tenantData) {
  const displayName = tapToPayTerminalDisplayNameForTenant(tenantData);
  const existing = (tenantData.stripeTerminalLocationId || "").toString().trim();
  if (existing) {
    const loc = await retrieveTerminalLocationOrNull(stripe, stripeAccountId, existing);
    if (loc) {
      await syncTerminalLocationDisplayNameIfNeeded(
        stripe,
        stripeAccountId,
        existing,
        displayName,
        loc
      );
      return existing;
    }
    console.warn(
      "ensureStripeTerminalLocationForTenant stale location; recreating",
      tenantId,
      existing
    );
  }
  const address = terminalAddressFromTenant(tenantData);
  const location = await stripe.terminal.locations.create(
    {
      display_name: displayName,
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
 * Recreates the location when a stored id is missing (e.g. test→live key switch).
 */
async function ensureStripeTerminalLocationForUser(uid, stripe, stripeAccountId, userData, tenantData) {
  const displayName = tapToPayTerminalDisplayNameForUser(userData, tenantData);
  const existing = (userData.stripeTerminalLocationId || "").toString().trim();
  if (existing) {
    const loc = await retrieveTerminalLocationOrNull(stripe, stripeAccountId, existing);
    if (loc) {
      await syncTerminalLocationDisplayNameIfNeeded(
        stripe,
        stripeAccountId,
        existing,
        displayName,
        loc
      );
      return existing;
    }
    console.warn(
      "ensureStripeTerminalLocationForUser stale location; recreating",
      uid,
      existing
    );
  }
  const address = terminalAddressFromTenant(tenantData);
  const location = await stripe.terminal.locations.create(
    {
      display_name: displayName,
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
 * Returns the Connect account balance.
 * { availableCents, pendingCents, instantAvailableCents, instantPayoutEligible }.
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
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
      };
    }
    if (isDemoShowcaseStripeAccountId(stripeAccountId)) {
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
      };
    }
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      return {
        availableCents: 0,
        pendingCents: 0,
        instantAvailableCents: 0,
        instantPayoutEligible: false,
      };
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: stripeAccountId }
    );
    const available = balance.available?.find((b) => b.currency === "usd");
    const pending = balance.pending?.find((b) => b.currency === "usd");
    const instant = balance.instant_available?.find((b) => b.currency === "usd");
    const instantAvailableCents = Math.max(0, instant?.amount ?? 0);

    let instantPayoutEligible = false;
    if (instantAvailableCents >= 50) {
      try {
        const ext = await stripe.accounts.listExternalAccounts(stripeAccountId, {
          object: "bank_account",
          limit: 10,
        });
        const banks = ext.data || [];
        const cards = await stripe.accounts.listExternalAccounts(stripeAccountId, {
          object: "card",
          limit: 10,
        });
        const all = banks.concat(cards.data || []);
        instantPayoutEligible = all.some((a) =>
          Array.isArray(a.available_payout_methods) &&
          a.available_payout_methods.includes("instant")
        );
      } catch (e) {
        console.warn("instant payout eligibility check failed", e?.message || e);
        // Still expose instant_available; payout may fail if destination ineligible.
        instantPayoutEligible = instantAvailableCents >= 50;
      }
    }

    return {
      availableCents: available?.amount ?? 0,
      pendingCents: pending?.amount ?? 0,
      instantAvailableCents,
      instantPayoutEligible,
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
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: PROCESSING_SERVICE_FEE_LABEL,
            description: PROCESSING_SERVICE_FEE_DESCRIPTION,
          },
          unit_amount: checkout.surchargeCents,
        },
        quantity: 1,
      });
    }
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const link = await stripe.paymentLinks.create(
      {
        line_items: lineItems,
        application_fee_amount: feeCents,
        metadata: {
          tenantId: tenantId || "",
          paymentKind,
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
 * Creates a PaymentIntent for in-app manual card entry (Stripe Payment Sheet).
 * Same pricing as createDepositLink; returns clientSecret for iOS.
 */
exports.createPaymentIntentForManualCheckout = functions
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
    const feeCents = platformFeeCents(checkout.totalCents);
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const pi = await stripe.paymentIntents.create(
      {
        amount: checkout.totalCents,
        currency: "usd",
        payment_method_types: ["card"],
        application_fee_amount: feeCents,
        capture_method: "automatic",
        metadata: {
          tenantId: tenantId || "",
          paymentKind,
          serviceAmountCents: String(checkout.serviceCents),
          surchargeCents: String(checkout.surchargeCents),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
          checkoutChannel: "manual_in_app",
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeAccountId,
      platformFeeCents: feeCents,
      serviceCents: checkout.serviceCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: checkout.totalCents,
      attributedMemberUid,
      chargeStripeScope: payCtx.scope || "tenant",
    };
  });

function chargeIdFromExpandedBalanceSource(source) {
  if (!source) return null;
  if (typeof source === "string") {
    return source.startsWith("ch_") ? source : null;
  }
  if (source.object === "charge" && source.id) {
    return source.id;
  }
  if (source.latest_charge) {
    return typeof source.latest_charge === "string"
      ? source.latest_charge
      : source.latest_charge.id || null;
  }
  if (source.charge) {
    return typeof source.charge === "string" ? source.charge : source.charge.id || null;
  }
  return null;
}

async function resolveChargeIdForBalanceSourceId(stripe, sourceId, stripeAccountId) {
  const src = (sourceId || "").toString().trim();
  if (!src) return null;
  if (src.startsWith("ch_")) return src;
  const opts = { stripeAccount: stripeAccountId };
  try {
    if (src.startsWith("pi_")) {
      const pi = await stripe.paymentIntents.retrieve(src, opts);
      const lc = pi.latest_charge;
      return typeof lc === "string" ? lc : lc?.id || null;
    }
  } catch (e) {
    console.warn("resolveChargeIdForBalanceSourceId", src, e.message);
  }
  return null;
}

async function enrichConnectBalanceTransaction(stripe, t, stripeAccountId) {
  const net = t.net ?? 0;
  let chargeId = chargeIdFromExpandedBalanceSource(t.source);
  const sourceId =
    typeof t.source === "string" ? t.source : t.source?.id || null;
  if (!chargeId && sourceId) {
    chargeId = await resolveChargeIdForBalanceSourceId(
      stripe,
      sourceId,
      stripeAccountId
    );
  }
  return {
    id: t.id,
    type: t.type || "unknown",
    amount: t.amount ?? 0,
    fee: t.fee ?? 0,
    net,
    isCredit: net > 0,
    created: t.created ?? 0,
    description: t.description || null,
    reportingCategory: t.reporting_category || null,
    sourceId,
    chargeId,
  };
}

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

function receiptServiceLabel(paymentKind) {
  const kind = (paymentKind || "deposit").toString().trim().toLowerCase();
  if (kind === "deposit") return "Deposit";
  if (kind === "service") return "Service";
  return "Payment";
}

function receiptLineItemsFromAmounts({
  serviceCents,
  surchargeCents,
  paymentKind,
  grossCents,
}) {
  const service = Math.max(0, Math.round(Number(serviceCents) || 0));
  const gross = Math.max(
    service,
    Math.round(Number(grossCents) || 0)
  );
  const surcharge = Math.max(
    0,
    Math.round(Number(surchargeCents) || 0) || gross - service
  );
  const items = [
    {
      name: receiptServiceLabel(paymentKind),
      quantity: 1,
      amountCents: service,
    },
  ];
  if (surcharge > 0) {
    items.push({
      name: PROCESSING_SERVICE_FEE_LABEL,
      quantity: 1,
      amountCents: surcharge,
    });
  }
  return items;
}

async function findPaymentLedgerEntry(tenantId, { paymentIntentId, chargeId }) {
  const tid = (tenantId || "").toString().trim();
  if (!tid) return null;
  const piId = (paymentIntentId || "").toString().trim();
  if (piId) {
    const direct = await db
      .collection("tenants")
      .doc(tid)
      .collection("paymentLedger")
      .doc(piId)
      .get();
    if (direct.exists) return direct.data();
  }
  const chId = (chargeId || "").toString().trim();
  if (chId) {
    const snap = await db
      .collection("tenants")
      .doc(tid)
      .collection("paymentLedger")
      .where("chargeId", "==", chId)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].data();
  }
  return null;
}

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
    let grossCents = charge.amount || 0;

    if (ledger) {
      if (ledger.serviceCents > 0) serviceCents = ledger.serviceCents;
      if (ledger.surchargeCents >= 0) surchargeCents = ledger.surchargeCents;
      if (ledger.grossCents > 0) grossCents = ledger.grossCents;
    }
    if (Number.isNaN(serviceCents) || serviceCents <= 0) {
      serviceCents = Math.max(0, grossCents - (Number.isNaN(surchargeCents) ? 0 : surchargeCents));
    }
    if (Number.isNaN(surchargeCents)) {
      surchargeCents = Math.max(0, grossCents - serviceCents);
    }

    const lineItems = receiptLineItemsFromAmounts({
      serviceCents,
      surchargeCents,
      paymentKind,
      grossCents,
    });

    const serviceLabel = serviceName || receiptServiceLabel(paymentKind);

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
      providerReceivedCents: serviceCents,
      stripeReceiptUrl: charge.receipt_url || null,
    };
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

    // Guard: refunds must be covered by the available balance so Stripe never
    // debits the linked bank account (funds still settling don't count).
    const charge = await stripe.charges.retrieve(chargeId, {
      stripeAccount: stripeAccountId,
    });
    const remainingCents = Math.max(
      0,
      (charge.amount || 0) - (charge.amount_refunded || 0)
    );
    const refundCents =
      typeof amountCents === "number" && amountCents > 0
        ? Math.round(amountCents)
        : remainingCents;
    if (refundCents <= 0) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This payment has already been fully refunded."
      );
    }
    if (refundCents > remainingCents) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Refund amount exceeds what remains on this payment."
      );
    }

    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: stripeAccountId }
    );
    const currency = (charge.currency || "usd").toLowerCase();
    const availableCents = (balance.available || [])
      .filter((b) => (b.currency || "").toLowerCase() === currency)
      .reduce((sum, b) => sum + (b.amount || 0), 0);
    if (refundCents > availableCents) {
      const fmt = (cents) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Not enough available funds to refund ${fmt(refundCents)}. ` +
          `You have ${fmt(availableCents)} available. Funds from recent payments ` +
          `become available after they finish settling (usually about 2 business days). ` +
          `Try again then, or refund a smaller amount.`
      );
    }

    const params = {
      charge: chargeId,
      reason: reason,
      refund_application_fee: true,
      amount: refundCents,
    };
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
    if (assignmentPreference === "first_available" && plan !== "solo") {
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

const BETA_WAITLIST_PLANS = new Set(["solo", "studio", "shop"]);

const BETA_WAITLIST_BUSINESS_TYPES = new Set([
  "barber",
  "hair",
  "tattoos",
  "nails",
  "fitness",
  "other",
]);

function parseBetaWaitlistTeamSize(raw) {
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

function validateBetaWaitlistPlanAndTeamSize(plan, teamSize) {
  if (!BETA_WAITLIST_PLANS.has(plan)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Select a plan."
    );
  }
  if (!Number.isFinite(teamSize) || teamSize < 1) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Enter the number of users on your team."
    );
  }
  if (plan === "solo" && teamSize !== 1) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Solo is for one user. Choose Studio or Shop for teams."
    );
  }
  if (plan === "studio" && (teamSize < 2 || teamSize > 5)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Studio supports 2–5 users."
    );
  }
  if (plan === "shop" && (teamSize < 6 || teamSize > 10)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Shop supports 6–10 users."
    );
  }
}

/**
 * Public marketing: iOS beta waitlist (TestFlight signup page). No auth required.
 * Params: { firstName, lastName, email, plan, teamSize, businessName, businessType, businessTypeCustom?, website? (honeypot) }
 */
exports.submitBetaWaitlist = functions.https.onCall(async (data) => {
  if ((data?.website || "").toString().trim()) {
    return { ok: true, duplicate: false };
  }

  const firstName = (data?.firstName || "").toString().trim();
  const lastName = (data?.lastName || "").toString().trim();
  const email = (data?.email || "").toString().trim().toLowerCase();
  const plan = (data?.plan || "").toString().trim().toLowerCase();
  const teamSize = parseBetaWaitlistTeamSize(data?.teamSize);
  const businessName = (data?.businessName || "").toString().trim();
  const businessType = (data?.businessType || "").toString().trim().toLowerCase();
  const businessTypeCustom = (data?.businessTypeCustom || "")
    .toString()
    .trim()
    .slice(0, 200);

  if (!firstName || !lastName || !email || !plan || !businessName || !businessType) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "First name, last name, email, plan, business name, and business type are required."
    );
  }

  if (businessType === "other" && !businessTypeCustom) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Describe your business type."
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Enter a valid email address."
    );
  }

  if (!BETA_WAITLIST_BUSINESS_TYPES.has(businessType)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Select a business type."
    );
  }

  validateBetaWaitlistPlanAndTeamSize(plan, teamSize);

  const waitlistBusinessFields = {
    businessName,
    businessType,
    businessTypeCustom: businessType === "other" ? businessTypeCustom : "",
  };

  const existing = await db
    .collection("betaWaitlist")
    .where("email", "==", email)
    .limit(1)
    .get();

  if (!existing.empty) {
    await existing.docs[0].ref.set(
      {
        firstName,
        lastName,
        plan,
        teamSize,
        ...waitlistBusinessFields,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { ok: true, duplicate: true };
  }

  const ref = await db.collection("betaWaitlist").add({
    firstName,
    lastName,
    email,
    plan,
    teamSize,
    ...waitlistBusinessFields,
    source: "testflight-page",
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, duplicate: false, id: ref.id };
});

async function fetchTenantProductsById(tenantId) {
  const productSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("products")
    .get();
  const productsById = new Map();
  productSnap.docs.forEach((doc) => {
    productsById.set(doc.id, doc.data());
  });
  return productsById;
}

/** Stripe Tax code: general tangible goods (retail shop products). */
const SHOP_PRODUCT_TAX_CODE = "txcd_99999999";

function shopTaxAddressFromTenant(tenantData) {
  const addr = terminalAddressFromTenant(tenantData || {});
  return {
    line1: addr.line1,
    city: addr.city,
    state: addr.state,
    postal_code: addr.postal_code,
    country: addr.country || "US",
  };
}

async function calculateShopSalesTax(stripe, stripeAccountId, tenantData, lineItems) {
  const address = shopTaxAddressFromTenant(tenantData);
  const calculation = await stripe.tax.calculations.create(
    {
      currency: "usd",
      line_items: lineItems.map((line) => ({
        amount: Math.max(0, parseInt(line.lineTotalCents, 10) || 0),
        reference: (line.productId || "item").toString().slice(0, 200),
        tax_code: SHOP_PRODUCT_TAX_CODE,
        tax_behavior: "exclusive",
      })),
      customer_details: {
        address,
        address_source: "billing",
      },
      ship_from_details: {
        address,
      },
    },
    { stripeAccount: stripeAccountId }
  );
  const taxCents = Math.max(0, parseInt(calculation.tax_amount_exclusive, 10) || 0);
  return {
    taxCents,
    taxCalculationId: calculation.id,
  };
}

async function recordShopTaxTransactionFromCalculation(
  stripe,
  stripeAccountId,
  taxCalculationId,
  paymentIntentId
) {
  if (!taxCalculationId || !paymentIntentId) return;
  try {
    await stripe.tax.transactions.createFromCalculation(
      {
        calculation: taxCalculationId,
        reference: paymentIntentId,
      },
      { stripeAccount: stripeAccountId }
    );
  } catch (err) {
    console.warn("recordShopTaxTransactionFromCalculation", err.message || err);
  }
}

function buildValidatedShopLineItems(rawLines, productsById) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    throw new functions.https.HttpsError("invalid-argument", "lineItems is required");
  }
  if (rawLines.length > 50) {
    throw new functions.https.HttpsError("invalid-argument", "Too many line items");
  }
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
  return { lineItems, subtotalCents };
}

async function resolvePublicShopTenant(tenantSlug) {
  const slug = (tenantSlug || "").toString().trim().toLowerCase();
  if (!slug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required");
  }
  const tenantSnap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
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
  return { tenantId, tenantData };
}

async function assertTenantShopStripeReady(stripe, tenantData) {
  const stripeAccountId = (tenantData.stripeAccountId || "").toString().trim();
  if (!stripeAccountId || isDemoShowcaseStripeAccountId(stripeAccountId)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Online card payments are not set up for this shop yet."
    );
  }
  let account;
  try {
    account = await stripe.accounts.retrieve(stripeAccountId);
  } catch (err) {
    console.warn("assertTenantShopStripeReady retrieve failed", stripeAccountId, err.message || err);
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Online card payments are not set up for this shop yet."
    );
  }
  if (!account.charges_enabled) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Online payments are not available yet. The business is still completing Stripe setup."
    );
  }
  return stripeAccountId;
}

async function upsertShopCheckoutCustomer(tenantId, customerName, customerEmail, customerPhone) {
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
}

function shopOrderReceiptResponse(tenantData, orderId, order, totals = {}) {
  const businessName =
    (tenantData?.displayName || tenantData?.businessName || "Receipt").toString().trim() ||
    "Receipt";
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const subtotalCents =
    totals.subtotalCents ??
    order?.subtotalCents ??
    lineItems.reduce((sum, line) => sum + (line.lineTotalCents || 0), 0);
  const taxCents = totals.taxCents ?? order?.taxCents ?? 0;
  const surchargeCents = totals.surchargeCents ?? order?.surchargeCents ?? 0;
  const totalCents =
    totals.totalCents ??
    order?.totalCents ??
    subtotalCents + Math.max(0, taxCents) + Math.max(0, surchargeCents);
  const customerEmail = (order?.customerEmail || "").toString().trim().toLowerCase();
  const paidAt =
    totals.paidAt ||
    (order?.paidAt && typeof order.paidAt.toDate === "function"
      ? order.paidAt.toDate().toISOString()
      : null);
  return {
    ok: true,
    orderId,
    receipt: {
      businessName,
      orderId,
      customerName: (order?.customerName || "").toString().trim() || "Customer",
      customerEmail: customerEmail.endsWith("@checkout.pending") ? "" : customerEmail,
      lineItems: lineItems.map((line) => ({
        name: (line.name || "Item").toString(),
        qty: Math.max(1, parseInt(line.qty, 10) || 1),
        unitPriceCents: Math.max(0, parseInt(line.unitPriceCents, 10) || 0),
        lineTotalCents: Math.max(0, parseInt(line.lineTotalCents, 10) || 0),
      })),
      subtotalCents,
      taxCents: Math.max(0, taxCents),
      surchargeCents: Math.max(0, surchargeCents),
      totalCents,
      paidAt,
    },
  };
}

async function markShopOrderPaidFromPaymentIntent(stripe, tenantId, orderId, paymentIntentId) {
  const orderRef = db.collection("tenants").doc(tenantId).collection("shopOrders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Order not found");
  }
  const order = orderSnap.data() || {};
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  const tenantData = tenantSnap.exists ? tenantSnap.data() || {} : {};
  if ((order.status || "").toString() === "paid") {
    return {
      ...shopOrderReceiptResponse(tenantData, orderId, order),
      alreadyPaid: true,
    };
  }
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const stripeAccountId = (tenantData.stripeAccountId || "").toString().trim();
  if (!stripeAccountId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Stripe is not configured for this business"
    );
  }
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    stripeAccount: stripeAccountId,
  });
  if (pi.status !== "succeeded") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Payment is not complete yet"
    );
  }
  const meta = pi.metadata || {};
  if ((meta.shopOrderId || "").toString() !== orderId) {
    throw new functions.https.HttpsError("permission-denied", "Payment does not match this order");
  }
  if ((meta.tenantId || "").toString() !== tenantId) {
    throw new functions.https.HttpsError("permission-denied", "Payment does not belong to this business");
  }
  const surchargeCents = parseInt(meta.surchargeCents, 10);
  const resolvedSurcharge = Number.isNaN(surchargeCents) ? 0 : Math.max(0, surchargeCents);
  const taxCentsMeta = parseInt(meta.taxCents, 10);
  const resolvedTax = Number.isNaN(taxCentsMeta) ? 0 : Math.max(0, taxCentsMeta);
  const serviceCents = parseInt(meta.serviceAmountCents, 10);
  const resolvedSubtotal =
    Number.isNaN(serviceCents) || serviceCents <= 0
      ? Math.max(0, (pi.amount || 0) - resolvedSurcharge - resolvedTax)
      : serviceCents;
  const grossCents = pi.amount || resolvedSubtotal + resolvedTax + resolvedSurcharge;
  const platformFee = platformFeeCents(grossCents);
  const taxCalculationId = (meta.taxCalculationId || order.taxCalculationId || "")
    .toString()
    .trim();

  await orderRef.set(
    {
      status: "paid",
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      stripePaymentIntentId: paymentIntentId,
      subtotalCents: resolvedSubtotal,
      taxCents: resolvedTax,
      surchargeCents: resolvedSurcharge,
      totalCents: grossCents,
      platformFeeCents: platformFee,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  if (taxCalculationId) {
    await recordShopTaxTransactionFromCalculation(
      stripe,
      stripeAccountId,
      taxCalculationId,
      paymentIntentId
    );
  }

  const ledgerRef = db
    .collection("tenants")
    .doc(tenantId)
    .collection("paymentLedger")
    .doc(paymentIntentId);
  const existingLedger = await ledgerRef.get();
  if (!existingLedger.exists) {
    const chargeId =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : pi.latest_charge && pi.latest_charge.id;
    let stripeFeeCents = 0;
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
        console.warn("markShopOrderPaid fee lookup", feeErr.message);
      }
    }
    await ledgerRef.set({
      paymentIntentId,
      chargeId: chargeId || null,
      shopOrderId: orderId,
      bookingRequestId: null,
      attributedMemberUid: (tenantData.ownerUid || "").toString() || null,
      paymentKind: "shop",
      serviceCents: resolvedSubtotal,
      surchargeCents: resolvedSurcharge,
      grossCents,
      stripeFeeCents,
      platformFeeCents: platformFee,
      splitApplied: false,
      splitPercentApplied: 0,
      artistShareCents: 0,
      studioServiceShareCents: resolvedSubtotal,
      initiatedByUid: null,
      chargeStripeScope: "tenant",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const paidAtIso = new Date().toISOString();
  return shopOrderReceiptResponse(tenantData, orderId, {
    ...order,
    subtotalCents: resolvedSubtotal,
    surchargeCents: resolvedSurcharge,
    totalCents: grossCents,
  }, {
    subtotalCents: resolvedSubtotal,
    surchargeCents: resolvedSurcharge,
    totalCents: grossCents,
    paidAt: paidAtIso,
  });
}

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

/** Public browser callables need explicit invoker + CORS (secret-backed v1 defaults to private IAM). */
const publicWebCallableOptions = {
  secrets: [stripeSecretKey],
  invoker: "public",
  cors: true,
  region: "us-central1",
};

/**
 * Public web: create shop order + Stripe PaymentIntent for embedded checkout.
 * Params: { tenantSlug, lineItems, customerName, customerEmail, customerPhone?, notes? }
 */
exports.createShopCheckoutPayment = onCall(publicWebCallableOptions, async (request) => {
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
          "Could not calculate sales tax. Complete tax setup in Stripe, or turn off Collect sales tax in Payment settings."
        );
      }
    }

    const checkout = computeCardCheckoutAmounts(subtotalCents, "online");
    const piAmount = subtotalCents + taxCents + checkout.surchargeCents;
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

    const pi = await stripe.paymentIntents.create(
      {
        amount: piAmount,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        application_fee_amount: feeCents,
        receipt_email: customerEmail,
        metadata: {
          tenantId,
          paymentKind: "shop",
          shopOrderId: orderId,
          serviceAmountCents: String(checkout.serviceCents),
          taxCents: String(taxCents),
          surchargeCents: String(checkout.surchargeCents),
          ...(taxCalculationId ? { taxCalculationId } : {}),
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: "tenant",
        },
      },
      { stripeAccount: stripeAccountId }
    );

    const orderData = {
      status: "pending_payment",
      source: "shop",
      tenantId,
      customerName,
      customerEmail,
      lineItems,
      subtotalCents: checkout.serviceCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: piAmount,
      stripePaymentIntentId: pi.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
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
      subtotalCents: checkout.serviceCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      platformFeeCents: feeCents,
      totalCents: piAmount,
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
exports.finalizeShopOrderPayment = onCall(publicWebCallableOptions, async (request) => {
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

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const meta = pi.metadata || {};
      if ((meta.paymentKind || "").toString() === "shop" && meta.shopOrderId && meta.tenantId) {
        try {
          await markShopOrderPaidFromPaymentIntent(
            stripe,
            meta.tenantId.toString(),
            meta.shopOrderId.toString(),
            pi.id
          );
        } catch (e) {
          console.error("stripeSubscriptionWebhook shop order finalize", e.message);
        }
      } else if (
        (meta.paymentKind || "").toString() === "deposit" &&
        meta.bookingRequestId &&
        meta.tenantId
      ) {
        try {
          await confirmBookingAfterDepositPaid(
            meta.tenantId.toString(),
            meta.bookingRequestId.toString()
          );
        } catch (e) {
          console.error("stripeSubscriptionWebhook deposit confirm", e.message);
        }
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

async function confirmBookingAfterDepositPaid(tenantId, bookingRequestId) {
  const tid = (tenantId || "").toString().trim();
  const rid = (bookingRequestId || "").toString().trim();
  if (!tid || !rid) return false;
  const reqRef = db
    .collection("tenants")
    .doc(tid)
    .collection("bookingRequests")
    .doc(rid);
  const snap = await reqRef.get();
  if (!snap.exists) return false;
  const status = (snap.data().status || "").toString().trim().toLowerCase();
  if (status !== "pending_deposit") return false;
  await reqRef.set(
    {
      status: "confirmed",
      depositPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return true;
}

function canManageAppointmentTime(ctx) {
  if (ctx.isOwner) return true;
  return (
    ctx.accessRole === "manager" &&
    ctx.managerPermissions &&
    ctx.managerPermissions.viewAllBookings === true
  );
}

function canApproveRejectBookingRequests(ctx) {
  if (!ctx.bookingRequiresApproval) return false;
  if (ctx.isOwner) return true;
  if (!ctx.managersApproveAppointments) return false;
  return (
    ctx.accessRole === "manager" &&
    ctx.managerPermissions &&
    ctx.managerPermissions.approveRejectRequests === true
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
  const canEditPortfolio = d.canEditPortfolio === true;
  const canEditPublicBio = d.canEditPublicBio === true;
  const out = {
    useStudioBookingPolicy: useStudio,
    paymentSplitEnabled,
    paymentSplitPercent,
    paymentSplitAppliesTo,
    payoutMode,
    canEditPortfolio,
    canEditPublicBio,
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

    if (paymentKind === "deposit" && bookingRequestId) {
      await confirmBookingAfterDepositPaid(tenantId, bookingRequestId);
    }

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

const MAX_PROVIDER_GALLERY_IMAGES = 24;

function normalizeProviderGalleryImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const url = (item || "").toString().trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (out.includes(url)) continue;
    out.push(url);
    if (out.length >= MAX_PROVIDER_GALLERY_IMAGES) break;
  }
  return out;
}

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

function resolveShowOnTeamPage(d, ownerUid, uid) {
  if (d.showOnTeamPage === true) return true;
  if (d.showOnTeamPage === false) return false;
  return resolveMemberIsBookable(d, ownerUid, uid);
}

function resolveShowOnTeamHome(d, ownerUid, uid) {
  if (d.showOnTeamHome === true) return true;
  if (d.showOnTeamHome === false) return false;
  return resolveMemberIsBookable(d, ownerUid, uid);
}

const TERMINAL_BOOKING_STATUSES = new Set([
  "declined",
  "rejected",
  "cancelled",
  "canceled",
  "completed",
  "done",
]);

function isTerminalBookingStatus(status) {
  return TERMINAL_BOOKING_STATUSES.has(
    (status || "").toString().trim().toLowerCase()
  );
}

function attachAssignedMemberToBookingData(bookingData, memberDoc) {
  const memberData = memberDoc.data();
  const mFn = (memberData.firstName || "").toString().trim();
  const mLn = (memberData.lastName || "").toString().trim();
  const memberName =
    (memberData.displayName || memberData.name || `${mFn} ${mLn}`.trim() || "Team member")
      .toString()
      .slice(0, 120);
  bookingData.assignedMemberUid = memberDoc.id;
  bookingData.assignedMemberName = memberName;
  const memberEmail = (memberData.email || "").toString().trim().toLowerCase();
  if (memberEmail) bookingData.assignedMemberEmail = memberEmail;
}

/** Pick the bookable member with the fewest open bookings (studio "first available"). */
async function pickMemberForFirstAvailable(tenantId, tenant) {
  const usersSnap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const candidates = [];
  for (const doc of usersSnap.docs) {
    if (!serializePublicProvider(doc, tenant)) continue;
    candidates.push(doc);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const bookingsSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .get();
  const openCounts = {};
  for (const doc of candidates) openCounts[doc.id] = 0;
  for (const bookingDoc of bookingsSnap.docs) {
    const d = bookingDoc.data();
    if (isTerminalBookingStatus(d.status)) continue;
    const assigned = (d.assignedMemberUid || "").toString().trim();
    if (assigned && openCounts[assigned] !== undefined) {
      openCounts[assigned] += 1;
    }
  }

  let bestDoc = candidates[0];
  let bestCount = openCounts[bestDoc.id] ?? 0;
  for (let i = 1; i < candidates.length; i++) {
    const doc = candidates[i];
    const count = openCounts[doc.id] ?? 0;
    if (count < bestCount) {
      bestDoc = doc;
      bestCount = count;
    }
  }
  return bestDoc;
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
    displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Team member").toString(),
    jobTitle: (d.jobTitle || "").toString(),
    profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
    providerAboutText: (d.providerAboutText || "").toString(),
    providerGalleryImages: normalizeProviderGalleryImages(d.providerGalleryImages),
    isOwner: uid === ownerUid,
  };
}

function serializeTeamRosterMember(doc, tenant) {
  const d = doc.data();
  const uid = doc.id;
  const ownerUid = (tenant.ownerUid || "").toString();
  const memberSlug = normalizeMemberSlugInput(d.memberSlug);
  if (!memberSlug) return null;
  const showOnTeamPage = resolveShowOnTeamPage(d, ownerUid, uid);
  const showOnTeamHome = resolveShowOnTeamHome(d, ownerUid, uid);
  if (!showOnTeamPage && !showOnTeamHome) return null;
  const fn = (d.firstName || "").toString().trim();
  const ln = (d.lastName || "").toString().trim();
  return {
    uid,
    memberSlug,
    displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Team member").toString(),
    jobTitle: (d.jobTitle || "").toString(),
    profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
    providerAboutText: (d.providerAboutText || "").toString(),
    isOwner: uid === ownerUid,
    isBookable: resolveMemberIsBookable(d, ownerUid, uid),
    showOnTeamPage,
    showOnTeamHome,
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
    showOnTeamPage: resolveShowOnTeamPage(d, ownerUid, uid),
    showOnTeamHome: resolveShowOnTeamHome(d, ownerUid, uid),
    providerAboutText: (d.providerAboutText || "").toString(),
    providerGalleryImages: normalizeProviderGalleryImages(d.providerGalleryImages),
    memberSettings: normalizeMemberSettings(d.memberSettings),
    smsEnabled: d.smsEnabled === true,
    smsStatus: (d.smsStatus || "off").toString(),
    smsPhoneNumber: (d.smsPhoneNumber || "").toString(),
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

/** Public: team roster cards for /team and home strip (visibility flags, not bookable-only). */
exports.listTeamRoster = functions.https.onCall(async (data) => {
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
    return { members: [], subscriptionPlan: plan, tenantSlug };
  }
  if (tenant.isActive === false || tenant.isDemoAccount === true) {
    return { members: [], subscriptionPlan: plan, tenantSlug };
  }
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const members = [];
  for (const doc of snap.docs) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      const row = serializeTeamRosterMember(fresh, tenant);
      if (row) members.push(row);
    } else {
      const row = serializeTeamRosterMember(doc, tenant);
      if (row) members.push(row);
    }
  }
  members.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  return { members, subscriptionPlan: plan, tenantSlug };
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
    throw new functions.https.HttpsError("not-found", "Team member not found.");
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
    throw new functions.https.HttpsError("not-found", "Team member not found.");
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
      "This team member is not available for online booking."
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

/** Member (or owner for a member): save portfolio image URLs for a provider page. */
exports.updateProviderGallery = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const targetUid = ((data && data.memberUid) || uid).toString().trim();
  const images = normalizeProviderGalleryImages(data && data.providerGalleryImages);
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
  if (plan === "solo" && targetUid !== ctx.tenant.ownerUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Member portfolios are for Studio and Shop teams."
    );
  }
  if (targetUid !== uid && !ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can edit another member's portfolio."
    );
  }
  if (targetUid !== uid) {
    await assertTenantOwnerUid(uid, ctx.tenantId);
  }
  const memberRef = db.collection("users").doc(targetUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  if (targetUid === uid && !ctx.isOwner) {
    const selfSettings = normalizeMemberSettings(memberSnap.data().memberSettings);
    if (!selfSettings.canEditPortfolio) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Your studio owner has not enabled portfolio editing for your account."
      );
    }
  }
  await memberRef.set({ providerGalleryImages: images }, { merge: true });
  return { ok: true, providerGalleryImages: images };
});

/** Member: save own public bio when owner enabled self-edit in Design → Team. */
exports.updateMyPublicProfile = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const settings = normalizeMemberSettings(ctx.userData.memberSettings);
  if (!ctx.isOwner && !settings.canEditPublicBio) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio owner has not enabled bio editing for your account."
    );
  }
  if (data && data.providerAboutText == null) {
    throw new functions.https.HttpsError("invalid-argument", "providerAboutText is required.");
  }
  const providerAboutText = (data.providerAboutText || "")
    .toString()
    .trim()
    .slice(0, 2000);
  await db.collection("users").doc(uid).set({ providerAboutText }, { merge: true });
  return { ok: true, providerAboutText };
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
  const studioSmsActive = sms.tenantStudioSmsActive(ctx.tenant);
  const memberSmsStatus = (ctx.userData.smsStatus || "off").toString();
  const memberSmsPhone = (ctx.userData.smsPhoneNumber || "").toString().trim();
  const usesOwnSms =
    usesOwnPayments && memberSmsStatus === "active" && !!memberSmsPhone;
  const canSendClientSms = sms.canSendClientSms({
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    managerPermissions: ctx.managerPermissions,
    senderUserData: ctx.userData,
  });
  const memberWebsiteSettings = normalizeMemberSettings(ctx.userData.memberSettings);
  const canEditPortfolio = isOwner || memberWebsiteSettings.canEditPortfolio === true;
  const canEditPublicBio = isOwner || memberWebsiteSettings.canEditPublicBio === true;
  return {
    tenantId: ctx.tenantId,
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    subscriptionPlan: normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan),
    managerPermissions: ctx.managerPermissions,
    confirmationType: ctx.workflow.confirmationType,
    responseTimeHours: ctx.workflow.responseTimeHours,
    depositAmount: ctx.workflow.depositAmount ?? null,
    bookingRequiresApproval: ctx.bookingRequiresApproval,
    managersApproveAppointments: ctx.managersApproveAppointments,
    usesStudioBookingPolicy: ctx.usesStudioBookingPolicy === true,
    tenantConfirmationType: ctx.tenantWorkflow.confirmationType,
    payoutMode: isOwner ? null : memberSettings.payoutMode,
    usesOwnPayments,
    canTakePayments: isOwner || usesOwnPayments,
    studioSmsActive,
    usesOwnSms,
    canSendClientSms,
    memberSmsStatus: isOwner ? null : memberSmsStatus,
    memberSmsPhoneNumber: isOwner ? null : memberSmsPhone,
    canEditPortfolio,
    canEditPublicBio,
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
  let normalized = status.toLowerCase();
  if (normalized === "approved") normalized = "confirmed";
  if (normalized === "rejected") normalized = "declined";

  const isConfirm = normalized === "confirmed";
  const isDecline = normalized === "declined";

  if (isConfirm) {
    if (!canManageAppointmentTime(ctx)) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to confirm booking requests."
      );
    }
  } else if (isDecline) {
    if (!canApproveRejectBookingRequests(ctx) && !canManageAppointmentTime(ctx)) {
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
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  const isOwnerMember = memberUid === tenant.ownerUid;
  if (isOwnerMember && uid !== memberUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot change the owner's profile from another account."
    );
  }
  if (isOwnerMember && uid === memberUid) {
    const patch = {};
    if (data && data.jobTitle != null) {
      patch.jobTitle = normalizeJobTitle(data.jobTitle);
    }
    if (data && data.isBookable != null) {
      patch.isBookable = Boolean(data.isBookable);
    }
    if (data && data.showOnTeamPage != null) {
      patch.showOnTeamPage = Boolean(data.showOnTeamPage);
    }
    if (data && data.showOnTeamHome != null) {
      patch.showOnTeamHome = Boolean(data.showOnTeamHome);
    }
    if (data && data.providerAboutText != null) {
      patch.providerAboutText = (data.providerAboutText || "")
        .toString()
        .trim()
        .slice(0, 2000);
    }
    if (data && data.profilePhotoUrl != null) {
      patch.profilePhotoUrl = (data.profilePhotoUrl || "")
        .toString()
        .trim()
        .slice(0, 2000);
    }
    if (!Object.keys(patch).length) {
      throw new functions.https.HttpsError("invalid-argument", "Nothing to update.");
    }
    await memberRef.set(patch, { merge: true });
    return { ok: true };
  }
  if (isOwnerMember) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot change the owner's role."
    );
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
    const existing = normalizeMemberSettings(memberSnap.data().memberSettings);
    const incoming =
      data.memberSettings && typeof data.memberSettings === "object"
        ? data.memberSettings
        : {};
    patch.memberSettings = normalizeMemberSettings({ ...existing, ...incoming });
  }
  if (data && data.isBookable != null) {
    patch.isBookable = Boolean(data.isBookable);
  }
  if (data && data.showOnTeamPage != null) {
    patch.showOnTeamPage = Boolean(data.showOnTeamPage);
  }
  if (data && data.showOnTeamHome != null) {
    patch.showOnTeamHome = Boolean(data.showOnTeamHome);
  }
  if (data && data.providerAboutText != null) {
    patch.providerAboutText = (data.providerAboutText || "")
      .toString()
      .trim()
      .slice(0, 2000);
  }
  if (data && data.profilePhotoUrl != null) {
    patch.profilePhotoUrl = (data.profilePhotoUrl || "")
      .toString()
      .trim()
      .slice(0, 2000);
  }
  if (data && data.memberSlug != null) {
    const nextSlug = normalizeMemberSlugInput(data.memberSlug);
    if (!nextSlug) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Page URL must use letters, numbers, and hyphens only."
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
        "That page URL is already in use on your team."
      );
    }
    patch.memberSlug = nextSlug;
  }
  if (data && data.providerGalleryImages != null) {
    patch.providerGalleryImages = normalizeProviderGalleryImages(data.providerGalleryImages);
  }
  if (!Object.keys(patch).length) {
    throw new functions.https.HttpsError("invalid-argument", "Nothing to update.");
  }
  await memberRef.set(patch, { merge: true });
  return { ok: true };
});

async function unassignMemberFromTenantRecords(tenantId, memberUid) {
  let unassignedBookings = 0;
  let clearedThreads = 0;

  const bookingsSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .where("assignedMemberUid", "==", memberUid)
    .get();

  let batch = db.batch();
  let batchCount = 0;
  const commitBatch = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  };

  for (const doc of bookingsSnap.docs) {
    const status = (doc.data().status || "").toString().trim().toLowerCase();
    if (TERMINAL_BOOKING_STATUSES.has(status)) continue;
    batch.update(doc.ref, {
      assignedMemberUid: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    unassignedBookings += 1;
    batchCount += 1;
    if (batchCount >= 400) await commitBatch();
  }

  const threadsSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("smsThreads")
    .where("assignedMemberUid", "==", memberUid)
    .get();

  for (const doc of threadsSnap.docs) {
    batch.update(doc.ref, {
      assignedMemberUid: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    clearedThreads += 1;
    batchCount += 1;
    if (batchCount >= 400) await commitBatch();
  }

  await commitBatch();
  return { unassignedBookings, clearedThreads };
}

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
  const memberData = memberSnap.data();
  const hadPersonalSms =
    memberData.smsEnabled === true ||
    (memberData.smsStatus || "").toString() === "active" ||
    !!(memberData.smsPhoneNumber || "").toString().trim();

  const smsRelease = await sms.releaseMemberSms(memberData);
  const { unassignedBookings, clearedThreads } = await unassignMemberFromTenantRecords(
    tenantId,
    memberUid
  );

  await memberRef.set(
    {
      tenantId: admin.firestore.FieldValue.delete(),
      tenantSlug: admin.firestore.FieldValue.delete(),
      role: admin.firestore.FieldValue.delete(),
      accessRole: admin.firestore.FieldValue.delete(),
      jobTitle: admin.firestore.FieldValue.delete(),
      memberSlug: admin.firestore.FieldValue.delete(),
      isBookable: false,
      providerAboutText: admin.firestore.FieldValue.delete(),
      providerGalleryImages: admin.firestore.FieldValue.delete(),
      memberSettings: admin.firestore.FieldValue.delete(),
      workflow: admin.firestore.FieldValue.delete(),
      smsPhoneNumber: admin.firestore.FieldValue.delete(),
      smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
      smsStatus: "off",
      smsEnabled: false,
      smsEnabledAt: admin.firestore.FieldValue.delete(),
      smsProvisionError: admin.firestore.FieldValue.delete(),
      smsSuspendedAt: admin.firestore.FieldValue.delete(),
      smsSuspendReason: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    ok: true,
    releasedPersonalSms: hadPersonalSms && smsRelease.released,
    unassignedBookings,
    clearedThreads,
  };
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

/**
 * Owner: Stripe Checkout to restart a canceled/unpaid subscription (no free trial).
 */
exports.createResubscribeCheckout = functions
  .runWith({ secrets: [stripeSecretKey, stripeSubscriptionPriceIds] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
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
    if (!body) {
      throw new functions.https.HttpsError("invalid-argument", "Message body is required.");
    }
    if (body.length > 1600) {
      throw new functions.https.HttpsError("invalid-argument", "Message body is too long.");
    }

    const ownerData = ctx.ownerUserData || ctx.userData;
    try {
      const sent = await sms.sendOutboundClientSms({
        tenantId,
        tenant,
        toE164: to,
        body,
        meta: {
          threadId: sms.threadIdFromPhone(to),
          clientName,
          paymentKind: paymentKind || undefined,
          amountCents: amountCents || undefined,
          paymentUrl: paymentUrl || undefined,
          threadPreview: threadPreview || undefined,
        },
        ownerUserData: ownerData,
        senderUid: context.auth.uid,
        senderUserData: ctx.userData,
        isOwner,
        accessRole: ctx.accessRole,
        managerPermissions: ctx.managerPermissions,
      });
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

async function provisionMemberSms(tenantId, tenant, memberUid, memberData) {
  return sms.provisionMemberSms(tenantId, tenant, memberUid, memberData);
}

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

    try {
      await provisionMemberSms(tenantId, tenant, memberUid, after);
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

/** Twilio inbound SMS (STOP/HELP + inbound consent YES). */
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
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("smsOptOuts")
        .doc(from.replace(/\W/g, "_"))
        .set({
          phone: from,
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
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }
      res
        .type("text/xml")
        .send(
          sms.twimlMessage(
            "You have been unsubscribed. Reply START to resubscribe."
          )
        );
      return;
    }

    if (body === "HELP") {
      res
        .type("text/xml")
        .send(
          sms.twimlMessage(
            "Bookking client texting: appointment updates only. Reply STOP to opt out."
          )
        );
      return;
    }

    if (sms.isInboundConsentAffirmation(body)) {
      await sms.grantInboundSmsConsent(tenantId, from);
      await sms.recordInboundTenantSms(tenantId, {
        from,
        to,
        body: rawBody,
        threadId: sms.threadIdFromPhone(from),
        assignedMemberUid,
        smsLineScope,
      });
      const confirmed = sms.inboundConsentConfirmedBody();
      try {
        await sms.recordSystemOutboundSms(tenantId, {
          from: to,
          to: from,
          body: confirmed,
          threadId: sms.threadIdFromPhone(from),
          assignedMemberUid,
          smsLineScope,
        });
      } catch (e) {
        console.warn("twilioInboundSms: consent confirm log", e.message || e);
      }
      res.type("text/xml").send(sms.twimlMessage(confirmed));
      return;
    }

    await sms.recordInboundTenantSms(tenantId, {
      from,
      to,
      body: rawBody,
      threadId: sms.threadIdFromPhone(from),
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

function passwordResetMarketingOrigin() {
  return (marketingOriginParam.value() || "https://getbookking.com").toString().trim().replace(/\/+$/, "")
    || "https://getbookking.com";
}

function passwordResetPortalOrigin(portal) {
  const marketing = passwordResetMarketingOrigin();
  if (portal === "admin") {
    const explicit = (process.env.ADMIN_ORIGIN || "").toString().trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    if (/getbookking\.com$/i.test(marketing.replace(/^https?:\/\//, ""))) {
      return "https://admin.getbookking.com";
    }
    return marketing;
  }
  if (portal === "beta") {
    const explicit = (process.env.BETA_ORIGIN || "").toString().trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    if (/getbookking\.com$/i.test(marketing.replace(/^https?:\/\//, ""))) {
      return "https://beta.getbookking.com";
    }
    return marketing;
  }
  return marketing;
}

function passwordResetPortalPaths(portal) {
  if (portal === "admin") {
    return { resetPath: "/admin/reset-password", loginPath: "/admin/login" };
  }
  if (portal === "beta") {
    return { resetPath: "/beta/reset-password", loginPath: "/beta/login" };
  }
  return { resetPath: "/reset-password", loginPath: "/login.html" };
}

function parsePasswordResetOobLink(link) {
  const parsed = new URL(link);
  let oobCode = parsed.searchParams.get("oobCode");
  if (!oobCode && parsed.hash) {
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    oobCode = hashParams.get("oobCode");
  }
  return oobCode;
}

/**
 * Sends a branded password reset email via Resend, pointing to the custom
 * reset-password handler instead of Firebase's default action page.
 * Public callable — no auth required (user is logged out).
 * Params: { email, portal?: "marketing" | "admin" | "beta" }
 */
exports.sendPasswordResetLink = functions.https.onCall(async (data) => {
  const email = ((data && data.email) ? data.email : "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new functions.https.HttpsError("invalid-argument", "A valid email address is required.");
  }

  const portalRaw = ((data && data.portal) ? data.portal : "marketing").toString().trim().toLowerCase();
  const portal = portalRaw === "admin" || portalRaw === "beta" ? portalRaw : "marketing";
  const origin = passwordResetPortalOrigin(portal);
  const paths = passwordResetPortalPaths(portal);
  const loginUrl = origin + paths.loginPath;

  let resetLink;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(email, { url: loginUrl });
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return { ok: true };
    }
    console.error("generatePasswordResetLink error", err);
    throw new functions.https.HttpsError("internal", "Could not generate reset link.");
  }

  let oobCode;
  try {
    oobCode = parsePasswordResetOobLink(resetLink);
  } catch (err) {
    console.error("Failed to parse reset link", resetLink, err);
    throw new functions.https.HttpsError("internal", "Could not parse reset link.");
  }

  if (!oobCode) {
    console.error("Reset link missing oobCode", resetLink);
    throw new functions.https.HttpsError("internal", "Reset link missing required parameters.");
  }

  const customResetUrl =
    origin +
    paths.resetPath +
    "?mode=resetPassword" +
    "&oobCode=" + encodeURIComponent(oobCode) +
    "&continueUrl=" + encodeURIComponent(loginUrl);

  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set; skipping password reset email to", email);
    return { ok: true };
  }

  const from = (process.env.BETA_EMAIL_FROM || "Get Bookking <beta@getbookking.com>").trim();
  const replyTo = (process.env.BETA_SUPPORT_EMAIL || "support@getbookking.com").trim();

  const html = [
    "<p>Hello,</p>",
    "<p>Follow this link to reset your Get Bookking password for your <strong>" + email + "</strong> account.</p>",
    "<p><a href=\"" + customResetUrl + "\">Reset password</a></p>",
    "<p>If you didn't ask to reset your password, you can ignore this email.</p>",
    "<p>Thanks,<br>Your Get Bookking team</p>",
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + resendApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: email, subject: "Reset your Get Bookking password", html, reply_to: replyTo }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Resend error sending password reset", res.status, body);
    throw new functions.https.HttpsError("internal", "Could not send reset email. Please try again.");
  }

  return { ok: true };
});

const { registerBetaAdminFunctions } = require("./betaAdmin");
registerBetaAdminFunctions(exports);

const { registerTapToPayLaunchEmailFunctions } = require("./tapToPayLaunchEmail");
registerTapToPayLaunchEmailFunctions(exports);
