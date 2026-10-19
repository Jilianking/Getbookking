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

module.exports = {
  BOOKING_PLATFORM_HOST,
  bookingHostForSlug,
  stripeAccountsForShop,
  setWalletDomain,
};
