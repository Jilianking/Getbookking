/**
 * Booking balances: a price on each booking, a list of payments (card, link, Tap to Pay, cash),
 * the balance still owed, and one reminder before the appointment or trip.
 *
 * Booking fields (tenants/{t}/bookingRequests/{id}):
 *   priceCents        total price set by the owner (charters: trip + add-ons when not set)
 *   payments          map id → { kind, role, cents, grossCents, at, pi?, by?, note?, refundedCents? }
 *                     cents = amount toward the price (before card fees); grossCents = what the client paid
 *   paidServiceCents  sum of payments (cents), minus refunds
 *   balanceCents      priceCents − paidServiceCents (null when there is no price)
 *   balanceReminderAt when the reminder should go out (null when none is due)
 *   balanceReminderSentAt
 *
 * paidCents and stripePaymentIntentId keep their old meaning so older apps still work.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const BOOKED = new Set(["confirmed", "pending_deposit", "pending_payment", "completed"]);
const MAX_CENTS = 5000000; // $50,000

function db() {
  return admin.firestore();
}

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v._seconds === "number") return new Date(v._seconds * 1000);
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function tzOf(tenant) {
  const tz = (tenant && (tenant.timeZone || tenant.timezone)) || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch (e) {
    return "America/New_York";
  }
}

/** Minutes the zone is ahead of UTC at that moment. */
function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Start time: requestedStartTime, else scheduledDate + scheduledStartMin in the shop's zone. */
function appointmentStart(doc, tz) {
  const requested = toDate(doc.requestedStartTime);
  if (requested) return requested;
  const iso = String(doc.scheduledDate || "").trim();
  let startMin = doc.scheduledStartMin;
  if (typeof startMin === "string") startMin = parseInt(startMin, 10);
  if (iso.length >= 10 && typeof startMin === "number" && !isNaN(startMin)) {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(startMin / 60), startMin % 60));
    return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000);
  }
  return null;
}

function whenLabel(date, tz) {
  return date.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(cents) {
  const v = (Number(cents) || 0) / 100;
  return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

function cleanCents(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_CENTS ? n : null;
}

function isCharter(tenant) {
  return String((tenant && tenant.subscriptionPlan) || "").toLowerCase() === "charter";
}

/** Owner-set price, else the charter trip total. */
function bookingPriceCents(d) {
  if (d.priceCents != null && Number.isFinite(Number(d.priceCents))) return Math.round(Number(d.priceCents));
  const trip = Number(d.tripCents);
  if (Number.isFinite(trip) && trip > 0) return Math.round(trip + (Number(d.addonCents) || 0));
  return null;
}

function paymentList(d) {
  const p = d.payments && typeof d.payments === "object" ? d.payments : {};
  return Object.keys(p).map((id) => ({ id, ...p[id] }));
}

function paidServiceCents(d) {
  return paymentList(d).reduce((sum, p) => sum + Math.max(0, (Number(p.cents) || 0) - (Number(p.refundedCents) || 0)), 0);
}

/** Settings with defaults: balanceReminderDays (0 = off), depositRefundable, balanceDue. */
function balanceSettings(tenant) {
  const w = (tenant && tenant.workflow) || {};
  const charter = isCharter(tenant);
  let days = Number(w.balanceReminderDays);
  if (!Number.isFinite(days) || days < 0 || days > 14) days = charter ? 2 : 1;
  return {
    balanceReminderDays: Math.round(days),
    depositRefundable: w.depositRefundable !== false,
    balanceDue: w.balanceDue === "before" || w.balanceDue === "at" ? w.balanceDue : charter ? "before" : "at",
  };
}

/** Fields that follow from price, payments, status and time. */
function computedFields(d, tenant) {
  const tz = tzOf(tenant);
  const price = bookingPriceCents(d);
  const paid = paidServiceCents(d);
  const balance = price == null ? null : Math.max(0, price - paid);
  const status = String(d.status || "").toLowerCase();
  const settings = balanceSettings(tenant);
  let reminderAt = null;
  if (balance && balance > 0 && BOOKED.has(status) && status !== "completed" && !d.balanceReminderSentAt && settings.balanceReminderDays > 0) {
    const start = appointmentStart(d, tz);
    if (start && start.getTime() > Date.now()) {
      reminderAt = new Date(Math.max(Date.now(), start.getTime() - settings.balanceReminderDays * 86400000));
    }
  }
  return { paidServiceCents: paid, balanceCents: balance, balanceReminderAt: reminderAt };
}

function sameValue(a, b) {
  const ta = toDate(a);
  const tb = toDate(b);
  if (ta || tb) return !!ta && !!tb && Math.abs(ta.getTime() - tb.getTime()) < 60000;
  return (a == null ? null : a) === (b == null ? null : b);
}

/** Adds the old single payment to the list once, using the ledger for the pre-fee amount. */
async function legacyPaymentPatch(ref, d) {
  if (d.payments && Object.keys(d.payments).length) return null;
  const pi = String(d.stripePaymentIntentId || "").trim();
  const gross = Number(d.paidCents) || 0;
  if (!pi.startsWith("pi_") || gross <= 0) return null;
  let cents = gross;
  try {
    const led = await ref.parent.parent.collection("paymentLedger").doc(pi).get();
    const sc = led.exists ? Number((led.data() || {}).serviceCents) : NaN;
    if (Number.isFinite(sc) && sc > 0) cents = Math.round(sc);
  } catch (e) {
    /* keep gross */
  }
  if (Number(d.depositPartCents) > 0) cents = Math.round(Number(d.depositPartCents));
  return {
    [pi]: { kind: "card", role: d.depositPaidAt ? "deposit" : "payment", cents, grossCents: gross, at: d.paidAt || d.depositPaidAt || null, pi },
  };
}

/**
 * Records a card payment from Stripe on the booking (idempotent by PaymentIntent id).
 * Called from confirmBookingAfterDepositPaid and the charter checkout.
 */
async function recordCardPaymentOnBooking(tenantId, bookingRequestId, pi, opts) {
  const tid = String(tenantId || "").trim();
  const rid = String(bookingRequestId || "").trim();
  if (!tid || !rid || !pi || !pi.id) return false;
  const ref = db().collection("tenants").doc(tid).collection("bookingRequests").doc(rid);
  const meta = pi.metadata || {};
  const service = parseInt(meta.serviceAmountCents, 10);
  const channel = String(meta.checkoutChannel || "");
  const kind = /tap/i.test(channel) || meta.tapToPay === "true" ? "tap" : channel === "deposit_link" || meta.balanceLink === "true" ? "link" : "card";
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data() || {};
    if (d.payments && d.payments[pi.id]) return;
    const role = meta.balanceLink === "true" ? "balance" : (opts && opts.role) || (String(meta.paymentKind) === "deposit" ? "deposit" : "payment");
    const entry = {
      kind,
      role,
      cents: Number.isFinite(service) && service > 0 ? service : pi.amount || 0,
      grossCents: pi.amount || 0,
      at: admin.firestore.FieldValue.serverTimestamp(),
      pi: pi.id,
    };
    const patch = { payments: { [pi.id]: entry } };
    // Older payment (before balances) goes into the list too, so it still counts.
    const oldPi = String(d.stripePaymentIntentId || "").trim();
    if (!d.payments && oldPi && oldPi !== pi.id) {
      const legacy = await legacyPaymentPatch(ref, d);
      if (legacy) Object.assign(patch.payments, legacy);
    }
    tx.set(ref, patch, { merge: true });
  });
  return true;
}

/* ── Permissions ── */

async function bookingForCaller(deps, uid, requestId) {
  const ctx = await deps.getMemberAccessContext(uid);
  const rid = String(requestId || "").trim();
  if (!rid) throw new functions.https.HttpsError("invalid-argument", "requestId is required.");
  const ref = db().collection("tenants").doc(ctx.tenantId).collection("bookingRequests").doc(rid);
  const snap = await ref.get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found", "Booking not found.");
  const d = snap.data() || {};
  const perms = ctx.managerPermissions || {};
  const assigned = String(d.assignedMemberUid || "") === uid;
  const manager = ctx.accessRole === "manager" && perms.viewAllBookings === true;
  if (!ctx.isOwner && !manager && !assigned) {
    throw new functions.https.HttpsError("permission-denied", "You can only change payments on your own bookings.");
  }
  return { ctx, ref, d };
}

/* ── Cancel refunds: every card payment, keeping deposits when the shop says they're non-refundable ── */

/**
 * PaymentIntents to refund on cancel, besides the booking's first one (stripePaymentIntentId).
 * Returns { extra: [piId], keepPrimary: bool }.
 */
function refundPlan(d, tenant) {
  const settings = balanceSettings(tenant);
  const primary = String(d.stripePaymentIntentId || "").trim();
  const list = paymentList(d).filter((p) => String(p.pi || "").startsWith("pi_") && !(Number(p.refundedCents) >= Number(p.cents)));
  const keep = (p) => !settings.depositRefundable && p.role === "deposit";
  const primaryEntry = list.find((p) => p.pi === primary);
  return {
    keepPrimary: primaryEntry ? keep(primaryEntry) : false,
    extra: list.filter((p) => p.pi !== primary && !keep(p)).map((p) => p.pi),
    keptDepositCents: list.filter(keep).reduce((s, p) => s + (Number(p.cents) || 0), 0),
  };
}

/* ── Reminder text and email ── */

function reminderText(tenant, d, start, tz) {
  const name = String(tenant.businessName || tenant.displayName || "us").trim();
  const service = String(d.serviceName || (isCharter(tenant) ? "trip" : "appointment")).trim();
  const when = whenLabel(start, tz);
  const balance = money(d.balanceCents);
  const settings = balanceSettings(tenant);
  if (isCharter(tenant)) {
    return { lead: `Reminder: your ${service} with ${name} is ${when}.`, due: `Balance due: ${balance}${settings.balanceDue === "before" ? ", before departure" : ""}.`, name };
  }
  return { lead: `Reminder: your appointment at ${name} is ${when}.`, due: `Balance due: ${balance}.`, name, atAppt: settings.balanceDue === "at" };
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendEmail({ to, fromName, replyTo, subject, html }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${String(fromName).replace(/[<>"]/g, "").slice(0, 60)} via Get Bookking <noreply@getbookking.com>`,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error("Resend " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 200));
  return { ok: true };
}

/* ── Registration ── */

function registerBalanceFunctions(exportsObj, deps) {
  const callAs = (fnName, data, uid) => {
    const fn = exportsObj[fnName];
    if (!fn || typeof fn.run !== "function") throw new Error(fnName + " unavailable");
    return fn.run(data, { auth: { uid, token: {} } });
  };

  /** Keeps balance fields in step whenever a booking changes. Writes only when something differs. */
  exportsObj.onBookingBalanceChanged = functions.firestore
    .document("tenants/{tenantId}/bookingRequests/{requestId}")
    .onWrite(async (change, context) => {
      if (!change.after.exists) return null;
      const ref = change.after.ref;
      let d = change.after.data() || {};
      const legacy = bookingPriceCents(d) != null ? await legacyPaymentPatch(ref, d) : null;
      if (legacy) d = { ...d, payments: legacy };
      if (bookingPriceCents(d) == null && !d.payments && d.balanceCents == null) return null;
      const tenant = (await db().collection("tenants").doc(context.params.tenantId).get()).data() || {};
      const next = computedFields(d, tenant);
      const patch = {};
      for (const k of Object.keys(next)) if (!sameValue(d[k], next[k])) patch[k] = next[k];
      if (legacy) patch.payments = legacy;
      if (next.balanceCents === 0 && d.balanceCents !== 0 && bookingPriceCents(d) != null) patch.paidInFullAt = admin.firestore.FieldValue.serverTimestamp();
      // Keep the old total in step for older apps.
      const gross = paymentList(d).reduce((s, p) => s + Math.max(0, (Number(p.grossCents) || Number(p.cents) || 0) - (Number(p.refundedCents) || 0)), 0);
      if (d.payments && gross !== Number(d.paidCents || 0)) patch.paidCents = gross;
      if (!Object.keys(patch).length) return null;
      await ref.set(patch, { merge: true });
      return null;
    });

  /** Owner or assigned member sets the total price (null clears it). */
  exportsObj.setBookingPrice = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const { ref } = await bookingForCaller(deps, context.auth.uid, data && data.requestId);
    const raw = data && data.priceCents;
    const price = raw === null || raw === "" ? null : cleanCents(raw);
    if (raw !== null && raw !== "" && price == null) throw new functions.https.HttpsError("invalid-argument", "Enter a price between $0 and $50,000.");
    await ref.set({ priceCents: price, priceSetBy: context.auth.uid, priceSetAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, priceCents: price };
  });

  /** Records cash (full or partial). */
  exportsObj.recordBookingCashPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const { ref } = await bookingForCaller(deps, context.auth.uid, data && data.requestId);
    const cents = cleanCents(data && data.cents);
    if (!cents) throw new functions.https.HttpsError("invalid-argument", "Enter the cash amount.");
    const id = "cash_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await ref.set({
      payments: {
        [id]: {
          kind: "cash", role: "balance", cents, grossCents: cents,
          at: admin.firestore.FieldValue.serverTimestamp(), by: context.auth.uid,
          note: String((data && data.note) || "").trim().slice(0, 120),
        },
      },
    }, { merge: true });
    return { ok: true, id };
  });

  /** Removes a cash entry made by mistake. Card payments are refunded instead, never removed. */
  exportsObj.removeBookingCashPayment = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const { ref, d } = await bookingForCaller(deps, context.auth.uid, data && data.requestId);
    const id = String((data && data.paymentId) || "");
    const p = d.payments && d.payments[id];
    if (!p || p.kind !== "cash") throw new functions.https.HttpsError("not-found", "Cash payment not found.");
    await ref.update({ ["payments." + id]: admin.firestore.FieldValue.delete() });
    return { ok: true };
  });

  /** Creates a pay link for the balance (or a part of it), through the same code as deposit links. */
  exportsObj.createBookingBalanceLink = functions
    .runWith({ secrets: [deps.stripeSecretKey].filter(Boolean) })
    .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const { ctx, d } = await bookingForCaller(deps, context.auth.uid, data && data.requestId);
    const next = computedFields(d, ctx.tenant || {});
    const owed = next.balanceCents;
    if (owed == null) throw new functions.https.HttpsError("failed-precondition", "Set a price on this booking first.");
    if (owed <= 0) throw new functions.https.HttpsError("failed-precondition", "This booking is paid in full.");
    const cents = data && data.cents != null ? cleanCents(data.cents) : owed;
    if (!cents || cents < 50 || cents > owed) throw new functions.https.HttpsError("invalid-argument", "Amount must be between $0.50 and the balance.");
    const label = (String(d.serviceName || "Booking").trim() + " balance").slice(0, 60);
    const res = await callAs("createDepositLink", {
      serviceAmountCents: cents,
      bookingRequestId: String(data.requestId),
      paymentKind: "service",
      productName: label,
      balanceLink: true,
    }, context.auth.uid);
    return { ok: true, url: res && res.url, cents, label };
    });

  /** Owner: balance settings (reminder days, deposits refundable, when the balance is due). */
  exportsObj.updateBalanceSettings = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const ctx = await deps.getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) throw new functions.https.HttpsError("permission-denied", "Only the owner can change payment settings.");
    const patch = {};
    if (data && data.balanceReminderDays != null) {
      const n = Math.round(Number(data.balanceReminderDays));
      if (![0, 1, 2, 3, 7].includes(n)) throw new functions.https.HttpsError("invalid-argument", "Reminder must be off, 1, 2, 3 or 7 days.");
      patch["workflow.balanceReminderDays"] = n;
    }
    if (data && data.depositRefundable != null) patch["workflow.depositRefundable"] = data.depositRefundable === true;
    if (data && data.depositPerService != null) patch["workflow.depositPerService"] = data.depositPerService === true;
    if (data && data.balanceDue != null) {
      if (!["before", "at"].includes(data.balanceDue)) throw new functions.https.HttpsError("invalid-argument", "Balance due must be before or at.");
      patch["workflow.balanceDue"] = data.balanceDue;
    }
    if (!Object.keys(patch).length) return { ok: true, settings: balanceSettings(ctx.tenant || {}) };
    await db().collection("tenants").doc(ctx.tenantId).update(patch);
    const fresh = (await db().collection("tenants").doc(ctx.tenantId).get()).data() || {};
    return { ok: true, settings: balanceSettings(fresh) };
  });

  /** Daily-ish: one balance reminder per booking, by text (if the shop texts) and email. */
  exportsObj.sendBookingBalanceReminders = functions
    .runWith({ secrets: [deps.stripeSecretKey, deps.twilioAccountSid, deps.twilioAuthToken].filter(Boolean), timeoutSeconds: 300 })
    .pubsub.schedule("every 1 hours")
    .onRun(async () => {
      const due = await db().collectionGroup("bookingRequests").where("balanceReminderAt", "<=", new Date()).limit(200).get();
      const out = { sent: 0, skipped: 0, failed: 0 };
      for (const doc of due.docs) {
        const ref = doc.ref;
        const tenantId = ref.parent.parent.id;
        try {
          const claimed = await db().runTransaction(async (tx) => {
            const s = await tx.get(ref);
            const d = s.data() || {};
            if (d.balanceReminderSentAt || !d.balanceReminderAt) return null;
            tx.set(ref, { balanceReminderSentAt: admin.firestore.FieldValue.serverTimestamp(), balanceReminderAt: null }, { merge: true });
            return d;
          });
          if (!claimed) { out.skipped++; continue; }
          const tenantSnap = await db().collection("tenants").doc(tenantId).get();
          const tenant = tenantSnap.data() || {};
          const tz = tzOf(tenant);
          const fresh = computedFields(claimed, tenant);
          const start = appointmentStart(claimed, tz);
          const status = String(claimed.status || "").toLowerCase();
          if (!fresh.balanceCents || !start || start.getTime() < Date.now() || !BOOKED.has(status)) { out.skipped++; continue; }
          const d = { ...claimed, balanceCents: fresh.balanceCents };
          const owner = tenant.ownerUid ? (await db().collection("users").doc(tenant.ownerUid).get()).data() || {} : {};
          const link = await callAs("createBookingBalanceLink", { requestId: ref.id }, tenant.ownerUid).catch((e) => {
            console.warn("balance reminder link", ref.id, e.message);
            return null;
          });
          const url = link && link.url;
          const t = reminderText(tenant, d, start, tz);
          const payLine = url ? (t.atAppt ? `Pay ahead here: ${url}, or pay at your appointment.` : `Pay here: ${url}`) : (t.atAppt ? "You can pay at your appointment." : "");
          const results = {};
          const phone = deps.sms.toE164US(claimed.customerPhone);
          const textBody = [t.lead, t.due, payLine].filter(Boolean).join(" ");
          // Artist's own number when the booking is theirs and their line is active; else the shop's.
          const artistUid = String(claimed.assignedMemberUid || "").trim();
          let artist = null;
          if (artistUid && artistUid !== tenant.ownerUid) {
            const a = (await db().collection("users").doc(artistUid).get()).data() || {};
            if (a.smsStatus === "active" && String(a.smsPhoneNumber || "").trim()) artist = a;
          }
          if (phone && artist) {
            try {
              await callAs("sendClientSms", { to: phone, body: textBody, clientName: String(claimed.customerName || ""), threadId: phone, threadPreview: t.due }, artistUid);
              results.text = "sent (artist number)";
            } catch (e) {
              results.text = "skipped: " + String(e.message).slice(0, 120);
            }
          } else if (phone && tenant.smsPhoneNumber) {
            try {
              await deps.sms.sendTenantSms(tenantId, tenant, phone, textBody, { bookingRequestId: ref.id, kind: "balance_reminder" }, owner);
              results.text = "sent";
            } catch (e) {
              results.text = "skipped: " + String(e.message).slice(0, 120);
            }
          }
          const email = String(claimed.customerEmail || "").trim();
          if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            try {
              const btn = url ? `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#2b2118;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">Pay ${escapeHtml(money(d.balanceCents))}</a></p>` : "";
              await sendEmail({
                to: email,
                fromName: t.name,
                replyTo: String(tenant.email || tenant.contactEmail || owner.email || "").trim() || undefined,
                subject: `Balance due for ${t.name}: ${money(d.balanceCents)}`,
                html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1f;max-width:520px">` +
                  `<p>${escapeHtml(t.lead)}</p><p><strong>${escapeHtml(t.due)}</strong></p>${btn}` +
                  (t.atAppt ? `<p>You can also pay at your appointment.</p>` : "") +
                  `<p style="color:#86868b;font-size:12px">Sent for ${escapeHtml(t.name)} by Get Bookking. Reply to this email to reach ${escapeHtml(t.name)}.</p></div>`,
              });
              results.email = "sent";
            } catch (e) {
              results.email = "failed: " + String(e.message).slice(0, 120);
            }
          }
          await ref.set({ balanceReminderResult: results }, { merge: true });
          if (String(results.text || "").startsWith("sent") || results.email === "sent") out.sent++; else out.skipped++;
        } catch (e) {
          out.failed++;
          console.error("sendBookingBalanceReminders", tenantId, ref.id, e.message);
        }
      }
      console.log("sendBookingBalanceReminders", JSON.stringify(out));
      return null;
    });
}

module.exports = {
  registerBalanceFunctions,
  recordCardPaymentOnBooking,
  refundPlan,
  balanceSettings,
  bookingPriceCents,
  _test: { computedFields, appointmentStart, paidServiceCents, reminderText, tzOffsetMinutes },
};
