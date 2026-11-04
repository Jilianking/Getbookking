/**
 * Cloud Functions for Get Bookking.
 * Set secrets:
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set OPENAI_API_KEY
 *   firebase functions:secrets:set SHIPPO_API_TOKEN
 *     (Shippo API token — use shippo_test_… while developing shop shipping)
 *   firebase functions:secrets:set STRIPE_SUBSCRIPTION_PRICE_IDS
 *     (JSON map solo/studio/shop/charter → price_… and optional smsExtra $12.99/mo add-on;
 *      copy from stripe-subscription-price-ids.example.json or Stripe Dashboard)
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 *     ("Your account" webhook destination → https://us-central1-<PROJECT>.cloudfunctions.net/stripeSubscriptionWebhook)
 *   firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET
 *     ("Connected accounts" destination, same URL — payment_intent.succeeded, refund.updated,
 *      charge.refunded for ledger + studio-share reversal on Connect customer refunds)
 *
 * Optional: set string param STRIPE_PUBLISHABLE_KEY (pk_test_… / pk_live_…) via Firebase
 * params / functions .env so createProviderSubscriptionCheckout can return it to signup.html.
 *
 * Optional: MARKETING_ORIGIN (https://getbookking.com or your marketing host) for Stripe Billing
 * Portal return_url → …/account.html. Enable the portal in Stripe Dashboard → Billing → Customer portal.
 * Callable getBillingSummary: read-only Stripe subscription + invoices for account.html.
 *
 * Customer payments (Connect): 1% platform application fee on createDepositLink,
 * createPaymentIntentForManualCheckout, and createPaymentIntentForTapToPay — grossed up
 * to the customer at checkout (with estimated Stripe card fees). Not on subscription checkout.
 * Studio/Shop independent members: optional team payment split — studio share is collected
 * with the application fee, then transferred to the tenant Connect account after success
 * (see teamPaymentSplit.js). End-customer checkout UI/totals unchanged.
 *
 * Client texting (Twilio): set secrets TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
 * Paid subscription (active) required; free trial (trialing) cannot enable SMS —
 * unless BYPASS_SUBSCRIPTION_PAYMENT_GATE is true in sms.js (testing only).
 *
 * Custom domains (Namecheap): set secret NAMECHEAP_API_KEY and params
 * NAMECHEAP_API_USER, NAMECHEAP_CLIENT_IP; optional NAMECHEAP_USERNAME,
 * NAMECHEAP_API_HOST (sandbox default), NAMECHEAP_NAMESERVER_1/2.
 * Buy/transfer only — no DIY DNS connect.
 *
 * App Store subscriptions: the iOS app sends Apple's signed transaction.
 * syncAppleSubscription verifies it. Renewals, cancels, and expirations arrive at
 * appStoreServerNotification (App Store Server Notifications V2). URL:
 * https://us-central1-test-app-96812.cloudfunctions.net/appStoreServerNotification
 */

const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const shippoShop = require("./shippoShop");
const {
  platformFeeCents,
  computeCardCheckoutAmounts,
  checkoutMethodId,
  checkoutRateForChannel,
} = require("./checkoutRates");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Stripe = require("stripe");
const {
  formSchemaForIndustry,
  guidedStepTitlesForIndustry,
  defaultServicesByIndustry,
  resolveWebThemeId,
  slugFromBusiness,
  normalizeIndustry,
} = require("./signupPayloads");
const sms = require("./sms");
const teamPaymentSplit = require("./teamPaymentSplit");
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
const charterOccupancy = require("./charterOccupancy");
const appleSubscription = require("./appleSubscription");
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const walletDomains = require("./walletDomains");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
/** Shippo API token (shippo_test_… or live). Rates-only at checkout — Bookking never buys labels. */
const shippoApiToken = defineSecret("SHIPPO_API_TOKEN");
/** JSON map: solo, studio, shop, charter → Stripe Price id; optional smsExtra ($10/mo per extra SMS line). */
const stripeSubscriptionPriceIds = defineSecret("STRIPE_SUBSCRIPTION_PRICE_IDS");
/** Stripe Dashboard → Webhooks → "Your account" destination signing secret (whsec_…). */
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
/**
 * Stripe Dashboard → Webhooks → "Connected accounts" destination signing secret (whsec_…).
 * Customer Connect charges (payment_intent.succeeded on acct_…) arrive signed with this
 * secret, not STRIPE_WEBHOOK_SECRET. Optional until the Connect destination exists.
 */
const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET");
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
/** Canonical plan slug: `solo` | `studio` | `shop` | `charter` (accepts legacy `basic` and older aliases). */
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
    charter: "charter",
    charters: "charter",
    boat: "charter",
    fishing: "charter",
    boating: "charter",
  };
  if (legacy[p]) return legacy[p];
  if (p === "solo" || p === "studio" || p === "shop" || p === "charter") return p;
  return "solo";
}
function isSingleOperatorPlan(plan) {
  const p = normalizeSubscriptionPlan(plan);
  return p === "solo" || p === "charter";
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
        '{"solo":"price_...","studio":"price_...","shop":"price_...","charter":"price_..."}'
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
const PROVIDER_SIGNUP_TRIAL_DAYS = 14;
function readFirestoreTimestampMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return null;
}
/** Unix seconds when the Firestore-only signup trial ends (trialStartDate + 14 days). */
function providerTrialEndUnixFromTenant(tenant) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const startMs = readFirestoreTimestampMs(tenant && tenant.trialStartDate);
  const endMs =
    startMs != null
      ? startMs + PROVIDER_SIGNUP_TRIAL_DAYS * 86400000
      : Date.now() + PROVIDER_SIGNUP_TRIAL_DAYS * 86400000;
  let endUnix = Math.floor(endMs / 1000);
  if (endUnix <= nowUnix + 60) endUnix = nowUnix + 120;
  return endUnix;
}
function planListPriceCents(planNorm) {
  const plan = normalizeSubscriptionPlan(planNorm);
  const map = { solo: 3999, studio: 7999, shop: 14999, charter: 2499 };
  return map[plan] || 3999;
}
function stripePriceIdForPlan(planNorm) {
  const map = parseStripeSubscriptionPriceIds();
  let id = map[planNorm];
  if (!id || typeof id !== "string") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `No Stripe price id for plan "${planNorm}" in STRIPE_SUBSCRIPTION_PRICE_IDS.`
    );
  }
  id = id.trim();
  if (planNorm === "charter") {
    const soloId = (map.solo || "").toString().trim();
    if (soloId && soloId === id) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Charter needs its own Stripe price id in STRIPE_SUBSCRIPTION_PRICE_IDS (must not reuse Solo)."
      );
    }
  }
  return id;
}
/** Optional $12.99/mo recurring price for SMS numbers beyond free included (Studio/Shop). */
function stripeSmsExtraPriceId() {
  const map = parseStripeSubscriptionPriceIds();
  const id =
    map.smsExtra ||
    map.sms_extra ||
    map.extraSms ||
    map.smsLine ||
    map.sms_line;
  if (!id || typeof id !== "string" || !String(id).trim()) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      'Set "smsExtra":"price_..." in secret STRIPE_SUBSCRIPTION_PRICE_IDS ' +
        "for the $12.99/mo extra texting number (Stripe product)."
    );
  }
  const trimmed = String(id).trim();
  if (trimmed.includes("REPLACE") || !trimmed.startsWith("price_")) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      'Create a $12.99/mo Stripe Price for extra SMS lines and set "smsExtra" in STRIPE_SUBSCRIPTION_PRICE_IDS.'
    );
  }
  return trimmed;
}
/**
 * Current smsExtra price plus legacy ids (e.g. old $5 Test price) so qty still counts after price rotation.
 * Optional secret keys: smsExtraLegacy / sms_extra_legacy (string or array).
 */
function stripeSmsExtraPriceIds() {
  const primary = stripeSmsExtraPriceId();
  const map = parseStripeSubscriptionPriceIds();
  const legacyRaw = map.smsExtraLegacy || map.sms_extra_legacy || map.smsExtraOld || [];
  const legacyList = Array.isArray(legacyRaw)
    ? legacyRaw
    : typeof legacyRaw === "string" && legacyRaw.trim()
      ? [legacyRaw]
      : [];
  // Previous Test extra-line prices (kept so existing subscription items still count).
  const knownLegacy = [
    "price_1U0j3VCeE17fSOZIkt3kn1BZ", // $5/mo
    "price_1U0oH0CeE17fSOZIAaPNsxJB", // $10/mo
  ];
  const out = [];
  const seen = new Set();
  for (const id of [primary, ...legacyList, ...knownLegacy]) {
    const s = (id || "").toString().trim();
    if (!s.startsWith("price_") || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function subscriptionItemPriceId(item) {
  const price = item && item.price;
  return (
    (price && typeof price === "object" && price.id) ||
    (typeof price === "string" ? price : "") ||
    ""
  )
    .toString()
    .trim();
}
/** Sum SMS extra quantities across current + legacy Stripe price ids. */
function smsExtraQuantityFromSubscription(sub, extraPriceIdOrIds) {
  if (!sub) return 0;
  const ids = new Set(
    (Array.isArray(extraPriceIdOrIds)
      ? extraPriceIdOrIds
      : [extraPriceIdOrIds]
    )
      .map((id) => (id || "").toString().trim())
      .filter((id) => id.startsWith("price_"))
  );
  if (!ids.size) return 0;
  const items = (sub.items && sub.items.data) || [];
  let qty = 0;
  for (const item of items) {
    const pid = subscriptionItemPriceId(item);
    if (ids.has(pid)) {
      qty += Math.max(0, Math.floor(Number(item.quantity) || 0));
    }
  }
  return qty;
}
/** Find subscription items that are SMS extras (current or legacy price). */
function smsExtraSubscriptionItems(sub, extraPriceIds) {
  const ids = new Set(
    (extraPriceIds || []).map((id) => (id || "").toString().trim()).filter(Boolean)
  );
  const items = (sub && sub.items && sub.items.data) || [];
  return items.filter((it) => ids.has(subscriptionItemPriceId(it)));
}
async function syncSmsExtraLineQuantityToTenant(tenantId, quantity) {
  const q = Math.max(0, Math.floor(Number(quantity) || 0));
  await db.collection("tenants").doc(tenantId).set(
    {
      smsExtraLineQuantity: q,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return q;
}
/**
 * Move any legacy smsExtra subscription items onto the current primary price
 * without invoicing, so price rotations ($10 → $12.99) never double-charge.
 * Returns { primaryItem, quantity, subscription }.
 */
async function migrateSmsExtraLegacyToPrimary(stripe, subscription) {
  let sub = subscription;
  const subId = sub && sub.id;
  if (!stripe || !subId) {
    return { primaryItem: null, quantity: 0, subscription: sub };
  }
  let extraPriceId;
  let extraPriceIds;
  try {
    extraPriceId = stripeSmsExtraPriceId();
    extraPriceIds = stripeSmsExtraPriceIds();
  } catch (_) {
    return { primaryItem: null, quantity: 0, subscription: sub };
  }

  const refresh = async () => {
    sub = await stripe.subscriptions.retrieve(subId, {
      expand: ["items.data.price"],
    });
    return sub;
  };

  let extraItems = smsExtraSubscriptionItems(sub, extraPriceIds);
  let primaryItem = extraItems.find(
    (it) => subscriptionItemPriceId(it) === extraPriceId
  );
  let legacyItems = extraItems.filter(
    (it) => subscriptionItemPriceId(it) !== extraPriceId
  );
  const totalQty = smsExtraQuantityFromSubscription(sub, extraPriceIds);

  if (legacyItems.length) {
    for (const legacy of legacyItems) {
      await stripe.subscriptionItems.del(legacy.id, {
        proration_behavior: "none",
      });
    }
    await refresh();
    extraItems = smsExtraSubscriptionItems(sub, extraPriceIds);
    primaryItem = extraItems.find(
      (it) => subscriptionItemPriceId(it) === extraPriceId
    );
  }

  if (totalQty > 0) {
    if (primaryItem) {
      const pq = Math.max(0, Math.floor(Number(primaryItem.quantity) || 0));
      if (pq !== totalQty) {
        await stripe.subscriptionItems.update(primaryItem.id, {
          quantity: totalQty,
          proration_behavior: "none",
        });
        await refresh();
        primaryItem = smsExtraSubscriptionItems(sub, extraPriceIds).find(
          (it) => subscriptionItemPriceId(it) === extraPriceId
        );
      }
    } else {
      await stripe.subscriptionItems.create({
        subscription: subId,
        price: extraPriceId,
        quantity: totalQty,
        proration_behavior: "none",
      });
      await refresh();
      primaryItem = smsExtraSubscriptionItems(sub, extraPriceIds).find(
        (it) => subscriptionItemPriceId(it) === extraPriceId
      );
    }
  }

  const quantity = smsExtraQuantityFromSubscription(sub, extraPriceIds);
  return { primaryItem: primaryItem || null, quantity, subscription: sub };
}
/** Flat monthly price for an extra texting number (cents). Never prorate purchases. */
const SMS_EXTRA_MONTHLY_CENTS = 1299;
/**
 * Set Stripe smsExtra subscription quantity (0 deletes items) and mirror on the tenant.
 * Legacy items are consolidated first with no invoice. Qty changes default to
 * proration_behavior "none" — purchases bill via a separate flat $12.99 invoice.
 */
/** Resolve subscription id from tenant doc or Stripe customer lookup. */
async function resolveTenantStripeSubscriptionId(stripe, tenant) {
  let subId = ((tenant && tenant.stripeSubscriptionId) || "").toString().trim();
  if (subId) return subId;
  const customerId = ((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!customerId || !stripe) return "";
  try {
    const list = await stripe.subscriptions.list({
      customer: customerId,
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
    return ranked[0] ? ranked[0].id : "";
  } catch (e) {
    console.warn("resolveTenantStripeSubscriptionId", e.message || e);
    return "";
  }
}
async function readSmsExtraQuantityOnStripe(stripe, subId, extraPriceIds) {
  if (!stripe || !subId) return 0;
  const sub = await stripe.subscriptions.retrieve(subId, {
    expand: ["items.data.price"],
  });
  return smsExtraQuantityFromSubscription(sub, extraPriceIds);
}
/** Metadata tag on the Stripe subscription that holds only an App Store subscriber's extra lines. */
const SMS_ADD_ON_PURPOSE = "sms_extra_lines";
/**
 * A plan bought in the iOS app is billed by Apple and has no Stripe subscription to add a
 * monthly texting line to. Those businesses pay for extra lines on a separate Stripe customer
 * (tenant.smsAddOnStripeCustomerId) whose subscription contains nothing but the lines.
 */
function usesSmsAddOnBilling(tenant) {
  return ((tenant && tenant.billingSource) || "").toString() === "apple";
}
/** Stripe customer and subscription that pay for this business's extra texting lines. */
function smsLineBilling(tenant) {
  const text = (value) => (value || "").toString().trim();
  if (usesSmsAddOnBilling(tenant)) {
    return {
      addOn: true,
      customerId: text(tenant.smsAddOnStripeCustomerId),
      subscriptionId: text(tenant.smsAddOnStripeSubscriptionId),
    };
  }
  return {
    addOn: false,
    customerId: text(tenant && tenant.stripeCustomerId),
    subscriptionId: text(tenant && tenant.stripeSubscriptionId),
  };
}
const SMS_ADD_ON_LIVE_STATUSES = ["active", "trialing", "past_due"];
/**
 * Sets how many extra lines an App Store subscriber's add-on subscription bills for.
 * The first line creates the subscription with its first monthly charge a month out — the
 * $12.99 for today is the separate one-time invoice — and removing the last line cancels it.
 * Reads the ids fresh so back-to-back calls in one purchase never work from a stale copy.
 */
async function applySmsAddOnLineQuantity(stripe, tenantId, nextQty) {
  const q = Math.max(0, Math.floor(Number(nextQty) || 0));
  const tenantRef = db.collection("tenants").doc(tenantId);
  const fresh = (await tenantRef.get()).data() || {};
  const billing = smsLineBilling({ ...fresh, billingSource: "apple" });
  let sub = null;
  if (billing.subscriptionId) {
    try {
      sub = await stripe.subscriptions.retrieve(billing.subscriptionId, {
        expand: ["items.data.price"],
      });
    } catch (e) {
      console.warn("applySmsAddOnLineQuantity retrieve", billing.subscriptionId, e.message || e);
    }
  }
  const live = !!sub && SMS_ADD_ON_LIVE_STATUSES.includes(sub.status);

  if (q <= 0) {
    if (live) await stripe.subscriptions.cancel(sub.id);
    await tenantRef.set(
      {
        smsAddOnStripeSubscriptionId: admin.firestore.FieldValue.delete(),
        smsExtraLineQuantity: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return 0;
  }

  if (!billing.customerId) {
    throw new Error("Add a card for extra texting numbers in billing first.");
  }
  const priceId = stripeSmsExtraPriceId();
  if (live) {
    const item = (sub.items.data || []).find((row) => row.price && row.price.id === priceId);
    if (item) {
      if (item.quantity !== q) {
        await stripe.subscriptionItems.update(item.id, { quantity: q, proration_behavior: "none" });
      }
    } else {
      await stripe.subscriptionItems.create({
        subscription: sub.id,
        price: priceId,
        quantity: q,
        proration_behavior: "none",
      });
    }
  } else {
    const firstMonthly = new Date();
    firstMonthly.setMonth(firstMonthly.getMonth() + 1);
    sub = await stripe.subscriptions.create({
      customer: billing.customerId,
      items: [{ price: priceId, quantity: q }],
      billing_cycle_anchor: Math.floor(firstMonthly.getTime() / 1000),
      proration_behavior: "none",
      metadata: { tenantId, purpose: SMS_ADD_ON_PURPOSE },
    });
    if (!SMS_ADD_ON_LIVE_STATUSES.includes(sub.status)) {
      try {
        await stripe.subscriptions.cancel(sub.id);
      } catch (_) {
        /* best effort */
      }
      throw new Error("Stripe could not start billing for the extra texting number.");
    }
  }
  await tenantRef.set(
    {
      smsAddOnStripeSubscriptionId: sub.id,
      smsExtraLineQuantity: q,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return q;
}
async function applySmsExtraLineQuantity(stripe, tenantId, tenant, nextQty, opts) {
  const q = Math.max(0, Math.floor(Number(nextQty) || 0));
  const prorationBehavior =
    opts && opts.prorationBehavior === "always_invoice"
      ? "always_invoice"
      : "none";
  const strictStripe = !(opts && opts.strictStripe === false);

  if (!stripe) {
    if (strictStripe) {
      throw new Error("Stripe is not configured for texting line billing sync.");
    }
    await syncSmsExtraLineQuantityToTenant(tenantId, q);
    return q;
  }

  if (usesSmsAddOnBilling(tenant)) {
    return applySmsAddOnLineQuantity(stripe, tenantId, q);
  }

  let extraPriceId;
  let extraPriceIds;
  try {
    extraPriceId = stripeSmsExtraPriceId();
    extraPriceIds = stripeSmsExtraPriceIds();
  } catch (e) {
    if (strictStripe) throw e;
    console.warn("applySmsExtraLineQuantity no smsExtra price", e.message || e);
    await syncSmsExtraLineQuantityToTenant(tenantId, q);
    return q;
  }

  const subId = await resolveTenantStripeSubscriptionId(stripe, tenant);
  if (!subId) {
    if (strictStripe) {
      throw new Error("No Stripe subscription is linked to this business.");
    }
    await syncSmsExtraLineQuantityToTenant(tenantId, q);
    return q;
  }

  let sub = await stripe.subscriptions.retrieve(subId, {
    expand: ["items.data.price"],
  });
  const migrated = await migrateSmsExtraLegacyToPrimary(stripe, sub);
  sub = migrated.subscription || sub;
  const primaryItem = migrated.primaryItem;
  const currentQty = migrated.quantity;

  if (currentQty === q) {
    await syncSmsExtraLineQuantityToTenant(tenantId, q);
    return q;
  }

  if (q <= 0) {
    const extras = smsExtraSubscriptionItems(sub, extraPriceIds);
    for (const item of extras) {
      await stripe.subscriptionItems.del(item.id, {
        proration_behavior: prorationBehavior,
      });
    }
  } else if (primaryItem) {
    await stripe.subscriptionItems.update(primaryItem.id, {
      quantity: q,
      proration_behavior: prorationBehavior,
    });
  } else {
    await stripe.subscriptionItems.create({
      subscription: subId,
      price: extraPriceId,
      quantity: q,
      proration_behavior: prorationBehavior,
    });
  }

  const verifiedQty = await readSmsExtraQuantityOnStripe(stripe, subId, extraPriceIds);
  if (verifiedQty !== q) {
    throw new Error(
      `Stripe smsExtra quantity is ${verifiedQty} after update but expected ${q}.`
    );
  }
  await syncSmsExtraLineQuantityToTenant(tenantId, q);
  return q;
}
/**
 * Payment method id Stripe already uses for this subscriber (sub → customer →
 * attached PMs → last paid invoice). Empty string means invoice.pay should use
 * Stripe's normal collection defaults — never treat that as "no card" when they
 * have an active subscription.
 */
async function resolveChargeablePaymentMethodId(
  stripe,
  customerId,
  subscriptionIdOpt
) {
  const pickPm = (raw) => {
    if (typeof raw === "string" && raw.startsWith("pm_")) return raw.trim();
    if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.startsWith("pm_")) {
      return raw.id.trim();
    }
    return "";
  };

  const subId = (subscriptionIdOpt || "").toString().trim();
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId, {
        expand: ["default_payment_method"],
      });
      const fromSub = pickPm(sub.default_payment_method);
      if (fromSub) return fromSub;
    } catch (e) {
      console.warn("resolveChargeablePaymentMethodId sub", subId, e.message || e);
    }
  }

  try {
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (customer && !customer.deleted) {
      const fromCust = pickPm(
        customer.invoice_settings && customer.invoice_settings.default_payment_method
      );
      if (fromCust) return fromCust;
    }
  } catch (e) {
    console.warn("resolveChargeablePaymentMethodId customer", e.message || e);
  }

  try {
    const listed = await stripe.paymentMethods.list({
      customer: customerId,
      limit: 10,
    });
    for (const item of listed.data || []) {
      const id = pickPm(item);
      if (id) return id;
    }
  } catch (e) {
    console.warn("resolveChargeablePaymentMethodId list", e.message || e);
  }

  try {
    const invs = await stripe.invoices.list({
      customer: customerId,
      status: "paid",
      limit: 5,
    });
    for (const inv of invs.data || []) {
      if (!inv.id || !(inv.amount_paid > 0)) continue;
      const full = await stripe.invoices.retrieve(inv.id, {
        expand: ["payment_intent.payment_method"],
      });
      let pi = full.payment_intent;
      if (typeof pi === "string") {
        try {
          pi = await stripe.paymentIntents.retrieve(pi, {
            expand: ["payment_method"],
          });
        } catch (_) {
          pi = null;
        }
      }
      const fromInv = pickPm(pi && pi.payment_method);
      if (fromInv) return fromInv;
    }
  } catch (e) {
    console.warn("resolveChargeablePaymentMethodId invoices", e.message || e);
  }

  return "";
}
/**
 * Flat $12.99 same-day charge via the same invoice collection path as their plan.
 * Creates a draft invoice, attaches the $12.99 line to that invoice (avoids empty
 * paid/$0 invoices when pending items are excluded), then pays it.
 */
async function chargeOneTimeSmsExtraFee(stripe, tenant, description) {
  const lineBilling = smsLineBilling(tenant);
  const customerId = lineBilling.customerId;
  if (!customerId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      lineBilling.addOn
        ? "Add a card for extra texting numbers in billing first."
        : "Billing is not set up. Complete subscription checkout first."
    );
  }
  const desc = (description || "Get Bookking extra texting number ($12.99)").toString();
  const subId = lineBilling.subscriptionId;

  let paymentMethodId = "";
  try {
    paymentMethodId = await resolveChargeablePaymentMethodId(
      stripe,
      customerId,
      subId
    );
  } catch (e) {
    console.warn("resolveChargeablePaymentMethodId", e.message || e);
  }

  try {
    // Draft first, then attach the $12.99 line to THIS invoice — never rely on
    // pending_invoice_items_behavior (defaults can exclude items → paid/total=0).
    let invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
    });
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: SMS_EXTRA_MONTHLY_CENTS,
      currency: "usd",
      description: desc,
    });
    invoice = await stripe.invoices.retrieve(invoice.id);
    const draftTotal = Math.max(0, Math.floor(Number(invoice.total) || 0));
    if (draftTotal < SMS_EXTRA_MONTHLY_CENTS) {
      try {
        await stripe.invoices.del(invoice.id);
      } catch (_) {
        /* best effort */
      }
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Could not build the $12.99 texting-number invoice. Try again."
      );
    }
    invoice = await stripe.invoices.finalizeInvoice(invoice.id);
    if (invoice.status === "open") {
      const payOpts = paymentMethodId
        ? { payment_method: paymentMethodId }
        : undefined;
      try {
        invoice = await stripe.invoices.pay(invoice.id, payOpts);
      } catch (payErr) {
        if (paymentMethodId) {
          try {
            invoice = await stripe.invoices.pay(invoice.id);
          } catch (payErr2) {
            throw new functions.https.HttpsError(
              "failed-precondition",
              `Could not charge your card for the texting number: ${stripeErrorMessage(payErr2)}`
            );
          }
        } else {
          throw new functions.https.HttpsError(
            "failed-precondition",
            `Could not charge your card for the texting number: ${stripeErrorMessage(payErr)}`
          );
        }
      }
    }
    const total = Math.max(0, Math.floor(Number(invoice && invoice.total) || 0));
    if (invoice && invoice.status === "paid" && total >= SMS_EXTRA_MONTHLY_CENTS) {
      return {
        id: invoice.id,
        status: "paid",
        amount_paid: Math.max(
          total,
          Math.floor(Number(invoice.amount_paid) || 0)
        ),
      };
    }
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Stripe did not confirm the $12.99 texting-number payment` +
        (invoice ? ` (status=${invoice.status}, total=${total}).` : ".") +
        " No number was set up. Try again or update billing if the charge failed."
    );
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Could not charge your card for the texting number: ${stripeErrorMessage(e)}`
    );
  }
}
/**
 * Drop Stripe/Firestore paid extras down to what's needed for current usage
 * (no prepaid empty slots). usedOpt skips a users scan when already known.
 */
/**
 * Drop Stripe/Firestore paid extras to match currently active paid-tagged lines.
 * No prepaid spare seats. Legacy untagged lines: fall back to max(0, used - free)
 * only when no paid tags exist yet.
 */
async function reconcileSmsExtraPaidToUsage(
  stripe,
  tenantId,
  tenant,
  planNorm,
  usedOpt,
  opts
) {
  const plan = normalizeSubscriptionPlan(
    planNorm || (tenant && tenant.subscriptionPlan)
  );
  if (isSingleOperatorPlan(plan)) {
    return { tenant, paid: 0, changed: false };
  }
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const used =
    typeof usedOpt === "number"
      ? Math.max(0, usedOpt)
      : sms.countOccupiedSmsLinesFromDocs(tenant, snap.docs);
  const free = sms.freeIncludedSmsLinesForPlan(plan);
  // Subscription smsExtra qty = concurrent lines beyond free allotment only.
  const target = Math.max(0, used - free);
  const paidFs = sms.smsExtraPaidQuantity(tenant);
  const strictStripe = !(opts && opts.strictStripe === false);

  if (!stripe) {
    if (strictStripe) {
      throw new Error("Stripe is not configured for texting line billing sync.");
    }
    if (paidFs === target) {
      return { tenant, paid: paidFs, changed: false };
    }
    await syncSmsExtraLineQuantityToTenant(tenantId, target);
    return {
      tenant: { ...tenant, smsExtraLineQuantity: target },
      paid: target,
      changed: true,
    };
  }

  // App Store subscribers: the add-on subscription is the only thing to bring in line.
  if (usesSmsAddOnBilling(tenant)) {
    if (paidFs === target) {
      return { tenant, paid: paidFs, changed: false };
    }
    if (target > 0 && !smsLineBilling(tenant).customerId) {
      console.warn("reconcileSmsExtraPaidToUsage: add-on lines without a card", tenantId, target);
      await syncSmsExtraLineQuantityToTenant(tenantId, target);
    } else {
      await applySmsAddOnLineQuantity(stripe, tenantId, target);
    }
    return {
      tenant: { ...tenant, smsExtraLineQuantity: target },
      paid: target,
      changed: true,
    };
  }

  let extraPriceIds;
  try {
    extraPriceIds = stripeSmsExtraPriceIds();
  } catch (e) {
    if (strictStripe) throw e;
    console.warn("reconcileSmsExtraPaidToUsage no smsExtra price", e.message || e);
    if (paidFs === target) {
      return { tenant, paid: paidFs, changed: false };
    }
    await syncSmsExtraLineQuantityToTenant(tenantId, target);
    return {
      tenant: { ...tenant, smsExtraLineQuantity: target },
      paid: target,
      changed: true,
    };
  }

  const resolvedSubId = await resolveTenantStripeSubscriptionId(stripe, tenant);
  let tenantForApply = tenant;
  if (resolvedSubId && resolvedSubId !== ((tenant && tenant.stripeSubscriptionId) || "")) {
    tenantForApply = { ...tenant, stripeSubscriptionId: resolvedSubId };
    await db.collection("tenants").doc(tenantId).set(
      {
        stripeSubscriptionId: resolvedSubId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  let stripeQty = 0;
  if (resolvedSubId) {
    stripeQty = await readSmsExtraQuantityOnStripe(stripe, resolvedSubId, extraPriceIds);
  } else if (strictStripe && (paidFs > 0 || target > 0)) {
    throw new Error("No Stripe subscription is linked to this business.");
  }

  const current = Math.max(paidFs, stripeQty);
  if (current === target && paidFs === target) {
    return { tenant: tenantForApply, paid: target, changed: false };
  }

  console.info(
    "reconcileSmsExtraPaidToUsage",
    tenantId,
    JSON.stringify({ used, free, target, paidFs, stripeQty, subId: resolvedSubId || null })
  );

  await applySmsExtraLineQuantity(stripe, tenantId, tenantForApply, target, {
    prorationBehavior: "none",
    strictStripe,
  });
  return {
    tenant: { ...tenantForApply, smsExtraLineQuantity: target },
    paid: target,
    changed: true,
  };
}
/**
 * Tag occupied personal lines as paid extras until tagged count matches stripeQty.
 * Prefers member lines over studio (studio is usually a free included seat).
 */
async function backfillPaidSmsLineTags(tenantId, tenant, userDocs, stripeQty) {
  const need = Math.max(0, Math.floor(Number(stripeQty) || 0));
  if (need <= 0) return;
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const candidates = [];
  for (const doc of userDocs || []) {
    if (ownerUid && doc.id === ownerUid) continue;
    const d = typeof doc.data === "function" ? doc.data() || {} : {};
    if (!sms.occupiesSmsLineSlot(d)) continue;
    if (sms.isPaidSmsLineExtra(d)) continue;
    candidates.push({ ref: doc.ref, kind: "member" });
  }
  // Studio last — only if we still need tags.
  if (sms.occupiesSmsLineSlot(tenant) && !sms.isPaidSmsLineExtra(tenant)) {
    candidates.push({
      ref: db.collection("tenants").doc(tenantId),
      kind: "studio",
    });
  }
  let tagged = 0;
  for (const c of candidates) {
    if (tagged >= need) break;
    await c.ref.set(
      {
        smsLineIsPaidExtra: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tagged += 1;
  }
}
/**
 * After releasing a line that held inventory, sync smsExtra subscription qty to usage.
 * Throws when Stripe is available but billing could not be updated.
 */
async function maybeReduceSmsExtraAfterReleasingOccupiedLine(
  stripe,
  tenantId,
  tenant,
  planNorm,
  releasedLineHeldSlot
) {
  if (!releasedLineHeldSlot) return null;
  const plan = normalizeSubscriptionPlan(
    planNorm || (tenant && tenant.subscriptionPlan)
  );
  if (isSingleOperatorPlan(plan)) return null;
  const usedAfter = await sms.countOccupiedSmsLines(tenantId, tenant);
  try {
    const result = await reconcileSmsExtraPaidToUsage(
      stripe,
      tenantId,
      tenant,
      plan,
      usedAfter
    );
    return result.paid;
  } catch (e) {
    console.error("maybeReduceSmsExtraAfterReleasingOccupiedLine", tenantId, e.message || e);
    throw new functions.https.HttpsError(
      "failed-precondition",
      `The texting number was removed, but subscription billing could not be updated: ${stripeErrorMessage(e)}. Open Billing on getbookking.com or remove the extra line in Stripe.`
    );
  }
}
function stripeClientFromSecret() {
  const secretKey = stripeSecretKey.value();
  if (!secretKey) return null;
  return new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
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
  const isCharterPlan = plan === "charter";
  const isCharterIndustry = industry === "charters";
  if (isCharterPlan !== isCharterIndustry) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Boat / Fishing charter sign-up requires the Charter plan."
    );
  }
  if (isCharterPlan && teamSize !== "solo") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "The Charter plan supports one operator."
    );
  }
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
    const subscriptionPlan = normalizeSubscriptionPlan(
      (tSnap.exists && tSnap.data().subscriptionPlan) ||
        existingUser.data().subscriptionPlan
    );
    return { tenantId: tid, slug, subscriptionPlan, alreadyProvisioned: true };
  }

  const {
    teamSize,
    industry: industryRaw,
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

  const subscriptionPlan = normalizeSubscriptionPlan(plan);
  // Boat / Fishing charter is a plan, not an industry picker — lock industry + theme.
  const industry =
    subscriptionPlan === "charter" ? "charters" : industryRaw;
  const slug = slugFromBusiness(businessName);
  const webThemeId =
    subscriptionPlan === "charter"
      ? "charter-v1"
      : resolveWebThemeId(industry, templatePreset || "portfolio");
  const formSchema = formSchemaForIndustry(industry);
  const guidedStepTitles = guidedStepTitlesForIndustry(industry);
  const cityDisplay = titleCaseCityWords(city);
  const serviceArea = composeServiceArea(cityDisplay, stateAbbr);
  const displayName = `${firstName} ${lastName}`.trim();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;

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
    guidedStepTitles,
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
    shopEnabled: subscriptionPlan === "charter",
    shopTaxEnabled: false,
    inPersonTaxEnabled: false,
    aboutText: "",
    contactEmail: email || "",
    contactAddress: "",
    contactAddressSuite: "",
    heroTagline: "",
    heroSubtitle: "",
    managerPermissions: DEFAULT_MANAGER_PERMISSIONS,
    managerNotifications: DEFAULT_MANAGER_NOTIFICATIONS,
    workflow: defaultWorkflowForPlan(subscriptionPlan),
    bookingMode: subscriptionPlan === "charter" ? "calendar_slots" : "form",
    timeZone: "America/New_York",
    ...(subscriptionPlan === "charter"
      ? {
          charterBoats: [],
          charterBoatSetupPending: true,
          charterOnboardingVersion: 1,
        }
      : {}),
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
  const appleAppAccountToken = appleSubscription.preservedAccountToken(existingUser);

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
    ...(appleAppAccountToken ? { appleAppAccountToken } : {}),
    availability: {
      timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
      daysOpen: [1, 2, 3, 4, 5],
      timeZone: "America/New_York",
    },
    workflow: {
      confirmationType: "request_approve",
      responseTimeHours: 24,
      ...(subscriptionPlan === "charter" ? { bookingMode: "calendar_slots" } : {}),
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

  return { tenantId, slug, subscriptionPlan };
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
      if (checkoutKind === "initial_today" || checkoutKind === "initial_trial_end") {
        return finalizeInitialSubscriptionFromCheckoutSession(stripe, session, uid);
      }
      const tid = u.data().tenantId;
      const tSnap = await db.collection("tenants").doc(tid).get();
      const tenantData = tSnap.exists ? tSnap.data() || {} : {};
      return {
        tenantId: tid,
        slug: tenantData.slug || "",
        subscriptionPlan: normalizeSubscriptionPlan(
          tenantData.subscriptionPlan || u.data().subscriptionPlan
        ),
      };
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
  const planNorm = subscriptionPlanFromStripe(
    ctx.tenant && ctx.tenant.subscriptionPlan,
    planNormFromStripeSubscription(sub),
    sub
  );
  if (planNorm) {
    syncPatch.subscriptionPlan = planNorm;
    Object.assign(syncPatch, subscriptionPlanEntitlementPatch(ctx.tenant, planNorm));
  }

  await sms.syncSubscriptionStatusForTenant(ctx.tenantId, sub.status, syncPatch);

  return {
    ok: true,
    tenantId: ctx.tenantId,
    subscriptionStatus: sub.status,
    resubscribed: true,
  };
}
/** Owner already provisioned (cardless trial): link Stripe sub from first billing Checkout. */
async function finalizeInitialSubscriptionFromCheckoutSession(stripe, session, uid) {
  const sessionUid =
    (session.metadata && session.metadata.firebaseUid) || session.client_reference_id;
  if (!sessionUid || sessionUid !== uid) {
    console.warn("initial checkout uid mismatch", session.id);
    return null;
  }
  const checkoutKind = (session.metadata && session.metadata.checkoutKind) || "";
  if (checkoutKind !== "initial_today" && checkoutKind !== "initial_trial_end") {
    return null;
  }

  const paidOk =
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  if (!paidOk || session.mode !== "subscription") {
    console.warn("initial checkout not paid / not subscription", session.id);
    return null;
  }

  const ctx = await getMemberAccessContext(uid);
  if (!ctx.isOwner) {
    console.warn("initial checkout non-owner", session.id);
    return null;
  }
  const metaTenantId = ((session.metadata && session.metadata.tenantId) || "").toString().trim();
  if (metaTenantId && metaTenantId !== ctx.tenantId) {
    console.warn("initial checkout tenant mismatch", session.id);
    return null;
  }

  let sub = session.subscription;
  if (typeof sub === "string") {
    sub = await stripe.subscriptions.retrieve(sub, { expand: ["items.data.price"] });
  } else if (sub && sub.id && (!sub.items || !sub.items.data)) {
    sub = await stripe.subscriptions.retrieve(sub.id, { expand: ["items.data.price"] });
  }
  if (!sub || !sub.id) {
    console.warn("initial checkout missing subscription", session.id);
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
  const planNorm = subscriptionPlanFromStripe(
    ctx.tenant && ctx.tenant.subscriptionPlan,
    planNormFromStripeSubscription(sub),
    sub
  );
  if (planNorm) {
    syncPatch.subscriptionPlan = planNorm;
    Object.assign(syncPatch, subscriptionPlanEntitlementPatch(ctx.tenant, planNorm));
  }

  await sms.syncSubscriptionStatusForTenant(ctx.tenantId, sub.status, syncPatch);

  return {
    ok: true,
    tenantId: ctx.tenantId,
    subscriptionStatus: sub.status,
    initialCheckout: true,
  };
}
function planNormFromPriceId(priceId) {
  const pid = (priceId || "").toString().trim();
  if (!pid) return null;
  const planKeys = ["solo", "studio", "shop", "charter"];
  try {
    const map = parseStripeSubscriptionPriceIds();
    const matches = [];
    for (const key of planKeys) {
      if ((map[key] || "").toString().trim() === pid) matches.push(key);
    }
    if (matches.length === 1) return matches[0];
    return null;
  } catch (_) {
    /* secrets unavailable in some contexts */
  }
  return null;
}
function planNormFromStripeSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const metaRaw = sub.metadata && sub.metadata.plan;
  const metaPlan = planNormFromMetadata(metaRaw);
  if (metaPlan) return metaPlan;
  const items = (sub.items && sub.items.data) || [];
  // Prefer plan price ids; ignore smsExtra add-on item.
  const planKeys = ["solo", "studio", "shop", "charter"];
  try {
    parseStripeSubscriptionPriceIds();
    for (const item of items) {
      const price = item.price;
      const priceId =
        (price && typeof price === "object" && price.id) ||
        (typeof price === "string" ? price : null);
      if (!priceId) continue;
      const fromMap = planNormFromPriceId(priceId);
      if (fromMap && planKeys.includes(fromMap)) return fromMap;
    }
  } catch (_) {
    /* */
  }
  for (const item of items) {
    const price = item.price;
    const priceId =
      (price && typeof price === "object" && price.id) ||
      (typeof price === "string" ? price : null);
    if (!priceId) continue;
    const fromMap = planNormFromPriceId(priceId);
    if (fromMap && planKeys.includes(fromMap)) return fromMap;
  }
  return null;
}
function planNormFromMetadata(raw) {
  const p = (raw || "").toString().trim().toLowerCase();
  if (!p) return null;
  if (p === "solo" || p === "studio" || p === "shop" || p === "charter") return p;
  if (p === "charters" || p === "boat" || p === "fishing" || p === "boating") return "charter";
  if (p === "basic" || p === "free" || p === "starter") return "solo";
  if (p === "growth" || p === "pro") return "studio";
  if (p === "enterprise") return "shop";
  return null;
}
function subscriptionPlanFromStripe(existingPlan, planNorm, sub) {
  if (!planNorm) return null;
  const existing = (existingPlan || "").toString().trim().toLowerCase();
  const existingNorm =
    existing === "charter" || existing === "charters" ? "charter" : normalizeSubscriptionPlan(existingPlan);
  const metaPlan = planNormFromMetadata(sub && sub.metadata && sub.metadata.plan);
  if (existingNorm === "charter" && planNorm === "solo" && metaPlan !== "solo") {
    return null;
  }
  return planNorm;
}
function subscriptionPlanEntitlementPatch(tenantData, nextPlan) {
  const tenant = tenantData || {};
  const currentPlan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  const next = normalizeSubscriptionPlan(nextPlan);
  if (currentPlan === next) return {};
  if (next === "charter") {
    const boats = Array.isArray(tenant.charterBoats) ? tenant.charterBoats : [];
    return {
      preCharterConfig: {
        industry: tenant.industry || "custom",
        webThemeId: tenant.webThemeId || "custom-standard",
        resolvedWebThemeId: tenant.resolvedWebThemeId || tenant.webThemeId || "custom-standard",
        bookingMode: tenant.bookingMode || "form",
        shopEnabled: tenant.shopEnabled === true,
        workflow: tenant.workflow || defaultWorkflowForPlan(currentPlan),
      },
      industry: "charters",
      webThemeId: "charter-v1",
      resolvedWebThemeId: "charter-v1",
      bookingMode: "calendar_slots",
      shopEnabled: true,
      workflow: defaultWorkflowForPlan("charter"),
      charterBoats: boats,
      charterBoatSetupPending: boats.length === 0,
      charterOnboardingVersion: 1,
    };
  }
  if (currentPlan === "charter") {
    const saved =
      tenant.preCharterConfig && typeof tenant.preCharterConfig === "object"
        ? tenant.preCharterConfig
        : {};
    const industry = (saved.industry || "custom").toString();
    const theme = (saved.webThemeId || "custom-standard").toString();
    return {
      industry,
      webThemeId: theme,
      resolvedWebThemeId: (saved.resolvedWebThemeId || theme).toString(),
      bookingMode: (saved.bookingMode || "form").toString(),
      shopEnabled: saved.shopEnabled === true,
      workflow:
        saved.workflow && typeof saved.workflow === "object"
          ? saved.workflow
          : defaultWorkflowForPlan(next),
      preCharterConfig: admin.firestore.FieldValue.delete(),
      charterBoatSetupPending: false,
    };
  }
  return {};
}
async function deactivateTenantPaymentLinks(stripe, tenantId, tenantData) {
  const accountIds = new Set();
  const tenantAccountId = (tenantData.stripeAccountId || "").toString().trim();
  if (tenantAccountId && !isDemoShowcaseStripeAccountId(tenantAccountId)) {
    accountIds.add(tenantAccountId);
  }

  const members = await db.collection("users").where("tenantId", "==", tenantId).get();
  for (const memberDoc of members.docs) {
    const accountId = (memberDoc.data().stripeAccountId || "").toString().trim();
    if (accountId && !isDemoShowcaseStripeAccountId(accountId)) {
      accountIds.add(accountId);
    }
  }

  for (const stripeAccountId of accountIds) {
    try {
      let startingAfter;
      do {
        const page = await stripe.paymentLinks.list(
          {
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          { stripeAccount: stripeAccountId }
        );
        for (const link of page.data) {
          if (
            link.active &&
            (link.metadata?.tenantId || "").toString() === tenantId
          ) {
            await stripe.paymentLinks.update(
              link.id,
              { active: false },
              { stripeAccount: stripeAccountId }
            );
          }
        }
        startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : null;
      } while (startingAfter);
    } catch (err) {
      console.warn(
        "deactivateTenantPaymentLinks",
        tenantId,
        stripeAccountId,
        err.message || err
      );
    }
  }
}
/** Find tenant by Stripe customer id and sync subscription + plan to Firestore. */
/**
 * Keeps an App Store subscriber's extra texting lines in step with their add-on subscription.
 * While it is live the paid line count mirrors Stripe. Once it ends (cancelled, or unpaid
 * after Stripe's retries) the paid lines are suspended; the daily job releases them 30 days on.
 * Events for an older, already-replaced subscription are ignored.
 */
async function syncSmsAddOnSubscription(sub) {
  const tenantId = ((sub.metadata && sub.metadata.tenantId) || "").toString().trim();
  if (!tenantId) return;
  const tenantRef = db.collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) return;
  const tenant = tenantSnap.data() || {};
  const storedSubId = (tenant.smsAddOnStripeSubscriptionId || "").toString().trim();
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id;
  if ((tenant.smsAddOnStripeCustomerId || "").toString().trim() !== (customerId || "")) return;
  if (storedSubId && storedSubId !== sub.id) return;

  if (SMS_ADD_ON_LIVE_STATUSES.includes(sub.status)) {
    if (!storedSubId) return;
    const quantity = ((sub.items && sub.items.data) || []).reduce(
      (sum, item) => sum + Math.max(0, Number(item.quantity) || 0),
      0
    );
    await syncSmsExtraLineQuantityToTenant(tenantId, quantity);
    return;
  }
  if (!storedSubId) return;
  await tenantRef.set(
    {
      smsAddOnStripeSubscriptionId: admin.firestore.FieldValue.delete(),
      smsExtraLineQuantity: 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const members = await db.collection("users").where("tenantId", "==", tenantId).get();
  for (const doc of members.docs) {
    const member = doc.data() || {};
    if (member.smsLineIsPaidExtra !== true || member.smsStatus !== "active") continue;
    await doc.ref.set(
      {
        smsStatus: "suspended",
        smsSuspendedAt: admin.firestore.FieldValue.serverTimestamp(),
        smsSuspendReason: "addon_ended",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
}
/** Stops the monthly charge for extra lines, e.g. when the App Store plan itself has ended. */
async function cancelSmsAddOnSubscription(stripe, tenantId) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  const subId = ((tenantSnap.data() || {}).smsAddOnStripeSubscriptionId || "").toString().trim();
  if (!subId || !stripe) return false;
  const cancelled = await stripe.subscriptions.cancel(subId);
  await syncSmsAddOnSubscription(cancelled);
  return true;
}
async function syncStripeSubscriptionStatusToTenant(stripe, stripeCustomerId, status, sub) {
  if (sub && sub.metadata && sub.metadata.purpose === SMS_ADD_ON_PURPOSE) {
    await syncSmsAddOnSubscription(sub);
    return;
  }
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
  const planNorm = subscriptionPlanFromStripe(
    snap.docs[0].data() && snap.docs[0].data().subscriptionPlan,
    planNormFromStripeSubscription(sub),
    sub
  );
  if (planNorm) {
    patch.subscriptionPlan = planNorm;
    Object.assign(patch, subscriptionPlanEntitlementPatch(snap.docs[0].data(), planNorm));
  }
  try {
    const extraPriceIds = stripeSmsExtraPriceIds();
    if (sub && extraPriceIds.length) {
      const stripeQty = smsExtraQuantityFromSubscription(sub, extraPriceIds);
      // Stripe Extra SMS quantity is source of truth for the mirror field.
      patch.smsExtraLineQuantity = Math.max(0, stripeQty);
    }
  } catch (_) {
    /* optional */
  }
  const synced = await sms.syncSubscriptionStatusForTenant(tenantId, normalized, patch);
  if (normalized !== "active" && !(synced && synced.skipped)) {
    await deactivateTenantPaymentLinks(stripe, tenantId, snap.docs[0].data() || {});
  }
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
/**
 * Create a Standard Connect account (Stripe is pricing owner for these users).
 */
async function createStandardConnectAccount(stripe, email) {
  // Do not set settings.payouts.debit_negative_balances here: on Standard accounts
  // Stripe owns loss liability and rejects debit_negative_balances: false
  // ("Accounts where Stripe owns loss liability can not have their negative debits disabled.").
  return stripe.accounts.create({
    type: "standard",
    email: email || undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
}
/**
 * Validate and retrieve the stored Connect account directly.
 * Skips full-platform account listing scans to prevent severe latency / timeouts.
 */
async function reconcileConnectAccountId(stripe, accountRef, storedId, email) {
  const storedIdTrimmed = (storedId || "").toString().trim();
  if (!storedIdTrimmed) return null;

  try {
    const storedAccount = await stripe.accounts.retrieve(storedIdTrimmed);
    if (storedAccount) {
      return { stripeAccountId: storedIdTrimmed, account: storedAccount };
    }
  } catch (err) {
    console.warn(
      "reconcileConnectAccountId retrieve failed",
      storedIdTrimmed,
      err.message || err
    );
  }
  return null;
}
/**
 * If Firestore still points at a legacy Express account, replace with Standard
 * so pricing owner is Stripe (per Connect account type).
 */
async function replaceExpressWithStandardConnectAccount(
  stripe,
  accountRef,
  email,
  account
) {
  if (!account || (account.type || "").toString() !== "express") {
    return null;
  }
  console.log("ensureConnectAccountId replacing Express with Standard", {
    from: account.id,
    email: (email || "").toString().trim(),
  });
  const standard = await createStandardConnectAccount(stripe, email);
  await accountRef.set({ stripeAccountId: standard.id }, { merge: true });
  return { stripeAccountId: standard.id, account: standard };
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
    if (reconciled) {
      const migrated = await replaceExpressWithStandardConnectAccount(
        stripe,
        accountRef,
        email,
        reconciled.account
      );
      if (migrated) return migrated;
      return reconciled;
    }
  }

  const freshDoc = await accountRef.get();
  const raceId = (freshDoc.data()?.stripeAccountId || "").toString().trim();
  if (raceId) {
    const account = await stripe.accounts.retrieve(raceId);
    const migrated = await replaceExpressWithStandardConnectAccount(
      stripe,
      accountRef,
      email,
      account
    );
    if (migrated) return migrated;
    return { stripeAccountId: raceId, account };
  }

  const account = await createStandardConnectAccount(stripe, email);
  await accountRef.set({ stripeAccountId: account.id }, { merge: true });
  console.log("ensureConnectAccountId created Standard", {
    id: account.id,
    email: (email || "").toString().trim(),
  });
  return { stripeAccountId: account.id, account };
}
/**
 * Best-effort: turn off automatic bank debits for negative balances on
 * platform-liable Connect accounts (e.g. legacy Express). Skips Standard /
 * Stripe-liable accounts — Stripe rejects debit_negative_balances: false there.
 * Runs lazily from getConnectAccountStatus.
 */
async function ensureNoNegativeBalanceBankDebits(stripe, account) {
  try {
    if (!account || account.settings?.payouts?.debit_negative_balances !== true) {
      return account;
    }
    const type = (account.type || "").toString();
    if (type === "standard") {
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
 * Some Connect accounts reject `account_update` and only allow `account_onboarding`
 * (even after details_submitted). Prefer update when details are in, then fall back.
 */
async function createConnectAccountLinkWithFallback(
  stripe,
  stripeAccountId,
  { returnUrl, refreshUrl, preferUpdate }
) {
  const preferred = preferUpdate ? "account_update" : "account_onboarding";
  try {
    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: preferred,
    });
    return { accountLink: link, linkType: preferred };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const shouldFallback =
      preferred === "account_update" &&
      (/account_onboarding/i.test(msg) ||
        /Valid types for this account/i.test(msg) ||
        /cannot create ['"]account_update['"]/i.test(msg));
    if (!shouldFallback) throw err;
    console.warn(
      "createConnectAccountLinkWithFallback: account_update rejected; using account_onboarding",
      stripeAccountId,
      msg
    );
    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
    return { accountLink: link, linkType: "account_onboarding" };
  }
}
/** Best-effort Express login / Dashboard URL for status checks while in review. */
async function connectAccountStatusUrl(stripe, account, stripeAccountId) {
  const accountType = (account && account.type) || "";
  if (accountType === "standard") {
    return { url: "https://dashboard.stripe.com/login", accountType: "standard" };
  }
  try {
    const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
    if (loginLink && loginLink.url) {
      return { url: loginLink.url, accountType: accountType || "express" };
    }
  } catch (err) {
    console.warn(
      "connectAccountStatusUrl login link failed",
      stripeAccountId,
      err && err.message ? err.message : err
    );
  }
  return {
    url: "https://dashboard.stripe.com/login",
    accountType: accountType || "unknown",
  };
}
/**
 * Platform fee on customer payments (Tap to Pay, deposit links, shop, charter).
 * Rates live in checkoutRates.js. Not applied to provider subscriptions.
 */
const PROCESSING_SERVICE_FEE_LABEL = "Processing & service fees";
/**
 * In-person manual / Tap to Pay: tax is pass-through but Stripe + platform fees apply
 * to the full charge, so gross-up uses service + tax as the fee base.
 */
function computeInPersonCheckoutTotals(serviceCents, taxCents, channel = "online") {
  const service = Math.max(0, Math.round(Number(serviceCents) || 0));
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  if (service <= 0 && tax <= 0) {
    return {
      serviceCents: 0,
      taxCents: 0,
      surchargeCents: 0,
      totalCents: 0,
      platformFeeCents: 0,
    };
  }
  const checkout = computeCardCheckoutAmounts(service + tax, channel);
  return {
    serviceCents: service,
    taxCents: tax,
    surchargeCents: Math.max(0, checkout.totalCents - service - tax),
    totalCents: checkout.totalCents,
    platformFeeCents: checkout.platformFeeCents,
  };
}
/**
 * Card only. Link still appears inside the card option (Bank tab, saved Link details), and a
 * Link bank payment then shows as card brand "link", which the web checkout prices at the
 * instant-bank rate. Listing "link" as its own type instead hides card vs bank and lets Stripe
 * show Klarna through Link; Klarna and Affirm terms forbid a processing fee for choosing them.
 */
async function createCustomerCheckoutPaymentIntent(stripe, stripeAccountId, payload) {
  const methodLists = [["card"]];
  let lastErr = null;
  for (let i = 0; i < methodLists.length; i++) {
    try {
      return await stripe.paymentIntents.create(
        {
          ...payload,
          payment_method_types: methodLists[i],
        },
        { stripeAccount: stripeAccountId }
      );
    } catch (err) {
      lastErr = err;
    }
  }
  // Never fall back to every method enabled in Stripe: those would be charged at the card price.
  throw lastErr;
}
function pricedCustomerCheckoutFromMetadata(meta, method) {
  const feeBase = parseInt(meta.feeBaseCents, 10);
  const service = parseInt(meta.serviceAmountCents, 10);
  const base = Number.isFinite(feeBase) && feeBase > 0 ? feeBase : service;
  if (!Number.isFinite(base) || base <= 0) return null;
  const taxOutside = (meta.taxOutsideFeeBase || "") === "1";
  const tax = taxOutside ? Math.max(0, parseInt(meta.taxCents, 10) || 0) : 0;
  const priced = computeCardCheckoutAmounts(base, method);
  const totalCents = priced.totalCents + tax;
  const splitApplied = (meta.splitApplied || "") === "true";
  const studioShare = splitApplied ? Math.max(0, parseInt(meta.studioShareCents, 10) || 0) : 0;
  const platform = platformFeeCents(totalCents);
  const rate = checkoutRateForChannel(method);
  return {
    method: checkoutMethodId(method),
    rateLabel: rate.label,
    serviceCents: Number.isFinite(service) ? service : base,
    surchargeCents: priced.surchargeCents,
    taxCents: tax,
    totalCents,
    platformFeeCents: platform,
    applicationFeeCents: platform + studioShare,
  };
}
async function stripeAccountIdForCheckout(tenantId, tenantData, paymentIntentId) {
  const docId = (paymentIntentId || "").toString().trim();
  if (tenantId && docId) {
    const snap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("paymentCheckouts")
      .doc(docId)
      .get();
    if (snap.exists) {
      const id = ((snap.data() || {}).stripeAccountId || "").toString().trim();
      if (id) return id;
    }
  }
  return ((tenantData && tenantData.stripeAccountId) || "").toString().trim();
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
async function paidFeatureAccessForTenant(tenantId, providedTenant = null) {
  const normalizedTenantId = (tenantId || "").toString().trim();
  if (!normalizedTenantId) {
    return {
      paid: false,
      trialing: false,
      status: "",
      message: sms.PAID_FEATURE_UPGRADE_MESSAGE,
    };
  }

  let tenant = providedTenant;
  if (!tenant) {
    const tenantDoc = await db.collection("tenants").doc(normalizedTenantId).get();
    tenant = tenantDoc.exists ? tenantDoc.data() || {} : {};
  }

  const ownerUid = (tenant.ownerUid || "").toString().trim();
  let ownerUserData = null;
  if (ownerUid) {
    const ownerDoc = await db.collection("users").doc(ownerUid).get();
    ownerUserData = ownerDoc.exists ? ownerDoc.data() || {} : null;
  }

  const status = sms.resolveSubscriptionStatus(tenant, ownerUserData);
  return {
    paid: sms.tenantHasPaidSubscription(tenant, ownerUserData),
    trialing: sms.tenantIsTrialing(tenant, ownerUserData),
    status,
    message: sms.PAID_FEATURE_UPGRADE_MESSAGE,
  };
}
async function assertPaidFeatureAccessForTenant(tenantId, providedTenant = null) {
  const access = await paidFeatureAccessForTenant(tenantId, providedTenant);
  if (!access.paid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      sms.PAID_FEATURE_UPGRADE_MESSAGE
    );
  }
  return access;
}
async function assertPublicPaymentAccessForTenant(tenantId, providedTenant = null) {
  const access = await paidFeatureAccessForTenant(tenantId, providedTenant);
  if (!access.paid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Online payments are not available for this business right now."
    );
  }
  return access;
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

  const memberSettings = normalizeMemberSettings(userData.memberSettings);
  const payoutMode = memberSettings.payoutMode;
  // Every team member connects their own Stripe (shop split + takes own payments).
  const stripeAccountId = (userData.stripeAccountId || "").toString().trim() || null;
  const terminalLocationId =
    (userData.stripeTerminalLocationId || "").toString().trim() || null;
  // Owner can disable payments via memberSettings.canTakePayments === false.
  const paymentsAllowed = memberSettings.canTakePayments !== false;
  return {
    scope: "user",
    tenantId,
    stripeAccountId,
    terminalLocationId,
    canConnect: paymentsAllowed,
    canTakePayments: paymentsAllowed,
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
      "Connect your Stripe account in Payments to take payments."
    );
  }
  return ctx;
}
/**
 * Ensures a Connect account exists for Tap to Pay (creates Standard account if needed).
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
      "Connect your Stripe account in Payments to take payments."
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
    payoutMode: memberSettings.payoutMode,
    isOwner: false,
    attributedMemberUid,
    chargeOnBehalfOfMemberUid: attributedMemberUid,
    attributedMemberName: memberName,
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
      "Connect your Stripe account in Payments to take payments."
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
      "Connect your Stripe account in Payments to take payments."
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
      "Only the studio owner can manage payment settings."
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
 * Instant-eligible cents net of platform Instant pricing (0.3% markup).
 * Prefers expanded instant_available.net_available; falls back to gross amount.
 */
function instantAvailableCentsFromBalance(balance) {
  const instant = (balance.instant_available || []).find((b) => b.currency === "usd");
  const gross = Math.max(0, instant?.amount ?? 0);
  const netRows = Array.isArray(instant?.net_available) ? instant.net_available : [];
  if (!netRows.length) return gross;
  const netMax = Math.max(
    0,
    ...netRows.map((row) => Math.max(0, Number(row?.amount) || 0))
  );
  // Never advertise more Instant than Stripe's gross Instant bucket.
  return Math.min(gross, netMax);
}
/** PCI-safe payout destination label: bank/card name + last4 only. */
function formatExternalAccountLabel(account) {
  if (!account || typeof account !== "object") return null;
  const last4 = (account.last4 || "").toString().trim();
  if (!last4) return null;
  if (account.object === "bank_account") {
    const bank = (account.bank_name || "Bank").toString().trim() || "Bank";
    return `${bank} ····${last4}`;
  }
  if (account.object === "card") {
    const brand = (account.brand || "Debit").toString().trim() || "Debit";
    return `${brand} ····${last4}`;
  }
  return null;
}
function supportsInstantPayout(account) {
  return (
    Array.isArray(account?.available_payout_methods) &&
    account.available_payout_methods.includes("instant")
  );
}
/**
 * Default Standard destination + Instant-capable destination labels for Withdraw UI.
 */
async function loadPayoutDestinationLabels(stripe, stripeAccountId) {
  let banks = [];
  let cards = [];
  try {
    const bankRes = await stripe.accounts.listExternalAccounts(stripeAccountId, {
      object: "bank_account",
      limit: 10,
    });
    banks = bankRes.data || [];
  } catch (e) {
    console.warn("listExternalAccounts banks failed", e?.message || e);
  }
  try {
    const cardRes = await stripe.accounts.listExternalAccounts(stripeAccountId, {
      object: "card",
      limit: 10,
    });
    cards = cardRes.data || [];
  } catch (e) {
    console.warn("listExternalAccounts cards failed", e?.message || e);
  }

  const all = banks.concat(cards);
  const defaultBank =
    banks.find((b) => b.default_for_currency) || banks[0] || null;
  const defaultAny =
    defaultBank ||
    all.find((a) => a.default_for_currency) ||
    all[0] ||
    null;
  const instantDest =
    all.find((a) => supportsInstantPayout(a) && a.default_for_currency) ||
    all.find((a) => supportsInstantPayout(a)) ||
    null;

  return {
    standardPayoutDestinationLabel: formatExternalAccountLabel(defaultAny),
    instantPayoutDestinationLabel: formatExternalAccountLabel(instantDest),
    instantPayoutEligible: Boolean(instantDest),
  };
}
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
function paymentIntentIdFromExpandedBalanceSource(source) {
  if (!source) return null;
  if (typeof source === "string") {
    return source.startsWith("pi_") ? source : null;
  }
  if (source.object === "payment_intent" && source.id) return source.id;
  if (source.payment_intent) {
    return typeof source.payment_intent === "string"
      ? source.payment_intent
      : source.payment_intent.id || null;
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
  const paymentIntentId =
    paymentIntentIdFromExpandedBalanceSource(t.source) ||
    (sourceId && String(sourceId).startsWith("pi_") ? sourceId : null);
  let attributedMemberUid = null;
  let transferMetaPurpose = null;
  let description = t.description || null;
  let clientName = null;
  let serviceLabel = null;
  let serviceCents = null;
  let addonsLabel = null;
  let addonCents = null;
  const src = t.source;
  if (src && typeof src === "object") {
    const meta = src.metadata || {};
    if (meta.customerName) clientName = String(meta.customerName).trim() || null;
    if (meta.serviceLabel) serviceLabel = String(meta.serviceLabel).trim() || null;
    if (meta.serviceCents) serviceCents = parseInt(meta.serviceCents, 10) || null;
    if (meta.addonsLabel) addonsLabel = String(meta.addonsLabel).trim() || null;
    if (meta.addonCents) addonCents = parseInt(meta.addonCents, 10) || null;
    if (meta.attributedMemberUid) {
      attributedMemberUid = String(meta.attributedMemberUid).trim() || null;
    }
    if (meta.purpose) transferMetaPurpose = String(meta.purpose).trim();
    if (!description && src.description) {
      description = String(src.description);
    }
  }
  // Always resolve platform Transfer metadata for incoming tr_ sources (owner credits).
  if (sourceId && String(sourceId).startsWith("tr_")) {
    try {
      const transfer = await stripe.transfers.retrieve(sourceId);
      const meta = (transfer && transfer.metadata) || {};
      if (!attributedMemberUid && meta.attributedMemberUid) {
        attributedMemberUid = String(meta.attributedMemberUid).trim() || null;
      }
      if (!transferMetaPurpose && meta.purpose) {
        transferMetaPurpose = String(meta.purpose).trim();
      }
      if (
        !transferMetaPurpose &&
        (transfer.description || "").toLowerCase().includes("studio share")
      ) {
        transferMetaPurpose = "studio_payment_split";
      }
      if (!description && transfer.description) {
        description = String(transfer.description);
      }
      if (transferMetaPurpose === "studio_payment_split" || meta.purpose === "studio_payment_split") {
        description = "Studio share";
        transferMetaPurpose = "studio_payment_split";
      }
    } catch (err) {
      console.warn("enrichConnectBalanceTransaction transfer lookup", err.message);
    }
  }
  return teamPaymentSplit.labelStudioShareBalanceTransaction({
    id: t.id,
    type: t.type || "unknown",
    amount: t.amount ?? 0,
    fee: t.fee ?? 0,
    net,
    isCredit: net > 0,
    created: t.created ?? 0,
    description,
    clientName,
    serviceLabel,
    serviceCents,
    addonsLabel,
    addonCents,
    reportingCategory: t.reporting_category || null,
    sourceId,
    chargeId,
    paymentIntentId,
    attributedMemberUid,
    purpose: transferMetaPurpose || undefined,
  });
}
function firestoreTimestampToSeconds(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value.toMillis === "function") {
    return Math.floor(value.toMillis() / 1000);
  }
  if (typeof value._seconds === "number") return value._seconds;
  if (typeof value.seconds === "number") return value.seconds;
  return 0;
}
function cancelRefundStatusBlocksManualRefund(status, cancelRefundError) {
  const s = (status || "").toString().trim().toLowerCase();
  if (s === "pending" || s === "refunded" || s === "already_refunded") return s;
  if (s === "failed" && isUnsettledRefundError({ message: cancelRefundError })) {
    return "pending";
  }
  return null;
}
function cancelRefundBlockMessage(blockStatus) {
  if (blockStatus === "pending") {
    return "A refund is already pending for this cancelled booking.";
  }
  return "A refund has been issued for this payment.";
}
function collectCancelRefundMatchIds(rows) {
  const chargeIds = new Set();
  const piIds = new Set();
  for (const row of rows || []) {
    const ch = (row.chargeId || "").toString().trim();
    const pi = (row.paymentIntentId || "").toString().trim();
    const sid = (row.sourceId || "").toString().trim();
    if (ch.startsWith("ch_")) chargeIds.add(ch);
    if (pi.startsWith("pi_")) piIds.add(pi);
    if (sid.startsWith("pi_")) piIds.add(sid);
    if (sid.startsWith("ch_")) chargeIds.add(sid);
  }
  return { chargeIds, piIds };
}
function transactionMatchesCancelRefundIds(t, ids) {
  if (!t || !ids) return false;
  const ch = (t.chargeId || "").toString();
  const sid = (t.sourceId || "").toString();
  const pi = (t.paymentIntentId || "").toString();
  return (
    (ch && ids.chargeIds.has(ch)) ||
    (sid && (ids.chargeIds.has(sid) || ids.piIds.has(sid))) ||
    (pi && ids.piIds.has(pi))
  );
}
async function loadCancelRefundBlockForCharge(db, tenantId, { chargeId, paymentIntentId }) {
  if (!tenantId) return null;
  const col = db.collection("tenants").doc(tenantId).collection("bookingRequests");
  const docs = [];
  const seen = new Set();
  async function addQuery(field, value) {
    const v = (value || "").toString().trim();
    if (!v) return;
    const snap = await col.where(field, "==", v).limit(8).get();
    for (const doc of snap.docs) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  await addQuery("stripeChargeId", chargeId);
  await addQuery("stripePaymentIntentId", paymentIntentId);
  for (const doc of docs) {
    const d = doc.data() || {};
    const blocked = cancelRefundStatusBlocksManualRefund(
      d.cancelRefundStatus,
      d.cancelRefundError
    );
    if (blocked) {
      return { status: blocked, message: cancelRefundBlockMessage(blocked) };
    }
  }
  return null;
}
function stripeHasRefundForPendingRow(transactions, pendingRow) {
  const ch = (pendingRow.chargeId || "").toString();
  const pi = (pendingRow.paymentIntentId || "").toString();
  return (transactions || []).some((t) => {
    if ((t.type || "") !== "refund") return false;
    const tCh = (t.chargeId || "").toString();
    const tSid = (t.sourceId || "").toString();
    const tPi = (t.paymentIntentId || "").toString();
    if (ch && (tCh === ch || tSid === ch)) return true;
    if (pi && (tSid === pi || tPi === pi)) return true;
    return false;
  });
}
function applyCancelRefundBlocksToTransactions(transactions, { pendingRows, issuedRows }) {
  const pendingIds = collectCancelRefundMatchIds(pendingRows);
  const issuedIds = collectCancelRefundMatchIds(issuedRows);
  for (const t of transactions || []) {
    const isSyntheticPending = String(t.id || "").startsWith("pending_cancel_refund_");
    if (isSyntheticPending) {
      t.refundBlocked = true;
      t.refundBlockedReason = "This refund is already queued.";
      continue;
    }
    if (transactionMatchesCancelRefundIds(t, pendingIds)) {
      t.refundBlocked = true;
      t.refundBlockedReason = cancelRefundBlockMessage("pending");
      continue;
    }
    if (transactionMatchesCancelRefundIds(t, issuedIds)) {
      t.refundBlocked = true;
      t.refundBlockedReason = cancelRefundBlockMessage("refunded");
    }
  }
}
async function loadCancelRefundBookingRows(db, tenantId, status) {
  if (!tenantId || !status) return [];
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .where("cancelRefundStatus", "==", status)
    .limit(40)
    .get();
  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const bookingStatus = (d.status || "").toString().trim().toLowerCase();
    if (bookingStatus !== "cancelled" && bookingStatus !== "canceled") continue;
    const chargeId = (d.stripeChargeId || "").toString().trim();
    const paymentIntentId = (d.stripePaymentIntentId || "").toString().trim();
    if (!chargeId.startsWith("ch_") && !paymentIntentId.startsWith("pi_")) continue;
    rows.push({
      id: doc.id,
      chargeId: chargeId.startsWith("ch_") ? chargeId : null,
      paymentIntentId: paymentIntentId.startsWith("pi_") ? paymentIntentId : null,
      sourceId: paymentIntentId.startsWith("pi_")
        ? paymentIntentId
        : chargeId.startsWith("ch_")
          ? chargeId
          : null,
    });
  }
  return rows;
}
async function pendingCancelRefundTransactionRows(db, tenantId) {
  if (!tenantId) return [];
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .where("cancelRefundStatus", "==", "pending")
    .limit(40)
    .get();
  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const bookingStatus = (d.status || "").toString().trim().toLowerCase();
    if (bookingStatus !== "cancelled" && bookingStatus !== "canceled") continue;
    const paidCents = Math.max(
      0,
      Math.round(Number(d.paidCents) || Number(d.refundCents) || 0)
    );
    if (paidCents <= 0) continue;
    const chargeId = (d.stripeChargeId || "").toString().trim();
    const paymentIntentId = (d.stripePaymentIntentId || "").toString().trim();
    const customerName = (d.customerName || "").toString().trim();
    const created =
      firestoreTimestampToSeconds(
        d.cancelRefundQueuedAt || d.cancelledAt || d.updatedAt || d.createdAt
      ) || Math.floor(Date.now() / 1000);
    rows.push({
      id: `pending_cancel_refund_${doc.id}`,
      type: "refund",
      amount: paidCents,
      fee: 0,
      net: -paidCents,
      isCredit: false,
      created,
      description: customerName || "Refund",
      reportingCategory: "refund",
      status: "pending",
      chargeId: chargeId.startsWith("ch_") ? chargeId : null,
      sourceId: paymentIntentId.startsWith("pi_")
        ? paymentIntentId
        : chargeId.startsWith("ch_")
          ? chargeId
          : null,
      paymentIntentId: paymentIntentId.startsWith("pi_") ? paymentIntentId : null,
      refundBlocked: true,
      refundBlockedReason: "This refund is already queued.",
    });
  }
  return rows;
}
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
  taxCents = 0,
}) {
  const service = Math.max(0, Math.round(Number(serviceCents) || 0));
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  const gross = Math.max(
    service + tax,
    Math.round(Number(grossCents) || 0)
  );
  const surcharge = Math.max(
    0,
    Math.round(Number(surchargeCents) || 0) || Math.max(0, gross - service - tax)
  );
  const items = [
    {
      name: receiptServiceLabel(paymentKind),
      quantity: 1,
      amountCents: service,
    },
  ];
  if (tax > 0) {
    items.push({
      name: "Sales tax",
      quantity: 1,
      amountCents: tax,
    });
  }
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
 * Refund remaining captured amount on a Connect charge.
 * Returns { alreadyRefunded, refundCents, remainingRefundableCents, refundId }.
 */
async function refundConnectCharge({
  stripe,
  stripeAccountId,
  tenantId,
  chargeId,
  amountCents,
  reason,
  idempotencyKey,
  queueIfUnsettled = false,
}) {
  let charge;
  try {
    charge = await stripe.charges.retrieve(chargeId, {
      stripeAccount: stripeAccountId,
    });
  } catch (err) {
    const msg =
      (err && err.message) || "Could not load this payment. Try again.";
    console.error("refundConnectCharge retrieve charge", err);
    throw new functions.https.HttpsError("failed-precondition", msg);
  }
  const capturedCents =
    typeof charge.amount_captured === "number" && charge.amount_captured > 0
      ? charge.amount_captured
      : charge.amount || 0;
  const remainingCents = Math.max(
    0,
    capturedCents - (charge.amount_refunded || 0)
  );
  const refundCents =
    amountCents !== null && amountCents > 0 ? amountCents : remainingCents;
  if (refundCents <= 0) {
    return {
      alreadyRefunded: true,
      refundCents: 0,
      remainingRefundableCents: 0,
      refundId: null,
    };
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
    const msg =
      `Not enough available funds to refund ${fmt(refundCents)}. ` +
      `You have ${fmt(availableCents)} available. Funds from recent payments ` +
      `become available after they finish settling (usually about 2 business days). ` +
      `Try again then, or refund a smaller amount.`;
    if (queueIfUnsettled) {
      return {
        alreadyRefunded: false,
        pendingSettlement: true,
        refundCents,
        remainingRefundableCents: remainingCents,
        refundId: null,
      };
    }
    throw new functions.https.HttpsError("failed-precondition", msg);
  }

  const params = {
    charge: chargeId,
    reason: reason || "requested_by_customer",
    refund_application_fee: true,
    amount: refundCents,
  };
  let refund;
  try {
    refund = await stripe.refunds.create(params, {
      stripeAccount: stripeAccountId,
      idempotencyKey: (idempotencyKey || "").toString().slice(0, 255) || undefined,
    });
  } catch (err) {
    const msg =
      (err && err.message) ||
      "Refund failed. Check available balance and try again.";
    if (queueIfUnsettled && isUnsettledRefundError(err)) {
      return {
        alreadyRefunded: false,
        pendingSettlement: true,
        refundCents,
        remainingRefundableCents: remainingCents,
        refundId: null,
      };
    }
    console.error("refundConnectCharge", err);
    throw new functions.https.HttpsError("failed-precondition", msg);
  }

  try {
    const piId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent && charge.payment_intent.id;
    if (tenantId && refund && refund.id) {
      let amountRefundedCents = Math.min(
        capturedCents,
        (charge.amount_refunded || 0) + refundCents
      );
      try {
        const fresh = await stripe.charges.retrieve(
          chargeId,
          {},
          { stripeAccount: stripeAccountId }
        );
        amountRefundedCents = Math.max(0, fresh.amount_refunded || 0);
      } catch (_) {
        /* use estimate */
      }
      const ledgerOut = await recordConnectRefundOnLedger(stripe, db, {
        tenantId,
        paymentIntentId: piId || null,
        chargeId,
        refundId: refund.id,
        refundCents,
        chargeCapturedCents: capturedCents,
        amountRefundedCents,
        refundStatus: (refund.status || "succeeded").toString(),
        runStudioReverse: true,
        stripeAccountId,
        source: "createRefund",
      });
      if (!ledgerOut.duplicate) {
        await syncShopOrderRefundFromConnectPayment(stripe, db, {
          tenantId,
          paymentIntentId: piId || "",
          stripeAccountId,
          amountRefundedCents,
          capturedCents,
          fullyRefunded: capturedCents > 0 && amountRefundedCents >= capturedCents,
          refundId: refund.id,
          shopOrderIdHint: ledgerOut.shopOrderId || "",
        });
      }
    }
  } catch (revErr) {
    console.error("refundConnectCharge ledger/refund sync", revErr.message || revErr);
  }

  return {
    alreadyRefunded: false,
    refundCents,
    remainingRefundableCents: Math.max(0, remainingCents - refundCents),
    refundId: refund && refund.id,
  };
}
function isUnsettledRefundError(err) {
  const code = ((err && (err.code || err.decline_code)) || "").toString().toLowerCase();
  if (code === "balance_insufficient") return true;
  const msg = ((err && err.message) || String(err || "")).toLowerCase();
  return (
    msg.includes("not enough available funds") ||
    msg.includes("insufficient funds") ||
    (msg.includes("available") && msg.includes("settling"))
  );
}
function stripeObjectId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value && value.id) return value.id.toString().trim();
  return "";
}
function feeBasisFromLedger(ledgerData, captured, totalRefunded) {
  const disputeLost = Math.max(
    0,
    Math.round(Number(ledgerData && ledgerData.disputeLostCents) || 0)
  );
  const refunded = Math.max(0, Math.round(Number(totalRefunded) || 0));
  const basis = refunded + disputeLost;
  const cap = Math.max(0, Math.round(Number(captured) || 0));
  if (cap > 0) return Math.min(cap, basis);
  return basis;
}
/**
 * Return the application fee (1% + studio share included in that fee) to the
 * Connect account that was charged. The slice brings Stripe's refunded fee up
 * to the cumulative covered charge, so a second webhook for the same refund
 * returns nothing more. createRefund still sets refund_application_fee itself.
 */
async function refundConnectApplicationFeeIfNeeded(
  stripe,
  {
    stripeAccountId,
    chargeId,
    refundId,
    refundCents,
    chargeCapturedCents,
    feeBasisCents,
  }
) {
  const acct = (stripeAccountId || "").toString().trim();
  const chId = (chargeId || "").toString().trim();
  const rid = (refundId || "").toString().trim();
  const thisRefund = Math.max(0, Math.round(Number(refundCents) || 0));
  if (!acct || !chId || !rid || thisRefund <= 0) {
    return { refunded: false, reason: "missing" };
  }
  let charge;
  try {
    charge = await stripe.charges.retrieve(chId, {}, { stripeAccount: acct });
  } catch (err) {
    console.error("refundConnectApplicationFee retrieve charge", err.message || err);
    return { refunded: false, reason: "charge_lookup_failed", error: err.message };
  }
  const feeId = stripeObjectId(charge.application_fee);
  if (!feeId) return { refunded: false, reason: "no_application_fee" };
  let fee;
  try {
    fee = await stripe.applicationFees.retrieve(feeId);
  } catch (err) {
    console.error("refundConnectApplicationFee retrieve fee", err.message || err);
    return { refunded: false, reason: "fee_lookup_failed", error: err.message };
  }
  const feeAmount = Math.max(0, Math.round(Number(fee.amount) || 0));
  const already = Math.max(0, Math.round(Number(fee.amount_refunded) || 0));
  const remaining = Math.max(0, feeAmount - already);
  if (remaining <= 0 || feeAmount <= 0) {
    return { refunded: false, reason: "already_refunded" };
  }
  const captured = Math.max(
    1,
    Math.round(Number(chargeCapturedCents) || 0) ||
      Math.round(Number(charge.amount_captured) || Number(charge.amount) || 0) ||
      1
  );
  const basis = Math.max(
    thisRefund,
    Math.round(Number(feeBasisCents) || 0) || thisRefund
  );
  const slice = teamPaymentSplit.applicationFeeRefundSliceCents({
    feeAmountCents: feeAmount,
    alreadyRefundedCents: already,
    capturedCents: captured,
    basisCents: basis,
  });
  if (slice <= 0) return { refunded: false, reason: "already_refunded" };
  try {
    const feeRefund = await stripe.applicationFees.createRefund(
      feeId,
      { amount: slice },
      {
        idempotencyKey: `app-fee-refund-${rid}-${slice}`.slice(0, 255),
      }
    );
    return {
      refunded: true,
      amountCents: slice,
      applicationFeeRefundId: feeRefund.id,
    };
  } catch (err) {
    const msg = (err && err.message) || "application_fee_refund_failed";
    if (/already been refunded|greater than unrefunded/i.test(msg)) {
      return { refunded: false, reason: "already_refunded" };
    }
    console.error("refundConnectApplicationFee", feeId, msg);
    return { refunded: false, reason: "stripe_error", error: msg };
  }
}
/**
 * Idempotent refund row on paymentLedger + studio-share reversal.
 * Used by createRefund and Connect refund webhooks (refund.updated, charge.refunded).
 * A duplicate refund id still retries a failed studio-share reversal and any
 * application fee Stripe has not already returned.
 */
async function recordConnectRefundOnLedger(
  stripe,
  db,
  {
    tenantId,
    paymentIntentId,
    chargeId,
    refundId,
    refundCents,
    chargeCapturedCents,
    amountRefundedCents,
    refundStatus,
    runStudioReverse = true,
    stripeAccountId = "",
    source = "webhook",
  }
) {
  const tid = (tenantId || "").toString().trim();
  const piId = (paymentIntentId || "").toString().trim();
  const rid = (refundId || "").toString().trim();
  const status = (refundStatus || "succeeded").toString().trim().toLowerCase();
  const thisRefundCents = Math.max(0, Math.round(Number(refundCents) || 0));
  if (!tid || !piId || !rid) {
    return { recorded: false, reason: "missing_ids" };
  }

  const ledgerRef = db
    .collection("tenants")
    .doc(tid)
    .collection("paymentLedger")
    .doc(piId);
  const ledgerSnap = await ledgerRef.get();
  if (!ledgerSnap.exists) {
    return { recorded: false, reason: "no_ledger" };
  }
  const ledgerData = ledgerSnap.data() || {};
  const processed = Array.isArray(ledgerData.refundEvents)
    ? ledgerData.refundEvents
    : [];
  if (processed.some((r) => (r && r.refundId) === rid)) {
    let studioReverse = { reversed: false, reason: "skipped" };
    let applicationFeeRefund = { refunded: false, reason: "skipped" };
    if (status === "succeeded" && thisRefundCents > 0 && source !== "createRefund") {
      const dupCaptured =
        Math.round(Number(chargeCapturedCents) || 0) ||
        Math.round(Number(ledgerData.grossCents) || 0);
      const dupRefunded = Math.max(
        thisRefundCents,
        Math.round(Number(amountRefundedCents) || 0),
        Math.round(Number(ledgerData.amountRefundedCents) || 0)
      );
      applicationFeeRefund = await refundConnectApplicationFeeIfNeeded(stripe, {
        stripeAccountId,
        chargeId: (chargeId || ledgerData.chargeId || "").toString(),
        refundId: rid,
        refundCents: thisRefundCents,
        chargeCapturedCents: dupCaptured,
        feeBasisCents: feeBasisFromLedger(ledgerData, dupCaptured, dupRefunded),
      });
      if (runStudioReverse) {
        try {
          studioReverse = await teamPaymentSplit.reverseStudioShareOnRefund(stripe, {
            db,
            tenantId: tid,
            chargeId: (chargeId || ledgerData.chargeId || "").toString() || null,
            paymentIntentId: piId,
            refundCents: thisRefundCents,
            chargeCapturedCents:
              Math.round(Number(chargeCapturedCents) || 0) ||
              Math.round(Number(ledgerData.grossCents) || 0) ||
              thisRefundCents,
            refundId: rid,
          });
        } catch (err) {
          console.error("recordConnectRefundOnLedger studio reverse retry", rid, err.message);
          studioReverse = { reversed: false, reason: "error", error: err.message };
        }
      }
    }
    return {
      recorded: false,
      duplicate: true,
      reason: "duplicate_refund_id",
      studioReverse,
      applicationFeeRefund,
      paymentKind: (ledgerData.paymentKind || "").toString(),
      shopOrderId: (ledgerData.shopOrderId || "").toString().trim(),
    };
  }

  const captured = Math.max(
    0,
    Math.round(Number(chargeCapturedCents) || 0) ||
      Math.round(Number(ledgerData.grossCents) || 0)
  );
  let totalRefunded = Math.max(
    0,
    Math.round(Number(amountRefundedCents) || 0)
  );
  if (totalRefunded <= 0 && status === "succeeded") {
    totalRefunded = Math.max(
      0,
      Math.round(Number(ledgerData.amountRefundedCents) || 0) + thisRefundCents
    );
  }
  const fullyRefunded = captured > 0 && totalRefunded >= captured;

  const refundEvent = {
    refundId: rid,
    amountCents: thisRefundCents,
    status,
    source: (source || "webhook").toString().slice(0, 40),
  };

  const patch = {
    chargeId: (ledgerData.chargeId || chargeId || "").toString() || null,
    amountRefundedCents: totalRefunded,
    fullyRefunded,
    lastRefundId: rid,
    lastRefundStatus: status,
    refundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    refundEvents: admin.firestore.FieldValue.arrayUnion(refundEvent),
  };
  if (status === "failed" || status === "canceled") {
    patch.lastRefundError = status;
  } else {
    patch.lastRefundError = admin.firestore.FieldValue.delete();
  }
  await ledgerRef.set(patch, { merge: true });

  let applicationFeeRefund = { refunded: false, reason: "skipped" };
  let studioReverse = { reversed: false, reason: "skipped" };
  if (
    status === "succeeded" &&
    thisRefundCents > 0 &&
    source !== "createRefund"
  ) {
    applicationFeeRefund = await refundConnectApplicationFeeIfNeeded(stripe, {
      stripeAccountId,
      chargeId: (chargeId || ledgerData.chargeId || "").toString(),
      refundId: rid,
      refundCents: thisRefundCents,
      chargeCapturedCents: captured || thisRefundCents,
      feeBasisCents: feeBasisFromLedger(
        ledgerData,
        captured || thisRefundCents,
        totalRefunded
      ),
    });
  }
  if (runStudioReverse && status === "succeeded" && thisRefundCents > 0) {
    try {
      studioReverse = await teamPaymentSplit.reverseStudioShareOnRefund(stripe, {
        db,
        tenantId: tid,
        chargeId: (chargeId || ledgerData.chargeId || "").toString() || null,
        paymentIntentId: piId,
        refundCents: thisRefundCents,
        chargeCapturedCents: captured || thisRefundCents,
        refundId: rid,
      });
    } catch (err) {
      console.error("recordConnectRefundOnLedger studio reverse", rid, err.message);
      studioReverse = { reversed: false, reason: "error", error: err.message };
    }
  }

  try {
    await syncBookingCancelRefundFromWebhook(db, tid, piId, {
      amountRefundedCents: totalRefunded,
      capturedCents: captured,
      fullyRefunded,
    });
  } catch (err) {
    console.error("recordConnectRefundOnLedger booking sync", piId, err.message);
  }

  return {
    recorded: true,
    duplicate: false,
    amountRefundedCents: totalRefunded,
    fullyRefunded,
    studioReverse,
    applicationFeeRefund,
    paymentKind: (ledgerData.paymentKind || "").toString(),
    shopOrderId: (ledgerData.shopOrderId || "").toString().trim(),
  };
}
/**
 * Mark shopOrders paid/fulfilled rows refunded when Stripe confirms a Connect refund.
 */
async function syncShopOrderRefundFromConnectPayment(
  stripe,
  db,
  {
    tenantId,
    paymentIntentId,
    stripeAccountId,
    amountRefundedCents,
    capturedCents,
    fullyRefunded,
    refundId,
    shopOrderIdHint = "",
  }
) {
  const tid = (tenantId || "").toString().trim();
  const piId = (paymentIntentId || "").toString().trim();
  const acct = (stripeAccountId || "").toString().trim();
  if (!tid || !piId || !acct.startsWith("acct_")) {
    return { updated: false, reason: "missing_context" };
  }

  let shopOrderId = (shopOrderIdHint || "").toString().trim();
  let paymentKind = "";
  let captured = Math.max(0, Math.round(Number(capturedCents) || 0));
  try {
    const pi = await stripe.paymentIntents.retrieve(
      piId,
      {},
      { stripeAccount: acct }
    );
    const meta = pi.metadata || {};
    paymentKind = (meta.paymentKind || "").toString().trim().toLowerCase();
    if (!shopOrderId) shopOrderId = (meta.shopOrderId || "").toString().trim();
    if (captured <= 0) captured = Math.max(0, Math.round(Number(pi.amount) || 0));
  } catch (err) {
    console.warn("syncShopOrderRefund pi", piId, err.message || err);
  }

  if (!shopOrderId) {
    const q = await db
      .collection("tenants")
      .doc(tid)
      .collection("shopOrders")
      .where("stripePaymentIntentId", "==", piId)
      .limit(1)
      .get();
    if (q.empty) return { updated: false, reason: "not_shop" };
    shopOrderId = q.docs[0].id;
  } else if (paymentKind && paymentKind !== "shop" && !shopOrderIdHint) {
    return { updated: false, reason: "not_shop" };
  }

  if (!shopOrderId) return { updated: false, reason: "no_order_id" };

  const orderRef = db.collection("tenants").doc(tid).collection("shopOrders").doc(shopOrderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { updated: false, reason: "no_order" };
  const order = orderSnap.data() || {};
  const st = (order.status || "").toString().trim().toLowerCase();
  if (st === "pending_payment" || st === "cancelled") {
    return { updated: false, reason: "order_not_refundable_state" };
  }

  const refunded = Math.max(
    0,
    Math.round(Number(amountRefundedCents) || 0)
  );
  if (refunded <= 0) return { updated: false, reason: "zero_refund" };

  const orderTotal = Math.max(
    0,
    Math.round(Number(order.totalCents) || 0) || captured
  );
  const cap = captured > 0 ? captured : orderTotal;
  const isFull = !!fullyRefunded || (cap > 0 && refunded >= cap);

  const patch = {
    amountRefundedCents: refunded,
    lastRefundId: (refundId || "").toString().trim() || null,
    refundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (isFull) {
    patch.status = "refunded";
    patch.refundedAt = admin.firestore.FieldValue.serverTimestamp();
  } else {
    patch.status = "partially_refunded";
  }

  await orderRef.set(patch, { merge: true });
  console.log(
    "syncShopOrderRefund",
    JSON.stringify({ tenantId: tid, shopOrderId, piId, status: patch.status, refunded })
  );
  return { updated: true, shopOrderId, status: patch.status };
}
/**
 * Sync booking refund state when Stripe confirms a Connect refund (cancel queue or Dashboard).
 */
async function syncBookingCancelRefundFromWebhook(
  db,
  tenantId,
  paymentIntentId,
  { amountRefundedCents, capturedCents, fullyRefunded }
) {
  const piId = (paymentIntentId || "").toString().trim();
  if (!piId || !tenantId) return;
  const snap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .where("stripePaymentIntentId", "==", piId)
    .limit(8)
    .get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const cancelStatus = (d.cancelRefundStatus || "").toString().trim().toLowerCase();
    const refundCents = Math.max(0, Math.round(Number(amountRefundedCents) || 0));
    if (refundCents <= 0) continue;

    const paidCents = Math.max(0, Math.round(Number(d.paidCents) || 0));
    const cap = Math.max(
      0,
      Math.round(Number(capturedCents) || 0) || paidCents
    );
    const isFull =
      !!fullyRefunded || (cap > 0 && refundCents >= cap);

    if (["pending", "failed"].includes(cancelStatus)) {
      if (
        cancelStatus === "failed" &&
        !isUnsettledRefundError({ message: d.cancelRefundError })
      ) {
        continue;
      }
      const patch = { refundCents };
      if (isFull) {
        patch.cancelRefundStatus = "refunded";
        patch.refundedAt = admin.firestore.FieldValue.serverTimestamp();
        patch.cancelRefundError = admin.firestore.FieldValue.delete();
      } else if (cancelStatus === "pending") {
        patch.cancelRefundStatus = "pending";
      }
      await doc.ref.set(patch, { merge: true });
      continue;
    }

    if (cancelStatus === "refunded" || cancelStatus === "already_refunded") {
      continue;
    }

    const hasPaid =
      paidCents > 0 ||
      (d.stripePaymentIntentId || "").toString().trim() === piId;
    if (!hasPaid) continue;

    const patch = {
      refundCents,
      stripeRefundSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (isFull) {
      patch.cancelRefundStatus = "refunded";
      patch.refundedAt = admin.firestore.FieldValue.serverTimestamp();
      patch.cancelRefundError = admin.firestore.FieldValue.delete();
    } else {
      patch.cancelRefundStatus = "partially_refunded";
    }
    await doc.ref.set(patch, { merge: true });
  }
}
async function handleConnectRefundWebhook(stripe, db, event) {
  const stripeAccountId = (event.account || "").toString().trim();
  if (!stripeAccountId.startsWith("acct_")) {
    return { skipped: true, reason: "not_connect_event" };
  }

  if (event.type === "refund.updated") {
    const refund = event.data.object || {};
    const status = (refund.status || "").toString().trim().toLowerCase();
    const refundId = stripeObjectId(refund.id);
    const refundCents = Math.max(0, Math.round(Number(refund.amount) || 0));
    const piId = stripeObjectId(refund.payment_intent);
    let chargeId = stripeObjectId(refund.charge);

    console.log(
      "stripeSubscriptionWebhook refund",
      JSON.stringify({
        refundId,
        status,
        piId,
        chargeId,
        refundCents,
        account: stripeAccountId,
      })
    );

    if (status === "pending" || status === "requires_action") {
      return { skipped: true, reason: "pending" };
    }

    let tenantId = "";
    let capturedCents = 0;
    let amountRefundedCents = 0;
    try {
      if (piId) {
        const pi = await stripe.paymentIntents.retrieve(
          piId,
          { expand: ["latest_charge"] },
          { stripeAccount: stripeAccountId }
        );
        tenantId = ((pi.metadata && pi.metadata.tenantId) || "").toString().trim();
        const latest = pi.latest_charge;
        if (latest && typeof latest === "object") {
          capturedCents = latest.amount_captured || latest.amount || 0;
          amountRefundedCents = latest.amount_refunded || 0;
          if (!chargeId && latest.id) chargeId = latest.id;
        }
      }
      if (chargeId) {
        const ch = await stripe.charges.retrieve(
          chargeId,
          {},
          { stripeAccount: stripeAccountId }
        );
        capturedCents = capturedCents || ch.amount_captured || ch.amount || 0;
        amountRefundedCents = Math.max(
          amountRefundedCents,
          ch.amount_refunded || 0
        );
        if (!tenantId && ch.metadata && ch.metadata.tenantId) {
          tenantId = ch.metadata.tenantId.toString().trim();
        }
      }
    } catch (err) {
      console.error("stripeSubscriptionWebhook refund resolve", err.message || err);
      throw err;
    }

    if (!tenantId || !piId) {
      console.warn(
        "stripeSubscriptionWebhook refund missing tenantId or pi",
        JSON.stringify({ refundId, piId, tenantId })
      );
      return { skipped: true, reason: "missing_tenant_or_pi" };
    }

    if (status === "failed" || status === "canceled") {
      const ledgerRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("paymentLedger")
        .doc(piId);
      await ledgerRef.set(
        {
          lastRefundId: refundId,
          lastRefundStatus: status,
          lastRefundError: (refund.failure_reason || status)
            .toString()
            .slice(0, 200),
          refundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { ok: false, status };
    }

    if (status !== "succeeded") {
      return { skipped: true, reason: status || "unknown_status" };
    }

    const out = await recordConnectRefundOnLedger(stripe, db, {
      tenantId,
      paymentIntentId: piId,
      chargeId,
      refundId,
      refundCents,
      chargeCapturedCents: capturedCents,
      amountRefundedCents,
      refundStatus: status,
      runStudioReverse: true,
      stripeAccountId,
      source: "webhook",
    });

    if (!out.duplicate) {
      const full =
        out.fullyRefunded ??
        (capturedCents > 0 && amountRefundedCents >= capturedCents);
      try {
        await syncShopOrderRefundFromConnectPayment(stripe, db, {
          tenantId,
          paymentIntentId: piId,
          stripeAccountId,
          amountRefundedCents: out.amountRefundedCents ?? amountRefundedCents,
          capturedCents,
          fullyRefunded: full,
          refundId,
          shopOrderIdHint: out.shopOrderId || "",
        });
      } catch (shopErr) {
        console.error("stripeSubscriptionWebhook refund shop sync", shopErr.message || shopErr);
      }
    }

    console.log(
      "stripeSubscriptionWebhook refund ledger",
      JSON.stringify({
        piId,
        tenantId,
        refundId,
        duplicate: !!out.duplicate,
        amountRefundedCents: out.amountRefundedCents,
        fullyRefunded: out.fullyRefunded,
        studioReverse: out.studioReverse,
        applicationFeeRefund: out.applicationFeeRefund,
      })
    );
    return out;
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object || {};
    const chId = stripeObjectId(charge.id);
    const piId = stripeObjectId(charge.payment_intent);
    const amountRefundedCents = Math.max(
      0,
      Math.round(Number(charge.amount_refunded) || 0)
    );
    if (!piId || amountRefundedCents <= 0) {
      return { skipped: true, reason: "no_pi_or_refund" };
    }

    let tenantId = ((charge.metadata && charge.metadata.tenantId) || "")
      .toString()
      .trim();
    if (!tenantId && piId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          piId,
          {},
          { stripeAccount: stripeAccountId }
        );
        tenantId = ((pi.metadata && pi.metadata.tenantId) || "").toString().trim();
      } catch (err) {
        console.warn("stripeSubscriptionWebhook charge.refunded pi", err.message);
      }
    }
    if (!tenantId) {
      return { skipped: true, reason: "missing_tenant" };
    }

    const ledgerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("paymentLedger")
      .doc(piId);
    const snap = await ledgerRef.get();
    if (!snap.exists) {
      return { skipped: true, reason: "no_ledger" };
    }
    const captured = Math.max(
      0,
      Math.round(Number(charge.amount_captured) || Number(charge.amount) || 0)
    );
    const fullyRefunded = captured > 0 && amountRefundedCents >= captured;
    let refunds = [];
    if (chId) {
      try {
        const listed = await stripe.refunds.list(
          { charge: chId, limit: 100 },
          { stripeAccount: stripeAccountId }
        );
        refunds = (listed && listed.data) || [];
      } catch (err) {
        console.error("stripeSubscriptionWebhook charge.refunded list", err.message || err);
      }
    }
    const settled = [];
    for (const refund of refunds) {
      const refundStatus = (refund.status || "").toString().trim().toLowerCase();
      if (refundStatus !== "succeeded") continue;
      const refundId = stripeObjectId(refund.id);
      const refundCents = Math.max(0, Math.round(Number(refund.amount) || 0));
      if (!refundId || refundCents <= 0) continue;
      try {
        const out = await recordConnectRefundOnLedger(stripe, db, {
          tenantId,
          paymentIntentId: piId,
          chargeId: chId,
          refundId,
          refundCents,
          chargeCapturedCents: captured,
          amountRefundedCents,
          refundStatus,
          runStudioReverse: true,
          stripeAccountId,
          source: "charge.refunded",
        });
        settled.push({
          refundId,
          duplicate: !!out.duplicate,
          studioReverse: out.studioReverse,
          applicationFeeRefund: out.applicationFeeRefund,
        });
      } catch (err) {
        console.error(
          "stripeSubscriptionWebhook charge.refunded settle",
          refundId,
          err.message || err
        );
      }
    }
    if (!settled.length) {
      const ledgerRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("paymentLedger")
        .doc(piId);
      const snap = await ledgerRef.get();
      if (!snap.exists) {
        return { skipped: true, reason: "no_ledger" };
      }
      await ledgerRef.set(
        {
          chargeId: chId || null,
          amountRefundedCents,
          fullyRefunded,
          refundUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    try {
      await syncShopOrderRefundFromConnectPayment(stripe, db, {
        tenantId,
        paymentIntentId: piId,
        stripeAccountId,
        amountRefundedCents,
        capturedCents: captured,
        fullyRefunded,
        refundId: (settled[0] && settled[0].refundId) || "",
      });
    } catch (shopErr) {
      console.error("stripeSubscriptionWebhook charge.refunded shop", shopErr.message || shopErr);
    }
    console.log(
      "stripeSubscriptionWebhook charge.refunded sync",
      JSON.stringify({ piId, tenantId, amountRefundedCents, settled: settled.length })
    );
    return { ok: true, amountRefundedCents, settled };
  }

  return { skipped: true, reason: "unhandled_type" };
}
async function connectAccountIdsForBookingRefund(tenant, tenantId, booking) {
  const ids = [];
  const tenantAcct = ((tenant && tenant.stripeAccountId) || "").toString().trim();
  if (tenantAcct.startsWith("acct_")) ids.push(tenantAcct);
  const uids = [
    (booking && booking.assignedMemberUid) || "",
    (booking && booking.attributedMemberUid) || "",
  ]
    .map((u) => u.toString().trim())
    .filter(Boolean);
  const seenUid = new Set();
  for (const uid of uids) {
    if (seenUid.has(uid)) continue;
    seenUid.add(uid);
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    if ((data.tenantId || "").toString() !== (tenantId || "").toString()) continue;
    const acct = (data.stripeAccountId || "").toString().trim();
    if (acct.startsWith("acct_") && !ids.includes(acct)) ids.push(acct);
  }
  return ids;
}
async function refundBookingPaymentIfNeeded({
  stripe,
  tenant,
  tenantId,
  booking,
  requestId,
}) {
  const piId = (booking.stripePaymentIntentId || "").toString().trim();
  const refundAttempt =
    Math.max(0, Math.round(Number(booking.cancelRefundAttempts) || 0)) + 1;
  if (!piId.startsWith("pi_")) {
    return { refunded: false, refundAttempt };
  }
  const accountIds = await connectAccountIdsForBookingRefund(tenant, tenantId, booking);
  if (!accountIds.length) {
    return {
      refunded: false,
      refundAttempt,
      refundError: "Stripe is not set up for refunds.",
    };
  }
  try {
    const retrieved = await retrievePaymentIntentOnConnectAccounts(
      stripe,
      piId,
      accountIds
    );
    if (!retrieved) {
      return {
        refunded: false,
        refundAttempt,
        refundError: "Payment not found on this business.",
      };
    }
    const stripeAccountId = retrieved.stripeAccountId;
    const pi = await stripe.paymentIntents.retrieve(
      piId,
      { expand: ["latest_charge"] },
      { stripeAccount: stripeAccountId }
    );
    const metaTenant = ((pi.metadata && pi.metadata.tenantId) || "").toString();
    if (metaTenant !== (tenantId || "").toString()) {
      return {
        refunded: false,
        refundAttempt,
        refundError: "account_mismatch",
      };
    }
    if (pi.status !== "succeeded") {
      return { refunded: false, refundAttempt };
    }
    const latest = pi.latest_charge;
    const chargeId =
      typeof latest === "string" ? latest : latest && latest.id;
    if (!chargeId || !String(chargeId).startsWith("ch_")) {
      return {
        refunded: false,
        refundAttempt,
        refundError: "No charge found for this payment.",
      };
    }
    const result = await refundConnectCharge({
      stripe,
      stripeAccountId,
      tenantId,
      chargeId: String(chargeId),
      amountCents: null,
      reason: "requested_by_customer",
      idempotencyKey: `cancel_booking_${tenantId}_${requestId}_${refundAttempt}`,
      queueIfUnsettled: true,
    });
    const chargePatch = { chargeId: String(chargeId) };
    if (result.alreadyRefunded) {
      return { refunded: false, alreadyRefunded: true, refundAttempt, ...chargePatch };
    }
    if (result.pendingSettlement) {
      return {
        refunded: false,
        refundPending: true,
        refundAttempt,
        refundCents: result.refundCents,
        ...chargePatch,
      };
    }
    return {
      refunded: true,
      refundAttempt,
      refundCents: result.refundCents,
      ...chargePatch,
    };
  } catch (err) {
    const msg = (err && err.message) || "Refund failed.";
    if (isUnsettledRefundError(err)) {
      return { refunded: false, refundPending: true, refundAttempt };
    }
    console.error("refundBookingPaymentIfNeeded", requestId, msg);
    return { refunded: false, refundAttempt, refundError: msg };
  }
}
function cancelRefundPatchFromResult(refundResult) {
  if (!refundResult) return null;
  const chargeId = (refundResult.chargeId || "").toString().trim();
  const chargePatch = chargeId.startsWith("ch_") ? { stripeChargeId: chargeId } : {};
  const attempt = Math.max(0, Math.round(Number(refundResult.refundAttempt) || 0));
  const attemptPatch = attempt > 0 ? { cancelRefundAttempts: attempt } : {};
  if (refundResult.refunded) {
    return {
      ...chargePatch,
      ...attemptPatch,
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundCents: refundResult.refundCents || 0,
      cancelRefundStatus: "refunded",
      cancelRefundError: admin.firestore.FieldValue.delete(),
    };
  }
  if (refundResult.alreadyRefunded) {
    return {
      ...chargePatch,
      ...attemptPatch,
      cancelRefundStatus: "already_refunded",
    };
  }
  if (refundResult.refundPending) {
    return {
      ...chargePatch,
      ...attemptPatch,
      cancelRefundStatus: "pending",
      cancelRefundQueuedAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelRefundError: admin.firestore.FieldValue.delete(),
    };
  }
  if (refundResult.refundError) {
    return {
      ...chargePatch,
      ...attemptPatch,
      cancelRefundStatus: "failed",
      cancelRefundError: String(refundResult.refundError).slice(0, 500),
    };
  }
  return attemptPatch.cancelRefundAttempts ? attemptPatch : null;
}
function charterOccupyingStatus(status) {
  return charterOccupancy.occupyingStatus(status);
}
function charterParseTimeToMin(raw) {
  const t = (raw || "").toString().trim();
  if (!t) return null;
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
  }
  const am = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (am) {
    let h = parseInt(am[1], 10) % 12;
    if (/pm/i.test(am[3])) h += 12;
    return h * 60 + parseInt(am[2], 10);
  }
  return null;
}
/**
 * Assign a hull and write the booking in a transaction so two checkouts cannot take the same boat.
 * paymentHold: pending_deposit / pending_payment (15-minute holdUntil). Request & approve: no holdUntil.
 */
async function reserveCharterSlot(tenantId, tenantData, bookingData, opts) {
  const options = opts || {};
  const dateIso = bookingData.scheduledDate;
  const startMin = bookingData.scheduledStartMin;
  const dur = bookingData.durationMinutes || 240;
  if (!dateIso || startMin == null) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Pick a date and departure time."
    );
  }
  const now = new Date();
  let service = options.service || null;
  if (!service && (bookingData.serviceId || bookingData.serviceSlug)) {
    service = await loadCharterServiceDoc(tenantId, bookingData.serviceId, bookingData.serviceSlug);
  }
  charterOccupancy.assertHoursAndClock(tenantData, dateIso, startMin, dur, now, service);
  const startDate = charterOccupancy.instantFromIsoAndMin(
    dateIso,
    startMin,
    charterOccupancy.tenantTimeZone(tenantData)
  );
  if (startDate) {
    bookingData.requestedStartTime = admin.firestore.Timestamp.fromDate(startDate);
  }
  const occWin = charterOccupancy.occupancyWindow(startMin, dur, service);
  bookingData.scheduledOccStartMin = occWin.occStartMin;
  bookingData.scheduledOccEndMin = occWin.occEndMin;
  const boatFilterId = (options.boatFilterId || bookingData.boatId || "").toString().trim();
  const eligible = charterOccupancy.eligibleBoats(
    tenantData,
    service,
    bookingData.partySize || 0,
    boatFilterId
  );
  if (!eligible.length) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No boat in the fleet can take this trip."
    );
  }
  const bookingRef =
    options.bookingRef ||
    db.collection("tenants").doc(tenantId).collection("bookingRequests").doc();
  await db.runTransaction(async (tx) => {
    const col = db.collection("tenants").doc(tenantId).collection("bookingRequests");
    const prevIso = charterOccupancy.addDaysToIso(dateIso, -1);
    const nextIso = charterOccupancy.addDaysToIso(dateIso, 1);
    const snapPrev = prevIso ? await tx.get(col.where("scheduledDate", "==", prevIso)) : null;
    const snapDay = await tx.get(col.where("scheduledDate", "==", dateIso));
    const snapNext = nextIso ? await tx.get(col.where("scheduledDate", "==", nextIso)) : null;
    const rows = charterOccupancy.occupyingRowsFromSnaps(
      [snapPrev, snapDay, snapNext].filter(Boolean),
      now.getTime()
    );
    const boat = charterOccupancy.pickFreeBoat(
      eligible,
      rows,
      dateIso,
      startMin,
      dur,
      bookingRef.id,
      service,
      tenantData
    );
    if (!boat) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "That departure is no longer open."
      );
    }
    bookingData.boatId = String(boat.id);
    if (options.paymentHold) {
      bookingData.holdUntil = admin.firestore.Timestamp.fromMillis(
        now.getTime() + charterOccupancy.CHARTER_PAYMENT_HOLD_MINUTES * 60 * 1000
      );
    }
    tx.set(bookingRef, bookingData);
  });
  return bookingRef;
}
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
async function validatedCharterAddons(tenantId, rawProductIds) {
  const ids = Array.isArray(rawProductIds)
    ? [...new Set(rawProductIds.map((v) => (v || "").toString().trim()).filter(Boolean))]
    : [];
  if (!ids.length) return { addonItems: [], addonCents: 0 };
  if (ids.length > 20) {
    throw new HttpsError("invalid-argument", "Too many charter add-ons selected.");
  }
  const productsById = await fetchTenantProductsById(tenantId);
  const addonItems = [];
  let addonCents = 0;
  for (const productId of ids) {
    const prod = productsById.get(productId);
    if (!prod || prod.isActive === false) {
      throw new HttpsError(
        "failed-precondition",
        "One or more charter add-ons are no longer available."
      );
    }
    const regular = Number(prod.price) || 0;
    const sale = prod.salePrice != null ? Number(prod.salePrice) : NaN;
    const effective = Number.isFinite(sale) && sale >= 0 && sale < regular ? sale : regular;
    const unitPriceCents = Math.max(0, Math.round(effective * 100));
    addonCents += unitPriceCents;
    addonItems.push({
      productId,
      name: (prod.name || "Add-on").toString().trim().slice(0, 200),
      unitPriceCents,
    });
  }
  return { addonItems, addonCents };
}
/** Stripe Tax code: general tangible goods (retail shop products). */
const SHOP_PRODUCT_TAX_CODE = "txcd_99999999";
/** Stripe Tax code: general services (manual / Tap to Pay charges). */
const SERVICE_TAX_CODE = "txcd_20030000";
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
async function calculateSalesTaxFromLineItems(
  stripe,
  stripeAccountId,
  tenantData,
  lineItems
) {
  const address = shopTaxAddressFromTenant(tenantData);
  const calculation = await stripe.tax.calculations.create(
    {
      currency: "usd",
      line_items: lineItems.map((line) => ({
        amount: Math.max(0, parseInt(line.amount, 10) || 0),
        reference: (line.reference || "item").toString().slice(0, 200),
        tax_code: (line.taxCode || SHOP_PRODUCT_TAX_CODE).toString(),
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
async function calculateShopSalesTax(stripe, stripeAccountId, tenantData, lineItems) {
  return calculateSalesTaxFromLineItems(
    stripe,
    stripeAccountId,
    tenantData,
    lineItems.map((line) => ({
      amount: line.lineTotalCents,
      reference: line.productId || "item",
      taxCode: SHOP_PRODUCT_TAX_CODE,
    }))
  );
}
/** Sales tax for a single service/manual amount (business address). */
async function calculateServiceSalesTax(
  stripe,
  stripeAccountId,
  tenantData,
  amountCents
) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (amount <= 0) {
    return { taxCents: 0, taxCalculationId: null };
  }
  return calculateSalesTaxFromLineItems(stripe, stripeAccountId, tenantData, [
    {
      amount,
      reference: "service",
      taxCode: SERVICE_TAX_CODE,
    },
  ]);
}
/**
 * When in-person tax is enabled, calculate tax for a service amount.
 * Returns { taxCents, taxCalculationId } (zeros when disabled).
 */
async function maybeCalculateInPersonSalesTax(
  stripe,
  stripeAccountId,
  tenantData,
  serviceCents
) {
  if (tenantData?.inPersonTaxEnabled !== true) {
    return { taxCents: 0, taxCalculationId: null };
  }
  try {
    return await calculateServiceSalesTax(
      stripe,
      stripeAccountId,
      tenantData,
      serviceCents
    );
  } catch (taxErr) {
    console.warn("maybeCalculateInPersonSalesTax", taxErr.message || taxErr);
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Could not calculate sales tax. Complete tax setup in Stripe, or turn off In-person sales tax in Payment settings."
    );
  }
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
  const resolvedTenant = await resolveTenantBySlug(slug);
  if (!resolvedTenant) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenantId = resolvedTenant.id;
  const tenantData = resolvedTenant.data || {};
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
  await assertPublicPaymentAccessForTenant(tenantId, tenantData);
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
  const shippingCents = totals.shippingCents ?? order?.shippingCents ?? 0;
  const surchargeCents = totals.surchargeCents ?? order?.surchargeCents ?? 0;
  const totalCents =
    totals.totalCents ??
    order?.totalCents ??
    subtotalCents + Math.max(0, shippingCents) + Math.max(0, taxCents) + Math.max(0, surchargeCents);
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
      shippingCents: Math.max(0, shippingCents),
      taxCents: Math.max(0, taxCents),
      surchargeCents: Math.max(0, surchargeCents),
      fulfillmentMethod: (order?.fulfillmentMethod || "pickup").toString(),
      trackingNumber: order?.trackingNumber || null,
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
  const shippingCentsMeta = parseInt(meta.shippingCents, 10);
  const resolvedShipping = Number.isNaN(shippingCentsMeta)
    ? Math.max(0, parseInt(order.shippingCents, 10) || 0)
    : Math.max(0, shippingCentsMeta);
  const serviceCents = parseInt(meta.serviceAmountCents, 10);
  const resolvedSubtotal =
    Number.isNaN(serviceCents) || serviceCents <= 0
      ? Math.max(0, (pi.amount || 0) - resolvedSurcharge - resolvedTax - resolvedShipping)
      : serviceCents;
  const grossCents = pi.amount || resolvedSubtotal + resolvedShipping + resolvedTax + resolvedSurcharge;
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
      shippingCents: resolvedShipping,
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

  // Rates-only: customer paid the quoted shipping; studio buys postage/label themselves.
  // Do not call Shippo purchaseLabel on the platform token (avoids Bookking postage liability).
  const fulfillment = (order.fulfillmentMethod || meta.fulfillmentMethod || "pickup").toString();
  if (fulfillment === "shipping" && order.shippingLabelMode !== "studio_manual") {
    await orderRef.set(
      {
        shippingLabelMode: "studio_manual",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    order.shippingLabelMode = "studio_manual";
  }

  return shopOrderReceiptResponse(tenantData, orderId, {
    ...order,
    subtotalCents: resolvedSubtotal,
    shippingCents: resolvedShipping,
    taxCents: resolvedTax,
    surchargeCents: resolvedSurcharge,
    totalCents: grossCents,
  }, {
    subtotalCents: resolvedSubtotal,
    shippingCents: resolvedShipping,
    taxCents: resolvedTax,
    surchargeCents: resolvedSurcharge,
    totalCents: grossCents,
    paidAt: paidAtIso,
  });
}
/** Public browser callables need explicit invoker + CORS (secret-backed v1 defaults to private IAM). */
const publicWebCallableOptions = {
  secrets: [stripeSecretKey],
  invoker: "public",
  cors: true,
  region: "us-central1",
};
/**
 * Link Instant Bank Payments show up as a card whose brand is `link`.
 * A saved Visa or Mastercard inside Link stays a normal card.
 * @returns {"card"|"klarna"|"affirm"|"instant_bank"|""}
 */
async function checkoutMethodFromPaymentMethod(stripe, stripeAccountId, paymentMethodId) {
  const id = (paymentMethodId || "").toString().trim();
  if (!id.startsWith("pm_")) return "";
  let pm = null;
  try {
    pm = await stripe.paymentMethods.retrieve(id, { stripeAccount: stripeAccountId });
  } catch (err) {
    try {
      pm = await stripe.paymentMethods.retrieve(id);
    } catch (err2) {
      return "";
    }
  }
  const type = (pm.type || "").toString();
  if (type === "klarna" || type === "affirm") return type;
  if (type === "link") return "instant_bank";
  const brand = (pm.card && pm.card.brand ? pm.card.brand : "").toString().toLowerCase();
  if (brand === "link") return "instant_bank";
  if (type === "card") return "card";
  return "";
}
/** Shop checkout + shipping (Stripe Connect + optional Shippo). */
const publicShopCallableOptions = {
  secrets: [stripeSecretKey, shippoApiToken],
  invoker: "public",
  cors: true,
  region: "us-central1",
};
function readShippoTokenOrThrow() {
  let token = "";
  try {
    token = (shippoApiToken.value() || "").toString().trim();
  } catch (_) {
    token = "";
  }
  if (!token) {
    throw new HttpsError(
      "failed-precondition",
      "Shipping is not configured yet. Add SHIPPO_API_TOKEN to Cloud Functions secrets."
    );
  }
  return token;
}
async function resolvePublicCharterTenant(tenantSlug) {
  const slug = (tenantSlug || "").toString().trim().toLowerCase();
  if (!slug) {
    throw new HttpsError("invalid-argument", "tenantSlug is required");
  }
  const resolvedTenant = await resolveTenantBySlug(slug);
  if (!resolvedTenant) {
    throw new HttpsError("not-found", "Business not found");
  }
  const tenantId = resolvedTenant.id;
  const tenantData = resolvedTenant.data || {};
  if (tenantData.isActive === false) {
    throw new HttpsError("failed-precondition", "This business is not accepting bookings");
  }
  const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
  if (plan !== "charter") {
    throw new HttpsError("failed-precondition", "This checkout is only for fishing charters.");
  }
  if (tenantData.isDemoAccount === true) {
    throw new HttpsError(
      "failed-precondition",
      "This demo site is read-only. Sign up for your own account to accept bookings."
    );
  }
  await assertPublicPaymentAccessForTenant(tenantId, tenantData);
  return { tenantId, tenantData };
}
function charterServicePriceCents(svc) {
  if (!svc) return 0;
  if (typeof svc.priceCents === "number" && svc.priceCents > 0) {
    return Math.round(svc.priceCents);
  }
  if (typeof svc.price === "number" && svc.price > 0) {
    return Math.round(svc.price * 100);
  }
  return 0;
}
function charterPayModeFromTenant(tenantData) {
  const t = (
    (tenantData && tenantData.workflow && tenantData.workflow.confirmationType) ||
    ""
  )
    .toString()
    .trim()
    .toLowerCase();
  if (t === "pay_in_full") return "full";
  if (t === "deposit_to_confirm" || t === "approve_and_deposit") return "deposit";
  return "request";
}
async function loadCharterServiceDoc(tenantId, serviceId, serviceSlug) {
  const col = db.collection("tenants").doc(tenantId).collection("services");
  const sid = (serviceId || "").toString().trim();
  if (sid) {
    const snap = await col.doc(sid).get();
    if (snap.exists) return { id: snap.id, ...(snap.data() || {}) };
  }
  const slug = (serviceSlug || "").toString().trim();
  if (slug) {
    const q = await col.where("slug", "==", slug).limit(1).get();
    if (!q.empty) {
      const doc = q.docs[0];
      return { id: doc.id, ...(doc.data() || {}) };
    }
  }
  return null;
}
async function markCharterBookingPaidFromPaymentIntent(
  stripe,
  tenantId,
  requestId,
  paymentIntentId,
  knownPaymentIntent
) {
  const reqRef = db
    .collection("tenants")
    .doc(tenantId)
    .collection("bookingRequests")
    .doc(requestId);
  let pi = knownPaymentIntent;
  if (!pi || pi.id !== paymentIntentId) {
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    const tenantData = tenantSnap.exists ? tenantSnap.data() || {} : {};
    const stripeAccountId = (tenantData.stripeAccountId || "").toString().trim();
    if (!stripeAccountId) {
      throw new HttpsError("failed-precondition", "Online card payments are not set up yet.");
    }
    pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      stripeAccount: stripeAccountId,
    });
  }
  if (!pi || pi.status !== "succeeded") {
    throw new HttpsError("failed-precondition", "Payment is not complete yet.");
  }
  const meta = pi.metadata || {};
  if ((meta.tenantId || "").toString() !== (tenantId || "").toString()) {
    throw new HttpsError("permission-denied", "Payment does not belong to this business.");
  }
  if ((meta.bookingRequestId || "").toString() !== (requestId || "").toString()) {
    throw new HttpsError("failed-precondition", "Payment does not match this booking.");
  }
  let alreadyPaid = false;
  let recoveredAfterExpiry = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reqRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "Booking not found");
    }
    const booking = snap.data() || {};
    const storedPi = (booking.stripePaymentIntentId || "").toString().trim();
    if (storedPi && storedPi !== paymentIntentId) {
      throw new HttpsError("failed-precondition", "Payment does not match this booking.");
    }
    const chargeCents = Math.max(0, Math.round(Number(booking.chargeCents) || 0));
    if (chargeCents >= 50) {
      const expected = computeCardCheckoutAmounts(chargeCents, "online").totalCents;
      if (Number(pi.amount) !== expected) {
        throw new HttpsError(
          "failed-precondition",
          "Payment amount does not match this booking."
        );
      }
    }
    const status = (booking.status || "").toString().trim().toLowerCase();
    const cancelReason = (booking.cancelReason || "").toString().trim().toLowerCase();
    alreadyPaid = status === "confirmed";
    recoveredAfterExpiry = status === "cancelled" && cancelReason === "hold_expired";
    if (status === "declined" || (status === "cancelled" && !recoveredAfterExpiry)) {
      throw new HttpsError(
        "failed-precondition",
        "This booking was cancelled before payment completed."
      );
    }
    tx.set(
      reqRef,
      {
        status: "confirmed",
        depositPaidAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paidCents: pi.amount || 0,
        stripePaymentIntentId: paymentIntentId,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        holdUntil: admin.firestore.FieldValue.delete(),
        ...(recoveredAfterExpiry
          ? {
              paymentRecoveredAfterHoldExpiry: true,
              paymentRecoveredAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : {}),
      },
      { merge: true }
    );
  });
  return {
    ok: true,
    requestId,
    alreadyPaid,
    recoveredAfterExpiry,
    paidCents: pi.amount || 0,
  };
}
/**
 * Collect FCM device tokens for the given user uids.
 */
async function collectDeviceTokensForUids(uids) {
  const tokens = [];
  const uniqueUids = [...new Set((uids || []).filter(Boolean))];
  for (const uid of uniqueUids) {
    const tokSnap = await db
      .collection("users")
      .doc(uid)
      .collection("deviceTokens")
      .get();
    tokSnap.forEach((t) => {
      const token = t.data().token;
      if (token && typeof token === "string") tokens.push(token);
    });
  }
  return [...new Set(tokens)];
}
/**
 * Recipients for booking alerts: owner when Owner booking alerts toggle is on;
 * assigned member always; managers when the same flag is on.
 */
async function resolveBookingAlertRecipientUids(tenantId, bookingData, managerFlagKey) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) return [];
  const tenant = tenantSnap.data() || {};
  const ownerUid = (tenant.ownerUid || "").toString().trim();
  const notifs = {
    ...DEFAULT_MANAGER_NOTIFICATIONS,
    ...(tenant.managerNotifications || {}),
  };
  const alertsEnabled = notifs[managerFlagKey] === true;

  const recipientSet = new Set();

  // Owner booking alerts toggle gates owner pushes.
  if (alertsEnabled && ownerUid) recipientSet.add(ownerUid);

  const assigned = ((bookingData && bookingData.assignedMemberUid) || "")
    .toString()
    .trim();
  if (assigned) recipientSet.add(assigned);

  if (alertsEnabled) {
    const usersSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .get();
    for (const userDoc of usersSnap.docs) {
      if (ownerUid && userDoc.id === ownerUid) continue;
      const role = parseAccessRole(
        userDoc.data().role || userDoc.data().accessRole
      );
      if (role === "manager") recipientSet.add(userDoc.id);
    }
  }

  return [...recipientSet];
}
async function sendBookingAlertPush({ tokens, title, body, data }) {
  if (!tokens || !tokens.length) return;
  const chunkSize = 500;
  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);
    try {
      await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: data || {},
        apns: {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: { title, body },
              sound: "default",
            },
          },
        },
      });
    } catch (e) {
      console.error("sendBookingAlertPush FCM error", e);
    }
  }
}
/** Push copy: "Booking request" + service, or "Booking request for {artist}" + service. */
function bookingRequestAlertCopy(bookingData) {
  const serviceName =
    ((bookingData && bookingData.serviceName) || "").toString().trim() ||
    ((bookingData && bookingData.serviceSlug) || "").toString().trim() ||
    "Appointment";
  const assignee = ((bookingData && bookingData.assignedMemberName) || "")
    .toString()
    .trim();
  const title = assignee
    ? `Booking request for ${assignee}`.slice(0, 100)
    : "Booking request";
  return { title, body: serviceName.slice(0, 200) };
}
function bookingCancelledAlertCopy(bookingData) {
  const serviceName =
    ((bookingData && bookingData.serviceName) || "").toString().trim() ||
    ((bookingData && bookingData.serviceSlug) || "").toString().trim() ||
    "Appointment";
  const assignee = ((bookingData && bookingData.assignedMemberName) || "")
    .toString()
    .trim();
  const title = assignee
    ? `Booking cancelled for ${assignee}`.slice(0, 100)
    : "Booking cancelled";
  return { title, body: serviceName.slice(0, 200) };
}
/**
 * Copies a verified App Store status onto the owner's profile and suspends texting when the plan
 * is not active — the same follow-through a Stripe status change gets. The paid-feature checks
 * read the owner's profile first, so without this an Apple subscriber stays "trialing".
 */
async function mirrorAppleSubscriptionStatus(tenantId, applied) {
  if (!applied || applied.applied !== true) return;
  await sms.syncSubscriptionStatusForTenant(
    tenantId,
    applied.subscriptionStatus,
    { subscriptionPlan: applied.subscriptionPlan },
    { source: "apple" }
  );
  if (applied.subscriptionStatus === "canceled") {
    try {
      const secretKey = stripeSecretKey.value();
      if (secretKey) {
        const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
        await cancelSmsAddOnSubscription(stripe, tenantId);
      }
    } catch (e) {
      console.error("mirrorAppleSubscriptionStatus cancel texting add-on", tenantId, e.message || e);
    }
  }
}
/**
 * Stripe webhook: completes provisioning when Checkout succeeds (backup if user closes tab before client completes).
 */
function expectedStripeLivemode(secretKey) {
  const k = (secretKey || "").toString();
  return k.startsWith("sk_live_") || k.startsWith("rk_live_");
}
function isRetryableWebhookError(err) {
  if (!err) return false;
  const httpsCode = (err.code || "").toString();
  if (
    httpsCode === "unavailable" ||
    httpsCode === "deadline-exceeded" ||
    httpsCode === "aborted" ||
    httpsCode === "resource-exhausted"
  ) {
    return true;
  }
  const status = Number(err.statusCode || err.status || 0);
  if (status === 429 || status >= 500) return true;
  const grpc = Number(err.code);
  if ([4, 8, 10, 13, 14].includes(grpc)) return true;
  const msg = `${err.message || ""} ${err.details || ""}`.toLowerCase();
  return (
    msg.includes("unavailable") ||
    msg.includes("deadline exceeded") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}
async function handleConnectDisputeWebhook(stripe, db, event) {
  if (event.type !== "charge.dispute.created" && event.type !== "charge.dispute.closed") {
    return { skipped: true, reason: "not_dispute" };
  }
  const stripeAccountId = (event.account || "").toString().trim();
  if (!stripeAccountId.startsWith("acct_")) {
    return { skipped: true, reason: "not_connect_event" };
  }
  const dispute = event.data.object || {};
  const disputeId = stripeObjectId(dispute.id);
  const status = (dispute.status || "").toString().trim().toLowerCase();
  const reason = (dispute.reason || "").toString().trim().slice(0, 80);
  const disputeCents = Math.max(0, Math.round(Number(dispute.amount) || 0));
  let piId = stripeObjectId(dispute.payment_intent);
  let chargeId = stripeObjectId(dispute.charge);
  const closed = event.type === "charge.dispute.closed";

  if (!piId && chargeId) {
    const ch = await stripe.charges.retrieve(chargeId, {}, { stripeAccount: stripeAccountId });
    piId = stripeObjectId(ch.payment_intent);
    if (!piId && ch.payment_intent && typeof ch.payment_intent === "object") {
      piId = stripeObjectId(ch.payment_intent.id);
    }
  }
  if (!piId) {
    console.warn("stripeSubscriptionWebhook dispute missing pi", disputeId);
    return { skipped: true, reason: "missing_pi" };
  }

  const pi = await stripe.paymentIntents.retrieve(piId, {}, { stripeAccount: stripeAccountId });
  const tenantId = ((pi.metadata && pi.metadata.tenantId) || "").toString().trim();
  if (!tenantId) {
    return { skipped: true, reason: "missing_tenant" };
  }

  const ledgerRef = db
    .collection("tenants")
    .doc(tenantId)
    .collection("paymentLedger")
    .doc(piId);
  const patch = {
    disputeId,
    disputeStatus: status,
    disputeReason: reason,
    disputeAmountCents: disputeCents,
    disputeChargeId: chargeId || null,
    disputeUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!closed) {
    patch.disputeOpenedAt = admin.firestore.FieldValue.serverTimestamp();
  } else {
    patch.disputeClosedAt = admin.firestore.FieldValue.serverTimestamp();
    patch.disputeLost = status === "lost";
    patch.disputeWon = status === "won";
  }
  await ledgerRef.set(patch, { merge: true });

  let disputeFeeRefund = null;
  let disputeShareReverse = null;
  if (closed && status === "lost" && disputeId && disputeCents > 0) {
    try {
      const snap = await ledgerRef.get();
      const ledgerData = snap.exists ? snap.data() || {} : {};
      const lostIds = Array.isArray(ledgerData.disputeLostIds)
        ? ledgerData.disputeLostIds.map((id) => (id || "").toString())
        : [];
      let disputeLostCents = Math.max(
        0,
        Math.round(Number(ledgerData.disputeLostCents) || 0)
      );
      if (!lostIds.includes(disputeId)) {
        disputeLostCents += disputeCents;
        await ledgerRef.set(
          {
            disputeLostCents,
            disputeLostIds: admin.firestore.FieldValue.arrayUnion(disputeId),
          },
          { merge: true }
        );
      }
      let capturedCents = Math.max(
        0,
        Math.round(Number(pi.amount_received) || Number(pi.amount) || 0)
      );
      if (chargeId) {
        try {
          const ch = await stripe.charges.retrieve(
            chargeId,
            {},
            { stripeAccount: stripeAccountId }
          );
          capturedCents = Math.max(
            capturedCents,
            Math.round(Number(ch.amount_captured) || Number(ch.amount) || 0)
          );
        } catch (chErr) {
          console.warn("stripeSubscriptionWebhook dispute charge", chErr.message || chErr);
        }
      }
      const amountRefundedCents = Math.max(
        0,
        Math.round(Number(ledgerData.amountRefundedCents) || 0)
      );
      disputeFeeRefund = await refundConnectApplicationFeeIfNeeded(stripe, {
        stripeAccountId,
        chargeId,
        refundId: `dispute-${disputeId}`,
        refundCents: disputeCents,
        chargeCapturedCents: capturedCents || disputeCents,
        feeBasisCents: feeBasisFromLedger(
          { disputeLostCents },
          capturedCents || disputeCents,
          amountRefundedCents
        ),
      });
      disputeShareReverse = await teamPaymentSplit.reverseStudioShareOnRefund(stripe, {
        db,
        tenantId,
        chargeId: chargeId || null,
        paymentIntentId: piId,
        refundCents: disputeCents,
        chargeCapturedCents: capturedCents || disputeCents,
        refundId: `dispute-${disputeId}`,
      });
    } catch (disputeMoneyErr) {
      console.error(
        "stripeSubscriptionWebhook dispute settle",
        disputeId,
        disputeMoneyErr.message || disputeMoneyErr
      );
    }
  }

  const relatedPatch = {
    disputeId,
    disputeStatus: status,
    disputeAmountCents: disputeCents,
    disputeUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (closed) {
    relatedPatch.disputeClosedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  const shopOrderIdHint = ((pi.metadata && pi.metadata.shopOrderId) || "").toString().trim();
  if (shopOrderIdHint) {
    await db
      .collection("tenants")
      .doc(tenantId)
      .collection("shopOrders")
      .doc(shopOrderIdHint)
      .set(relatedPatch, { merge: true });
  } else {
    const orders = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("shopOrders")
      .where("stripePaymentIntentId", "==", piId)
      .limit(4)
      .get();
    for (const doc of orders.docs) {
      await doc.ref.set(relatedPatch, { merge: true });
    }
  }

  const bookingRequestIdHint = ((pi.metadata && pi.metadata.bookingRequestId) || "")
    .toString()
    .trim();
  if (bookingRequestIdHint) {
    await db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .doc(bookingRequestIdHint)
      .set(relatedPatch, { merge: true });
  } else {
    const books = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .where("stripePaymentIntentId", "==", piId)
      .limit(8)
      .get();
    for (const doc of books.docs) {
      await doc.ref.set(relatedPatch, { merge: true });
    }
  }

  console.log(
    "stripeSubscriptionWebhook dispute",
    JSON.stringify({
      disputeId,
      type: event.type,
      status,
      tenantId,
      piId,
      disputeFeeRefund,
      disputeShareReverse,
    })
  );
  return { ok: true, disputeId, status };
}
// ── Team invites (opaque token = Firestore doc id) ─────────────────────────

const TENANT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MANAGER_PERMISSIONS = {
  viewAllBookings: true,
  approveRejectRequests: true,
  editServicesPricing: false,
  manageBookingFormStyle: false,
  manageArtistSchedules: false,
  accessClientList: false,
  viewEarningsReports: false,
  // On for new businesses: this switch also gates the owner's own texts and automatic booking
  // texts, so starting it off made texting fail right after setup. Owners can turn it off.
  sendClientNotifications: true,
};
const DEFAULT_TENANT_WORKFLOW = {
  confirmationType: "request_approve",
  responseTimeHours: 24,
  bookingMode: "form",
  managersApproveAppointments: false,
};
function defaultWorkflowForPlan(plan) {
  const subscriptionPlan = normalizeSubscriptionPlan(plan);
  if (subscriptionPlan === "charter") {
    return {
      confirmationType: "request_approve",
      responseTimeHours: 24,
      bookingMode: "calendar_slots",
      managersApproveAppointments: true,
      charterBookBy: "location",
      charterBufferMinutes: 30,
    };
  }
  return { ...DEFAULT_TENANT_WORKFLOW };
}
/** Charter /book is always calendar slots; payment is request, deposit, or pay in full. */
function applyCharterBookingWorkflow(tenant, workflow) {
  const plan = normalizeSubscriptionPlan(tenant && tenant.subscriptionPlan);
  if (plan !== "charter" || !workflow || typeof workflow !== "object") return workflow;
  workflow.bookingMode = "calendar_slots";
  workflow.managersApproveAppointments = true;
  const bookBy = (workflow.charterBookBy || "").toString().trim().toLowerCase();
  workflow.charterBookBy =
    bookBy === "boat" || bookBy === "boats" || bookBy === "fleet" ? "boat" : "location";
  const buf = Number(workflow.charterBufferMinutes);
  if (buf === 0) {
    workflow.charterBufferMinutes = 0;
  } else if (Number.isFinite(buf) && buf > 0) {
    workflow.charterBufferMinutes = Math.min(240, Math.round(buf));
  } else {
    workflow.charterBufferMinutes = 30;
  }
  const lastBook = Number(workflow.charterLastBookingMin);
  if (!Number.isFinite(lastBook) || lastBook < 0) {
    delete workflow.charterLastBookingMin;
  } else {
    workflow.charterLastBookingMin = Math.min(24 * 60, Math.round(lastBook));
  }
  const t = (workflow.confirmationType || "").toString().trim().toLowerCase();
  if (t === "pay_in_full") {
    workflow.confirmationType = "pay_in_full";
  } else if (t === "deposit_to_confirm" || t === "approve_and_deposit") {
    workflow.confirmationType = "deposit_to_confirm";
  } else {
    workflow.confirmationType = "request_approve";
  }
  return workflow;
}
function bookingRequiresApproval(confirmationType) {
  const t = (confirmationType || "").toString().trim().toLowerCase();
  return (
    t === "request_approve" ||
    t === "approve_and_deposit" ||
    t === "consultation_first"
  );
}
async function confirmBookingAfterDepositPaid(tenantId, bookingRequestId, paymentIntent) {
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
  const data = snap.data() || {};
  const status = (data.status || "").toString().trim().toLowerCase();
  const patch = {};
  const pi = paymentIntent && paymentIntent.id ? paymentIntent : null;
  if (pi) {
    const storedPi = (data.stripePaymentIntentId || "").toString().trim();
    if (storedPi && storedPi !== pi.id) {
      console.warn("confirmBookingAfterDepositPaid pi mismatch", rid, storedPi, pi.id);
    } else {
      patch.stripePaymentIntentId = pi.id;
      patch.paidCents = pi.amount || 0;
      patch.paidAt = admin.firestore.FieldValue.serverTimestamp();
    }
  }
  if (status === "pending_deposit" || status === "pending_payment") {
    patch.status = "confirmed";
    patch.depositPaidAt = admin.firestore.FieldValue.serverTimestamp();
    patch.reviewedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (!Object.keys(patch).length) return false;
  await reqRef.set(patch, { merge: true });
  return true;
}
function canManageAppointmentTime(ctx) {
  const perms = ctx.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  if (ctx.isOwner) return perms.viewAllBookings === true;
  return (
    ctx.accessRole === "manager" &&
    perms.viewAllBookings === true
  );
}
function canApproveRejectBookingRequests(ctx) {
  const perms = ctx.managerPermissions || DEFAULT_MANAGER_PERMISSIONS;
  if (ctx.isOwner) return perms.approveRejectRequests === true;
  if (!ctx.bookingRequiresApproval) return false;
  if (!ctx.managersApproveAppointments) return false;
  return (
    ctx.accessRole === "manager" &&
    perms.approveRejectRequests === true
  );
}
function managersApproveAppointments(workflow) {
  if (!workflow || typeof workflow !== "object") return false;
  // Opt-in: owner must explicitly turn on “Owner sets team booking type”.
  return workflow.managersApproveAppointments === true;
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
  return { ...DEFAULT_TENANT_WORKFLOW, managersApproveAppointments: false };
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
  const managerPermissions = {
    ...DEFAULT_MANAGER_PERMISSIONS,
    ...(tenant.managerPermissions || {}),
  };
  return {
    uid,
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
const PAYOUT_MODES = new Set(["shop_split", "independent", "studio_payroll"]);
/** All team members take payments on their own Connect (legacy studio_payroll → shop_split). */
function memberUsesOwnConnect(payoutMode) {
  const m = (payoutMode || "").toString().trim().toLowerCase();
  return (
    m === "independent" ||
    m === "shop_split" ||
    m === "studio_payroll" ||
    !m
  );
}
function normalizePayoutMode(raw) {
  const m = (raw || "independent").toString().trim().toLowerCase();
  if (m === "studio_payroll" || m === "shop_split") return "shop_split";
  if (m === "independent") return "independent";
  return "independent";
}
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
  let payoutMode = normalizePayoutMode(d.payoutMode);
  const canEditPortfolio = d.canEditPortfolio === true;
  const canEditPublicBio = d.canEditPublicBio === true;
  // Default true so existing members keep payments; owner may set false.
  const canTakePayments = d.canTakePayments !== false;
  const out = {
    useStudioBookingPolicy: useStudio,
    paymentSplitEnabled,
    paymentSplitPercent,
    paymentSplitAppliesTo,
    payoutMode,
    canEditPortfolio,
    canEditPublicBio,
    canTakePayments,
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
/** Wire teamPaymentSplit helpers with local deps. */
async function buildTeamSplitFeeAndMetaForCharge(args) {
  return teamPaymentSplit.buildTeamSplitFeeAndMeta({
    db,
    platformFeeCents,
    normalizeSubscriptionPlan,
    normalizeMemberSettings,
    computeTeamPaymentSplit,
    ...args,
  });
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
function defaultJobTitleForIndustry(industry) {
  const map = {
    tattoos: "Artist",
    hair: "Stylist",
    barber: "Barber",
    nails: "Nail technician",
    charters: "Captain",
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
      payoutMode: "shop_split",
      useStudioBookingPolicy: true,
      paymentSplitEnabled: true,
      paymentSplitPercent: 70,
      paymentSplitAppliesTo: "service",
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
  // The public site is the business guests are looking at. A slug query with
  // limit(1) can hit an older duplicate and save the booking on the wrong account.
  const publicSnap = await db.collection("publicSites").doc(slug).get();
  const publishedTenantId = publicSnap.exists
    ? (publicSnap.data().tenantId || "").toString().trim()
    : "";
  if (publishedTenantId) {
    const tenantSnap = await db.collection("tenants").doc(publishedTenantId).get();
    if (tenantSnap.exists) {
      return { id: tenantSnap.id, data: tenantSnap.data() || {} };
    }
  }
  const snap = await db.collection("tenants").where("slug", "==", slug).limit(2).get();
  if (snap.size !== 1) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() || {} };
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
    smsLineRequestPending: d.smsLineRequestPending === true,
    smsMonthlyUsageCount: sms.smsMonthlyUsageForMember(d, tenant).count,
    smsMonthlyLimit: sms.smsMonthlyUsageForMember(d, tenant).limit,
    smsMonthlyUsageRemaining: sms.smsMonthlyUsageForMember(d, tenant).remaining,
    personalConfirmationType: personalRaw,
    effectiveConfirmationType: (effective.confirmationType || "").toString(),
  };
}
/** Seat caps: Solo/Charter 1, Studio 2–5, Shop 6–10. */
function maxSeatsForPlanNormalized(plan) {
  const p = normalizeSubscriptionPlan(plan);
  if (p === "solo" || p === "charter") return 1;
  if (p === "studio") return 5;
  if (p === "shop") return 10;
  return 1;
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
const {
  SEED_CONFIRM,
  MAX_SEED_COUNT,
  writeSeedBookingRequests,
} = require("./seedBookingRequestsLib");
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
/**
 * Gives a business's texting numbers back to Twilio — the studio line and every teammate's
 * personal line — so we stop paying for numbers nobody is paying us for. Best effort: a Twilio
 * failure is logged and never blocks the caller. The number fields are cleared only once Twilio
 * confirms the release, so a failed release is retried instead of forgotten.
 */
async function releaseTenantTextingNumbers(tenantId, tenant) {
  const out = { studioReleased: false, memberLinesReleased: 0 };
  try {
    if ((tenant && tenant.smsPhoneNumberSid || "").toString().trim()) {
      const release = await sms.releaseTenantSms(tenant);
      out.studioReleased = release.released === true;
      if (out.studioReleased) {
        await db.collection("tenants").doc(tenantId).set(sms.tenantSmsClearedFields(), { merge: true });
      } else {
        console.error("releaseTenantTextingNumbers: studio number NOT released", tenantId, tenant.smsPhoneNumberSid);
      }
    }
  } catch (e) {
    console.warn("releaseTenantTextingNumbers studio", tenantId, e.message || e);
  }
  try {
    const members = await db.collection("users").where("tenantId", "==", tenantId).get();
    for (const doc of members.docs) {
      const memberData = doc.data() || {};
      if (!(memberData.smsPhoneNumberSid || "").toString().trim()) continue;
      try {
        const release = await sms.releaseMemberSms(memberData);
        if (release.released === true) {
          out.memberLinesReleased += 1;
          await doc.ref.set(sms.personalSmsClearedFields(), { merge: true });
        } else {
          console.error("releaseTenantTextingNumbers: member number NOT released", doc.id, memberData.smsPhoneNumberSid);
        }
      } catch (e) {
        console.warn("releaseTenantTextingNumbers member", doc.id, e.message || e);
      }
    }
  } catch (e) {
    console.warn("releaseTenantTextingNumbers members", tenantId, e.message || e);
  }
  return out;
}
/** How long a number is kept after its plan lapses, so a late payment doesn't cost the number. */
const SMS_LAPSED_NUMBER_GRACE_DAYS = 30;
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
  return memberUsesOwnConnect(payoutMode) ? accountId : null;
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
async function resolvePaymentMethodForCustomer(
  stripe,
  stripeCustomerId,
  sub,
  invoices,
  cachedDisplay
) {
  const tryPm = (pm) => paymentMethodDisplayIfPresent(pm);
  const cache =
    cachedDisplay && typeof cachedDisplay === "object" && cachedDisplay.label
      ? {
          label: String(cachedDisplay.label),
          expiry: (cachedDisplay.expiry || "").toString(),
        }
      : null;

  // Prefer already-expanded default_payment_method (no extra Stripe round-trip).
  const dpm = sub && sub.default_payment_method;
  if (dpm && typeof dpm === "object") {
    const display = tryPm(dpm);
    if (display) return display;
  } else if (typeof dpm === "string" && dpm.trim()) {
    const display = tryPm(await retrievePaymentMethod(stripe, dpm.trim()));
    if (display) return display;
  }

  // Tenant cache beats the expensive waterfall when expand/id had no card display.
  if (cache) return cache;

  if (sub && sub.id) {
    try {
      const subFresh = await stripe.subscriptions.retrieve(sub.id, {
        expand: ["default_payment_method"],
      });
      const display = tryPm(
        await paymentMethodFromRef(stripe, subFresh.default_payment_method)
      );
      if (display) return display;
    } catch (_) {}
  }

  const cust = await stripe.customers.retrieve(stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method", "default_source"],
  });
  if (!cust.deleted) {
    let display = tryPm(
      await paymentMethodFromRef(
        stripe,
        cust.invoice_settings && cust.invoice_settings.default_payment_method
      )
    );
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
    const display = tryPm(item);
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
  const planToWrite = subscriptionPlanFromStripe(
    tenant && tenant.subscriptionPlan,
    planNorm,
    sub
  );
  if (planToWrite) {
    syncPatch.subscriptionPlan = planToWrite;
    Object.assign(syncPatch, subscriptionPlanEntitlementPatch(tenant, planToWrite));
  }
  try {
    if (sub) {
      const extraPriceIds = stripeSmsExtraPriceIds();
      const stripeQty = smsExtraQuantityFromSubscription(sub, extraPriceIds);
      syncPatch.smsExtraLineQuantity = Math.max(0, stripeQty);
    }
  } catch (_) {
    /* smsExtra price optional during sync */
  }
  await sms.syncSubscriptionStatusForTenant(tenantId, status, syncPatch);

  const refreshed = await db.collection("tenants").doc(tenantId).get();
  return {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId || "",
    subscriptionStatus: status,
    tenant: refreshed.exists ? refreshed.data() : tenant,
  };
}
function serializeMessagingFields(tenant, ownerUserData, lineSummary) {
  const subscriptionStatus = sms.resolveSubscriptionStatus(tenant, ownerUserData);
  const paid = sms.tenantHasPaidSubscription(tenant, ownerUserData);
  const trialing = sms.tenantIsTrialing(tenant, ownerUserData);
  // "Can use" here means texting is set up and paid for. The "Send client text notifications"
  // switch is deliberately left out: the app only shows that switch when this is true, so
  // counting it would hide the switch for good once it had been turned off.
  const canUse = sms.tenantCanUseSms(tenant, ownerUserData, null);
  const usage = sms.smsMonthlyUsageForTenant(tenant);
  const stripeCustomerId = ((tenant && tenant.stripeCustomerId) || "").toString().trim();
  const plan = normalizeSubscriptionPlan(
    (tenant && tenant.subscriptionPlan) ||
      (ownerUserData && ownerUserData.subscriptionPlan)
  );
  const lines =
    lineSummary ||
    sms.buildSmsLineSummary(tenant, plan, 0);
  return {
    subscriptionStatus,
    subscriptionPaid: paid,
    subscriptionTrialing: trialing,
    stripeCustomerId,
    hasStripeBillingCustomer: stripeCustomerId.length > 0,
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
    smsFreeIncluded: lines.freeIncluded,
    smsMaxLines: lines.maxLines,
    smsLinesUsed: lines.used,
    smsLineCapacity: lines.capacity,
    smsExtraPaid: lines.paidExtras,
    smsFreeRemaining: lines.freeRemaining,
    smsNeedsPurchaseForNextLine: lines.needsPurchaseForNext,
    smsNeedsMonthlyExtraForNextLine: !!lines.needsMonthlyExtraForNext,
    smsNeedsOneTimePurchaseForNextLine: !!lines.needsOneTimePurchaseForNext,
    smsAtMaxLines: lines.atMax,
    smsCanAddWithoutPurchase: lines.canAddWithoutPurchase,
    smsCanPurchaseExtra: lines.canPurchaseExtra,
    smsCanPurchaseSoloReplacement: !!lines.canPurchaseSoloReplacement,
    smsExtraMonthlyPriceCents: lines.extraMonthlyPriceCents,
    smsExtraMonthlyPriceLabel: lines.extraMonthlyPriceLabel,
    smsExtraOneTimeReplacementCents: lines.extraOneTimeReplacementCents || SMS_EXTRA_MONTHLY_CENTS,
    smsExtraOneTimeReplacementLabel: lines.extraOneTimeReplacementLabel || "$12.99",
    smsNextLineIsFree: lines.nextIsFree,
    smsLifetimeNumbersBought: lines.lifetimeNumbersBought || 0,
    // Refresh that buys a new Twilio number: free only within lifetime allotment
    // (Solo 1 · Studio/Shop 2). No visible counter — boolean for confirm copy.
    smsRefreshNeedsPurchase: sms.smsRefreshNeedsPurchase(
      tenant,
      plan,
      lines.used
    ),
    smsPhonePurchasingBlockedDuringTestFlight:
      sms.isSmsPhonePurchasingBlockedDuringTestFlight(tenant) === true,
    smsPhonePurchaseBlockMessage: (sms.smsPhonePurchaseBlockReason(tenant) || "").toString(),
  };
}
async function messagingFieldsWithLineCount(tenantId, tenant, ownerUserData, userDocsOpt) {
  const plan = normalizeSubscriptionPlan(
    (tenant && tenant.subscriptionPlan) ||
      (ownerUserData && ownerUserData.subscriptionPlan)
  );
  let snapDocs =
    userDocsOpt ||
    (await db.collection("users").where("tenantId", "==", tenantId).get()).docs;

  // Drop Firestore lines whose Twilio SIDs are gone (prevents ghost Active numbers).
  try {
    const reconciled = await sms.reconcileStaleSmsLinesInFirestore(
      tenantId,
      tenant,
      snapDocs
    );
    if (reconciled.cleared > 0) {
      tenant = reconciled.tenant;
      snapDocs = (
        await db.collection("users").where("tenantId", "==", tenantId).get()
      ).docs;
    }
  } catch (e) {
    console.warn("messagingFieldsWithLineCount reconcile", e.message || e);
  }

  const used = sms.countOccupiedSmsLinesFromDocs(tenant, snapDocs);
  let tenantForSummary = tenant;
  if (plan === "studio" || plan === "shop") {
    try {
      const stripe = stripeClientFromSecret();
      if (stripe) {
        const synced = await reconcileSmsExtraPaidToUsage(
          stripe,
          tenantId,
          tenant,
          plan,
          used
        );
        tenantForSummary = synced.tenant;
      }
    } catch (e) {
      console.error(
        "messagingFieldsWithLineCount sync extras",
        tenantId,
        e.message || e
      );
    }
  }
  const lineSummary = sms.buildSmsLineSummary(tenantForSummary, plan, used);
  const fields = serializeMessagingFields(tenantForSummary, ownerUserData, lineSummary);
  const assignments = listSmsLineAssignmentsForBillingFromDocs(
    tenantForSummary,
    lineSummary,
    snapDocs
  );
  const eligible = listSmsEligibleMembersForBillingFromDocs(tenantForSummary, snapDocs);
  return {
    ...fields,
    smsLineAssignments: assignments,
    smsEligibleMembers: eligible,
  };
}
/** Independent teammates without an active/pending personal line (for assign-on-billing). */
function listSmsEligibleMembersForBillingFromDocs(tenant, userDocs) {
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const out = [];
  for (const doc of userDocs || []) {
    if (ownerUid && doc.id === ownerUid) continue;
    const d = typeof doc.data === "function" ? doc.data() || {} : doc || {};
    if (sms.memberPayoutMode(d) !== "independent") continue;
    const status = (d.smsStatus || "off").toString().trim().toLowerCase();
    const phone = (d.smsPhoneNumber || "").toString().trim();
    if (status === "active" || status === "pending") continue;
    if (phone) continue;
    const fn = (d.firstName || "").toString().trim();
    const ln = (d.lastName || "").toString().trim();
    const name =
      (d.displayName || d.name || `${fn} ${ln}`.trim() || "Team member").toString().trim() ||
      "Team member";
    out.push({
      memberUid: doc.id,
      name,
      accessRole: (d.accessRole || d.role || "member").toString(),
      jobTitle: (d.jobTitle || "").toString(),
    });
  }
  out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return out;
}
async function listSmsEligibleMembersForBilling(tenantId, tenant) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  return listSmsEligibleMembersForBillingFromDocs(tenant, snap.docs);
}
/** Active / pending lines + unassigned unlocked slots for billing Client texting UI. */
function listSmsLineAssignmentsForBillingFromDocs(tenant, lineSummary, userDocs) {
  const out = [];
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const studioStatus = ((tenant && tenant.smsStatus) || "off").toString();
  const studioPhone = ((tenant && tenant.smsPhoneNumber) || "").toString().trim();
  if (sms.countsAsOccupiedSmsLine(studioStatus) || studioPhone) {
    const studioUsage = sms.smsMonthlyUsageForTenant(tenant);
    out.push({
      kind: "studio",
      name: "Studio",
      role: "Business line",
      phone: studioPhone,
      status: studioStatus || (studioPhone ? "active" : "off"),
      smsMonthlyUsageCount: studioUsage.count,
      smsMonthlyLimit: studioUsage.limit,
      smsMonthlyUsageRemaining: studioUsage.remaining,
    });
  }

  for (const doc of userDocs || []) {
    if (ownerUid && doc.id === ownerUid) continue;
    const d = typeof doc.data === "function" ? doc.data() || {} : doc || {};
    const status = (d.smsStatus || "off").toString();
    const phone = (d.smsPhoneNumber || "").toString().trim();
    const requestPending = d.smsLineRequestPending === true;
    if (!sms.countsAsOccupiedSmsLine(status) && !phone && !requestPending) continue;
    const fn = (d.firstName || "").toString().trim();
    const ln = (d.lastName || "").toString().trim();
    const name =
      (d.displayName || d.name || `${fn} ${ln}`.trim() || "Team member").toString().trim() ||
      "Team member";
    const usage = sms.smsMonthlyUsageForMember(d, tenant);
    out.push({
      kind: "personal",
      name,
      role: "Personal line",
      phone: phone,
      status: requestPending && status !== "active" ? "requested" : status,
      memberUid: doc.id,
      smsMonthlyUsageCount: usage.count,
      smsMonthlyLimit: usage.limit,
      smsMonthlyUsageRemaining: usage.remaining,
    });
  }

  const used = lineSummary && typeof lineSummary.used === "number" ? lineSummary.used : out.length;
  const freeIncluded =
    lineSummary && typeof lineSummary.freeIncluded === "number"
      ? lineSummary.freeIncluded
      : 0;
  const nextIsFree = !!(lineSummary && lineSummary.nextIsFree);
  const open = nextIsFree ? Math.max(0, freeIncluded - used) : 0;
  const openSlotLimit = sms.maxSmsMessagesForPlan(tenant && tenant.subscriptionPlan);
  for (let i = 0; i < open; i++) {
    out.push({
      kind: "open",
      name: "Unassigned slot",
      role: "Available capacity",
      phone: "",
      status: "open",
      smsMonthlyUsageCount: 0,
      smsMonthlyLimit: openSlotLimit,
      smsMonthlyUsageRemaining: openSlotLimit,
    });
  }
  return out;
}
async function listSmsLineAssignmentsForBilling(tenantId, tenant, lineSummary) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  return listSmsLineAssignmentsForBillingFromDocs(tenant, lineSummary, snap.docs);
}
/**
 * Web sign-up, card before the account is finished (Terms §8: a card is required for the free trial).
 * Step 1: a Stripe SetupIntent for the new owner, so the card form on the plan step can save the card.
 * Returns { clientSecret, publishableKey }.
 */
async function assertSignupTrialOwner(uid) {
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError("permission-denied", "Only the business owner can add billing.");
  }
  if ((ctx.tenant.stripeSubscriptionId || "").toString().trim()) {
    throw new functions.https.HttpsError("failed-precondition", "Billing is already set up for this business.");
  }
  if (sms.resolveSubscriptionStatus(ctx.tenant, ctx.ownerUserData) !== "trialing") {
    throw new functions.https.HttpsError("failed-precondition", "Your trial has ended or billing is not available in this state. Contact support.");
  }
  return ctx;
}
/**
 * Owner: add one paid SMS line capacity ($12.99 flat now + $12.99/mo recurring).
 * Charges a one-time $12.99 invoice (no proration), then adds the smsExtra seat
 * with proration_behavior none. Free included slots must be used first.
 * Does not provision a number — returns a short-lived auth for requestSmsPhoneNumber.
 */
/** Reserves a verified App Store texting-number purchase, as a callable error when it can't be. */
async function claimAppleSmsExtraPurchase(params) {
  try {
    return await appleSubscription.claimSmsExtraPurchase(params);
  } catch (error) {
    const code = (error && error.code) || "";
    if (code === "already-used") {
      throw new functions.https.HttpsError("already-exists", error.message);
    }
    if (code === "wrong-account") {
      throw new functions.https.HttpsError("permission-denied", error.message);
    }
    if (code === "unverified" || code === "refunded") {
      throw new functions.https.HttpsError("failed-precondition", error.message);
    }
    throw error;
  }
}
/**
 * One-time $12.99 charge for a texting-number replacement after the lifetime
 * free allotment is used (Solo 1 · Studio/Shop 2). Does not change seat qty.
 */
async function chargeOneTimeSmsNumberReplacementFee(stripe, tenant) {
  return chargeOneTimeSmsExtraFee(
    stripe,
    tenant,
    "Get Bookking texting number replacement ($12.99)"
  );
}
/**
 * Who can act on an SMS conversation: personal-line threads stay with that teammate;
 * studio threads need owner or manager. Same rules as sendClientSms.
 */
function assertCanUseSmsThread(ctx, uid, requestedThreadId, threadData) {
  const isOwner = ctx.isOwner;
  // Personal-line threads stay with that teammate — owners/managers cannot reply there.
  if (sms.isLineScopedThreadId(requestedThreadId)) {
    const assigned = ((threadData && threadData.assignedMemberUid) || "").toString().trim();
    if (assigned) {
      if (uid !== assigned) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "This conversation belongs to another teammate's texting line."
        );
      }
    } else {
      const senderDigits = ((ctx.userData && ctx.userData.smsPhoneNumber) || "")
        .toString()
        .replace(/\D/g, "");
      const lineDigits = requestedThreadId.split("_c")[0].replace(/^l/, "");
      if (!senderDigits || senderDigits !== lineDigits) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "This conversation belongs to another teammate's texting line."
        );
      }
    }
  } else if (threadData && !sms.isStudioSmsThread({ ...threadData, threadId: requestedThreadId })) {
    const assigned = ((threadData.assignedMemberUid || "")).toString().trim();
    if (uid !== assigned) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "This conversation belongs to another teammate's texting line."
      );
    }
  } else if (
    !isOwner &&
    ctx.accessRole !== "manager" &&
    sms.memberPayoutMode(ctx.userData) === "independent" &&
    (ctx.userData.smsStatus || "") === "active" &&
    (ctx.userData.smsPhoneNumber || "").toString().trim()
  ) {
    // New compose from personal-line member — OK (routes to their number).
  } else if (!isOwner && ctx.accessRole !== "manager") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to send on the studio texting line."
    );
  }
}
/** Load an SMS conversation the caller may use, plus the client's phone. */
async function loadSmsThreadForCaller(context, data) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (
    !sms.canSendClientSms({
      isOwner: ctx.isOwner,
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
  const threadId = ((data && data.threadId) || "").toString().trim();
  if (!threadId || threadId.includes("/")) {
    throw new functions.https.HttpsError("invalid-argument", "Choose a conversation.");
  }
  const threadRef = db.collection("tenants").doc(ctx.tenantId).collection("smsThreads").doc(threadId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Conversation not found.");
  }
  const threadData = threadSnap.data() || {};
  assertCanUseSmsThread(ctx, context.auth.uid, threadId, threadData);
  const clientPhone =
    sms.toE164US(threadData.counterpartPhone) ||
    sms.toE164US(threadId.includes("_c") ? threadId.split("_c").pop() : threadId) ||
    "";
  return { ctx, threadId, threadRef, threadData, clientPhone };
}
async function provisionTenantSms(tenantId, tenant, opts) {
  return sms.provisionTenantSms(tenantId, tenant, opts);
}
async function provisionMemberSms(tenantId, tenant, memberUid, memberData, opts) {
  return sms.provisionMemberSms(tenantId, tenant, memberUid, memberData, opts);
}
async function loadCharterItineraryStepsForSms(tenantId, booking) {
  const svc = await loadCharterServiceDoc(
    tenantId,
    booking && booking.serviceId,
    booking && booking.serviceSlug
  );
  if (!svc || !Object.prototype.hasOwnProperty.call(svc, "itinerary")) return [];
  if (!Array.isArray(svc.itinerary)) return [];
  const steps = [];
  for (let i = 0; i < svc.itinerary.length; i++) {
    const row = svc.itinerary[i] || {};
    const text = String(row.text || "").trim();
    if (!text) continue;
    const off = Number(row.offsetMinutes);
    steps.push({ offsetMinutes: Number.isFinite(off) ? off : 0, text });
  }
  return steps;
}
/** Guest SMS on charter request submit, confirm, and decline. */
async function sendBookingClientStatusSms(tenantId, requestId, booking, status) {
  const next = (status || "").toString().toLowerCase();
  if ((booking.source || "").toString().toLowerCase() === "seed") return null;

  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) return null;
  const tenant = tenantSnap.data() || {};
  const isCharter = normalizeSubscriptionPlan(tenant.subscriptionPlan) === "charter";

  const allowed = isCharter
    ? next === "new" || next === "confirmed" || next === "declined" || next === "cancelled" || next === "canceled"
    : next === "confirmed" || next === "declined";
  if (!allowed) return null;

  const ownerUid = tenant.ownerUid;
  let ownerData = null;
  if (ownerUid) {
    const o = await db.collection("users").doc(ownerUid).get();
    if (o.exists) ownerData = o.data();
  }
  const blockReason = sms.smsEligibilityBlockReason(
    tenant,
    ownerData,
    isCharter ? {} : tenant.managerPermissions
  );
  if (blockReason) {
    console.warn("sendBookingClientStatusSms skipped", requestId, blockReason);
    return null;
  }

  const to = sms.extractCustomerPhone(booking);
  if (!to) {
    console.warn("sendBookingClientStatusSms skipped", requestId, "no customer phone");
    return null;
  }

  const source = (booking.source || "").toString().toLowerCase();
  // Charter web checkout already requires a mobile number + SMS checkbox.
  // Deposit confirms were dropping because older checkout writes omitted smsConsentAccepted.
  const consented =
    booking.smsConsentAccepted === true ||
    (isCharter && source === "web");
  if (consented) {
    try {
      await sms.ensureWebBookingSmsConsent(tenantId, to, {
        name: booking.customerName,
        email: booking.customerEmail,
      });
    } catch (e) {
      console.warn("ensureWebBookingSmsConsent", requestId, e && e.message ? e.message : e);
    }
  }

  let body;
  if (isCharter && next === "new") {
    body = sms.charterRequestReceivedSmsBody(tenant, booking);
  } else if (isCharter && next === "confirmed") {
    const steps = await loadCharterItineraryStepsForSms(tenantId, booking);
    body = sms.charterConfirmationSmsBody(tenant, booking, steps);
  } else if (isCharter && (next === "cancelled" || next === "canceled")) {
    body = sms.charterCancelledSmsBody(tenant, booking);
  } else {
    body = sms.bookingStatusSmsBody(tenant, next, booking);
  }
  if (!body) {
    console.warn("sendBookingClientStatusSms skipped", requestId, "empty body", next);
    return null;
  }

  try {
    await sms.sendTenantSms(
      tenantId,
      tenant,
      to,
      body,
      {
        bookingRequestId: requestId,
        threadId: sms.threadIdFromPhone(to),
        clientName: (booking.customerName || "").toString(),
        smsConsentAccepted: consented,
      },
      ownerData
    );
  } catch (e) {
    console.error("sendBookingClientStatusSms", requestId, e);
  }
  return null;
}
function passwordResetMarketingOrigin() {
  return (marketingOriginParam.value() || "https://getbookking.com").toString().trim().replace(/\/+$/, "")
    || "https://getbookking.com";
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
const { assertPlatformAdmin } = require("./platformAdmin");
const { registerPublicSiteFunctions } = require("./publicSite");
const { registerTapToPayLaunchEmailFunctions } = require("./tapToPayLaunchEmail");
const { registerTrialReminderFunctions } = require("./trialReminderEmail");
const { registerMcpFunctions } = require("./mcp");
const { registerCustomDomainFunctions } = require("./customDomain");
function escapeEmailHtml(text) {
  return (text || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
/**
 * Tells the shop owner about something on their account (e.g. their domain): an app notification,
 * a notice kept in the app's activity center, and an email. Each part is tried on its own.
 */
async function notifyOwnerAboutAccount({ tenantId, tenant, title, body, emailSubject }) {
  const ownerUid = (tenant.ownerUid || "").toString().trim();
  if (!ownerUid) return;
  try {
    const tokens = await collectDeviceTokensForUids([ownerUid]);
    await sendBookingAlertPush({ tokens, title, body, data: { type: "account_notice", kind: "domain" } });
  } catch (e) {
    console.warn("notifyOwnerAboutAccount push", tenantId, e.message || e);
  }
  try {
    await db.collection("tenants").doc(tenantId).collection("accountNotices").add({
      kind: "domain",
      title,
      body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn("notifyOwnerAboutAccount notice", tenantId, e.message || e);
  }
  try {
    const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
    const ownerSnap = await db.collection("users").doc(ownerUid).get();
    const email = ownerSnap.exists ? ((ownerSnap.data() || {}).email || "").toString().trim() : "";
    if (!resendApiKey || !email) return;
    const from = (process.env.PASSWORD_RESET_EMAIL_FROM || "Get Bookking <noreply@getbookking.com>").trim();
    const replyTo = (process.env.SUPPORT_EMAIL || "support@getbookking.com").trim();
    const html = [
      "<p>Hello,</p>",
      "<p>" + escapeEmailHtml(body) + "</p>",
      "<p>Questions? Just reply to this email.</p>",
      "<p>Thanks,<br>Your Get Bookking team</p>",
    ].join("\n");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + resendApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: email, subject: emailSubject || title, html, reply_to: replyTo }),
    });
    if (!res.ok) console.warn("notifyOwnerAboutAccount email", tenantId, res.status, await res.text());
  } catch (e) {
    console.warn("notifyOwnerAboutAccount email", tenantId, e.message || e);
  }
}


// Shared with the area files (connectPayments.js, checkout.js, ...).
module.exports = {
  functions,
  onCall,
  HttpsError,
  defineSecret,
  defineString,
  shippoShop,
  platformFeeCents,
  computeCardCheckoutAmounts,
  checkoutMethodId,
  checkoutRateForChannel,
  admin,
  crypto,
  Stripe,
  formSchemaForIndustry,
  guidedStepTitlesForIndustry,
  defaultServicesByIndustry,
  resolveWebThemeId,
  slugFromBusiness,
  normalizeIndustry,
  sms,
  teamPaymentSplit,
  isDemoShowcaseStripeAccountId,
  loadDemoShowcaseForPayCtx,
  demoConnectAccountStatusResponse,
  demoConnectBalanceResponse,
  demoConnectTransactionsResponse,
  ALLOWED_DEMO_APP_SLUGS,
  buildDemoAppSnapshot,
  charterOccupancy,
  appleSubscription,
  stripeSecretKey,
  walletDomains,
  openaiApiKey,
  shippoApiToken,
  stripeSubscriptionPriceIds,
  stripeWebhookSecret,
  stripeConnectWebhookSecret,
  stripePublishableKeyParam,
  marketingOriginParam,
  db,
  normalizeCustomerPhone,
  customerDocIdForTenant,
  normalizeSubscriptionPlan,
  isSingleOperatorPlan,
  US_STATE_ABBRS,
  titleCaseCityWords,
  composeServiceArea,
  parseStripeSubscriptionPriceIds,
  PROVIDER_SIGNUP_TRIAL_DAYS,
  readFirestoreTimestampMs,
  providerTrialEndUnixFromTenant,
  planListPriceCents,
  stripePriceIdForPlan,
  stripeSmsExtraPriceId,
  stripeSmsExtraPriceIds,
  subscriptionItemPriceId,
  smsExtraQuantityFromSubscription,
  smsExtraSubscriptionItems,
  syncSmsExtraLineQuantityToTenant,
  migrateSmsExtraLegacyToPrimary,
  SMS_EXTRA_MONTHLY_CENTS,
  resolveTenantStripeSubscriptionId,
  readSmsExtraQuantityOnStripe,
  SMS_ADD_ON_PURPOSE,
  usesSmsAddOnBilling,
  smsLineBilling,
  SMS_ADD_ON_LIVE_STATUSES,
  applySmsAddOnLineQuantity,
  applySmsExtraLineQuantity,
  resolveChargeablePaymentMethodId,
  chargeOneTimeSmsExtraFee,
  reconcileSmsExtraPaidToUsage,
  backfillPaidSmsLineTags,
  maybeReduceSmsExtraAfterReleasingOccupiedLine,
  stripeClientFromSecret,
  normalizeSignupWizardPayload,
  provisionNewProviderFromWizard,
  finalizeFromCheckoutSession,
  finalizeResubscribeFromCheckoutSession,
  finalizeInitialSubscriptionFromCheckoutSession,
  planNormFromPriceId,
  planNormFromStripeSubscription,
  planNormFromMetadata,
  subscriptionPlanFromStripe,
  subscriptionPlanEntitlementPatch,
  deactivateTenantPaymentLinks,
  syncSmsAddOnSubscription,
  cancelSmsAddOnSubscription,
  syncStripeSubscriptionStatusToTenant,
  connectAccountPriority,
  createStandardConnectAccount,
  reconcileConnectAccountId,
  replaceExpressWithStandardConnectAccount,
  ensureConnectAccountId,
  ensureNoNegativeBalanceBankDebits,
  connectAccountPendingReview,
  createConnectAccountLinkWithFallback,
  connectAccountStatusUrl,
  PROCESSING_SERVICE_FEE_LABEL,
  computeInPersonCheckoutTotals,
  createCustomerCheckoutPaymentIntent,
  pricedCustomerCheckoutFromMetadata,
  stripeAccountIdForCheckout,
  parseServiceAmountCents,
  paidFeatureAccessForTenant,
  assertPaidFeatureAccessForTenant,
  assertPublicPaymentAccessForTenant,
  resolvePaymentStripeContext,
  getStripeAccountIdForUser,
  assertCanTakePayments,
  ensureStripeAccountForTapToPayContext,
  memberDisplayNameFromUserData,
  resolveEffectivePaymentContext,
  assertCanInitiateBookingPayment,
  assertCanTapToPayForBooking,
  retrievePaymentIntentOnConnectAccounts,
  getTenantIdForUser,
  assertTenantOwner,
  terminalAddressFromTenant,
  tapToPayTerminalDisplayNameForTenant,
  tapToPayTerminalDisplayNameForUser,
  tapToPayRequireSignatureForTenant,
  tapToPayRequireSignatureForUser,
  tapToPayAutoOfferReceiptForTenant,
  tapToPayAutoOfferReceiptForUser,
  TAP_TO_PAY_RECEIPT_DELIVERY,
  tapToPayReceiptDeliveryForTenant,
  tapToPayReceiptDeliveryForUser,
  tapToPayReceiptPreferencesForScope,
  parseTapToPayReceiptPreferencesInput,
  receiptPreferencesResponse,
  tapToPayPaymentSettingsForScope,
  isStripeResourceMissing,
  retrieveTerminalLocationOrNull,
  syncTerminalLocationDisplayNameIfNeeded,
  ensureStripeTerminalLocationForTenant,
  ensureStripeTerminalLocationForUser,
  instantAvailableCentsFromBalance,
  formatExternalAccountLabel,
  supportsInstantPayout,
  loadPayoutDestinationLabels,
  chargeIdFromExpandedBalanceSource,
  paymentIntentIdFromExpandedBalanceSource,
  resolveChargeIdForBalanceSourceId,
  enrichConnectBalanceTransaction,
  firestoreTimestampToSeconds,
  cancelRefundStatusBlocksManualRefund,
  cancelRefundBlockMessage,
  collectCancelRefundMatchIds,
  transactionMatchesCancelRefundIds,
  loadCancelRefundBlockForCharge,
  stripeHasRefundForPendingRow,
  applyCancelRefundBlocksToTransactions,
  loadCancelRefundBookingRows,
  pendingCancelRefundTransactionRows,
  receiptServiceLabel,
  receiptLineItemsFromAmounts,
  findPaymentLedgerEntry,
  refundConnectCharge,
  isUnsettledRefundError,
  stripeObjectId,
  feeBasisFromLedger,
  refundConnectApplicationFeeIfNeeded,
  recordConnectRefundOnLedger,
  syncShopOrderRefundFromConnectPayment,
  syncBookingCancelRefundFromWebhook,
  handleConnectRefundWebhook,
  connectAccountIdsForBookingRefund,
  refundBookingPaymentIfNeeded,
  cancelRefundPatchFromResult,
  charterOccupyingStatus,
  charterParseTimeToMin,
  reserveCharterSlot,
  fetchTenantProductsById,
  validatedCharterAddons,
  SHOP_PRODUCT_TAX_CODE,
  SERVICE_TAX_CODE,
  shopTaxAddressFromTenant,
  calculateSalesTaxFromLineItems,
  calculateShopSalesTax,
  calculateServiceSalesTax,
  maybeCalculateInPersonSalesTax,
  recordShopTaxTransactionFromCalculation,
  buildValidatedShopLineItems,
  resolvePublicShopTenant,
  assertTenantShopStripeReady,
  upsertShopCheckoutCustomer,
  shopOrderReceiptResponse,
  markShopOrderPaidFromPaymentIntent,
  publicWebCallableOptions,
  checkoutMethodFromPaymentMethod,
  publicShopCallableOptions,
  readShippoTokenOrThrow,
  resolvePublicCharterTenant,
  charterServicePriceCents,
  charterPayModeFromTenant,
  loadCharterServiceDoc,
  markCharterBookingPaidFromPaymentIntent,
  collectDeviceTokensForUids,
  resolveBookingAlertRecipientUids,
  sendBookingAlertPush,
  bookingRequestAlertCopy,
  bookingCancelledAlertCopy,
  mirrorAppleSubscriptionStatus,
  expectedStripeLivemode,
  isRetryableWebhookError,
  handleConnectDisputeWebhook,
  TENANT_INVITE_TTL_MS,
  DEFAULT_MANAGER_PERMISSIONS,
  DEFAULT_TENANT_WORKFLOW,
  defaultWorkflowForPlan,
  applyCharterBookingWorkflow,
  bookingRequiresApproval,
  confirmBookingAfterDepositPaid,
  canManageAppointmentTime,
  canApproveRejectBookingRequests,
  managersApproveAppointments,
  resolveTenantWorkflow,
  resolveEffectiveBookingWorkflow,
  getMemberAccessContext,
  DEFAULT_MANAGER_NOTIFICATIONS,
  parseAccessRole,
  parseInviteAccessRole,
  normalizeJobTitle,
  PAYMENT_SPLIT_APPLIES,
  PAYOUT_MODES,
  memberUsesOwnConnect,
  normalizePayoutMode,
  normalizeMemberSettings,
  paymentKindMatchesSplit,
  computeTeamPaymentSplit,
  buildTeamSplitFeeAndMetaForCharge,
  resolveAttributedMemberUid,
  loadBookingRequestForPayment,
  defaultJobTitleForIndustry,
  assertTenantOwnerUid,
  RESERVED_PROVIDER_SLUGS,
  MAX_PROVIDER_GALLERY_IMAGES,
  normalizeProviderGalleryImages,
  slugFromPersonName,
  normalizeMemberSlugInput,
  allocateMemberSlug,
  ensureUserMemberSlug,
  resolveMemberIsBookable,
  resolveShowOnTeamPage,
  resolveShowOnTeamHome,
  TERMINAL_BOOKING_STATUSES,
  isTerminalBookingStatus,
  attachAssignedMemberToBookingData,
  pickMemberForFirstAvailable,
  defaultMemberSettingsForInvite,
  serializePublicProvider,
  serializeTeamRosterMember,
  resolveTenantBySlug,
  serializeTeamMember,
  maxSeatsForPlanNormalized,
  countUsersForTenant,
  parseInviteToken,
  SEED_CONFIRM,
  MAX_SEED_COUNT,
  writeSeedBookingRequests,
  unassignMemberFromTenantRecords,
  TENANT_SUBCOLLECTIONS,
  parseLifecycleConfirmPhrase,
  deleteFirestoreQueryInBatches,
  deleteCollectionRef,
  deleteUserDeviceTokens,
  deleteStoragePrefix,
  deleteUserProfileStorage,
  UNLINK_TENANT_USER_PATCH,
  unlinkUsersFromTenant,
  countOtherTeamMembers,
  cancelTenantStripeSubscription,
  deleteTenantInvitesForTenant,
  releaseTenantTextingNumbers,
  SMS_LAPSED_NUMBER_GRACE_DAYS,
  deleteTenantData,
  deleteUserFirestoreAndAuth,
  memberIndependentStripeAccountId,
  getConnectUsdBalanceCents,
  assessMemberStripeDeletionBlock,
  BILLING_PORTAL_RETURN_ORIGINS,
  isAllowedReturnOrigin,
  billingPortalReturnBase,
  stripeErrorMessage,
  formatPaymentMethodLabel,
  formatPaymentMethodExpiry,
  paymentMethodDisplayFromPm,
  paymentMethodDisplayFromCard,
  retrievePaymentMethod,
  paymentMethodDisplayFromCharge,
  paymentMethodDisplayFromChargeAsync,
  paymentMethodDisplayIfPresent,
  paymentMethodFromRef,
  paymentMethodFromPaidInvoice,
  resolvePaymentMethodForCustomer,
  linkAndSyncTenantStripeBilling,
  serializeMessagingFields,
  messagingFieldsWithLineCount,
  listSmsEligibleMembersForBillingFromDocs,
  listSmsEligibleMembersForBilling,
  listSmsLineAssignmentsForBillingFromDocs,
  listSmsLineAssignmentsForBilling,
  assertSignupTrialOwner,
  claimAppleSmsExtraPurchase,
  chargeOneTimeSmsNumberReplacementFee,
  assertCanUseSmsThread,
  loadSmsThreadForCaller,
  provisionTenantSms,
  provisionMemberSms,
  loadCharterItineraryStepsForSms,
  sendBookingClientStatusSms,
  passwordResetMarketingOrigin,
  parsePasswordResetOobLink,
  assertPlatformAdmin,
  registerPublicSiteFunctions,
  registerTapToPayLaunchEmailFunctions,
  registerTrialReminderFunctions,
  registerMcpFunctions,
  registerCustomDomainFunctions,
  escapeEmailHtml,
  notifyOwnerAboutAccount,
};
