/**
 * Shop calendars (not charters): stop two clients from taking the same time.
 *  - getShopBusyTimes: public list of taken times (no client details) so /book hides them.
 *  - reserveShopSlot: saves a web booking in a transaction after checking the time is still free.
 *  - onBookingHoldClosed: when an unpaid hold is cancelled or declined, the pay link is shut off.
 *
 * A time is taken by bookings that are new, pending, waiting for payment (until the hold ends)
 * or confirmed. On teams it is taken only for the same artist; unassigned bookings share one lane.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const occ = require("./charterOccupancy");

const HORIZON_DAYS = 150;
const DEFAULT_MINUTES = 60;

function db() {
  return admin.firestore();
}

function minutesInTz(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const h = Number((p.find((x) => x.type === "hour") || {}).value || 0);
  const m = Number((p.find((x) => x.type === "minute") || {}).value || 0);
  return (h % 24) * 60 + m;
}

/** { date, startMin, endMin, member } for a booking, or null when it has no usable time. */
function slotOf(d, tz, team) {
  let date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.scheduledDate || "")) ? d.scheduledDate : null;
  let start = Number.isFinite(Number(d.scheduledStartMin)) && d.scheduledStartMin !== null ? Number(d.scheduledStartMin) : null;
  const ts = d.requestedStartTime && d.requestedStartTime.toDate ? d.requestedStartTime.toDate() : null;
  if (ts) {
    // A time set in the app wins (the shop may have moved it).
    date = occ.isoDateInTz(ts, tz);
    start = minutesInTz(ts, tz);
  }
  if (!date || start == null) return null;
  const dur = Number(d.durationMinutes) > 0 ? Number(d.durationMinutes) : DEFAULT_MINUTES;
  return { date, startMin: start, endMin: start + dur, member: team ? String(d.assignedMemberUid || "") : "" };
}

function stillTakes(d, nowMs) {
  return occ.rowStillOccupies(d, nowMs);
}

function overlaps(a, b) {
  return a.date === b.date && a.member === b.member && a.startMin < b.endMin && b.startMin < a.endMin;
}

/** Bookings on or around a day (by saved date, and by app-set start time). */
async function rowsForDays(col, fromIso, toIso, tz, tx) {
  const fromTs = occ.instantFromIsoAndMin(fromIso, 0, tz);
  const toTs = occ.instantFromIsoAndMin(occ.addDaysToIso(toIso, 1), 0, tz);
  const q1 = col.where("scheduledDate", ">=", fromIso).where("scheduledDate", "<=", toIso);
  const q2 = col
    .where("requestedStartTime", ">=", admin.firestore.Timestamp.fromDate(fromTs))
    .where("requestedStartTime", "<", admin.firestore.Timestamp.fromDate(toTs));
  const [a, b] = tx ? [await tx.get(q1), await tx.get(q2)] : await Promise.all([q1.get(), q2.get()]);
  const byId = new Map();
  for (const doc of [...a.docs, ...b.docs]) byId.set(doc.id, doc);
  return [...byId.values()];
}

function isShopCalendar(tenant) {
  const plan = String((tenant && tenant.subscriptionPlan) || "").toLowerCase();
  return plan !== "charter";
}

/**
 * Save a non-charter web booking. When it has a date and time, it is saved only if that time
 * is still free for the same artist; otherwise the client is asked to pick another time.
 */
async function reserveShopSlot(tenantId, tenant, bookingData, team) {
  const col = db().collection("tenants").doc(tenantId).collection("bookingRequests");
  const tz = occ.tenantTimeZone(tenant);
  const mine = slotOf(bookingData, tz, team);
  if (!mine) return col.add(bookingData);
  const ref = col.doc();
  await db().runTransaction(async (tx) => {
    const docs = await rowsForDays(col, mine.date, mine.date, tz, tx);
    const nowMs = Date.now();
    for (const doc of docs) {
      const d = doc.data() || {};
      if (!stillTakes(d, nowMs)) continue;
      const s = slotOf(d, tz, team);
      if (s && overlaps(s, mine)) {
        throw new functions.https.HttpsError(
          "already-exists",
          "Sorry, that time was just taken. Please pick another time."
        );
      }
    }
    tx.set(ref, bookingData);
  });
  return ref;
}

function registerShopSlotFunctions(exportsObj, deps) {
  /** Public: taken times for the next few months. Times and artist only, never client details. */
  exportsObj.getShopBusyTimes = functions.https.onCall(async (data) => {
    const slug = String((data && data.tenantSlug) || "").trim().toLowerCase();
    const resolved = slug ? await deps.resolveTenantBySlug(slug) : null;
    if (!resolved) throw new functions.https.HttpsError("not-found", "Business not found");
    const tenant = resolved.data || {};
    if (!isShopCalendar(tenant)) return { busy: [] };
    const tz = occ.tenantTimeZone(tenant);
    const team = deps.isTeam(tenant);
    const fromIso = occ.isoDateInTz(new Date(), tz);
    const toIso = occ.addDaysToIso(fromIso, HORIZON_DAYS);
    const col = db().collection("tenants").doc(resolved.id).collection("bookingRequests");
    const docs = await rowsForDays(col, fromIso, toIso, tz, null);
    const nowMs = Date.now();
    const uids = new Set();
    const rows = [];
    for (const doc of docs) {
      const d = doc.data() || {};
      if (!stillTakes(d, nowMs)) continue;
      const s = slotOf(d, tz, team);
      if (!s || s.date < fromIso) continue;
      rows.push(s);
      if (s.member) uids.add(s.member);
    }
    // The page knows artists by their booking link name, not their account id.
    const slugByUid = {};
    if (uids.size) {
      const users = await db().collection("users").where("tenantId", "==", resolved.id).get();
      users.forEach((u) => {
        if (uids.has(u.id)) slugByUid[u.id] = String((u.data() || {}).memberSlug || "");
      });
    }
    return {
      busy: rows.map((s) => ({
        date: s.date,
        startMin: s.startMin,
        endMin: s.endMin,
        member: s.member ? slugByUid[s.member] || "artist" : "",
      })),
    };
  });

  /** Cancelled or declined while waiting for payment: shut off the pay link right away. */
  exportsObj.onBookingHoldClosed = functions
    .runWith({ secrets: [deps.stripeSecretKey] })
    .firestore.document("tenants/{tenantId}/bookingRequests/{requestId}")
    .onUpdate(async (change) => {
      const before = change.before.data() || {};
      const after = change.after.data() || {};
      const prev = String(before.status || "").toLowerCase();
      const next = String(after.status || "").toLowerCase();
      if (prev === next) return null;
      if (!occ.isPaymentHoldStatus(prev)) return null;
      if (!["cancelled", "canceled", "declined"].includes(next)) return null;
      const piId = String(after.stripePaymentIntentId || "").trim();
      if (!piId.startsWith("pi_")) return null;
      const key = deps.stripeSecretKey.value();
      if (!key) return null;
      const stripe = new Stripe(key, { apiVersion: "2024-11-20.acacia" });
      const acct = String(after.chargeStripeAccountId || "").trim();
      const opts = acct ? { stripeAccount: acct } : undefined;
      try {
        const pi = await stripe.paymentIntents.retrieve(piId, opts);
        if (pi.status === "succeeded" || pi.status === "canceled") return null; // paid: refund path handles it
        if (pi.status === "processing") return null; // can't cancel mid-payment; late-payment refund covers it
        await stripe.paymentIntents.cancel(piId, opts);
        await change.after.ref.set({ payLinkClosedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      } catch (e) {
        console.error("onBookingHoldClosed", change.after.ref.path, e.message || e);
      }
      return null;
    });
}

module.exports = { registerShopSlotFunctions, reserveShopSlot, isShopCalendar, slotOf, overlaps };
