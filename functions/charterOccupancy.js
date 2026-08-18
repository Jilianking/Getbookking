/**
 * Charter fleet occupancy: assign a hull, honor payment holds, check clocks in tenant TZ.
 */
const { HttpsError } = require("firebase-functions/v2/https");
const functions = require("firebase-functions");

const CHARTER_PAYMENT_HOLD_MINUTES = 15;
const CHARTER_OCCUPANCY_HORIZON_DAYS = 186;
const CHARTER_DEFAULT_MEET_PAD_MIN = 30;
const DEFAULT_TZ = "America/New_York";

function failed(msg) {
  try {
    return new HttpsError("failed-precondition", msg);
  } catch (_) {
    return new functions.https.HttpsError("failed-precondition", msg);
  }
}

function occupyingStatus(status) {
  const s = (status || "").toString().trim().toLowerCase();
  return (
    s === "new" ||
    s === "pending" ||
    s === "pending_deposit" ||
    s === "pending_payment" ||
    s === "pending_consultation" ||
    s === "confirmed"
  );
}

function isPaymentHoldStatus(status) {
  const s = (status || "").toString().trim().toLowerCase();
  return s === "pending_deposit" || s === "pending_payment";
}

function tsMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (typeof v._seconds === "number") return v._seconds * 1000;
  return 0;
}

function holdUntilMillis(d) {
  const until = tsMillis(d && d.holdUntil);
  if (until > 0) return until;
  const created = tsMillis(d && d.createdAt);
  if (created > 0) return created + CHARTER_PAYMENT_HOLD_MINUTES * 60 * 1000;
  return 0;
}

function rowStillOccupies(d, nowMs) {
  const s = (d && d.status) || "";
  if (isPaymentHoldStatus(s)) {
    const until = holdUntilMillis(d);
    if (until > 0 && until <= nowMs) return false;
    return true;
  }
  return occupyingStatus(s);
}

function tenantTimeZone(tenant) {
  const raw =
    (tenant && tenant.timeZone) ||
    (tenant && tenant.availability && tenant.availability.timeZone) ||
    DEFAULT_TZ;
  const tz = String(raw || "").trim();
  return tz || DEFAULT_TZ;
}

function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const bag = {};
  fmt.formatToParts(date).forEach((p) => {
    if (p.type !== "literal") bag[p.type] = p.value;
  });
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
  };
}

function isoDateInTz(date, tz) {
  const p = partsInTz(date, tz);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  return `${p.year}-${m}-${d}`;
}

/** UTC Date whose wall clock in `tz` is `dateIso` at `startMin` minutes from midnight. */
function instantFromIsoAndMin(dateIso, startMin, tz) {
  const m = String(dateIso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !Number.isFinite(Number(startMin))) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hour = Math.floor(Number(startMin) / 60);
  const minute = Number(startMin) % 60;
  let ms = Date.UTC(y, mo - 1, d, hour, minute, 0);
  const zone = tz || DEFAULT_TZ;
  for (let i = 0; i < 4; i++) {
    const p = partsInTz(new Date(ms), zone);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const want = Date.UTC(y, mo - 1, d, hour, minute, 0);
    const delta = want - got;
    if (delta === 0) break;
    ms += delta;
  }
  return new Date(ms);
}

function leadCutoffMin(now, tz) {
  const p = partsInTz(now, tz);
  return (p.hour + 1) * 60;
}

function weekdayIndexForIso(dateIso, tz) {
  const m = String(dateIso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || DEFAULT_TZ,
    weekday: "short",
  }).format(utc);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[wd] != null ? map[wd] : 0;
}

function intMin(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Math.max(0, Math.min(Math.floor(v), 24 * 60 - 1));
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : Math.max(0, Math.min(n, 24 * 60 - 1));
}

function parseDaySchedule(dayMap) {
  if (!dayMap || typeof dayMap !== "object") return { closed: true, ranges: [] };
  const closed = dayMap.closed === true;
  let ranges = Array.isArray(dayMap.ranges) ? dayMap.ranges : [];
  if (!ranges.length && dayMap.openMin != null && dayMap.closeMin != null) {
    ranges = [{ openMin: dayMap.openMin, closeMin: dayMap.closeMin }];
  }
  if (closed || !ranges.length) return { closed: true, ranges: [] };
  return {
    closed: false,
    ranges: ranges.map((r) => ({
      openMin: intMin(r.openMin != null ? r.openMin : r.startMin),
      closeMin: intMin(r.closeMin != null ? r.closeMin : r.endMin),
    })),
  };
}

function daySchedule(tenant, dateIso) {
  const keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const idx = weekdayIndexForIso(dateIso, tenantTimeZone(tenant));
  const w = tenant && tenant.businessHoursWeekly;
  if (w && typeof w === "object" && Object.keys(w).length) {
    return parseDaySchedule(w[keys[idx]]);
  }
  if (idx >= 5) return { closed: true, ranges: [] };
  return { closed: false, ranges: [{ openMin: 9 * 60, closeMin: 17 * 60 }] };
}

function isFullDayBlocked(tenant, dateIso) {
  const blocked = tenant && Array.isArray(tenant.blockedDates) ? tenant.blockedDates : [];
  return blocked.indexOf(dateIso) >= 0;
}

function partialBlocks(tenant, dateIso) {
  const list = tenant && Array.isArray(tenant.blockedTimeRanges) ? tenant.blockedTimeRanges : [];
  return list
    .filter((b) => {
      const d = b && (b.date || b.dateYmd) ? String(b.date || b.dateYmd) : "";
      return d === dateIso;
    })
    .map((b) => {
      let s = parseInt(b.startMin != null ? b.startMin : b.startMinutes, 10);
      let e = parseInt(b.endMin != null ? b.endMin : b.endMinutes, 10);
      if (Number.isNaN(s)) s = 0;
      if (Number.isNaN(e)) e = s + 30;
      return { startMin: s, endMin: e };
    });
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function boatsList(tenant) {
  return tenant && Array.isArray(tenant.charterBoats) ? tenant.charterBoats : [];
}

/** One location = any overlapping trip blocks the dock. By boat = hulls can overlap. */
function charterBookByLocation(tenant) {
  const wf = tenant && tenant.workflow && typeof tenant.workflow === "object" ? tenant.workflow : {};
  const raw = String(wf.charterBookBy || tenant.charterBookBy || "location")
    .toString()
    .trim()
    .toLowerCase();
  return raw !== "boat" && raw !== "boats" && raw !== "fleet";
}

function workflowBag(tenant) {
  return tenant && tenant.workflow && typeof tenant.workflow === "object" ? tenant.workflow : {};
}

/** Minutes held after a trip before the next departure can start. Default 30. */
function charterBufferMinutes(tenant) {
  const n = Number(workflowBag(tenant).charterBufferMinutes);
  if (n === 0) return 0;
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.min(240, Math.round(n));
}

/** Latest allowed departure start (minutes from midnight), or null for end of hours. */
function charterLastBookingMin(tenant) {
  const raw = workflowBag(tenant).charterLastBookingMin;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(24 * 60, Math.round(n));
}

function serviceBoatIds(service) {
  if (!service) return [];
  if (Array.isArray(service.boatIds) && service.boatIds.length) {
    return service.boatIds.map((id) => String(id || "").trim()).filter(Boolean);
  }
  const one = String(service.boatId || "").trim();
  return one ? [one] : [];
}

function eligibleBoats(tenant, service, partySize, boatFilterId) {
  let boats = boatsList(tenant).filter((b) => b && String(b.id || "").trim());
  if (!boats.length) return [];
  const ids = serviceBoatIds(service);
  if (ids.length) {
    const want = new Set(ids);
    boats = boats.filter((b) => want.has(String(b.id)));
  }
  const filter = String(boatFilterId || "").trim();
  if (filter) boats = boats.filter((b) => String(b.id) === filter);
  const people = Number(partySize) || 0;
  if (people > 0) {
    boats = boats.filter((b) => Number(b.maxPeople) >= people);
  }
  boats.sort((a, b) => {
    const ca = Number(a.maxPeople) || 0;
    const cb = Number(b.maxPeople) || 0;
    if (ca !== cb) return ca - cb;
    return String(a.id).localeCompare(String(b.id));
  });
  return boats;
}

function addDaysToIso(dateIso, days) {
  const m = String(dateIso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const dt = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(days), 12, 0, 0)
  );
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mo}-${d}`;
}

function itineraryOccupancyOffsets(service, durationMin) {
  const dur = Math.max(30, Number(durationMin) || 60);
  const raw = service && Array.isArray(service.itinerary) ? service.itinerary : [];
  let minOff = 0;
  let maxOff = dur;
  let any = false;
  for (let i = 0; i < raw.length; i++) {
    const off = Number(raw[i] && raw[i].offsetMinutes);
    if (!Number.isFinite(off)) continue;
    any = true;
    if (off < minOff) minOff = off;
    if (off > maxOff) maxOff = off;
  }
  if (!any) minOff = -CHARTER_DEFAULT_MEET_PAD_MIN;
  return { minOff, maxOff: Math.max(maxOff, dur) };
}

function occupancyWindow(startMin, durationMin, service) {
  const start = Number(startMin);
  const { minOff, maxOff } = itineraryOccupancyOffsets(service, durationMin);
  return {
    occStartMin: start + minOff,
    occEndMin: start + maxOff,
  };
}

function occupyingSegments(dateIso, occStartMin, occEndMin, boatId) {
  const segs = [];
  const bid = String(boatId || "").trim();
  if (!dateIso) return segs;
  let date = dateIso;
  let start = Number(occStartMin);
  let end = Number(occEndMin);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return segs;
  if (start < 0) {
    const prev = addDaysToIso(date, -1);
    if (prev) {
      segs.push({ date: prev, startMin: 1440 + start, endMin: 1440, boatId: bid });
    }
    start = 0;
  }
  while (end > 1440) {
    segs.push({ date, startMin: start, endMin: 1440, boatId: bid });
    date = addDaysToIso(date, 1);
    start = 0;
    end -= 1440;
    if (!date) break;
  }
  if (date) segs.push({ date, startMin: start, endMin: end, boatId: bid });
  return segs;
}

function occupyingWindowFromRow(d, bufferMin) {
  const startMin = Number.isFinite(Number(d.scheduledStartMin))
    ? Number(d.scheduledStartMin)
    : null;
  if (startMin == null) return null;
  const dur = Number(d.durationMinutes) > 0 ? Number(d.durationMinutes) : 240;
  const storedStart = Number(d.scheduledOccStartMin);
  const storedEnd = Number(d.scheduledOccEndMin);
  const occStartMin = Number.isFinite(storedStart)
    ? storedStart
    : startMin - CHARTER_DEFAULT_MEET_PAD_MIN;
  let occEndMin = Number.isFinite(storedEnd) ? storedEnd : startMin + dur;
  occEndMin += Math.max(0, Number(bufferMin) || 0);
  return {
    dateIso: String(d.scheduledDate || "").trim(),
    occStartMin,
    occEndMin,
    boatId: String(d.boatId || "").trim(),
  };
}

function occupyingInterval(d, bufferMin) {
  const win = occupyingWindowFromRow(d, bufferMin);
  if (!win) return null;
  return {
    startMin: win.occStartMin,
    endMin: win.occEndMin,
    boatId: win.boatId,
  };
}

function segmentsFromRow(d, bufferMin) {
  const win = occupyingWindowFromRow(d, bufferMin);
  if (!win || !win.dateIso) return [];
  return occupyingSegments(win.dateIso, win.occStartMin, win.occEndMin, win.boatId);
}

function boatBlockedByRows(boatId, rows, candidateSegs, excludeRequestId, locationWide, bufferMin) {
  const skip = String(excludeRequestId || "");
  const want = String(boatId || "").trim();
  const segs = candidateSegs || [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (skip && String(row.id || "") === skip) continue;
    const rowSegs = segmentsFromRow(row, bufferMin);
    for (let r = 0; r < rowSegs.length; r++) {
      const rs = rowSegs[r];
      for (let c = 0; c < segs.length; c++) {
        const cs = segs[c];
        if (String(cs.date || "") !== String(rs.date || "")) continue;
        if (!overlaps(cs.startMin, cs.endMin, rs.startMin, rs.endMin)) continue;
        if (locationWide || !rs.boatId || rs.boatId === want) return true;
      }
    }
  }
  return false;
}

function pickFreeBoat(eligible, rows, dateIso, startMin, durationMin, excludeRequestId, service, tenant) {
  const locationWide = charterBookByLocation(tenant);
  const bufferMin = charterBufferMinutes(tenant);
  const win = occupancyWindow(startMin, durationMin, service);
  const segs = occupyingSegments(dateIso, win.occStartMin, win.occEndMin, "");
  for (let i = 0; i < eligible.length; i++) {
    const id = String(eligible[i].id || "").trim();
    if (!id) continue;
    const withBoat = segs.map((s) => Object.assign({}, s, { boatId: id }));
    if (!boatBlockedByRows(id, rows, withBoat, excludeRequestId, locationWide, bufferMin)) {
      return eligible[i];
    }
  }
  return null;
}

function startFitsHours(day, startMin, durationMin, service) {
  if (!day || day.closed || !day.ranges || !day.ranges.length) return false;
  const { maxOff } = itineraryOccupancyOffsets(service, durationMin);
  const end = startMin + maxOff;
  return day.ranges.some((r) => {
    if (startMin < r.openMin || startMin > r.closeMin) return false;
    if (maxOff > 1440) return true;
    return end <= r.closeMin;
  });
}

function departureMinsForDay(day, durationMin, service, lastBookingMin) {
  if (!day || day.closed || !day.ranges || !day.ranges.length) return [];
  const { maxOff } = itineraryOccupancyOffsets(service, durationMin);
  const seen = new Set();
  const out = [];
  const lastCap = Number.isFinite(Number(lastBookingMin)) ? Number(lastBookingMin) : null;
  for (const r of day.ranges) {
    let first = Math.ceil(r.openMin / 60) * 60;
    if (first < r.openMin) first += 60;
    const last = maxOff > 1440 ? r.closeMin : r.closeMin - maxOff;
    for (let t = first; t <= last && t <= r.closeMin; t += 60) {
      if (lastCap != null && t > lastCap) continue;
      if (t >= r.openMin && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function assertHoursAndClock(tenant, dateIso, startMin, durationMin, now, service) {
  const tz = tenantTimeZone(tenant);
  const todayIso = isoDateInTz(now, tz);
  if (dateIso < todayIso) {
    throw failed("That day is in the past.");
  }
  if (dateIso === todayIso && startMin < leadCutoffMin(now, tz)) {
    throw failed("That departure is too soon. Pick the next clock hour or later.");
  }
  if (isFullDayBlocked(tenant, dateIso)) {
    throw failed("The boat is off that day.");
  }
  const day = daySchedule(tenant, dateIso);
  if (!day || day.closed || !day.ranges.length) {
    throw failed("We're closed that day.");
  }
  if (startMin % 60 !== 0) {
    throw failed("Pick a departure on the hour.");
  }
  const lastBook = charterLastBookingMin(tenant);
  if (lastBook != null && startMin > lastBook) {
    throw failed("That departure is after the last booking time.");
  }
  if (!startFitsHours(day, startMin, durationMin, service)) {
    throw failed("That time is outside our hours.");
  }
  const win = occupancyWindow(startMin, durationMin, service);
  const segs = occupyingSegments(dateIso, win.occStartMin, win.occEndMin, "");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (isFullDayBlocked(tenant, seg.date) && seg.date !== dateIso) {
      throw failed("That trip runs into a blocked day.");
    }
    const blocks = partialBlocks(tenant, seg.date);
    if (blocks.some((b) => overlaps(seg.startMin, seg.endMin, b.startMin, b.endMin))) {
      throw failed("That time is blocked.");
    }
  }
}

function occupyingRowsFromSnap(snap, nowMs) {
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    d.id = doc.id;
    if (!rowStillOccupies(d, nowMs)) return;
    rows.push(d);
  });
  return rows;
}

function occupyingRowsFromSnaps(snaps, nowMs) {
  const rows = [];
  const seen = new Set();
  (snaps || []).forEach((snap) => {
    occupyingRowsFromSnap(snap, nowMs).forEach((row) => {
      const id = String(row.id || "");
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      rows.push(row);
    });
  });
  return rows;
}

function publicSlotsFromRow(d, bufferMin) {
  const until = holdUntilMillis(d);
  const holdUntilMs = isPaymentHoldStatus(d.status) ? until : 0;
  return segmentsFromRow(d, bufferMin)
    .filter((seg) => seg && seg.date)
    .map((seg) => ({
      date: seg.date,
      startMin: seg.startMin,
      endMin: seg.endMin,
      boatId: seg.boatId || "",
      holdUntilMs,
    }));
}

function publicSlotFromRow(d, bufferMin) {
  const slots = publicSlotsFromRow(d, bufferMin);
  return slots.length ? slots[0] : null;
}

module.exports = {
  CHARTER_PAYMENT_HOLD_MINUTES,
  CHARTER_OCCUPANCY_HORIZON_DAYS,
  occupyingStatus,
  isPaymentHoldStatus,
  rowStillOccupies,
  holdUntilMillis,
  tenantTimeZone,
  isoDateInTz,
  instantFromIsoAndMin,
  addDaysToIso,
  occupancyWindow,
  occupyingSegments,
  eligibleBoats,
  pickFreeBoat,
  assertHoursAndClock,
  departureMinsForDay,
  occupyingRowsFromSnap,
  occupyingRowsFromSnaps,
  publicSlotFromRow,
  publicSlotsFromRow,
  boatsList,
  charterBookByLocation,
  charterBufferMinutes,
  charterLastBookingMin,
};
