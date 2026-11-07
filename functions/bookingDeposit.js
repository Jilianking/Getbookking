/**
 * Deposit at booking for shops (non-charter) with "Deposit to confirm".
 * The client books, the request is held as pending_deposit for 15 minutes, and they are sent to
 * the shop's /pay page. Paying confirms it (stripeSubscriptionWebhook → confirmBookingAfterDepositPaid).
 * Unpaid holds are cancelled by expireCharterPaymentHolds (it handles any booking with holdUntil).
 *
 * Deposit amount: the service's own deposit when "Different deposit per service" is on
 * (workflow.depositPerService), else workflow.depositAmount. Amounts are in dollars, like the app.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const HOLD_MINUTES = 15;

function db() {
  return admin.firestore();
}

function dollarsToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function needsDepositAtBooking(tenant) {
  const w = (tenant && tenant.workflow) || {};
  const plan = String((tenant && tenant.subscriptionPlan) || "").toLowerCase();
  return plan !== "charter" && String(w.confirmationType || "").toLowerCase() === "deposit_to_confirm";
}

/** Deposit in cents for this service (0 = none set). */
function depositCentsFor(tenant, service) {
  const w = (tenant && tenant.workflow) || {};
  if (w.depositPerService === true && service) {
    const own = dollarsToCents(service.depositAmount);
    if (own) return own;
  }
  return dollarsToCents(w.depositAmount);
}

async function loadService(tenantId, serviceId, serviceSlug) {
  const col = db().collection("tenants").doc(tenantId).collection("services");
  if (serviceId) {
    const s = await col.doc(String(serviceId)).get();
    if (s.exists) return { id: s.id, ...s.data() };
  }
  if (serviceSlug) {
    const q = await col.where("slug", "==", String(serviceSlug)).limit(1).get();
    if (!q.empty) return { id: q.docs[0].id, ...q.docs[0].data() };
  }
  return null;
}

function registerBookingDepositFunctions(exportsObj, deps) {
  /**
   * Public: same input as createBookingRequestFromWeb. Returns { requestId, payUrl } when a deposit
   * is due, or { requestId, noDeposit: true } when the shop has no deposit set (plain request).
   */
  exportsObj.startBookingDepositCheckout = functions
    .runWith({ secrets: [deps.stripeSecretKey] })
    .https.onCall(async (data, context) => {
      const slug = String((data && data.tenantSlug) || "").trim().toLowerCase();
      const resolved = slug ? await deps.resolveTenantBySlug(slug) : null;
      if (!resolved) throw new functions.https.HttpsError("not-found", "Business not found");
      const tenantId = resolved.id;
      const tenant = resolved.data || {};
      const service = await loadService(tenantId, data && data.serviceId, data && data.serviceSlug);
      const depositCents = needsDepositAtBooking(tenant) ? depositCentsFor(tenant, service) : 0;

      // Same checks and record as a normal booking request.
      const created = await exportsObj.createBookingRequestFromWeb.run(data, context);
      const requestId = created && created.requestId;
      if (!requestId) throw new functions.https.HttpsError("internal", "Could not save the booking.");
      const ref = db().collection("tenants").doc(tenantId).collection("bookingRequests").doc(requestId);

      const priceCents = service ? dollarsToCents(service.price) : 0;
      if (depositCents < 50) {
        if (priceCents) await ref.set({ priceCents }, { merge: true });
        return { requestId, noDeposit: true };
      }

      await ref.set({
        status: "pending_deposit",
        depositCents,
        ...(priceCents ? { priceCents } : {}),
        holdUntil: admin.firestore.Timestamp.fromMillis(Date.now() + HOLD_MINUTES * 60000),
        depositAtBooking: true,
      }, { merge: true });

      // Deposit link through the same code the owner uses (routes to the artist's account on teams).
      const ownerUid = String(tenant.ownerUid || "").trim();
      const label = ((service && service.name) || (data && data.serviceName) || "Booking").toString().trim().slice(0, 50) + " deposit";
      let link;
      try {
        link = await exportsObj.createDepositLink.run(
          { serviceAmountCents: depositCents, bookingRequestId: requestId, paymentKind: "deposit", productName: label },
          { auth: { uid: ownerUid, token: {} } }
        );
      } catch (e) {
        // Payments not set up: keep it as a normal request instead of losing the booking.
        console.warn("startBookingDepositCheckout link", tenantId, requestId, e.message || e);
        await ref.set({
          status: "NEW",
          holdUntil: admin.firestore.FieldValue.delete(),
          depositAtBooking: admin.firestore.FieldValue.delete(),
          depositLinkError: String((e && e.message) || "link failed").slice(0, 200),
        }, { merge: true });
        return { requestId, noDeposit: true };
      }
      const url = String((link && link.url) || "");
      const m = url.match(/[?&]pi=(pi_[A-Za-z0-9_]+)/);
      const patch = {};
      const piId = (link && link.paymentIntentId) || (m && m[1]);
      if (piId) patch.stripePaymentIntentId = piId;
      if (link && link.stripeAccountId) patch.chargeStripeAccountId = link.stripeAccountId;
      if (Object.keys(patch).length) await ref.set(patch, { merge: true });
      return { requestId, payUrl: url, depositCents, holdMinutes: HOLD_MINUTES };
    });
}

module.exports = { registerBookingDepositFunctions, needsDepositAtBooking, depositCentsFor };
