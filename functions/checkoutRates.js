/**
 * Checkout rate table (USD). Platform fee is 1% of the charged total on every row.
 *
 * card: deposit link, manual checkout, shop, charter web — 2.9% + 30¢
 * card_present: Tap to Pay — 2.7% + 15¢ (in-person 5¢ + Tap to Pay authorization 10¢)
 * klarna: 5.99% + 30¢ (Stripe US standard)
 * affirm: 6% + 30¢ (Stripe US standard, not the Enhanced 7.99% rate)
 * instant_bank: Link Instant Bank Payments — 2.6% + 30¢
 *
 * iOS card / Tap to Pay preview mirror: Test/CardCheckoutPricing.swift
 */

const PLATFORM_FEE_BPS = 100;

const CHECKOUT_RATES = {
  card: {
    id: "card",
    bps: 290,
    fixedCents: 30,
    label: "2.9% + 30¢",
  },
  card_present: {
    id: "card_present",
    bps: 270,
    fixedCents: 15,
    label: "2.7% + 15¢",
  },
  klarna: {
    id: "klarna",
    bps: 599,
    fixedCents: 30,
    label: "5.99% + 30¢",
  },
  affirm: {
    id: "affirm",
    bps: 600,
    fixedCents: 30,
    label: "6% + 30¢",
  },
  instant_bank: {
    id: "instant_bank",
    bps: 260,
    fixedCents: 30,
    label: "2.6% + 30¢",
  },
};

/**
 * @param {string} [channel]
 * @returns {typeof CHECKOUT_RATES.card}
 */
function checkoutRateForChannel(channel) {
  const method = checkoutMethodId(channel);
  return CHECKOUT_RATES[method] || CHECKOUT_RATES.card;
}

/** @param {string} [method] @returns {"card"|"card_present"|"klarna"|"affirm"|"instant_bank"} */
function checkoutMethodId(method) {
  const m = (method || "card").toString().trim().toLowerCase();
  if (m === "klarna") return "klarna";
  if (m === "affirm") return "affirm";
  if (m === "instant_bank" || m === "link_bank" || m === "link_card_brand" || m === "bank") return "instant_bank";
  if (m === "card_present" || m === "tap_to_pay") return "card_present";
  return "card";
}

/** Application fee in USD cents (min 1¢). Collected via Connect; grossed up to the customer. */
function platformFeeCents(amountCents) {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round((n * PLATFORM_FEE_BPS) / 10000));
}

/** Stripe processing fee in cents: nearest-cent percentage, then the fixed fee. */
function stripeProcessingFeeCents(totalCents, rate) {
  const percent = Math.round((totalCents * rate.bps) / 10000);
  return percent + rate.fixedCents;
}

/** What the business keeps after Stripe's fee and the 1% platform fee. */
function netAfterCheckoutFees(totalCents, rate) {
  return totalCents - stripeProcessingFeeCents(totalCents, rate) - platformFeeCents(totalCents);
}

function processingServiceFeeDescription(channel = "online") {
  const rate = checkoutRateForChannel(channel);
  const name =
    rate.id === "klarna"
      ? "Klarna"
      : rate.id === "affirm"
        ? "Affirm"
        : rate.id === "instant_bank"
          ? "bank"
          : "card";
  return `Includes Stripe ${name} processing (${rate.label}) and a 1% platform fee.`;
}

/**
 * Smallest charge whose rounded Stripe fee and 1% platform fee leave exactly the service amount.
 * Starts at the rounded-up estimate, then steps down while the business still nets the full service.
 * @param {number} serviceCents
 * @param {string} [channel]
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
  const rate = checkoutRateForChannel(channel);
  const combinedBps = rate.bps + PLATFORM_FEE_BPS;
  let totalCents = Math.ceil(
    (service + rate.fixedCents) / (1 - combinedBps / 10000)
  );
  while (totalCents > service && netAfterCheckoutFees(totalCents - 1, rate) >= service) {
    totalCents -= 1;
  }
  while (netAfterCheckoutFees(totalCents, rate) < service) {
    totalCents += 1;
  }
  const surchargeCents = totalCents - service;
  return {
    serviceCents: service,
    surchargeCents,
    totalCents,
    platformFeeCents: platformFeeCents(totalCents),
  };
}

module.exports = {
  PLATFORM_FEE_BPS,
  CHECKOUT_RATES,
  checkoutMethodId,
  checkoutRateForChannel,
  platformFeeCents,
  processingServiceFeeDescription,
  computeCardCheckoutAmounts,
};
