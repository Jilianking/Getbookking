/**
 * Public read-only app demo snapshots for marketing personas (no auth).
 * Allowlisted slugs only — used by iOS "Try demo" on the login screen.
 */

const { resolveTenantBySlug } = require("./demoSeedActivityLib");

const ALLOWED_DEMO_APP_SLUGS = new Set(["gilded-palm", "iron-district-gym"]);

function serializeValue(value) {
  if (value == null) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

function serializeDoc(data, id) {
  return serializeValue({ id, ...data });
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} slug
 */
async function buildDemoAppSnapshot(db, slug) {
  const resolved = await resolveTenantBySlug(db, slug);
  const tenantId = resolved.id;
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new Error(`Tenant missing for slug "${slug}"`);
  }
  const tenant = tenantSnap.data() || {};
  if (!tenant.isDemoAccount) {
    throw new Error(`Slug "${slug}" is not a demo account`);
  }

  const ownerUid = (tenant.ownerUid || "").toString();
  let owner = {
    uid: ownerUid,
    firstName: "",
    lastName: "",
    email: "",
    name: "",
    displayName: "",
  };
  if (ownerUid) {
    const ownerSnap = await db.collection("users").doc(ownerUid).get();
    if (ownerSnap.exists) {
      const o = ownerSnap.data() || {};
      owner = {
        uid: ownerUid,
        firstName: (o.firstName || "").toString(),
        lastName: (o.lastName || "").toString(),
        email: (o.email || "").toString(),
        name: (o.name || o.displayName || "").toString(),
        displayName: (o.displayName || o.name || "").toString(),
      };
    }
  }

  const tenantRef = db.collection("tenants").doc(tenantId);
  const [bookingsSnap, customersSnap, threadsSnap, servicesSnap, smsLogSnap] =
    await Promise.all([
      tenantRef
        .collection("bookingRequests")
        .orderBy("createdAt", "desc")
        .limit(100)
        .get(),
      tenantRef.collection("customers").limit(120).get(),
      tenantRef
        .collection("smsThreads")
        .orderBy("lastMessageAt", "desc")
        .limit(50)
        .get(),
      tenantRef.collection("services").limit(50).get(),
      tenantRef
        .collection("smsLog")
        .orderBy("createdAt", "desc")
        .limit(250)
        .get(),
    ]);

  const payments = tenant.demoShowcase?.payments
    ? serializeValue(tenant.demoShowcase.payments)
    : null;

  return {
    slug,
    tenantId,
    tenant: serializeDoc(tenant, tenantId),
    owner,
    bookingRequests: bookingsSnap.docs.map((d) => serializeDoc(d.data(), d.id)),
    customers: customersSnap.docs.map((d) => serializeDoc(d.data(), d.id)),
    smsThreads: threadsSnap.docs.map((d) => serializeDoc(d.data(), d.id)),
    smsMessages: smsLogSnap.docs.map((d) => serializeDoc(d.data(), d.id)),
    services: servicesSnap.docs.map((d) => serializeDoc(d.data(), d.id)),
    payments,
  };
}

module.exports = {
  ALLOWED_DEMO_APP_SLUGS,
  buildDemoAppSnapshot,
};
