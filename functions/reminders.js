/**
 * Automatic appointment reminder texts + "Reply C to confirm or R to reschedule".
 *
 * Owner settings (tenant.appointmentReminders): { dayBefore: bool, twoHours: bool }. Both off unless the owner turns them on.
 * - Day before: sent from 10 AM to 9 PM shop time the day before the appointment.
 * - 2 hours before: sent when the appointment is 2 hours (or less, but at least 30 min) away, never before 7 AM.
 * Only confirmed appointments with a set time, a phone number, and texting consent. Skipped when the owner
 * unchecked "Text the client a confirmation" (skipConfirmationSms). Each reminder is claimed in a transaction
 * keyed to the appointment start, so it sends once; moving the appointment resets it.
 */
"use strict";

const admin = require("firebase-admin");

const DEFAULT_TZ = "America/New_York";
const CONFIRM_WORDS = new Set(["C", "CONFIRM", "CONFIRMED", "C."]);
const RESCHEDULE_WORDS = new Set(["R", "RESCHEDULE", "R."]);

function db() {
  return admin.firestore();
}

function tzOf(tenant) {
  const tz = String((tenant && tenant.timeZone) || "").trim();
  try {
    if (tz) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_TZ;
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "0";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return dt.toISOString().slice(0, 10);
}

function businessName(tenant) {
  return String((tenant && (tenant.businessName || tenant.displayName)) || "us").trim() || "us";
}

function isCharterTenant(tenant) {
  return String((tenant && tenant.subscriptionPlan) || "").toLowerCase() === "charter";
}

function bookingPageUrl(tenant) {
  if (!tenant) return "";
  if (String(tenant.bookingMode || "") !== "calendar_slots" || isCharterTenant(tenant)) return "";
  const custom = tenant.customDomainStatus === "active" && tenant.customDomain
    ? "https://www." + String(tenant.customDomain).replace(/^www\./, "")
    : "";
  const slug = String(tenant.slug || "").trim();
  const base = custom || (slug ? `https://${slug}.getbookking.com` : "");
  return base ? base + "/book" : "";
}

function timeLabel(date, tz) {
  return date.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

function dayLabel(date, tz) {
  return date.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}

function firstName(name) {
  const n = String(name || "").trim().split(/\s+/)[0] || "";
  return n && n.toLowerCase() !== "client" ? n : "";
}

function reminderBody(tenant, booking, start, kind) {
  const tz = tzOf(tenant);
  const hi = firstName(booking.customerName) ? `Hi ${firstName(booking.customerName)}! ` : "Hi! ";
  const biz = businessName(tenant);
  const svc = String(booking.serviceName || "").trim();
  const when = kind === "dayBefore"
    ? `tomorrow at ${timeLabel(start, tz)}`
    : `today at ${timeLabel(start, tz)}`;
  let line;
  if (isCharterTenant(tenant)) {
    line = `${hi}Reminder: your trip${svc ? " (" + svc + ")" : ""} with ${biz} departs ${when}.`;
  } else {
    line = `${hi}Reminder: your ${svc || "appointment"} with ${biz} is ${when}.`;
  }
  let body = `${line} Reply C to confirm or R to reschedule.`;
  const link = bookingPageUrl(tenant);
  if (link) body += `\nPick a new time: ${link}`;
  body += "\nReply STOP to opt out.";
  return body.slice(0, 1600);
}

/** Which reminder (if any) is due right now for this booking. */
function dueKind(settings, start, now, tz, booking) {
  const startMs = start.getTime();
  const nowMs = now.getTime();
  if (startMs <= nowMs) return null;
  const sent = booking.reminders || {};
  const local = localParts(now, tz);
  const startLocal = localParts(start, tz);
  // Don't remind about something booked in the last 3 hours (they just heard from you).
  const created = booking.createdAt && booking.createdAt.toDate ? booking.createdAt.toDate().getTime() : 0;
  const fresh = created && nowMs - created < 3 * 3600 * 1000;

  if (settings.twoHours && sent.twoHoursFor !== startMs) {
    const minsAway = (startMs - nowMs) / 60000;
    if (minsAway <= 120 && minsAway >= 30 && local.hour >= 7 && local.hour < 21 && !fresh) return "twoHours";
  }
  if (settings.dayBefore && sent.dayBeforeFor !== startMs) {
    const tomorrow = addDaysYmd(local.ymd, 1);
    if (startLocal.ymd === tomorrow && local.hour >= 10 && local.hour < 21 && !fresh) return "dayBefore";
  }
  return null;
}

/**
 * Runs every 15 minutes. `deps` = { sms } (the functions/sms.js module).
 */
async function runReminderSweep(deps, now = new Date()) {
  const { sms } = deps;
  const tenantsById = new Map();
  for (const field of ["appointmentReminders.dayBefore", "appointmentReminders.twoHours"]) {
    const snap = await db().collection("tenants").where(field, "==", true).get();
    snap.forEach((doc) => tenantsById.set(doc.id, doc.data() || {}));
  }
  let sentCount = 0;
  for (const [tenantId, tenant] of tenantsById) {
    const settings = tenant.appointmentReminders || {};
    const tz = tzOf(tenant);
    let ownerData = null;
    if (tenant.ownerUid) {
      const o = await db().collection("users").doc(String(tenant.ownerUid)).get();
      if (o.exists) ownerData = o.data();
    }
    if (sms.smsEligibilityBlockReason(tenant, ownerData, isCharterTenant(tenant) ? {} : tenant.managerPermissions)) continue;

    const from = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - 60 * 1000));
    const until = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 40 * 3600 * 1000));
    const snap = await db().collection("tenants").doc(tenantId).collection("bookingRequests")
      .where("requestedStartTime", ">=", from)
      .where("requestedStartTime", "<=", until)
      .get();

    for (const doc of snap.docs) {
      const b = doc.data() || {};
      if (String(b.status || "").toLowerCase() !== "confirmed") continue;
      if (b.skipConfirmationSms === true) continue;
      if (String(b.source || "").toLowerCase() === "seed") continue;
      const start = b.requestedStartTime && b.requestedStartTime.toDate ? b.requestedStartTime.toDate() : null;
      if (!start) continue;
      const kind = dueKind(settings, start, now, tz, b);
      if (!kind) continue;
      const to = sms.extractCustomerPhone(b);
      if (!to) continue;

      // Claim it so a retry or overlapping run can't send twice.
      const startMs = start.getTime();
      const flag = kind === "dayBefore" ? "reminders.dayBeforeFor" : "reminders.twoHoursFor";
      const claimed = await db().runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        const r = (fresh.data() || {}).reminders || {};
        const already = kind === "dayBefore" ? r.dayBeforeFor : r.twoHoursFor;
        if (already === startMs) return false;
        tx.update(doc.ref, { [flag]: startMs });
        return true;
      });
      if (!claimed) continue;

      try {
        await sms.sendTenantSms(tenantId, tenant, to, reminderBody(tenant, b, start, kind), {
          bookingRequestId: doc.id,
          threadId: sms.threadIdFromPhone(to),
          clientName: String(b.customerName || ""),
          smsConsentAccepted: b.smsConsentAccepted === true,
        }, ownerData);
        await doc.ref.update({
          "reminders.lastSentAt": admin.firestore.FieldValue.serverTimestamp(),
          "reminders.lastKind": kind,
          // Lets a "C" / "R" reply find this booking.
          reminderReplyPhone: to,
        });
        sentCount += 1;
      } catch (e) {
        // Not eligible (no consent, opted out, limit reached…): leave it claimed so we don't retry every 15 min.
        console.warn("reminder skipped", tenantId, doc.id, kind, e && e.message ? e.message : e);
      }
    }
  }
  if (sentCount) console.log("appointment reminders sent", sentCount);
  return sentCount;
}

/**
 * Called from the inbound text webhook. Returns { reply } when the text was a C / R answer to a reminder,
 * or null to let the normal message handling run. `deps` = { sms, notifyOwner(tenantId, booking, requestId) }.
 */
async function handleReminderReply(deps, { tenantId, tenant, from, upperBody }) {
  const word = String(upperBody || "").trim();
  const confirm = CONFIRM_WORDS.has(word);
  const reschedule = RESCHEDULE_WORDS.has(word);
  if (!confirm && !reschedule) return null;
  const { sms } = deps;
  const e164 = sms.toE164US(from) || from;
  const snap = await db().collection("tenants").doc(tenantId).collection("bookingRequests")
    .where("reminderReplyPhone", "==", e164)
    .get();
  const nowMs = Date.now();
  let best = null;
  snap.forEach((doc) => {
    const b = doc.data() || {};
    const start = b.requestedStartTime && b.requestedStartTime.toDate ? b.requestedStartTime.toDate() : null;
    if (!start || start.getTime() < nowMs - 3600 * 1000) return;
    if (String(b.status || "").toLowerCase() !== "confirmed") return;
    if (!best || start < best.start) best = { doc, data: b, start };
  });
  if (!best) return null;

  const tz = tzOf(tenant);
  const when = `${dayLabel(best.start, tz)} at ${timeLabel(best.start, tz)}`;
  const biz = businessName(tenant);
  if (confirm) {
    await best.doc.ref.update({
      clientConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      rescheduleRequestedAt: admin.firestore.FieldValue.delete(),
    });
    return { reply: `Thanks, you're confirmed for ${when}. See you then! — ${biz}` };
  }
  await best.doc.ref.update({
    rescheduleRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    clientConfirmedAt: admin.firestore.FieldValue.delete(),
  });
  try {
    if (deps.notifyOwner) await deps.notifyOwner(tenantId, best.data, best.doc.id, when);
  } catch (e) {
    console.warn("reschedule notify", e && e.message ? e.message : e);
  }
  const link = bookingPageUrl(tenant);
  return {
    reply: link
      ? `Got it — pick a new time here: ${link} or ${biz} will text you to find one.`
      : `Got it — ${biz} will text you to find a new time.`,
  };
}

module.exports = { runReminderSweep, handleReminderReply, reminderBody, dueKind, bookingPageUrl };
