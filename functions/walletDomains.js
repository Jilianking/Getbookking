/**
 * Apple Pay / Google Pay on shop booking pages.
 *
 * Stripe only shows wallet buttons on web addresses registered as payment method domains.
 * Booking payments are direct charges on each shop's (or team member's) own Stripe account,
 * so the shop's address is registered on every account that takes payments on that page.
 * Stripe keeps registered addresses (there is no delete), so removal switches an entry off.
 */
const { isDemoShowcaseStripeAccountId } = require("./demoShowcasePayments");

const BOOKING_PLATFORM_HOST = "getbookking.com";

function bookingHostForSlug(slug) {
  const s = (slug || "").toString().trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? `${s}.${BOOKING_PLATFORM_HOST}` : null;
}

/** The shop's Stripe account plus team members paid into their own accounts. */
async function stripeAccountsForShop(db, tenantId, tenant) {
  const ids = new Set();
  const add = (raw) => {
    const id = (raw || "").toString().trim();
    if (id && !isDemoShowcaseStripeAccountId(id)) ids.add(id);
  };
  add(tenant && tenant.stripeAccountId);
  const members = await db.collection("users").where("tenantId", "==", tenantId).get();
  members.forEach((m) => add((m.data() || {}).stripeAccountId));
  return [...ids];
}

/**
 * Turns wallet buttons on or off for `domain` on each account. Safe to repeat.
 * Returns one line per account describing what happened.
 */
async function setWalletDomain(stripe, accountIds, domain, enabled) {
  const results = [];
  if (!stripe || !domain) return results;
  for (const stripeAccount of accountIds || []) {
    try {
      const found = await stripe.paymentMethodDomains.list(
        { domain_name: domain, limit: 1 },
        { stripeAccount }
      );
      const existing = found && found.data && found.data[0];
      if (existing) {
        if (existing.enabled !== enabled) {
          await stripe.paymentMethodDomains.update(existing.id, { enabled }, { stripeAccount });
          results.push(`${stripeAccount}: ${enabled ? "switched on" : "switched off"}`);
        } else {
          results.push(`${stripeAccount}: already ${enabled ? "on" : "off"}`);
        }
      } else if (enabled) {
        await stripe.paymentMethodDomains.create({ domain_name: domain }, { stripeAccount });
        results.push(`${stripeAccount}: registered`);
      } else {
        results.push(`${stripeAccount}: not registered (nothing to switch off)`);
      }
    } catch (e) {
      console.warn("setWalletDomain", stripeAccount, domain, enabled, e.message || e);
      results.push(`${stripeAccount}: failed (${e.message || e})`);
    }
  }
  return results;
}

/** What Stripe reports for `domain` on each account (read-only). */
async function walletDomainStatus(stripe, accountIds, domain) {
  const results = [];
  for (const stripeAccount of accountIds || []) {
    try {
      const found = await stripe.paymentMethodDomains.list(
        { domain_name: domain, limit: 1 },
        { stripeAccount }
      );
      const d = found && found.data && found.data[0];
      if (!d) {
        results.push(`${stripeAccount}: not registered`);
        continue;
      }
      const wallet = (name) => {
        const w = d[name] || {};
        const why = w.status_details && w.status_details.error_message;
        return `${name.replace("_", " ")} ${w.status || "unknown"}${why ? ` — ${why}` : ""}`;
      };
      results.push(
        `${stripeAccount}: ${d.enabled ? "on" : "off"}; ${wallet("apple_pay")}; ${wallet("google_pay")}`
      );
    } catch (e) {
      results.push(`${stripeAccount}: could not read (${e.message || e})`);
    }
  }
  return results;
}

module.exports = {
  walletDomainStatus,
  BOOKING_PLATFORM_HOST,
  bookingHostForSlug,
  stripeAccountsForShop,
  setWalletDomain,
};
