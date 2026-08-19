/**
 * Cloud Functions for Get Bookking.
 * Set secrets:
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set OPENAI_API_KEY
 *   firebase functions:secrets:set SHIPPO_API_TOKEN
 *     (Shippo API token — use shippo_test_… while developing shop shipping)
 *   firebase functions:secrets:set STRIPE_SUBSCRIPTION_PRICE_IDS
 *     (JSON map solo/studio/shop/charter → price_… and optional smsExtra $12/mo add-on;
 *      copy from stripe-subscription-price-ids.example.json or Stripe Dashboard)
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
 */

const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const shippoShop = require("./shippoShop");
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

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
/** Shippo API token (shippo_test_… or live). Rates-only at checkout — Bookking never buys labels. */
const shippoApiToken = defineSecret("SHIPPO_API_TOKEN");
/** JSON map: solo, studio, shop, charter → Stripe Price id; optional smsExtra ($10/mo per extra SMS line). */
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

/** Optional $12/mo recurring price for SMS numbers beyond free included (Studio/Shop). */
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
        "for the $12/mo extra texting number (Stripe product)."
    );
  }
  const trimmed = String(id).trim();
  if (trimmed.includes("REPLACE") || !trimmed.startsWith("price_")) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      'Create a $12/mo Stripe Price for extra SMS lines and set "smsExtra" in STRIPE_SUBSCRIPTION_PRICE_IDS.'
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
 * without invoicing, so price rotations ($10 → $12) never double-charge.
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
const SMS_EXTRA_MONTHLY_CENTS = 1200;

/**
 * Set Stripe smsExtra subscription quantity (0 deletes items) and mirror on the tenant.
 * Legacy items are consolidated first with no invoice. Qty changes default to
 * proration_behavior "none" — purchases bill via a separate flat $12 invoice.
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
 * Flat $12 same-day charge via the same invoice collection path as their plan.
 * Creates a draft invoice, attaches the $12 line to that invoice (avoids empty
 * paid/$0 invoices when pending items are excluded), then pays it.
 */
async function chargeOneTimeSmsExtraFee(stripe, tenant, description) {
  const customerId = ((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!customerId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Billing is not set up. Complete subscription checkout first."
    );
  }
  const desc = (description || "Get Bookking extra texting number ($12)").toString();
  const subId = ((tenant && tenant.stripeSubscriptionId) || "").toString().trim();

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
    // Draft first, then attach the $12 line to THIS invoice — never rely on
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
        "Could not build the $12 texting-number invoice. Try again."
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
      `Stripe did not confirm the $12 texting-number payment` +
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
  await sms.syncSubscriptionStatusForTenant(tenantId, normalized, patch);
  if (normalized !== "active") {
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
 * Find the best Standard Connect account for an email (handles duplicate onboardings).
 * Express accounts are ignored so we never re-attach the older pricing-owner model.
 */
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
      if ((acct.type || "").toString() === "express") continue;
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

/** Create a Standard Connect account (Stripe is pricing owner for these users). */
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
 * Prefer the best Connect account for this email and persist stripeAccountId on accountRef.
 * Always considers platform accounts matching the email so we don't stick to incomplete shells
 * when a completed Standard account exists.
 */
async function reconcileConnectAccountId(stripe, accountRef, storedId, email) {
  const storedIdTrimmed = (storedId || "").toString().trim();

  let storedAccount = null;
  if (storedIdTrimmed) {
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
  }

  // Stored account already usable or in Stripe review — keep it (no email scan).
  if (
    storedAccount &&
    (storedAccount.charges_enabled || storedAccount.details_submitted)
  ) {
    return { stripeAccountId: storedIdTrimmed, account: storedAccount };
  }

  // No stored id: skip listing every Connect account (that scan times out on
  // large platforms). Caller creates a fresh Standard account instead.
  if (!storedIdTrimmed) return null;

  // Incomplete stored account: pick a better matching Standard account by email.
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
      from: storedIdTrimmed || null,
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

/**
 * If Firestore still points at a legacy Express account, replace with Standard
 * so pricing owner is Stripe (per Connect account type).
 * Reuses an existing Standard account for the email when possible (avoids duplicates).
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
  const existingStandard = await findBestConnectAccountForEmail(stripe, email);
  if (existingStandard && (existingStandard.type || "").toString() === "standard") {
    console.log("ensureConnectAccountId Express → reuse existing Standard", {
      from: account.id,
      to: existingStandard.id,
      email: (email || "").toString().trim(),
    });
    await accountRef.set({ stripeAccountId: existingStandard.id }, { merge: true });
    return { stripeAccountId: existingStandard.id, account: existingStandard };
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
      const tenantDoc = await tenantRef.get();
      const tenantData = tenantDoc.exists ? tenantDoc.data() : {};
      await assertPaidFeatureAccessForTenant(tenantId, tenantData);
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

    let stripeAccountId = payCtx.stripeAccountId;
    // Billing page passes skipEmailReconcile to avoid paging Stripe accounts.list by email.
    const skipEmailReconcile =
      data && (data.skipEmailReconcile === true || data.fast === true);
    if (!isDemoShowcaseStripeAccountId(stripeAccountId) && !skipEmailReconcile) {
      // Reuse best Standard account for this email when possible (fixes multi-shell linking).
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
        subscriptionPaid: paidFeatureAccess.paid,
        subscriptionTrialing: paidFeatureAccess.trialing,
        subscriptionStatus: paidFeatureAccess.status,
        paidFeatureUpgradeMessage: paidFeatureAccess.message,
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
    if (!/^[A-Z0-9 ]+$/.test(descriptor)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Use letters, numbers, and spaces only."
      );
    }

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
    if (!/^[A-Z0-9 ]+$/.test(prefix)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Card prefix: use letters, numbers, and spaces only."
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

    let updated;
    try {
      updated = await stripe.accounts.update(stripeAccountId, {
        settings: {
          payments: { statement_descriptor: descriptor },
          card_payments: { statement_descriptor_prefix: prefix },
        },
      });
    } catch (err) {
      console.error("updateStatementDescriptor", err);
      const msg =
        (err && err.message) ||
        "Could not update statement descriptor. Try a name closer to your business.";
      throw new functions.https.HttpsError("invalid-argument", msg);
    }

    return {
      statementDescriptor:
        (updated.settings?.payments?.statement_descriptor || "").toString().trim() ||
        descriptor,
      statementDescriptorPrefix:
        (updated.settings?.card_payments?.statement_descriptor_prefix || "")
          .toString()
          .trim() || prefix,
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
/** In-person 5¢ + Tap to Pay authorization 10¢ (Stripe Terminal US pricing). */
const STRIPE_CARD_PRESENT_FIXED_CENTS = 15;

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
  await assertPaidFeatureAccessForTenant(payCtx.tenantId);
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
  await assertPaidFeatureAccessForTenant(payCtx.tenantId);
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
    const paymentMeta = {
      tenantId: tenantId || "",
      paymentKind,
      serviceAmountCents: String(checkout.serviceCents),
      surchargeCents: String(checkout.surchargeCents),
      bookingRequestId,
      initiatedByUid: uid,
      attributedMemberUid,
      chargeStripeAccountId: stripeAccountId,
      chargeStripeScope: payCtx.scope || "tenant",
      ...splitFee.splitMeta,
    };
    const link = await stripe.paymentLinks.create(
      {
        line_items: lineItems,
        application_fee_amount: feeCents,
        metadata: paymentMeta,
        // Payment Link top-level metadata does NOT copy to the PaymentIntent.
        // Webhook settlement reads PI metadata — must set payment_intent_data.
        payment_intent_data: {
          metadata: paymentMeta,
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      url: link.url,
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
    const tenantDoc = tenantId
      ? await db.collection("tenants").doc(tenantId).get()
      : null;
    const tenantData = tenantDoc?.exists ? tenantDoc.data() || {} : {};
    const tax = await maybeCalculateInPersonSalesTax(
      stripe,
      stripeAccountId,
      tenantData,
      checkout.serviceCents
    );
    const taxCents = tax.taxCents || 0;
    const totalCents = checkout.totalCents + taxCents;
    const splitFee = await buildTeamSplitFeeAndMetaForCharge({
      tenant: tenantData,
      tenantId,
      payCtx,
      paymentKind,
      serviceCents: checkout.serviceCents,
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
          serviceAmountCents: String(checkout.serviceCents),
          taxCents: String(taxCents),
          surchargeCents: String(checkout.surchargeCents),
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
      platformFeeCents: splitFee.platformFeeCents,
      studioShareCents: splitFee.studioShareCents,
      serviceCents: checkout.serviceCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
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
  const src = t.source;
  if (src && typeof src === "object") {
    const meta = src.metadata || {};
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
    if (tenantId) {
      await teamPaymentSplit.reverseStudioShareOnRefund(stripe, {
        db,
        tenantId,
        chargeId,
        paymentIntentId: piId || null,
        refundCents,
        chargeCapturedCents: capturedCents,
        refundId: refund && refund.id,
      });
    }
  } catch (revErr) {
    console.error("refundConnectCharge studio share reverse", revErr.message || revErr);
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

async function refundBookingPaymentIfNeeded({
  stripe,
  tenant,
  tenantId,
  booking,
  requestId,
}) {
  const piId = (booking.stripePaymentIntentId || "").toString().trim();
  if (!piId.startsWith("pi_")) {
    return { refunded: false };
  }
  const stripeAccountId = (
    booking.chargeStripeAccountId ||
    (tenant && tenant.stripeAccountId) ||
    ""
  )
    .toString()
    .trim();
  if (!stripeAccountId.startsWith("acct_")) {
    return {
      refunded: false,
      refundError: "Stripe is not set up for refunds.",
    };
  }
  try {
    const pi = await stripe.paymentIntents.retrieve(piId, {
      stripeAccount: stripeAccountId,
      expand: ["latest_charge"],
    });
    if (pi.status !== "succeeded") {
      return { refunded: false };
    }
    const latest = pi.latest_charge;
    const chargeId =
      typeof latest === "string" ? latest : latest && latest.id;
    if (!chargeId || !String(chargeId).startsWith("ch_")) {
      return { refunded: false, refundError: "No charge found for this payment." };
    }
    const result = await refundConnectCharge({
      stripe,
      stripeAccountId,
      tenantId,
      chargeId: String(chargeId),
      amountCents: null,
      reason: "requested_by_customer",
      idempotencyKey: `cancel_booking_${tenantId}_${requestId}`,
      queueIfUnsettled: true,
    });
    const chargePatch = { chargeId: String(chargeId) };
    if (result.alreadyRefunded) {
      return { refunded: false, alreadyRefunded: true, ...chargePatch };
    }
    if (result.pendingSettlement) {
      return {
        refunded: false,
        refundPending: true,
        refundCents: result.refundCents,
        ...chargePatch,
      };
    }
    return { refunded: true, refundCents: result.refundCents, ...chargePatch };
  } catch (err) {
    const msg = (err && err.message) || "Refund failed.";
    if (isUnsettledRefundError(err)) {
      return { refunded: false, refundPending: true };
    }
    console.error("refundBookingPaymentIfNeeded", requestId, msg);
    return { refunded: false, refundError: msg };
  }
}

function cancelRefundPatchFromResult(refundResult) {
  if (!refundResult) return null;
  const chargeId = (refundResult.chargeId || "").toString().trim();
  const chargePatch = chargeId.startsWith("ch_") ? { stripeChargeId: chargeId } : {};
  if (refundResult.refunded) {
    return {
      ...chargePatch,
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundCents: refundResult.refundCents || 0,
      cancelRefundStatus: "refunded",
      cancelRefundError: admin.firestore.FieldValue.delete(),
    };
  }
  if (refundResult.alreadyRefunded) {
    return { ...chargePatch, cancelRefundStatus: "already_refunded" };
  }
  if (refundResult.refundPending) {
    return {
      ...chargePatch,
      cancelRefundStatus: "pending",
      cancelRefundQueuedAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelRefundError: admin.firestore.FieldValue.delete(),
    };
  }
  if (refundResult.refundError) {
    return {
      ...chargePatch,
      cancelRefundStatus: "failed",
      cancelRefundError: String(refundResult.refundError).slice(0, 500),
    };
  }
  return null;
}

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
 * Retries failed studio-share transfers (platform → studio Connect).
 * Runs every hour; also callable by ops if needed later.
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
  const isCharterPlan = normalizeSubscriptionPlan(tenantData.subscriptionPlan) === "charter";
  if (isCharterPlan && (!customerPhone || !smsConsentAccepted)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "A mobile number and SMS consent are required for charter bookings."
    );
  }
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
  const startMin = charterParseTimeToMin(preferredTime);
  if (startMin != null) bookingData.scheduledStartMin = startMin;
  if (preferredDays) bookingData.preferredDays = preferredDays;
  if (notes) bookingData.notes = notes;
  const partySize = parseInt(String(data?.partySize ?? ""), 10);
  if (Number.isFinite(partySize) && partySize > 0) bookingData.partySize = partySize;
  const durationMinutes = parseInt(String(data?.durationMinutes ?? ""), 10);
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
    bookingData.durationMinutes = durationMinutes;
  }
  const scheduledDate = (data?.scheduledDate || "").toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) bookingData.scheduledDate = scheduledDate;

  const memberSlug = normalizeMemberSlugInput(data?.memberSlug);
  if (memberSlug) {
    const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
    if (isSingleOperatorPlan(plan)) {
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
    if (assignmentPreference === "first_available" && !isSingleOperatorPlan(plan)) {
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

  const boatFilterId = (data?.boatId || data?.boat || "").toString().trim();
  let ref;
  if (isCharterPlan) {
    const responseHoursRaw = Number(
      tenantData.workflow && tenantData.workflow.responseTimeHours
    );
    const responseHours =
      Number.isFinite(responseHoursRaw) && responseHoursRaw > 0
        ? Math.min(168, Math.max(1, responseHoursRaw))
        : 24;
    bookingData.requestExpiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + responseHours * 60 * 60 * 1000
    );
    bookingData.requestResponseHours = responseHours;
    ref = await reserveCharterSlot(tenantId, tenantData, bookingData, {
      paymentHold: false,
      boatFilterId,
    });
  } else {
    ref = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .add(bookingData);
  }

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

/**
 * App walk-in / confirm / reschedule: same hull occupancy as the website.
 * Charter plan only. Writes scheduledDate, scheduledStartMin, boatId, occ window, requestedStartTime.
 */
exports.syncCharterBookingSlot = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan) !== "charter") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Charter occupancy is only for Boat / Fishing charter."
    );
  }
  const requestId = ((data && data.requestId) || "").toString().trim();
  const col = db.collection("tenants").doc(ctx.tenantId).collection("bookingRequests");
  let existing = {};
  let bookingRef;
  if (requestId) {
    bookingRef = col.doc(requestId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Booking not found.");
    }
    existing = snap.data() || {};
  } else {
    bookingRef = col.doc();
  }

  const preferredTime = (
    (data && data.preferredTime) ||
    existing.preferredTime ||
    ""
  )
    .toString()
    .trim();
  let startMin =
    data && data.scheduledStartMin != null && Number.isFinite(Number(data.scheduledStartMin))
      ? Number(data.scheduledStartMin)
      : charterParseTimeToMin(preferredTime);
  if (startMin == null && existing.scheduledStartMin != null) {
    startMin = Number(existing.scheduledStartMin);
  }
  let scheduledDate = ((data && data.scheduledDate) || existing.scheduledDate || "")
    .toString()
    .trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    throw new functions.https.HttpsError("invalid-argument", "Pick a date and departure time.");
  }
  const durRaw = data && data.durationMinutes != null ? Number(data.durationMinutes) : Number(existing.durationMinutes);
  const dur = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 240;

  const bookingData = { ...existing };
  delete bookingData.id;
  bookingData.tenantId = ctx.tenantId;
  bookingData.source = existing.source || "admin_app";
  bookingData.scheduledDate = scheduledDate;
  bookingData.scheduledStartMin = startMin;
  bookingData.durationMinutes = dur;
  bookingData.preferredDays = [scheduledDate];
  if (preferredTime) bookingData.preferredTime = preferredTime;
  const startDate = charterOccupancy.instantFromIsoAndMin(
    scheduledDate,
    startMin,
    charterOccupancy.tenantTimeZone(ctx.tenant)
  );
  if (startDate) {
    bookingData.requestedStartTime = admin.firestore.Timestamp.fromDate(startDate);
  }
  const customerName = data && data.customerName != null ? String(data.customerName).trim() : "";
  if (customerName) bookingData.customerName = customerName;
  const customerEmail = data && data.customerEmail != null ? String(data.customerEmail).trim() : "";
  if (customerEmail) bookingData.customerEmail = customerEmail;
  if (data && data.customerPhone != null) {
    const phone = normalizeCustomerPhone(data.customerPhone);
    if (phone) bookingData.customerPhone = phone;
  }
  if (data && data.serviceId) bookingData.serviceId = String(data.serviceId).trim();
  if (data && data.serviceSlug) bookingData.serviceSlug = String(data.serviceSlug).trim();
  if (data && data.serviceName) bookingData.serviceName = String(data.serviceName).trim();
  if (data && data.notes != null) {
    const notes = String(data.notes).trim();
    if (notes) bookingData.notes = notes.slice(0, 4000);
  }
  if (data && data.partySize != null && Number.isFinite(Number(data.partySize))) {
    bookingData.partySize = Number(data.partySize);
  }
  if (data && data.status) {
    bookingData.status = String(data.status).trim().toLowerCase() || bookingData.status;
  }
  if (!bookingData.status) bookingData.status = requestId ? "NEW" : "confirmed";
  if (data && data.assignedMemberUid) {
    bookingData.assignedMemberUid = String(data.assignedMemberUid).trim();
    if (data.assignedMemberName) bookingData.assignedMemberName = String(data.assignedMemberName).trim();
    if (data.assignedMemberEmail) bookingData.assignedMemberEmail = String(data.assignedMemberEmail).trim();
  }
  if (!bookingData.createdAt) {
    bookingData.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await reserveCharterSlot(ctx.tenantId, ctx.tenant, bookingData, {
    paymentHold: false,
    boatFilterId: ((data && (data.boatId || data.boat)) || "").toString().trim(),
    bookingRef,
  });

  return {
    ok: true,
    requestId: bookingRef.id,
    boatId: bookingData.boatId || "",
  };
});

/** Public occupancy for charter search (no PII). Slots by trip date + assigned boat. */
exports.listPublicCharterOccupancy = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required");
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
  const tenantData = tenantDoc.data() || {};
  const plan = normalizeSubscriptionPlan(tenantData.subscriptionPlan);
  if (plan !== "charter") return { slots: [], holdMinutes: charterOccupancy.CHARTER_PAYMENT_HOLD_MINUTES };

  const now = new Date();
  const tz = charterOccupancy.tenantTimeZone(tenantData);
  const fromIso = charterOccupancy.isoDateInTz(now, tz);
  const toIso = charterOccupancy.addDaysToIso(
    fromIso,
    charterOccupancy.CHARTER_OCCUPANCY_HORIZON_DAYS
  );
  const queryFromIso = charterOccupancy.addDaysToIso(fromIso, -1) || fromIso;

  const col = db.collection("tenants").doc(tenantDoc.id).collection("bookingRequests");
  const nowMs = now.getTime();
  const slots = [];
  let lastDoc = null;
  let truncated = false;
  for (let page = 0; page < 20; page++) {
    let q = col
      .where("scheduledDate", ">=", queryFromIso)
      .where("scheduledDate", "<=", toIso)
      .orderBy("scheduledDate")
      .limit(400);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const d = doc.data() || {};
      d.id = doc.id;
      if (!charterOccupancy.rowStillOccupies(d, nowMs)) return;
      const pub = charterOccupancy.publicSlotsFromRow(
        d,
        charterOccupancy.charterBufferMinutes(tenantData)
      );
      for (let i = 0; i < pub.length; i++) {
        if (pub[i] && pub[i].date) slots.push(pub[i]);
      }
    });
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
    if (page === 19) truncated = true;
  }
  return {
    slots,
    holdMinutes: charterOccupancy.CHARTER_PAYMENT_HOLD_MINUTES,
    serverNowMs: nowMs,
    occupancyUntilIso: toIso,
    truncated,
  };
});

/** Drop unpaid charter checkout holds after CHARTER_PAYMENT_HOLD_MINUTES. */
exports.expireCharterPaymentHolds = functions
  .runWith({ secrets: [stripeSecretKey] })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collectionGroup("bookingRequests")
      .where("holdUntil", "<=", now)
      .limit(80)
      .get();
    let n = 0;
    const secretKey = stripeSecretKey.value();
    const stripe = secretKey ? new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" }) : null;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (!charterOccupancy.isPaymentHoldStatus(d.status)) continue;
      const piId = (d.stripePaymentIntentId || "").toString().trim();
      const acct = (d.chargeStripeAccountId || "").toString().trim();
      const tenantRef = doc.ref.parent.parent;
      const tenantId = tenantRef ? tenantRef.id : "";
      let pi = null;
      if (piId.startsWith("pi_")) {
        if (!stripe || !tenantId) {
          console.error("expireCharterPaymentHolds: cannot verify payment", doc.ref.path);
          continue;
        }
        try {
          const opts = acct ? { stripeAccount: acct } : undefined;
          pi = await stripe.paymentIntents.retrieve(piId, opts);
        } catch (retrieveErr) {
          console.error(
            "expireCharterPaymentHolds retrieve",
            piId,
            retrieveErr.message || retrieveErr
          );
          continue;
        }
        if (pi.status === "succeeded") {
          await markCharterBookingPaidFromPaymentIntent(
            stripe,
            tenantId,
            doc.id,
            piId,
            pi
          );
          continue;
        }
        if (pi.status === "processing") {
          await doc.ref.set(
            {
              holdUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
              holdExtendedForProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          continue;
        }
        if (pi.status !== "canceled") {
          try {
            const opts = acct ? { stripeAccount: acct } : undefined;
            pi = await stripe.paymentIntents.cancel(piId, opts);
          } catch (cancelErr) {
            try {
              const opts = acct ? { stripeAccount: acct } : undefined;
              pi = await stripe.paymentIntents.retrieve(piId, opts);
            } catch (_) {
              pi = null;
            }
            if (pi && pi.status === "succeeded") {
              await markCharterBookingPaidFromPaymentIntent(
                stripe,
                tenantId,
                doc.id,
                piId,
                pi
              );
            } else if (pi && pi.status === "processing") {
              await doc.ref.set(
                {
                  holdUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
                  holdExtendedForProcessingAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            } else {
              console.error(
                "expireCharterPaymentHolds cancel",
                piId,
                cancelErr.message || cancelErr
              );
            }
            continue;
          }
        }
      }
      let cancelled = false;
      await db.runTransaction(async (tx) => {
        const latestSnap = await tx.get(doc.ref);
        if (!latestSnap.exists) return;
        const latest = latestSnap.data() || {};
        if (!charterOccupancy.isPaymentHoldStatus(latest.status)) return;
        if (charterOccupancy.holdUntilMillis(latest) > Date.now()) return;
        const latestPi = (latest.stripePaymentIntentId || "").toString().trim();
        if (latestPi !== piId) return;
        tx.set(
          doc.ref,
          {
            status: "cancelled",
            cancelReason: "hold_expired",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            holdUntil: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
        cancelled = true;
      });
      if (cancelled) n += 1;
    }
    if (n) console.log("expireCharterPaymentHolds", n);
    return null;
  });

/** Release unanswered no-card charter requests after their configured response window. */
exports.expireCharterBookingRequests = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collectionGroup("bookingRequests")
      .where("requestExpiresAt", "<=", now)
      .limit(100)
      .get();
    let expired = 0;
    for (const doc of snap.docs) {
      let didExpire = false;
      await db.runTransaction(async (tx) => {
        const latestSnap = await tx.get(doc.ref);
        if (!latestSnap.exists) return;
        const latest = latestSnap.data() || {};
        const status = (latest.status || "").toString().trim().toLowerCase();
        if (status !== "new") return;
        const expiresAtMs =
          latest.requestExpiresAt && typeof latest.requestExpiresAt.toMillis === "function"
            ? latest.requestExpiresAt.toMillis()
            : 0;
        if (!expiresAtMs || expiresAtMs > Date.now()) return;
        tx.set(
          doc.ref,
          {
            status: "cancelled",
            cancelReason: "request_expired",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            requestExpiresAt: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
        didExpire = true;
      });
      if (didExpire) expired += 1;
    }
    if (expired) console.log("expireCharterBookingRequests", expired);
    return null;
  });


const BETA_WAITLIST_PLANS = new Set(["solo", "studio", "shop", "charter"]);
const BETA_WAITLIST_BUSINESS_TYPES = new Set([
  "barber",
  "hair",
  "tattoos",
  "nails",
  "charters",
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
  if ((plan === "solo" || plan === "charter") && teamSize !== 1) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      plan === "charter"
        ? "Charter is for one user."
        : "Solo is for one user. Choose Studio or Shop for teams."
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
  await assertPublicPaymentAccessForTenant(tenantId, tenantData);

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

/**
 * Public web: live Shippo rates for cart + destination address.
 * Params: { tenantSlug, lineItems, addressTo: { name, street1, street2?, city, state, zip, country?, phone?, email? } }
 */
exports.getShopShippingRates = onCall(publicShopCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new HttpsError("invalid-argument", "tenantSlug is required");
  }
  const { tenantId, tenantData } = await resolvePublicShopTenant(tenantSlug);
  if (tenantData.shopShippingEnabled !== true) {
    throw new HttpsError(
      "failed-precondition",
      "Shipping is not enabled for this shop. Choose pickup or ask the studio to enable shipping."
    );
  }
  const token = readShippoTokenOrThrow();
  const rawLines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const productsById = await fetchTenantProductsById(tenantId);
  const { lineItems } = buildValidatedShopLineItems(rawLines, productsById);
  const defaults = tenantData.shopDefaultParcel && typeof tenantData.shopDefaultParcel === "object"
    ? tenantData.shopDefaultParcel
    : {};
  const parcel = shippoShop.buildParcelFromProducts(lineItems, productsById, defaults);
  const addressFrom = shippoShop.shipFromAddressFromTenant(tenantData, terminalAddressFromTenant);
  let addressTo;
  try {
    addressTo = shippoShop.normalizeShipAddress(
      data.addressTo,
      (data.customerName || "").toString().trim() || "Customer"
    );
  } catch (addrErr) {
    throw new HttpsError("invalid-argument", addrErr.message || "Invalid shipping address");
  }
  try {
    const result = await shippoShop.createShipmentRates(token, {
      addressFrom,
      addressTo,
      parcel,
    });
    if (!result.rates.length) {
      throw new HttpsError(
        "failed-precondition",
        "No shipping rates available for this address. Try a different address or choose pickup."
      );
    }
    return {
      shipmentId: result.shipmentId,
      rates: result.rates,
      parcel,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("getShopShippingRates", err);
    throw new HttpsError(
      "failed-precondition",
      err.message || "Could not get shipping rates"
    );
  }
});

/**
 * Public web: create shop order + Stripe PaymentIntent for embedded checkout.
 * Params: { tenantSlug, lineItems, customerName, customerEmail, customerPhone?, notes?,
 *   fulfillmentMethod?: 'pickup'|'shipping', shippoRateId?, shippoShipmentId?, shippingAddress? }
 */
exports.createShopCheckoutPayment = onCall(publicShopCallableOptions, async (request) => {
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

    const pickupEnabled = tenantData.shopPickupEnabled !== false;
    const shippingEnabled = tenantData.shopShippingEnabled === true;
    let fulfillmentMethod = (data?.fulfillmentMethod || "pickup").toString().trim().toLowerCase();
    if (fulfillmentMethod !== "shipping") fulfillmentMethod = "pickup";
    if (fulfillmentMethod === "pickup" && !pickupEnabled) {
      if (shippingEnabled) fulfillmentMethod = "shipping";
      else {
        throw new HttpsError("failed-precondition", "This shop is not accepting orders right now.");
      }
    }
    if (fulfillmentMethod === "shipping" && !shippingEnabled) {
      throw new HttpsError(
        "failed-precondition",
        "Shipping is not enabled. Choose pickup instead."
      );
    }

    let shippingCents = 0;
    let shippoRateId = null;
    let shippoShipmentId = null;
    let shippingAddress = null;
    let shippingProvider = null;
    let shippingService = null;

    if (fulfillmentMethod === "shipping") {
      shippoRateId = (data?.shippoRateId || "").toString().trim();
      shippoShipmentId = (data?.shippoShipmentId || "").toString().trim() || null;
      if (!shippoRateId) {
        throw new HttpsError("invalid-argument", "Select a shipping rate before paying.");
      }
      const token = readShippoTokenOrThrow();
      try {
        shippingAddress = shippoShop.normalizeShipAddress(
          data?.shippingAddress,
          (data?.customerName || "").toString().trim() || "Customer"
        );
      } catch (addrErr) {
        throw new HttpsError("invalid-argument", addrErr.message || "Invalid shipping address");
      }
      let rate;
      try {
        rate = await shippoShop.retrieveRate(token, shippoRateId);
      } catch (rateErr) {
        console.error("createShopCheckoutPayment shippo rate", rateErr);
        throw new HttpsError(
          "failed-precondition",
          "That shipping rate expired. Get new rates and try again."
        );
      }
      shippingCents = Math.max(0, rate.amountCents || 0);
      shippingProvider = rate.provider || null;
      shippingService = rate.service || null;
    }

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
          "Could not calculate sales tax. Complete tax setup in Stripe, or turn off Online sales tax in Payment settings."
        );
      }
    }

    const merchandiseCents = subtotalCents + shippingCents;
    const checkout = computeCardCheckoutAmounts(merchandiseCents, "online");
    const piAmount = merchandiseCents + taxCents + checkout.surchargeCents;
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
          serviceAmountCents: String(subtotalCents),
          shippingCents: String(shippingCents),
          taxCents: String(taxCents),
          surchargeCents: String(checkout.surchargeCents),
          fulfillmentMethod,
          ...(shippoRateId ? { shippoRateId } : {}),
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
      subtotalCents,
      shippingCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      totalCents: piAmount,
      fulfillmentMethod,
      stripePaymentIntentId: pi.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (shippoRateId) orderData.shippoRateId = shippoRateId;
    if (shippoShipmentId) orderData.shippoShipmentId = shippoShipmentId;
    if (shippingAddress) orderData.shippingAddress = shippingAddress;
    if (shippingProvider) orderData.shippingProvider = shippingProvider;
    if (shippingService) orderData.shippingService = shippingService;
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
      subtotalCents,
      shippingCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      platformFeeCents: feeCents,
      totalCents: piAmount,
      fulfillmentMethod,
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
exports.finalizeShopOrderPayment = onCall(publicShopCallableOptions, async (request) => {
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

async function resolvePublicCharterTenant(tenantSlug) {
  const slug = (tenantSlug || "").toString().trim().toLowerCase();
  if (!slug) {
    throw new HttpsError("invalid-argument", "tenantSlug is required");
  }
  const tenantSnap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (tenantSnap.empty) {
    throw new HttpsError("not-found", "Business not found");
  }
  const tenantDoc = tenantSnap.docs[0];
  const tenantId = tenantDoc.id;
  const tenantData = tenantDoc.data() || {};
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
 * Public web: create charter booking + Stripe PaymentIntent (deposit or trip total).
 */
exports.createCharterCheckoutPayment = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  try {
    const { tenantId, tenantData } = await resolvePublicCharterTenant(data.tenantSlug);
    const payMode = charterPayModeFromTenant(tenantData);
    if (payMode === "request") {
      throw new HttpsError(
        "failed-precondition",
        "This charter does not collect a card at checkout."
      );
    }
    const customerName = (data.customerName || "").toString().trim();
    const customerEmail = (data.customerEmail || "").toString().trim().toLowerCase();
    if (!customerName || !customerEmail) {
      throw new HttpsError("invalid-argument", "Name and email are required.");
    }
    const svc = await loadCharterServiceDoc(tenantId, data.serviceId, data.serviceSlug);
    if (!svc) {
      throw new HttpsError("not-found", "Trip not found.");
    }
    const tripCents = charterServicePriceCents(svc);
    const { addonItems, addonCents } = await validatedCharterAddons(
      tenantId,
      data.addonProductIds
    );
    const tripTotalCents = tripCents + addonCents;
    const depositRaw = Number(tenantData.workflow && tenantData.workflow.depositAmount);
    const depositCents =
      Number.isFinite(depositRaw) && depositRaw > 0 ? Math.round(depositRaw * 100) : 0;
    const chargeCents =
      payMode === "deposit"
        ? Math.max(50, Math.min(depositCents || Math.round(tripTotalCents * 0.2), tripTotalCents || depositCents))
        : tripTotalCents;
    if (chargeCents < 50) {
      throw new HttpsError(
        "failed-precondition",
        payMode === "deposit"
          ? "Set a deposit amount in Booking settings (at least $0.50)."
          : "This trip needs a price of at least $0.50 to pay by card."
      );
    }

    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      throw new HttpsError("failed-precondition", "Stripe is not configured");
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const stripeAccountId = await assertTenantShopStripeReady(stripe, tenantData);
    const checkout = computeCardCheckoutAmounts(chargeCents, "online");
    const piAmount = checkout.totalCents;
    const feeCents = platformFeeCents(piAmount);
    const paymentKind = payMode === "deposit" ? "deposit" : "service";
    const bookingStatus = payMode === "deposit" ? "pending_deposit" : "pending_payment";

    const customerPhone = normalizeCustomerPhone(data.customerPhone);
    const smsConsentAccepted = data.smsConsentAccepted === true;
    if (!customerPhone || !smsConsentAccepted) {
      throw new HttpsError(
        "invalid-argument",
        "A mobile number and SMS consent are required for charter bookings."
      );
    }
    const bookingRef = db.collection("tenants").doc(tenantId).collection("bookingRequests").doc();
    const requestId = bookingRef.id;
    const bookingData = {
      status: bookingStatus,
      source: "web",
      tenantId,
      customerName,
      customerEmail,
      serviceId: svc.id,
      serviceSlug: (svc.slug || data.serviceSlug || "").toString() || null,
      serviceName: (svc.name || data.serviceName || "").toString() || null,
      charterPayMode: payMode,
      tripCents,
      addonCents,
      addonItems,
      chargeCents,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    bookingData.customerPhone = customerPhone;
    bookingData.smsConsentAccepted = true;
    bookingData.smsConsentAt = admin.firestore.FieldValue.serverTimestamp();
    const preferredTime = data.preferredTime ? data.preferredTime.toString().trim() : "";
    if (preferredTime) bookingData.preferredTime = preferredTime;
    const startMin = charterParseTimeToMin(preferredTime);
    if (startMin != null) bookingData.scheduledStartMin = startMin;
    const scheduledDate = (data.scheduledDate || "").toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
      bookingData.scheduledDate = scheduledDate;
      bookingData.preferredDays = [scheduledDate];
    }
    const partySize = parseInt(String(data.partySize ?? ""), 10);
    if (Number.isFinite(partySize) && partySize > 0) bookingData.partySize = partySize;
    const durationMinutes = parseInt(String(data.durationMinutes ?? svc.durationMinutes ?? ""), 10);
    if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
      bookingData.durationMinutes = durationMinutes;
    }
    const notes = data.notes ? data.notes.toString().trim() : "";
    if (notes) bookingData.notes = notes;
    bookingData.chargeStripeAccountId = stripeAccountId;

    const boatFilterId = (data.boatId || data.boat || "").toString().trim();
    await reserveCharterSlot(tenantId, tenantData, bookingData, {
      paymentHold: true,
      boatFilterId,
      service: svc,
      bookingRef,
    });

    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: piAmount,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          application_fee_amount: feeCents,
          receipt_email: customerEmail,
          metadata: {
            tenantId,
            paymentKind,
            bookingRequestId: requestId,
            charterPayMode: payMode,
            serviceAmountCents: String(chargeCents),
            surchargeCents: String(checkout.surchargeCents),
            chargeStripeAccountId: stripeAccountId,
            chargeStripeScope: "tenant",
          },
        },
        { stripeAccount: stripeAccountId }
      );
    } catch (piErr) {
      await bookingRef.set(
        {
          status: "cancelled",
          cancelReason: "payment_intent_failed",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          holdUntil: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      throw piErr;
    }
    await bookingRef.set(
      { stripePaymentIntentId: pi.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    const customerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("customers")
      .doc(customerDocIdForTenant(customerName, customerEmail, customerPhone));
    await customerRef.set(
      {
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
        smsOptedIn: true,
        smsConsentAt: admin.firestore.FieldValue.serverTimestamp(),
        smsConsentSource: "web_booking",
        source: "booking_request_web",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const pkOut = stripePublishableKeyParam.value().trim();
    const out = {
      requestId,
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      stripeAccountId,
      tripCents,
      addonCents,
      addonItems,
      chargeCents,
      surchargeCents: checkout.surchargeCents,
      platformFeeCents: feeCents,
      totalCents: piAmount,
      payMode,
    };
    if (pkOut) out.publishableKey = pkOut;
    return out;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("createCharterCheckoutPayment", err);
    throw new HttpsError("internal", stripeErrorMessage(err));
  }
});

exports.finalizeCharterBookingPayment = onCall(publicWebCallableOptions, async (request) => {
  const data = request.data || {};
  const tenantSlug = (data.tenantSlug || "").toString().trim().toLowerCase();
  const requestId = (data.requestId || "").toString().trim();
  const paymentIntentId = (data.paymentIntentId || "").toString().trim();
  if (!tenantSlug || !requestId || !paymentIntentId || !paymentIntentId.startsWith("pi_")) {
    throw new HttpsError(
      "invalid-argument",
      "tenantSlug, requestId, and paymentIntentId are required"
    );
  }
  const { tenantId } = await resolvePublicCharterTenant(tenantSlug);
  const secretKey = stripeSecretKey.value();
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "Stripe is not configured");
  }
  const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
  return markCharterBookingPaidFromPaymentIntent(stripe, tenantId, requestId, paymentIntentId);
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
    const tenantDoc = tenantId
      ? await db.collection("tenants").doc(tenantId).get()
      : null;
    const tenantData = tenantDoc?.exists ? tenantDoc.data() || {} : {};
    const tax = await maybeCalculateInPersonSalesTax(
      stripe,
      stripeAccountId,
      tenantData,
      checkout.serviceCents
    );
    const taxCents = tax.taxCents || 0;
    const totalCents = checkout.totalCents + taxCents;
    const splitFee = await buildTeamSplitFeeAndMetaForCharge({
      tenant: tenantData,
      tenantId,
      payCtx,
      paymentKind: "service",
      serviceCents: checkout.serviceCents,
      grossCents: totalCents,
    });
    const feeCents = splitFee.applicationFeeCents;
    const attributedMemberUid = (payCtx.attributedMemberUid || uid).toString();
    const pi = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        payment_method_types: ["card_present"],
        application_fee_amount: feeCents,
        capture_method: "automatic",
        metadata: {
          tenantId: tenantId || "",
          paymentKind: "service",
          serviceAmountCents: String(checkout.serviceCents),
          taxCents: String(taxCents),
          surchargeCents: String(checkout.surchargeCents),
          ...(tax.taxCalculationId ? { taxCalculationId: tax.taxCalculationId } : {}),
          bookingRequestId,
          initiatedByUid: uid,
          attributedMemberUid,
          chargeStripeAccountId: stripeAccountId,
          chargeStripeScope: payCtx.scope || "tenant",
          ...splitFee.splitMeta,
        },
      },
      { stripeAccount: stripeAccountId }
    );
    return {
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      platformFeeCents: splitFee.platformFeeCents,
      studioShareCents: splitFee.studioShareCents,
      serviceCents: checkout.serviceCents,
      taxCents,
      surchargeCents: checkout.surchargeCents,
      totalCents,
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
    await assertPaidFeatureAccessForTenant(tenantId);
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
 * FCM push to provider devices when a booking request is created (web or app).
 * iOS stores tokens under users/{uid}/deviceTokens/{hash} (see PushNotificationManager.swift).
 */
exports.onTenantBookingRequestCreated = functions
  .runWith({ secrets: [sms.twilioAccountSid, sms.twilioAuthToken] })
  .firestore.document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onCreate(async (snap, context) => {
    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const data = snap.data() || {};
    const source = (data.source || "").toString().trim().toLowerCase();
    if (source === "seed") return null;

    const { title, body } = bookingRequestAlertCopy(data);

    const recipientUids = await resolveBookingAlertRecipientUids(
      tenantId,
      data,
      "onNewBooking"
    );
    const tokens = await collectDeviceTokensForUids(recipientUids);
    await sendBookingAlertPush({
      tokens,
      title,
      body,
      data: {
        type: "booking_request",
        tenantId: String(tenantId),
        requestId: String(requestId),
      },
    });
    const status = (data.status || "").toString().toLowerCase();
    if (status === "confirmed" || status === "declined" || status === "new") {
      await sendBookingClientStatusSms(tenantId, requestId, data, status);
    }
    return null;
  });

/**
 * FCM when a booking is cancelled (respects managerNotifications.onCancellation).
 */
exports.onTenantBookingRequestUpdated = functions.firestore
  .document("tenants/{tenantId}/bookingRequests/{requestId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const prev = (before.status || "").toString().trim().toLowerCase();
    const next = (after.status || "").toString().trim().toLowerCase();
    if (prev === next) return null;
    if (next !== "cancelled" && next !== "canceled") return null;

    const tenantId = context.params.tenantId;
    const requestId = context.params.requestId;
    const source = (after.source || "").toString().trim().toLowerCase();
    if (source === "seed") return null;

    const { title, body } = bookingCancelledAlertCopy(after);

    const recipientUids = await resolveBookingAlertRecipientUids(
      tenantId,
      after,
      "onCancellation"
    );
    const tokens = await collectDeviceTokensForUids(recipientUids);
    await sendBookingAlertPush({
      tokens,
      title,
      body,
      data: {
        type: "booking_cancelled",
        tenantId: String(tenantId),
        requestId: String(requestId),
      },
    });
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
  .runWith({
    secrets: [
      stripeSecretKey,
      stripeWebhookSecret,
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
        (meta.paymentKind || "").toString() === "domain_purchase" ||
        (meta.paymentKind || "").toString() === "domain_transfer"
      ) {
        try {
          const { fulfillDomainPaymentIntent } = require("./customDomain");
          await fulfillDomainPaymentIntent(pi.id);
        } catch (e) {
          console.error("stripeSubscriptionWebhook domain finalize", e.message || e);
        }
      } else if (
        meta.tenantId &&
        ["deposit", "service"].includes((meta.paymentKind || "").toString())
      ) {
        try {
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
              await teamPaymentSplit.recordAndSettleTenantPayment(stripe, {
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
            } else if (
              (meta.paymentKind || "").toString() === "deposit" &&
              meta.bookingRequestId
            ) {
              await confirmBookingAfterDepositPaid(
                tenantId,
                meta.bookingRequestId.toString()
              );
            }
          }
        } catch (e) {
          console.error(
            "stripeSubscriptionWebhook recordAndSettleTenantPayment",
            e.message || e
          );
        }
      }

      // Record Stripe Tax for service / manual / Tap to Pay when a calculation was created.
      const taxCalculationId = (meta.taxCalculationId || "").toString().trim();
      const taxAccountId = (meta.chargeStripeAccountId || "").toString().trim();
      if (
        taxCalculationId &&
        taxAccountId &&
        (meta.paymentKind || "").toString() !== "shop"
      ) {
        try {
          await recordShopTaxTransactionFromCalculation(
            stripe,
            taxAccountId,
            taxCalculationId,
            pi.id
          );
        } catch (e) {
          console.error("stripeSubscriptionWebhook tax transaction", e.message);
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
  manageArtistSchedules: false,
  accessClientList: false,
  viewEarningsReports: false,
  sendClientNotifications: false,
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
  if (status !== "pending_deposit" && status !== "pending_payment") return false;
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
    smsLineRequestPending: d.smsLineRequestPending === true,
    smsMonthlyUsageCount: sms.smsMonthlyUsageForMember(d).count,
    smsMonthlyLimit: sms.smsMonthlyUsageForMember(d).limit,
    smsMonthlyUsageRemaining: sms.smsMonthlyUsageForMember(d).remaining,
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
  if (isSingleOperatorPlan(plan)) {
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
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This plan is owner only. Upgrade to Studio or Shop to invite team members."
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
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is on an owner-only plan and cannot add team members."
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
  if (isSingleOperatorPlan(plan)) {
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
  if (isSingleOperatorPlan(plan)) {
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
  if (isSingleOperatorPlan(plan)) {
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
  if (isSingleOperatorPlan(plan) && targetUid !== ctx.tenant.ownerUid) {
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
  const usesOwnPayments = !isOwner && memberUsesOwnConnect(memberSettings.payoutMode);
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
    canTakePayments: isOwner || (usesOwnPayments && memberSettings.canTakePayments !== false),
    studioSmsActive,
    usesOwnSms,
    canSendClientSms,
    memberSmsStatus: isOwner ? null : memberSmsStatus,
    memberSmsPhoneNumber: isOwner ? null : memberSmsPhone,
    canEditPortfolio,
    canEditPublicBio,
  };
});

/** Owner-only: business-wide booking mode + confirmation policy (Settings). */
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

  if (data && data.bookingMode != null) {
    const modeRaw = (data.bookingMode || "").toString().trim().toLowerCase();
    const modeAllowed = [
      "form",
      "calendar_slots",
      "calendar",
      "slots",
      "slot_booking",
      "inquiry",
      "request",
    ];
    if (!modeAllowed.includes(modeRaw)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid booking mode.");
    }
    workflow.bookingMode =
      modeRaw === "form" || modeRaw === "inquiry" || modeRaw === "request"
        ? "form"
        : "calendar_slots";
  }

  if (data && data.confirmationType != null) {
    const confirmationType = (data.confirmationType || "").toString().trim().toLowerCase();
    const allowed = [
      "instant_book",
      "request_approve",
      "deposit_to_confirm",
      "approve_and_deposit",
      "consultation_first",
      "pay_in_full",
    ];
    if (!allowed.includes(confirmationType)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid confirmation type.");
    }
    // When owner does not set team type, still allow writing type for solo/calendar default policy.
    if (managersApprove || workflow.bookingMode === "calendar_slots" || data.bookingMode != null) {
      workflow.confirmationType = confirmationType;
    }
    if (data.depositAmount != null && !Number.isNaN(Number(data.depositAmount))) {
      const dep = Number(data.depositAmount);
      if (dep > 0) workflow.depositAmount = dep;
      else delete workflow.depositAmount;
    }
  }

  if (data && data.charterBookBy != null) {
    const bookBy = (data.charterBookBy || "").toString().trim().toLowerCase();
    if (bookBy === "boat" || bookBy === "boats" || bookBy === "fleet") {
      workflow.charterBookBy = "boat";
    } else if (bookBy === "location" || bookBy === "one_location" || bookBy === "") {
      workflow.charterBookBy = "location";
    } else {
      throw new functions.https.HttpsError("invalid-argument", "Invalid charter book-by mode.");
    }
  }

  if (data && data.charterBufferMinutes != null) {
    const buf = Number(data.charterBufferMinutes);
    if (!Number.isFinite(buf) || buf < 0) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid buffer between trips.");
    }
    workflow.charterBufferMinutes = Math.min(240, Math.round(buf));
  }

  if (data && data.charterLastBookingMin != null) {
    const lastBook = Number(data.charterLastBookingMin);
    if (!Number.isFinite(lastBook) || lastBook < 0) {
      delete workflow.charterLastBookingMin;
    } else {
      workflow.charterLastBookingMin = Math.min(24 * 60, Math.round(lastBook));
    }
  }

  applyCharterBookingWorkflow(ctx.tenant, workflow);

  const resolvedBookingMode =
    workflow.bookingMode || existingWf.bookingMode || DEFAULT_TENANT_WORKFLOW.bookingMode || "form";
  workflow.bookingMode = resolvedBookingMode;

  // workflow.bookingMode is authoritative for /book; top-level bookingMode mirrors for simple clients.
  await db.collection("tenants").doc(ctx.tenantId).update({
    workflow,
    bookingMode: resolvedBookingMode,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const userWorkflow = {
    managersApproveAppointments: managersApprove,
    bookingMode: resolvedBookingMode,
  };
  if (workflow.confirmationType) {
    userWorkflow.confirmationType = workflow.confirmationType;
  }
  if (workflow.depositAmount != null && !Number.isNaN(Number(workflow.depositAmount))) {
    userWorkflow.depositAmount = Number(workflow.depositAmount);
  }
  if (workflow.charterBookBy) {
    userWorkflow.charterBookBy = workflow.charterBookBy;
  }
  if (workflow.charterBufferMinutes != null) {
    userWorkflow.charterBufferMinutes = workflow.charterBufferMinutes;
  }
  if (workflow.charterLastBookingMin != null) {
    userWorkflow.charterLastBookingMin = workflow.charterLastBookingMin;
  }
  await db.collection("users").doc(uid).set(
    {
      workflow: userWorkflow,
    },
    { merge: true }
  );
  const effectiveType =
    workflow.confirmationType || DEFAULT_TENANT_WORKFLOW.confirmationType;
  return {
    ok: true,
    bookingRequiresApproval: bookingRequiresApproval(effectiveType),
    managersApproveAppointments: managersApprove,
    bookingMode: resolvedBookingMode,
    charterBookBy: workflow.charterBookBy || null,
    charterBufferMinutes:
      workflow.charterBufferMinutes != null ? workflow.charterBufferMinutes : null,
    charterLastBookingMin:
      workflow.charterLastBookingMin != null ? workflow.charterLastBookingMin : null,
  };
});

/** Approve / decline / cancel booking request status with permission checks. */
exports.updateBookingRequestStatus = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
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
  if (normalized === "canceled") normalized = "cancelled";

  const reqRef = db
    .collection("tenants")
    .doc(ctx.tenantId)
    .collection("bookingRequests")
    .doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Booking request not found.");
  }
  const reqData = reqSnap.data() || {};
  const assignedUid = (reqData.assignedMemberUid || "").toString().trim();
  const assignedToSelf = Boolean(assignedUid && assignedUid === ctx.uid);
  // View-all is visibility only — approve/reject uses explicit permission (or assignee).
  const canShopWide = ctx.isOwner || canApproveRejectBookingRequests(ctx);
  if (!canShopWide && !assignedToSelf) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to update this booking request."
    );
  }

  const patch = {
    status: normalized,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (data && data.notes != null) {
    patch.notes = (data.notes || "").toString().trim().slice(0, 4000);
  }
  await reqRef.set(patch, { merge: true });

  let refunded = false;
  let alreadyRefunded = false;
  let refundError = null;
  let refundCents = 0;
  if (normalized === "cancelled") {
    const secretKey = stripeSecretKey.value();
    if (secretKey) {
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const refundResult = await refundBookingPaymentIfNeeded({
        stripe,
        tenant: ctx.tenant,
        tenantId: ctx.tenantId,
        booking: reqData,
        requestId,
      });
      refunded = !!refundResult.refunded;
      alreadyRefunded = !!refundResult.alreadyRefunded;
      refundError = refundResult.refundError || null;
      refundCents = refundResult.refundCents || 0;
      const refundPending = !!refundResult.refundPending;
      const refundPatch = cancelRefundPatchFromResult(refundResult);
      if (refundPatch) {
        await reqRef.set(refundPatch, { merge: true });
      }
      return {
        ok: true,
        status: normalized,
        refunded,
        alreadyRefunded,
        refundPending,
        refundCents,
        refundError: refundPending ? null : refundError,
      };
    }
  }

  return {
    ok: true,
    status: normalized,
    refunded,
    alreadyRefunded,
    refundPending: false,
    refundCents,
    refundError,
  };
});

/** Retry queued cancel refunds once original charges have settled. */
exports.retryPendingBookingRefunds = functions
  .runWith({ secrets: [stripeSecretKey] })
  .pubsub.schedule("every 30 minutes")
  .onRun(async () => {
    const secretKey = stripeSecretKey.value();
    if (!secretKey) {
      console.warn("retryPendingBookingRefunds: no Stripe secret");
      return null;
    }
    const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
    const pendingSnap = await db
      .collectionGroup("bookingRequests")
      .where("cancelRefundStatus", "==", "pending")
      .limit(40)
      .get();
    const failedSnap = await db
      .collectionGroup("bookingRequests")
      .where("cancelRefundStatus", "==", "failed")
      .limit(40)
      .get();
    const seen = new Set();
    const docs = [];
    for (const doc of [...pendingSnap.docs, ...failedSnap.docs]) {
      if (seen.has(doc.ref.path)) continue;
      seen.add(doc.ref.path);
      docs.push(doc);
    }
    let retried = 0;
    let refunded = 0;
    let stillPending = 0;
    for (const doc of docs) {
      const d = doc.data() || {};
      const status = (d.status || "").toString().trim().toLowerCase();
      if (status !== "cancelled" && status !== "canceled") continue;
      const refundStatus = (d.cancelRefundStatus || "").toString().trim().toLowerCase();
      if (refundStatus === "failed" && !isUnsettledRefundError({ message: d.cancelRefundError })) {
        continue;
      }
      const tenantRef = doc.ref.parent.parent;
      const tenantId = tenantRef ? tenantRef.id : "";
      if (!tenantId) continue;
      retried += 1;
      let tenant = {};
      try {
        const tenantSnap = await tenantRef.get();
        tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};
      } catch (e) {
        console.error("retryPendingBookingRefunds tenant", doc.ref.path, e.message || e);
        continue;
      }
      const refundResult = await refundBookingPaymentIfNeeded({
        stripe,
        tenant,
        tenantId,
        booking: d,
        requestId: doc.id,
      });
      const patch = cancelRefundPatchFromResult(refundResult);
      if (patch) {
        await doc.ref.set(patch, { merge: true });
      }
      if (refundResult.refunded || refundResult.alreadyRefunded) refunded += 1;
      else if (refundResult.refundPending) stillPending += 1;
    }
    return { retried, refunded, stillPending };
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
exports.listTenantMembers = functions
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
  const perms = {
    ...DEFAULT_MANAGER_PERMISSIONS,
    ...(tenant.managerPermissions || {}),
  };
  const notifs = {
    ...DEFAULT_MANAGER_NOTIFICATIONS,
    ...(tenant.managerNotifications || {}),
  };
  const workflow = resolveTenantWorkflow(tenant, ownerData);
  const confirmationType = workflow.confirmationType;
  const messaging = await messagingFieldsWithLineCount(
    tenantId,
    tenant,
    ownerData,
    snap.docs
  );
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
exports.removeTenantMember = functions
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
  const heldSmsSlot =
    sms.occupiesSmsLineSlot(memberData) || memberData.smsLineRequestPending === true;
  const hadPersonalSms =
    heldSmsSlot || memberData.smsEnabled === true;

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
      smsLineRequestPending: admin.firestore.FieldValue.delete(),
      smsLineRequestedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  const paidExtras = await maybeReduceSmsExtraAfterReleasingOccupiedLine(
    stripeClientFromSecret(),
    tenantId,
    tenant,
    plan,
    heldSmsSlot
  );
  return {
    ok: true,
    releasedPersonalSms: hadPersonalSms && smsRelease.released,
    unassignedBookings,
    clearedThreads,
    smsExtraPaid: paidExtras != null ? paidExtras : sms.smsExtraPaidQuantity(tenant),
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
      if (!stripeCustomerId) {
        return {
          ok: true,
          hasStripeCustomer: false,
          firestorePlan,
          message: "Billing is not set up for this business yet.",
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
  const canUse = sms.tenantCanUseSms(tenant, ownerUserData, tenant.managerPermissions);
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
    smsExtraOneTimeReplacementCents: lines.extraOneTimeReplacementCents || 1200,
    smsExtraOneTimeReplacementLabel: lines.extraOneTimeReplacementLabel || "$12",
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
      sms.isSmsPhonePurchasingBlockedDuringTestFlight() === true,
    smsPhonePurchaseBlockMessage: (sms.smsPhonePurchaseBlockReason() || "").toString(),
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
    const usage = sms.smsMonthlyUsageForMember(d);
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
  for (let i = 0; i < open; i++) {
    out.push({
      kind: "open",
      name: "Unassigned slot",
      role: "Available capacity",
      phone: "",
      status: "open",
      smsMonthlyUsageCount: 0,
      smsMonthlyLimit: sms.MAX_SMS_PER_LINE_PER_MONTH || 1000,
      smsMonthlyUsageRemaining: sms.MAX_SMS_PER_LINE_PER_MONTH || 1000,
    });
  }
  return out;
}

async function listSmsLineAssignmentsForBilling(tenantId, tenant, lineSummary) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  return listSmsLineAssignmentsForBillingFromDocs(tenant, lineSummary, snap.docs);
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
    if (updated.status !== "active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Stripe could not activate the subscription. Update your payment method and try again."
      );
    }
    return { ok: true, subscriptionStatus: updated.status };
  });

/**
 * Owner: add one paid SMS line capacity ($12 flat now + $12/mo recurring).
 * Charges a one-time $12 invoice (no proration), then adds the smsExtra seat
 * with proration_behavior none. Free included slots must be used first.
 * Does not provision a number — returns a short-lived auth for requestSmsPhoneNumber.
 */
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

    // 3rd+ concurrent: $12 now + $12/mo subscription seat.
    // Under 2 concurrent with lifetime exhausted: $12 one-time only.
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

    const subId = (tenant.stripeSubscriptionId || "").toString().trim();
    const customerId = (tenant.stripeCustomerId || "").toString().trim();
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

    const extraPriceIds = stripeSmsExtraPriceIds();
    let currentQty = smsExtraQuantityFromSubscription(sub, extraPriceIds);
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
          "Get Bookking extra texting number ($12)"
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
          "Get Bookking texting number ($12)"
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
          "Getting a new texting number after your included free numbers requires a $12 payment."
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
      // $12 replacement before setting pending. The Firestore trigger verifies
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
              "Get Bookking Solo texting number replacement ($12)"
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
          "Getting a new texting number after your included free numbers requires a $12/mo payment. Use Refresh number in Messaging."
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
                ? "Request sent. Your studio owner can add a number ($12 now + $12/mo) under Billing or Messaging."
                : "Request sent. Your studio owner can add a number ($12 one-time) under Billing or Messaging.")
            : (summary.needsMonthlyExtraForNext
                ? "This member needs a paid texting number ($12 now + $12/mo). Confirm the purchase, then enable their line."
                : "This member needs a texting number ($12 one-time). Confirm the purchase, then enable their line."),
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
 * One-time $12 charge for a texting-number replacement after the lifetime
 * free allotment is used (Solo 1 · Studio/Shop 2). Does not change seat qty.
 */
async function chargeOneTimeSmsNumberReplacementFee(stripe, tenant) {
  return chargeOneTimeSmsExtraFee(
    stripe,
    tenant,
    "Get Bookking texting number replacement ($12)"
  );
}

/**
 * Owner: refresh a studio or personal texting number (release old Twilio SID, buy new).
 * Lifetime free buys: Solo 1 · Studio/Shop 2. Further refreshes charge $12 once, then buy.
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
            `The $12 charge succeeded but subscription billing could not be synced: ${stripeErrorMessage(e)}`
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
    const usage = sms.smsMonthlyUsageForMember(memberData);
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

    // Personal-line threads stay with that teammate — owners/managers cannot reply there.
    if (sms.isLineScopedThreadId(requestedThreadId)) {
      const assigned = ((threadData && threadData.assignedMemberUid) || "").toString().trim();
      if (assigned) {
        if (context.auth.uid !== assigned) {
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
      if (context.auth.uid !== assigned) {
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
    const smsPurchaseBlock = sms.smsPhonePurchaseBlockReason();
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
      // A Solo replacement needs the existing $12 invoice authorization.
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
                "A completed $12 texting-number payment is required before setup.",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          return null;
        }
        const secretKey = stripeSecretKey.value();
        if (!secretKey) {
          throw new Error("Stripe is not configured.");
        }
        const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
        const invoice = await stripe.invoices.retrieve(invoiceId);
        const customerMatches =
          (invoice.customer || "").toString() ===
          (after.stripeCustomerId || "").toString();
        const paidAmount = Math.max(
          Number(invoice.amount_paid) || 0,
          Number(invoice.total) || 0
        );
        if (invoice.status !== "paid" || !customerMatches || paidAmount < 1200) {
          await db.collection("tenants").doc(tenantId).set(
            {
              smsStatus: "failed",
              smsProvisionError:
                "Your $12 texting-number payment could not be verified. Please try again.",
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

async function provisionTenantSms(tenantId, tenant, opts) {
  return sms.provisionTenantSms(tenantId, tenant, opts);
}

async function provisionMemberSms(tenantId, tenant, memberUid, memberData, opts) {
  return sms.provisionMemberSms(tenantId, tenant, memberUid, memberData, opts);
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
      res
        .type("text/xml")
        .send(
          sms.twimlMessage(
            "You have been unsubscribed. Reply YES or START to opt back in for appointment texts."
          )
        );
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

const { registerCustomDomainFunctions } = require("./customDomain");
registerCustomDomainFunctions(exports);
