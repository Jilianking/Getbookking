/**
 * Shippo helpers for Bookking shop shipping (rates + labels).
 * Auth: Authorization: ShippoToken <token>
 * Test tokens start with shippo_test_
 */

const SHIPPO_API = "https://api.goshippo.com";

const DEFAULT_PARCEL = {
  length: "8",
  width: "6",
  height: "4",
  distance_unit: "in",
  weight: "16",
  mass_unit: "oz",
};

async function shippoFetch(token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${SHIPPO_API}${path}`, {
    method,
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (json && (json.detail || json.message || json.error)) ||
      `Shippo error ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build one parcel for the cart from product weight/dims (sum weight, max dims).
 */
function buildParcelFromProducts(lineItems, productsById, tenantDefaults = {}) {
  let weightOz = 0;
  let length = 0;
  let width = 0;
  let height = 0;
  let anyWeight = false;

  for (const line of lineItems) {
    const prod = productsById.get(line.productId) || {};
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    const w = numOr(prod.weightOz, numOr(tenantDefaults.weightOz, 16));
    weightOz += w * qty;
    anyWeight = true;
    length = Math.max(length, numOr(prod.lengthIn, numOr(tenantDefaults.lengthIn, 8)));
    width = Math.max(width, numOr(prod.widthIn, numOr(tenantDefaults.widthIn, 6)));
    height = Math.max(height, numOr(prod.heightIn, numOr(tenantDefaults.heightIn, 4)) * qty);
  }

  if (!anyWeight || weightOz <= 0) weightOz = numOr(tenantDefaults.weightOz, 16);
  if (length <= 0) length = numOr(tenantDefaults.lengthIn, 8);
  if (width <= 0) width = numOr(tenantDefaults.widthIn, 6);
  if (height <= 0) height = numOr(tenantDefaults.heightIn, 4);

  // Cap absurd stacked height for multi-qty; still charge by weight.
  height = Math.min(height, 36);

  return {
    length: String(Math.round(length * 10) / 10),
    width: String(Math.round(width * 10) / 10),
    height: String(Math.round(height * 10) / 10),
    distance_unit: "in",
    weight: String(Math.round(weightOz * 10) / 10),
    mass_unit: "oz",
  };
}

function normalizeShipAddress(raw, fallbackName) {
  const a = raw && typeof raw === "object" ? raw : {};
  const name = (a.name || fallbackName || "Customer").toString().trim().slice(0, 100);
  const street1 = (a.street1 || a.line1 || a.address1 || "").toString().trim().slice(0, 200);
  const street2 = (a.street2 || a.line2 || a.address2 || "").toString().trim().slice(0, 200);
  const city = (a.city || "").toString().trim().slice(0, 100);
  const state = (a.state || "").toString().trim().toUpperCase().slice(0, 3);
  const zip = (a.zip || a.postal_code || a.postalCode || "").toString().trim().slice(0, 20);
  const country = ((a.country || "US").toString().trim().toUpperCase() || "US").slice(0, 2);
  const phone = (a.phone || "").toString().trim().slice(0, 40);
  const email = (a.email || "").toString().trim().toLowerCase().slice(0, 200);
  if (!street1 || !city || !state || !zip) {
    const err = new Error("Shipping address needs street, city, state, and ZIP");
    err.code = "invalid-address";
    throw err;
  }
  const out = {
    name: name || "Customer",
    street1,
    city,
    state,
    zip,
    country,
  };
  if (street2) out.street2 = street2;
  if (phone) out.phone = phone;
  if (email) out.email = email;
  return out;
}

function shipFromAddressFromTenant(tenantData, terminalAddressFromTenant) {
  const custom = tenantData?.shopShipFrom && typeof tenantData.shopShipFrom === "object"
    ? tenantData.shopShipFrom
    : null;
  if (custom && (custom.street1 || custom.line1) && custom.city && custom.state && (custom.zip || custom.postal_code)) {
    return normalizeShipAddress(
      {
        ...custom,
        name:
          custom.name ||
          tenantData.displayName ||
          tenantData.businessName ||
          "Studio",
      },
      tenantData.displayName || tenantData.businessName || "Studio"
    );
  }
  const addr = terminalAddressFromTenant(tenantData || {});
  return {
    name: (tenantData.displayName || tenantData.businessName || "Studio").toString().trim().slice(0, 100),
    street1: addr.line1,
    city: addr.city,
    state: addr.state,
    zip: addr.postal_code,
    country: addr.country || "US",
  };
}

function mapShippoRate(rate) {
  const amount = Number(rate.amount);
  const amountCents = Math.round((Number.isFinite(amount) ? amount : 0) * 100);
  return {
    objectId: rate.object_id,
    amount: Number.isFinite(amount) ? amount : 0,
    amountCents,
    currency: (rate.currency || "USD").toString().toUpperCase(),
    provider: (rate.provider || "").toString(),
    service: (rate.servicelevel && rate.servicelevel.name) || (rate.servicelevel_name || "").toString(),
    estimatedDays: rate.estimated_days != null ? rate.estimated_days : null,
    durationTerms: (rate.duration_terms || "").toString(),
  };
}

async function createShipmentRates(token, { addressFrom, addressTo, parcel }) {
  const shipment = await shippoFetch(token, "/shipments/", {
    method: "POST",
    body: {
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [parcel || DEFAULT_PARCEL],
      async: false,
    },
  });
  const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
  const mapped = rates
    .map(mapShippoRate)
    .filter((r) => r.objectId && r.amountCents >= 0)
    .sort((a, b) => a.amountCents - b.amountCents);
  return {
    shipmentId: shipment.object_id,
    rates: mapped,
  };
}

async function retrieveRate(token, rateObjectId) {
  const rate = await shippoFetch(token, `/rates/${encodeURIComponent(rateObjectId)}/`);
  return mapShippoRate(rate);
}

async function purchaseLabel(token, rateObjectId) {
  const tx = await shippoFetch(token, "/transactions/", {
    method: "POST",
    body: {
      rate: rateObjectId,
      label_file_type: "PDF",
      async: false,
    },
  });
  return {
    transactionId: tx.object_id,
    status: tx.status,
    trackingNumber: tx.tracking_number || null,
    trackingUrl: tx.tracking_url_provider || null,
    labelUrl: tx.label_url || null,
  };
}

module.exports = {
  DEFAULT_PARCEL,
  buildParcelFromProducts,
  normalizeShipAddress,
  shipFromAddressFromTenant,
  createShipmentRates,
  retrieveRate,
  purchaseLabel,
};
