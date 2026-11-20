/**
 * Shop portal Insights: how the shop is doing over a chosen range.
 * Toolbar (compare, team member, service, download), summary tiles, then Money, Appointments,
 * Schedule, Clients, and How bookings came in sections. Every number covers only the chosen dates
 * (Booked ahead and Win back look forward from today).
 * Revenue comes from the same Stripe source as the iPhone app; tips from the payment ledger;
 * bookings, clients, and booked time from the shop's booking requests and weekly hours.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var RANGES = [
    { id: "30", label: "30 days", days: 30 },
    { id: "90", label: "90 days", days: 90 },
    { id: "365", label: "12 months", days: 365 },
    { id: "custom", label: "Custom", days: 0 },
  ];
  var COMPARES = [
    { id: "prev", label: "vs previous period" },
    { id: "year", label: "vs same time last year" },
    { id: "custom", label: "vs custom dates" },
    { id: "none", label: "No comparison" },
  ];
  var BOOKED = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  var WIN_BACK_DAYS = 60;
  var DAY = 864e5;
  // Targets shown under rates (common salon / studio benchmarks).
  var HEALTHY = { noShow: 5, returning: 60, prebook: 40, booked: 70 };

  var state = {
    session: null, range: "30", bookings: null,
    revenue: null, revenueFrom: null, tips: null, tipsFrom: null,
    servicePrices: null, wired: false,
    customFrom: null, customTo: null,
    compare: readPref("ins.compare", "prev"), cmpFrom: null, cmpTo: null,
    grain: "auto", staff: "", service: "",
    aheadMode: "all",
  };

  function readPref(key, fallback) {
    try { return global.localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }

  function writePref(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function charts() { return global.ShopAppDashCharts || {}; }
  function range() { return RANGES.filter(function (r) { return r.id === state.range; })[0] || RANGES[0]; }

  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function startOf(d) {
    if (d.requestedStartTime) return toDate(d.requestedStartTime);
    if (d.scheduledDate && typeof d.scheduledStartMin === "number") {
      var p = String(d.scheduledDate).split("-");
      var day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      day.setMinutes(d.scheduledStartMin);
      return day;
    }
    return null;
  }

  function canSeeRevenue() {
    return !!(global.ShopAppAccess && ShopAppAccess.can(state.session, "earnings"));
  }

  function seesWholeTeam() {
    return !!(state.session && state.session.teamMode && ShopAppAccess.can(state.session, "viewAllBookings"));
  }

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fromIso(v) { var p = String(v).split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function shortDate(d, withYear) {
    return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  }

  /* ── Periods ── */

  /** The chosen period: [from, to). Custom ends after the end date (or now, if that's today). */
  function period() {
    var now = new Date();
    if (state.range === "custom" && state.customFrom && state.customTo) {
      var end = addDays(dayStart(state.customTo), 1);
      return { from: dayStart(state.customFrom), to: end < now ? end : now };
    }
    return { from: addDays(now, -(range().days || 30)), to: now };
  }

  /** The period it's compared with, or null for "No comparison". */
  function comparePeriod() {
    var p = period();
    if (state.compare === "none") return null;
    if (state.compare === "year") {
      var f = new Date(p.from); f.setFullYear(f.getFullYear() - 1);
      var t = new Date(p.to); t.setFullYear(t.getFullYear() - 1);
      return { from: f, to: t };
    }
    if (state.compare === "custom" && state.cmpFrom && state.cmpTo) {
      return { from: dayStart(state.cmpFrom), to: addDays(dayStart(state.cmpTo), 1) };
    }
    var len = p.to - p.from;
    return { from: new Date(p.from.getTime() - len), to: new Date(p.from) };
  }

  function earliestNeeded() {
    var p = period();
    var c = comparePeriod();
    return c && c.from < p.from ? c.from : p.from;
  }

  function rangeLabel(p) {
    p = p || period();
    var last = new Date(p.to.getTime() - 1);
    var withYear = p.from.getFullYear() !== new Date().getFullYear() || last.getFullYear() !== p.from.getFullYear();
    return shortDate(p.from, withYear) + " – " + shortDate(last, withYear);
  }

  function compareWord() {
    return state.compare === "year" ? "last year" : state.compare === "custom" ? "compared" : "before";
  }

  /* ── Buckets ── */

  function grain() {
    if (state.grain !== "auto") return state.grain;
    var p = period();
    var days = (p.to - p.from) / DAY;
    return days <= 31 ? "day" : days <= 120 ? "week" : "month";
  }

  /** Buckets (oldest first) from exactly `from` to `to`, by day, week (7 days from the start), or month. */
  function buckets(from, to) {
    var g = grain();
    var out = [];
    var s = dayStart(from);
    while (s < to && out.length < 400) {
      var e = g === "day" ? addDays(s, 1) : g === "week" ? addDays(s, 7) : new Date(s.getFullYear(), s.getMonth() + 1, 1);
      out.push({
        start: s, end: e, value: 0,
        label: g === "month" ? s.toLocaleDateString("en-US", { month: "short" }) : shortDate(s),
      });
      s = e;
    }
    return out;
  }

  function fill(points, entries) {
    entries.forEach(function (e) {
      for (var i = 0; i < points.length; i++) {
        if (e.date >= points[i].start && e.date < points[i].end) {
          points[i].value += e.value;
          break;
        }
      }
    });
    return points;
  }

  /** Compared-period values lined up with the current buckets (by position). */
  function compareSeries(cur, entriesFor) {
    var c = comparePeriod();
    if (!c) return null;
    var cb = fill(buckets(c.from, c.to), entriesFor(c.from, c.to));
    return cur.map(function (_, i) { return cb[i] ? cb[i].value : 0; });
  }

  function tipFor(p) {
    var g = grain();
    return g === "week" ? "Week of " + p.label : p.label;
  }

  function money(n, compact) { return charts().money ? charts().money(n, compact) : "$" + Math.round(n); }

  /* ── Data ── */

  function loadBookings() {
    var s = state.session;
    return firebase.firestore().collection("tenants").doc(s.tenantId).collection("bookingRequests")
      .orderBy("createdAt", "desc").limit(2500).get().then(function (snap) {
        var uid = s.user && s.user.uid;
        var all = ShopAppAccess.can(s, "viewAllBookings");
        state.bookings = snap.docs.map(function (doc) {
          var d = doc.data() || {};
          var phone = String(d.customerPhone || "").replace(/\D/g, "").slice(-10);
          var dur = typeof d.durationMinutes === "string" ? parseInt(d.durationMinutes, 10) : d.durationMinutes;
          var source = String(d.source || "").toLowerCase();
          return {
            status: String(d.status || "new").toLowerCase(),
            noShow: !!d.noShowAt,
            start: startOf(d),
            createdAt: toDate(d.createdAt),
            service: String(d.serviceName || "").trim() || "Other",
            serviceId: String(d.serviceId || ""),
            staff: String(d.assignedMemberName || "").trim(),
            staffUid: String(d.assignedMemberUid || ""),
            name: String(d.customerName || "").trim() || "Client",
            phone: phone,
            email: String(d.customerEmail || "").trim(),
            client: phone || String(d.customerEmail || d.customerName || "").toLowerCase(),
            priceCents: typeof d.priceCents === "number" ? d.priceCents : 0,
            paidCents: typeof d.paidCents === "number" ? d.paidCents : 0,
            minutes: typeof dur === "number" && dur > 0 ? dur : 60,
            // Booked online through the shop's site (not made by the shop in the app).
            online: source.indexOf("web") !== -1 && !d.createdByUid,
            // Money fields for "Next 30 days" (same rules as app-balance.js).
            money: {
              priceCents: d.priceCents, payments: d.payments, paidCents: d.paidCents, depositPartCents: d.depositPartCents,
              depositPaidAt: d.depositPaidAt, paidAt: d.paidAt, tripCents: d.tripCents, addonCents: d.addonCents,
            },
            depositRequestCents: typeof d.depositRequestCents === "number" ? d.depositRequestCents : 0,
          };
        }).filter(function (b) { return all || b.staffUid === uid; });
      }).catch(function () {
        state.bookings = [];
      });
  }

  function loadServicePrices() {
    if (state.servicePrices) return Promise.resolve();
    var s = state.session;
    return firebase.firestore().collection("tenants").doc(s.tenantId).collection("services").get().then(function (snap) {
      var map = {};
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        var p = Number(d.price);
        if (isFinite(p) && p > 0) {
          map[doc.id] = Math.round(p * 100);
          if (d.name) map["name:" + String(d.name).trim().toLowerCase()] = Math.round(p * 100);
        }
      });
      state.servicePrices = map;
    }).catch(function () { state.servicePrices = {}; });
  }

  /** Card payments back to the earliest date needed, 100 at a time (up to 1,500). */
  function loadRevenue() {
    if (!canSeeRevenue()) return Promise.resolve();
    var need = earliestNeeded();
    if (Array.isArray(state.revenue) && state.revenueFrom && state.revenueFrom <= need) return Promise.resolve();
    var startTs = Math.floor(need.getTime() / 1000) - DAY / 1000;
    var call = firebase.app().functions(REGION).httpsCallable("getConnectBalanceTransactions");
    var out = [];
    var seen = {};
    var capped = false;
    function page(endTs, n) {
      var args = { startTimestampSeconds: startTs, limit: 100 };
      if (endTs) args.endTimestampSeconds = endTs;
      return call(args).then(function (res) {
        var list = (res && res.data && res.data.transactions) || [];
        // Page through Stripe's own rows (txn_…); studio-share rows from the ledger ride along.
        var oldest = null;
        var stripeRows = 0;
        list.forEach(function (t) {
          if (!(t.created > 0)) return;
          if (String(t.id || "").indexOf("txn_") === 0) {
            stripeRows += 1;
            if (oldest == null || t.created < oldest) oldest = t.created;
          }
          var key = t.id || (t.created + ":" + t.amount);
          if (seen[key]) return;
          seen[key] = true;
          if (String(t.type || "").toLowerCase() !== "charge") return;
          var cents = typeof t.net === "number" ? t.net : (t.amount || 0);
          out.push({ date: new Date(t.created * 1000), value: Math.abs(cents) / 100 });
        });
        if (stripeRows < 100 || oldest == null || oldest <= startTs) return null;
        if (n >= 14) { capped = true; return null; }
        return page(oldest - 1, n + 1);
      });
    }
    return page(null, 0).then(function () {
      state.revenue = out;
      state.revenue.capped = capped;
      state.revenueFrom = need;
    }).catch(function () {
      state.revenue = { error: true };
      state.revenueFrom = need;
    });
  }

  /** Tips (owners and managers who see earnings), back to the earliest date needed. */
  function loadTips() {
    if (!canSeeRevenue()) return Promise.resolve();
    var need = earliestNeeded();
    if (Array.isArray(state.tips) && state.tipsFrom && state.tipsFrom <= need) return Promise.resolve();
    return firebase.app().functions(REGION).httpsCallable("getTipsSummary")({ fromMs: need.getTime() })
      .then(function (res) {
        var list = (res && res.data && res.data.tips) || [];
        state.tips = list.map(function (t) {
          return {
            date: new Date(Number(t.createdMs) || 0),
            tipCents: Math.max(0, Number(t.tipCents) || 0),
            serviceCents: Math.max(0, Number(t.serviceCents) || 0),
            staffUid: String(t.staffUid || ""),
          };
        });
        state.tipsFrom = need;
      }).catch(function () {
        state.tips = [];
        state.tipsFrom = need;
      });
  }

  /* ── Math ── */

  function valueCents(b) {
    if (b.priceCents > 0) return b.priceCents;
    var p = state.servicePrices || {};
    return p[b.serviceId] || p["name:" + b.service.toLowerCase()] || b.paidCents || 0;
  }

  function isBooked(b) { return BOOKED.indexOf(b.status) !== -1 && b.start; }
  /** A real visit: booked, not cancelled, and not marked no-show. */
  function isVisit(b) { return isBooked(b) && !b.noShow; }
  function inWindow(b, from, to) { return b.start && b.start >= from && b.start < to; }

  function filtering() { return !!(state.staff || state.service); }

  function passes(b) {
    if (state.staff && b.staffUid !== state.staff) return false;
    if (state.service && b.service !== state.service) return false;
    return true;
  }

  /** Bookings the page counts (after the team member / service filters). */
  function list() { return state.bookings.filter(passes); }

  /** Open minutes between two dates from the weekly hours, minus days off and blocked time. */
  function openMinutes(from, to) {
    var t = (state.session && state.session.tenant) || {};
    var weekly = t.businessHoursWeekly || null;
    var blockedDays = Array.isArray(t.blockedDates) ? t.blockedDates : [];
    var blocks = Array.isArray(t.blockedTimeRanges) ? t.blockedTimeRanges : [];
    var total = 0;
    var d = dayStart(from);
    while (d < to) {
      var ymd = iso(d);
      if (blockedDays.indexOf(ymd) === -1) {
        var day = weekly ? weekly[DAY_KEYS[d.getDay()]] : null;
        var ranges = [];
        if (day && day.closed !== true && Array.isArray(day.ranges)) ranges = day.ranges;
        else if (!weekly && d.getDay() >= 1 && d.getDay() <= 5) ranges = [{ openMin: 540, closeMin: 1020 }];
        ranges.forEach(function (r) { total += Math.max(0, (Number(r.closeMin) || 0) - (Number(r.openMin) || 0)); });
        blocks.forEach(function (bl) {
          if (String(bl.date || "") === ymd) total -= Math.max(0, (Number(bl.endMin) || 0) - (Number(bl.startMin) || 0));
        });
      }
      d = addDays(d, 1);
    }
    return Math.max(0, total);
  }

  function staffCount() {
    if (state.staff || !seesWholeTeam()) return 1;
    return Math.max(1, (state.session.members || []).length);
  }

  /** First visit date per client, across the whole shop. */
  function firstVisitByClient() {
    var first = {};
    state.bookings.forEach(function (b) {
      if (!b.client || !isVisit(b)) return;
      if (!first[b.client] || b.start < first[b.client]) first[b.client] = b.start;
    });
    return first;
  }

  /** Every booking per client (any status), oldest first, for rebook / pre-book checks. */
  function bookingsByClient() {
    var by = {};
    state.bookings.forEach(function (b) {
      if (!b.client || !b.start) return;
      (by[b.client] = by[b.client] || []).push(b);
    });
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return a.start - b.start; }); });
    return by;
  }

  /** Of past visits, the share where the client already had their next visit booked before leaving. */
  function prebookPct(visits, byClient) {
    var now = new Date();
    var eligible = 0, hit = 0;
    visits.forEach(function (v) {
      if (!v.client || v.start > now) return;
      eligible += 1;
      var leftAt = new Date(v.start.getTime() + (v.minutes + 60) * 60000);
      var next = (byClient[v.client] || []).filter(function (b) {
        return b !== v && b.start > v.start && (isBooked(b) || b.status === "cancelled") && b.createdAt && b.createdAt <= leftAt;
      })[0];
      if (next) hit += 1;
    });
    return eligible ? Math.round((hit / eligible) * 100) : null;
  }

  function periodStats(from, to, first, byClient) {
    var now = new Date();
    var rows = list().filter(function (b) { return inWindow(b, from, to); });
    var visits = rows.filter(isVisit);
    var value = visits.reduce(function (a, b) { return a + valueCents(b); }, 0);
    var priced = visits.filter(function (b) { return valueCents(b) > 0; });
    var minutes = visits.reduce(function (a, b) { return a + b.minutes; }, 0);
    var open = openMinutes(from, to) * staffCount();
    var returning = visits.filter(function (b) { return b.client && first[b.client] && first[b.client] < from; }).length;
    var past = rows.filter(function (b) { return b.start <= now; });
    var completed = past.filter(isVisit).length;
    var cancelled = past.filter(function (b) { return b.status === "cancelled"; }).length;
    var noShows = past.filter(function (b) { return b.noShow && isBooked(b); }).length;
    var appts = completed + cancelled + noShows;
    return {
      rows: rows,
      booked: visits,
      count: visits.length,
      value: value / 100,
      avgTicket: priced.length ? value / priced.length / 100 : 0,
      utilization: open > 0 ? Math.min(100, Math.round((minutes / open) * 100)) : null,
      bookedHours: Math.round(minutes / 60),
      openHours: Math.round(open / 60),
      returningPct: visits.length ? Math.round((returning / visits.length) * 100) : null,
      completed: completed, cancelled: cancelled, noShows: noShows, appts: appts,
      noShowPct: appts ? Math.round((noShows / appts) * 100) : null,
      cancelPct: appts ? Math.round((cancelled / appts) * 100) : null,
      prebookPct: prebookPct(visits, byClient),
    };
  }

  /* ── Paint helpers ── */

  function delta(cur, prev, lowerIsBetter) {
    if (state.compare === "none" || prev == null) return "";
    var c = charts();
    if (!c.changeHtml || !c.pct) return "";
    var html = c.changeHtml(c.pct(cur, prev));
    if (lowerIsBetter && html) html = html.replace("is-up", "is-tmp").replace("is-down", "is-up").replace("is-tmp", "is-down");
    return html;
  }

  /** Change in percentage points (for rates). */
  function deltaPts(cur, prev, lowerIsBetter) {
    if (state.compare === "none" || cur == null || prev == null) return "";
    var d = cur - prev;
    if (!d) return '<span class="app-chart-change is-up">same</span>';
    var good = lowerIsBetter ? d < 0 : d > 0;
    return '<span class="app-chart-change ' + (good ? "is-up" : "is-down") + '">' + (d > 0 ? "▲ " : "▼ ") + Math.abs(d) + " pt</span>";
  }

  function healthy(text, ok) {
    return '<p class="app-ins-hint' + (ok ? " is-ok" : "") + '">' + (ok ? "✓ " : "") + esc(text) + "</p>";
  }

  function card(title, body, extraClass, sub) {
    return '<article class="app-card app-ins-card' + (extraClass ? " " + extraClass : "") + '">' +
      '<div class="app-card-head"><h2>' + esc(title) + '</h2><span class="app-chart-range">' + esc(sub == null ? rangeLabel() : sub) + "</span></div>" +
      '<div class="app-ins-body">' + body + "</div></article>";
  }

  function section(label) { return '<p class="app-ins-sec">' + esc(label) + "</p>"; }

  function rankList(counts, fmt) {
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 5);
    if (!keys.length) return '<p class="app-empty">Nothing in this range yet.</p>';
    var max = counts[keys[0]] || 1;
    return '<ol class="app-ins-rank">' + keys.map(function (k) {
      return '<li><span class="app-ins-rank-label">' + esc(k) + '</span><span class="app-ins-rank-bar"><i style="width:' +
        Math.max(4, Math.round((counts[k] / max) * 100)) + '%"></i></span><strong>' + esc(fmt(counts[k], k)) + "</strong></li>";
    }).join("") + "</ol>";
  }

  function gauge(pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    var a = Math.PI * (1 - p / 100);
    var x = 60 + 50 * Math.cos(a);
    var y = 60 - 50 * Math.sin(a);
    return '<svg class="app-ins-gauge" viewBox="0 0 120 70" role="img" aria-label="' + p + '% booked">' +
      '<path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="var(--line)" stroke-width="11" stroke-linecap="round"/>' +
      (p > 0 ? '<path d="M10 60 A50 50 0 0 1 ' + x.toFixed(1) + " " + y.toFixed(1) + '" fill="none" stroke="var(--warm)" stroke-width="11" stroke-linecap="round"/>' : "") +
      '<text x="60" y="57" text-anchor="middle" font-size="18" fill="var(--text)">' + p + "%</text></svg>";
  }

  /** Stacked bar: [[pct, className], ...]. */
  function stack(parts) {
    return '<div class="app-ins-stackbar">' + parts.filter(function (p) { return p[0] > 0; }).map(function (p) {
      return '<i class="' + p[1] + '" style="width:' + p[0] + '%"></i>';
    }).join("") + "</div>";
  }

  /** Day × hour grid of booking starts, cream (quiet) to espresso (packed). */
  function heatmap(booked) {
    var t = (state.session && state.session.tenant) || {};
    var weekly = t.businessHoursWeekly || {};
    var lo = 24, hi = 0;
    DAY_KEYS.forEach(function (k) {
      var day = weekly[k];
      if (day && day.closed !== true && Array.isArray(day.ranges)) {
        day.ranges.forEach(function (r) {
          lo = Math.min(lo, Math.floor((Number(r.openMin) || 0) / 60));
          hi = Math.max(hi, Math.ceil((Number(r.closeMin) || 0) / 60));
        });
      }
    });
    booked.forEach(function (b) { lo = Math.min(lo, b.start.getHours()); hi = Math.max(hi, b.start.getHours() + 1); });
    if (lo >= hi) { lo = 9; hi = 18; }
    var grid = {};
    var max = 0;
    booked.forEach(function (b) {
      var key = b.start.getDay() + "-" + b.start.getHours();
      grid[key] = (grid[key] || 0) + 1;
      max = Math.max(max, grid[key]);
    });
    var hours = [];
    for (var h = lo; h < hi; h++) hours.push(h);
    var label = function (h) { var d = new Date(); d.setHours(h, 0, 0, 0); return d.toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", "").toLowerCase(); };
    var order = [1, 2, 3, 4, 5, 6, 0];
    var html = '<div class="app-ins-heat" style="grid-template-columns:34px repeat(' + hours.length + ',minmax(0,1fr))"><span></span>' +
      hours.map(function (h, i) { return "<span>" + (i % 2 === 0 ? esc(label(h)) : "") + "</span>"; }).join("");
    order.forEach(function (d) {
      html += "<span>" + DAYS[d] + "</span>";
      hours.forEach(function (h) {
        var v = grid[d + "-" + h] || 0;
        var lvl = !v ? 0 : max <= 1 ? 2 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
        html += '<i class="lvl' + lvl + '" title="' + esc(DAYS[d] + " " + label(h) + ": " + v + (v === 1 ? " booking" : " bookings")) + '"></i>';
      });
    });
    return html + '</div><div class="app-ins-heat-key"><span>Quiet</span><i class="lvl1"></i><i class="lvl2"></i><i class="lvl3"></i><i class="lvl4"></i><span>Packed</span></div>';
  }

  /** Clients whose last visit was 60+ days ago and who have nothing booked. */
  function winBack() {
    var now = new Date();
    var byClient = {};
    list().forEach(function (b) {
      if (!b.client || !isVisit(b)) return;
      var c = byClient[b.client] || (byClient[b.client] = { name: b.name, phone: b.phone, last: null, visits: 0, upcoming: false });
      if (b.start > now) { c.upcoming = true; return; }
      c.visits += 1;
      if (!c.last || b.start > c.last) { c.last = b.start; c.name = b.name; }
    });
    return Object.keys(byClient).map(function (k) { return byClient[k]; }).filter(function (c) {
      return c.last && !c.upcoming && (now - c.last) / DAY >= WIN_BACK_DAYS;
    }).sort(function (a, b) { return b.visits - a.visits || a.last - b.last; });
  }

  /** Of visits in the range, the share followed by another visit within N days. */
  function rebookRates(booked, byClient) {
    var out = {};
    [30, 60, 90].forEach(function (n) {
      var eligible = 0, hit = 0;
      booked.forEach(function (b) {
        if (!b.client) return;
        var next = (byClient[b.client] || []).filter(function (x) { return x.start > b.start && isVisit(x); })[0];
        var measurable = (new Date() - b.start) / DAY >= n || next;
        if (!measurable) return;
        eligible += 1;
        if (next && (next.start - b.start) / DAY <= n) hit += 1;
      });
      out[n] = eligible ? Math.round((hit / eligible) * 100) : null;
    });
    return out;
  }

  function grainSeg() {
    return '<div class="app-ins-mini-seg" role="group" aria-label="Group bars by">' +
      [["day", "Day"], ["week", "Week"], ["month", "Month"]].map(function (o) {
        return '<button type="button" data-grain="' + o[0] + '" class="' + (grain() === o[0] ? "is-on" : "") + '">' + o[1] + "</button>";
      }).join("") + "</div>";
  }

  /* ── Toolbar ── */

  function toolbar() {
    var opts = function (items, cur) {
      return items.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>";
      }).join("");
    };
    var html = '<div class="app-ins-tools">' +
      '<label class="app-ins-select"><span class="app-sr-only">Compare</span><select data-ins="compare">' +
      opts(COMPARES.map(function (c) { return [c.id, c.label]; }), state.compare) + "</select></label>";
    if (seesWholeTeam()) {
      var members = (state.session.members || []).filter(function (m) { return m.uid; }).map(function (m) {
        return [m.uid, (m.displayName || m.firstName || m.email || "Team member").trim()];
      });
      html += '<label class="app-ins-select"><span class="app-sr-only">Team member</span><select data-ins="staff">' +
        opts([["", "All team"]].concat(members), state.staff) + "</select></label>";
    }
    var counts = {};
    state.bookings.forEach(function (b) { if (isBooked(b)) counts[b.service] = (counts[b.service] || 0) + 1; });
    var services = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 40);
    if (state.service && services.indexOf(state.service) === -1) services.unshift(state.service);
    html += '<label class="app-ins-select"><span class="app-sr-only">Service</span><select data-ins="service">' +
      opts([["", "All services"]].concat(services.map(function (s) { return [s, s]; })), state.service) + "</select></label>";
    html += '<button type="button" class="app-btn app-btn--primary app-ins-dl" data-ins-report>Build report</button></div>';
    if (state.compare === "custom") {
      var c = comparePeriod() || period();
      html += '<div class="app-ins-custom">Compare with <label>From <input type="date" data-ins="cmpFrom" value="' + iso(c.from) + '" max="' + iso(new Date()) + '"></label>' +
        '<label>To <input type="date" data-ins="cmpTo" value="' + iso(new Date(c.to.getTime() - 1)) + '" max="' + iso(new Date()) + '"></label></div>';
    }
    var cp = comparePeriod();
    html += '<p class="app-ins-period">' + esc(rangeLabel()) + (cp ? " · compared with " + esc(rangeLabel(cp)) : "") +
      (filtering() ? " · filtered" : "") + "</p>";
    return html;
  }

  /* ── Paint ── */

  function paint() {
    var host = $("insBody");
    if (!host) return;
    var seg = $("insRange");
    if (seg) seg.innerHTML = RANGES.map(function (r) {
      return '<button type="button" data-ins-range="' + r.id + '" class="' + (r.id === state.range ? "is-on" : "") + '">' + esc(r.label) + "</button>";
    }).join("");
    var customBox = $("insCustom");
    if (customBox) {
      customBox.classList.toggle("hidden", state.range !== "custom");
      if (state.customFrom) $("insFrom").value = iso(state.customFrom);
      if (state.customTo) $("insTo").value = iso(state.customTo);
      $("insFrom").max = $("insTo").max = iso(new Date());
    }
    if (!state.bookings) {
      host.innerHTML = '<p class="app-empty">Loading insights…</p>';
      return;
    }
    var c = charts();
    var today = new Date();
    var p = period();
    var cp = comparePeriod();
    var from = p.from, now = p.to;
    var first = firstVisitByClient();
    var byClient = bookingsByClient();
    var cur = periodStats(from, now, first, byClient);
    var prev = cp ? periodStats(cp.from, cp.to, first, byClient) : null;
    var seeMoney = canSeeRevenue();
    var filtered = filtering();
    var word = compareWord();

    // Revenue: card payments, or (when filtered by team member / service) the value of those visits.
    var revenueSum = null, revenuePrev = null, revEntries = null;
    if (seeMoney && filtered) {
      revEntries = function (a, z) {
        return list().filter(function (b) { return isVisit(b) && inWindow(b, a, z); }).map(function (b) { return { date: b.start, value: valueCents(b) / 100 }; });
      };
    } else if (seeMoney && Array.isArray(state.revenue)) {
      revEntries = function (a, z) { return state.revenue.filter(function (e) { return e.date >= a && e.date < z; }); };
    }
    var sumEntries = function (l) { return l.reduce(function (a, e) { return a + e.value; }, 0); };
    if (revEntries) {
      revenueSum = sumEntries(revEntries(from, now));
      revenuePrev = cp ? sumEntries(revEntries(cp.from, cp.to)) : null;
    }
    var revLabel = filtered ? "Service value" : "Revenue";

    // Upcoming is always the next 7 / 30 days from today.
    var in7 = new Date(today.getTime() + 7 * DAY);
    var in30 = new Date(today.getTime() + 30 * DAY);
    var upcoming = list().filter(function (b) { return isVisit(b) && b.status !== "completed" && b.start > today; });
    var up7 = upcoming.filter(function (b) { return b.start <= in7; });
    var up30 = upcoming.filter(function (b) { return b.start <= in30; });
    var sumValue = function (l) { return l.reduce(function (a, b) { return a + valueCents(b); }, 0) / 100; };
    // A deposit counts toward the appointment's total (capped at the service value when it's known).
    var sumDeposits = function (l) {
      return l.reduce(function (a, b) { var v = valueCents(b); return a + (v > 0 ? Math.min(b.paidCents, v) : b.paidCents); }, 0) / 100;
    };
    var aheadValue = function (l) {
      if (state.aheadMode === "deposits") return sumDeposits(l);
      if (state.aheadMode === "services") return Math.max(0, sumValue(l) - sumDeposits(l));
      return sumValue(l);
    };

    var html = toolbar();

    // Summary row.
    var tiles = [];
    if (seeMoney) {
      var loadingRev = !filtered && !Array.isArray(state.revenue);
      tiles.push([revLabel, revenueSum == null ? (state.revenue && state.revenue.error ? "—" : loadingRev ? "…" : "—") : money(revenueSum, revenueSum >= 1000),
        revenueSum == null ? "" : delta(revenueSum, revenuePrev)]);
    }
    tiles.push(["Visits", String(cur.count), delta(cur.count, prev && prev.count)]);
    if (seeMoney) tiles.push(["Avg ticket", cur.avgTicket ? money(cur.avgTicket, true) : "—", cur.avgTicket ? delta(cur.avgTicket, prev && prev.avgTicket) : ""]);
    tiles.push(["No-shows", cur.noShowPct == null ? "—" : cur.noShowPct + "%", deltaPts(cur.noShowPct, prev && prev.noShowPct, true)]);
    tiles.push(["Booked time", cur.utilization == null ? "—" : cur.utilization + "%", cur.utilization == null ? "" : deltaPts(cur.utilization, prev && prev.utilization)]);
    tiles.push(["Returning", cur.returningPct == null ? "—" : cur.returningPct + "%", deltaPts(cur.returningPct, prev && prev.returningPct)]);
    tiles.push(["Upcoming · 7 days", seeMoney ? money(sumValue(up7), true) : String(up7.length), '<span class="app-ins-tile-sub">' + up7.length + (up7.length === 1 ? " appt" : " appts") + " · from today</span>"]);

    html += '<div class="app-stats app-ins-tiles">' + tiles.map(function (t) {
      return "<div><span>" + esc(t[0]) + "</span><strong>" + t[1] + "</strong>" + (t[2] || "") + "</div>";
    }).join("") + "</div>";

    var cmpOpts = function (series) { return series ? { compare: series, compareLabel: word } : {}; };
    var legend = cp ? '<p class="app-ins-legend"><i class="is-bar"></i>This period <i class="is-line"></i>' + esc(word === "before" ? "Previous period" : word === "last year" ? "Last year" : "Compared dates") + "</p>" : "";

    // Money.
    if (seeMoney) {
      html += section("Money") + '<div class="app-ins-grid app-ins-grid--money">';
      var revBody;
      if (!filtered && state.revenue && state.revenue.error) {
        revBody = '<p class="app-empty">Revenue shows here once card payments are set up. <a class="app-btn app-btn--warm" data-route="payments" href="/app/payments">Set up payments</a></p>';
      } else if (!revEntries) {
        revBody = '<p class="app-empty">Loading revenue…</p>';
      } else {
        var rb = fill(buckets(from, now), revEntries(from, now));
        revBody = grainSeg() + c.bars(rb, function (v) { return money(v, false); }, revLabel + " by " + grain(),
          Object.assign({ tipPrefix: tipFor, width: 720, height: 190 }, cmpOpts(compareSeries(rb, revEntries)))) + legend +
          (filtered ? '<p class="app-hint">Card payments can\'t be split by team member or service, so this shows the price of those visits.</p>' : "") +
          (!filtered && state.revenue.capped ? '<p class="app-hint">Showing your 1,500 most recent card payments.</p>' : "");
      }
      html += card(revLabel, revBody, "is-span2");
      html += '<div class="app-ins-stack">';
      var aheadSeg = '<div class="app-ins-mini-seg" role="group" aria-label="Booked ahead shows">' +
        [["all", "All"], ["deposits", "Deposits"], ["services", "Services"]].map(function (o) {
          return '<button type="button" data-ahead="' + o[0] + '" class="' + (state.aheadMode === o[0] ? "is-on" : "") + '">' + o[1] + "</button>";
        }).join("") + "</div>";
      var aheadNote = state.aheadMode === "deposits" ? "Deposits already paid" : state.aheadMode === "services" ? "Still due at appointments" : "Deposits + services";
      html += card("Booked ahead", aheadSeg +
        '<p class="app-ins-figure">' + money(aheadValue(up7), true) + "</p>" +
        '<p class="app-ins-line">Next 7 days · ' + up7.length + (up7.length === 1 ? " appt" : " appts") + "</p>" +
        '<p class="app-ins-line">Next 30 days · ' + money(aheadValue(up30), true) + " · " + up30.length + (up30.length === 1 ? " appt" : " appts") + "</p>" +
        '<p class="app-ins-line app-ins-note">' + aheadNote + "</p>", "", "from today");
      var tipsBody;
      if (!Array.isArray(state.tips)) {
        tipsBody = '<p class="app-empty">Loading tips…</p>';
      } else {
        var tipsIn = function (a, z) {
          return state.tips.filter(function (t) { return t.date >= a && t.date < z && (!state.staff || t.staffUid === state.staff); });
        };
        var curTips = tipsIn(from, now);
        var tipTotal = curTips.reduce(function (a, t) { return a + t.tipCents; }, 0);
        var prevTipTotal = cp ? tipsIn(cp.from, cp.to).reduce(function (a, t) { return a + t.tipCents; }, 0) : null;
        var tipped = curTips.filter(function (t) { return t.tipCents > 0; });
        var tipBase = tipped.reduce(function (a, t) { return a + t.serviceCents; }, 0);
        var avgPct = tipBase ? Math.round((tipped.reduce(function (a, t) { return a + t.tipCents; }, 0) / tipBase) * 100) : 0;
        var names = memberNames();
        var byStaff = {};
        tipped.forEach(function (t) {
          var n = names[t.staffUid] || "Shop";
          byStaff[n] = (byStaff[n] || 0) + t.tipCents;
        });
        var staffLine = seesWholeTeam() && !state.staff
          ? Object.keys(byStaff).sort(function (a, b) { return byStaff[b] - byStaff[a]; }).slice(0, 3).map(function (n) { return esc(n) + " " + money(byStaff[n] / 100, true); }).join(" · ")
          : "";
        tipsBody = tipTotal
          ? '<p class="app-ins-figure">' + money(tipTotal / 100, tipTotal >= 100000) + " " + delta(tipTotal, prevTipTotal) + '</p><p class="app-ins-line">Avg ' + avgPct + "% · " + tipped.length + (tipped.length === 1 ? " tip" : " tips") + "</p>" +
            (staffLine ? '<p class="app-ins-line">' + staffLine + "</p>" : "")
          : '<p class="app-ins-figure">$0</p><p class="app-ins-line">Tips show here as clients add them at checkout.</p>';
      }
      html += card("Tips", tipsBody);
      html += "</div></div>";
    }

    // The month ahead (from today).
    html += section("Next 30 days") + '<div class="app-ins-grid">' + card("Booked ahead · deposits and balances", aheadCard(aheadStats(), seeMoney), "is-wide", "from today") + "</div>";

    // Appointments.
    html += section("Appointments") + '<div class="app-ins-grid">';
    var ap = cur.appts || 0;
    var apPct = function (n) { return ap ? Math.round((n / ap) * 100) : 0; };
    html += card("Completed, canceled, no-show", ap
      ? stack([[apPct(cur.completed), "is-done"], [apPct(cur.cancelled), "is-cancel"], [apPct(cur.noShows), "is-noshow"]]) +
        '<div class="app-ins-rows">' +
        "<div><span><i class=\"app-ins-dot is-done\"></i>Completed</span><strong>" + cur.completed + " · " + apPct(cur.completed) + "%</strong></div>" +
        "<div><span><i class=\"app-ins-dot is-cancel\"></i>Canceled</span><strong>" + cur.cancelled + " · " + apPct(cur.cancelled) + "% " + deltaPts(cur.cancelPct, prev && prev.cancelPct, true) + "</strong></div>" +
        "<div><span><i class=\"app-ins-dot is-noshow\"></i>No-show</span><strong>" + cur.noShows + " · " + apPct(cur.noShows) + "% " + deltaPts(cur.noShowPct, prev && prev.noShowPct, true) + "</strong></div>" +
        "</div>" + healthy("Healthy: no-shows under " + HEALTHY.noShow + "%", cur.noShowPct != null && cur.noShowPct < HEALTHY.noShow) +
        '<p class="app-ins-line app-ins-note">Mark a no-show from the appointment on your calendar.</p>'
      : '<p class="app-empty">No past appointments in this range.</p>');
    html += card("Pre-booked", cur.prebookPct == null
      ? '<p class="app-empty">No past visits in this range yet.</p>'
      : '<p class="app-ins-figure">' + cur.prebookPct + "% " + deltaPts(cur.prebookPct, prev && prev.prebookPct) + "</p>" +
        '<p class="app-ins-line">Booked their next visit before leaving</p>' +
        healthy("Healthy is " + HEALTHY.prebook + "%+", cur.prebookPct >= HEALTHY.prebook));
    html += "</div>";

    // Schedule.
    html += section("Schedule") + '<div class="app-ins-grid app-ins-grid--sched">';
    html += card("Booked vs open", cur.utilization == null
      ? '<p class="app-empty">Set your weekly hours in Scheduling to see this.</p>'
      : '<div class="app-ins-gauge-wrap">' + gauge(cur.utilization) + '<p class="app-ins-line">' + cur.bookedHours + " of " + cur.openHours + " open hours" + (staffCount() > 1 ? " (whole team)" : "") + "</p>" +
        healthy("Healthy is " + HEALTHY.booked + "%+", cur.utilization >= HEALTHY.booked) + "</div>");
    html += card("Busiest times", cur.count ? heatmap(cur.booked) : '<p class="app-empty">Nothing in this range yet.</p>', "is-span2");
    var visitEntries = function (a, z) {
      return list().filter(function (b) { return isVisit(b) && inWindow(b, a, z); }).map(function (b) { return { date: b.start, value: 1 }; });
    };
    var bb = fill(buckets(from, now), visitEntries(from, now));
    html += card("Visits", cur.count || (prev && prev.count)
      ? grainSeg() + c.bars(bb, function (v) { return v === 1 ? "1 visit" : v + " visits"; }, "Visits by " + grain(),
          Object.assign({ tipPrefix: tipFor, width: 720, height: 170 }, cmpOpts(compareSeries(bb, visitEntries)))) + legend
      : '<div class="app-chart-empty"><strong>No visits in this range</strong><span>Try a longer range, or share your booking link.</span></div>', "is-wide");
    html += "</div>";

    // Clients.
    html += section("Clients") + '<div class="app-ins-grid">';
    var newCount = Object.keys(first).filter(function (k) { return first[k] >= from && first[k] < now; }).length;
    var retPct = cur.returningPct == null ? 0 : cur.returningPct;
    var rates = rebookRates(cur.booked, byClient);
    html += card("Coming back",
      '<div class="app-ins-split"><i style="width:' + retPct + '%"></i></div>' +
      '<p class="app-ins-line">' + retPct + "% returning · " + (100 - retPct) + "% new · " + newCount + (newCount === 1 ? " new client" : " new clients") + "</p>" +
      (cur.returningPct != null ? healthy("Healthy is " + HEALTHY.returning + "%+ returning", cur.returningPct >= HEALTHY.returning) : "") +
      '<div class="app-ins-rows">' + [30, 60, 90].map(function (n) {
        return "<div><span>Rebooked within " + n + " days</span><strong>" + (rates[n] == null ? "—" : rates[n] + "%") + "</strong></div>";
      }).join("") + "</div>");
    var wb = winBack();
    html += card("Clients to win back", wb.length
      ? '<div class="app-ins-rows">' + wb.slice(0, 5).map(function (w) {
          var days = Math.round((today - w.last) / DAY);
          var link = w.phone ? '<a class="app-ins-text" href="/app/messages?phone=%2B1' + esc(w.phone) + '">Text ›</a>' : "";
          return "<div><span>" + esc(w.name) + ' <em>· ' + days + " days</em></span>" + link + "</div>";
        }).join("") + "</div>" + (wb.length > 5 ? '<p class="app-ins-line">+ ' + (wb.length - 5) + " more</p>" : "")
      : '<p class="app-empty">Everyone\'s been in within the last ' + WIN_BACK_DAYS + " days.</p>", "", WIN_BACK_DAYS + "+ days · from today");

    var svc = {};
    cur.booked.forEach(function (b) { svc[b.service] = (svc[b.service] || 0) + 1; });
    html += card("Top services", rankList(svc, function (n) { return String(n); }));
    html += "</div>";

    // Team.
    if (seesWholeTeam() && !state.staff) html += section("Team") + '<div class="app-ins-grid">' + card("Team members", teamTable(cur, from, now, byClient, seeMoney), "is-wide") + "</div>";

    // How bookings came in: clients booking themselves online vs. added by the shop.
    html += section("How bookings came in") + '<div class="app-ins-grid">' + card("Online vs. added by you", onlineCard(cur, prev, first, from, now), "is-wide") + "</div>";

    host.innerHTML = html;
    if (c.wireTips) host.querySelectorAll(".app-ins-body").forEach(function (b) { c.wireTips(b); });
  }

  /**
   * The month ahead (from today, next 30 days): booked value, deposits paid, still due, deposits waiting,
   * by week. Uses each booking's price (or its service's) and the payments recorded on it.
   */
  function aheadStats() {
    var now = new Date();
    var end = new Date(now.getTime() + 30 * DAY);
    var prices = state.servicePrices || {};
    var weeks = [0, 1, 2, 3].map(function (i) {
      var s = new Date(dayStart(now).getTime() + i * 7 * DAY);
      var e = i === 3 ? end : new Date(s.getTime() + 7 * DAY);
      return { start: s, end: e, paid: 0, due: 0, count: 0 };
    });
    var out = { count: 0, booked: 0, paid: 0, due: 0, waitingCount: 0, waitingCents: 0, unpriced: 0, weeks: weeks };
    list().forEach(function (b) {
      if (!isVisit(b) || b.status === "completed" || !b.start || b.start <= now || b.start > end) return;
      var svc = prices[b.serviceId] || prices["name:" + b.service.toLowerCase()] || 0;
      var m = global.ShopAppBalance ? ShopAppBalance.model(b.money || {}, svc) : { price: valueCents(b) || null, paid: b.paidCents, balance: null };
      var price = m.price;
      var paid = price != null ? Math.min(m.paid, price) : m.paid;
      var due = price != null ? Math.max(0, price - paid) : 0;
      out.count += 1;
      if (price == null) out.unpriced += 1;
      out.booked += price != null ? price : paid;
      out.paid += paid;
      out.due += due;
      if (b.status === "pending_deposit" || b.status === "pending_payment") {
        out.waitingCount += 1;
        out.waitingCents += b.depositRequestCents || 0;
      }
      for (var i = 0; i < weeks.length; i++) {
        if (b.start >= weeks[i].start && b.start < weeks[i].end) {
          weeks[i].paid += paid;
          weeks[i].due += due;
          weeks[i].count += 1;
          break;
        }
      }
    });
    return out;
  }

  function aheadCard(a, seeMoney) {
    var noun = state.session && isCharterShop() ? ["trip", "trips"] : ["appt", "appts"];
    if (!a.count) return '<p class="app-empty">Nothing booked in the next 30 days yet.</p>';
    var head = seeMoney
      ? '<p class="app-ins-figure">' + money(a.booked / 100, true) + '</p><p class="app-ins-line">' + a.count + " " + (a.count === 1 ? noun[0] : noun[1]) + " booked</p>"
      : '<p class="app-ins-figure">' + a.count + '</p><p class="app-ins-line">' + (a.count === 1 ? noun[0] : noun[1]) + " booked</p>";
    if (!seeMoney) return head;
    var max = Math.max.apply(null, a.weeks.map(function (w) { return w.paid + w.due; }).concat([1]));
    var rows = a.weeks.map(function (w) {
      var last = new Date(w.end.getTime() - 1);
      var label = shortDate(w.start) + " – " + shortDate(last);
      var total = w.paid + w.due;
      return '<div class="app-ins-ahead-row"><span>' + esc(label) + '</span><span class="app-ins-ahead-bar">' +
        (w.paid ? '<i class="is-paid" style="width:' + (w.paid / max) * 100 + '%"></i>' : "") +
        (w.due ? '<i class="is-due" style="width:' + (w.due / max) * 100 + '%"></i>' : "") +
        "</span><strong>" + (total ? money(total / 100, true) : "—") + "</strong></div>";
    }).join("");
    return head +
      '<div class="app-ins-rows">' +
      '<div><span><i class="app-ins-dot is-paidd"></i>Deposits paid</span><strong>' + money(a.paid / 100, true) + "</strong></div>" +
      '<div><span><i class="app-ins-dot is-duee"></i>Still due</span><strong>' + money(a.due / 100, true) + "</strong></div>" +
      "<div><span>Deposits waiting</span><strong>" + (a.waitingCount ? money(a.waitingCents / 100, true) + " · " + a.waitingCount : "0") + "</strong></div>" +
      "</div>" +
      '<div class="app-ins-ahead">' + rows + "</div>" +
      '<p class="app-ins-legend"><i class="is-bar"></i>Deposits paid <i class="is-due-key"></i>Still due</p>' +
      (a.unpriced ? '<p class="app-hint">' + a.unpriced + " booked without a price. Add prices to your services to count them.</p>" : "");
  }

  function isCharterShop() {
    return String((state.session.tenant && state.session.tenant.subscriptionPlan) || "").toLowerCase() === "charter";
  }

  function memberNames() {
    var names = {};
    (state.session.members || []).forEach(function (m) { if (m.uid) names[m.uid] = (m.displayName || m.firstName || "").trim(); });
    return names;
  }

  /** Per team member: service value, visits, booked time, pre-booked (busiest first). */
  function teamRows(cur, from, to, byClient) {
    var names = memberNames();
    var rows = {};
    cur.booked.forEach(function (b) {
      var key = b.staffUid || b.staff || "";
      if (!key) return;
      var r = rows[key] || (rows[key] = { name: names[b.staffUid] || b.staff || "Team member", value: 0, visits: [], minutes: 0 });
      r.value += valueCents(b);
      r.visits.push(b);
      r.minutes += b.minutes;
    });
    var open = openMinutes(from, to);
    return Object.keys(rows).map(function (k) {
      var r = rows[k];
      return {
        name: r.name,
        value: r.value / 100,
        visits: r.visits.length,
        busy: open > 0 ? Math.min(100, Math.round((r.minutes / open) * 100)) : null,
        prebook: prebookPct(r.visits, byClient),
      };
    }).sort(function (a, b) { return (b.value - a.value) || (b.visits - a.visits); });
  }

  function teamTable(cur, from, to, byClient, seeMoney) {
    var rows = teamRows(cur, from, to, byClient);
    if (!rows.length) return '<p class="app-empty">No visits with a team member in this range.</p>';
    return '<div class="app-ins-table' + (seeMoney ? "" : " is-4") + '" role="table"><div class="is-head" role="row"><span>Team member</span>' + (seeMoney ? "<span>Service value</span>" : "") +
      "<span>Visits</span><span>Booked time</span><span>Pre-booked</span></div>" +
      rows.map(function (r) {
        return '<div role="row"><span>' + esc(r.name) + "</span>" + (seeMoney ? "<span>" + money(r.value, true) + "</span>" : "") +
          "<span>" + r.visits + "</span><span>" + (r.busy == null ? "—" : r.busy + "%") + "</span><span>" + (r.prebook == null ? "—" : r.prebook + "%") + "</span></div>";
      }).join("") + "</div>";
  }

  function onlineStats(rows, first, from, to) {
    var appts = rows.filter(function (b) { return isBooked(b) || b.status === "cancelled"; });
    var online = appts.filter(function (b) { return b.online; });
    var newOnline = 0;
    var seen = {};
    online.forEach(function (b) {
      if (!b.client || seen[b.client] || !isVisit(b)) return;
      if (first[b.client] && first[b.client] >= from && first[b.client] < to && first[b.client].getTime() === b.start.getTime()) { newOnline += 1; seen[b.client] = true; }
    });
    return {
      total: appts.length,
      online: online.length,
      byYou: appts.length - online.length,
      newClients: newOnline,
      noShows: online.filter(function (b) { return b.noShow; }).length,
      cancels: online.filter(function (b) { return b.status === "cancelled"; }).length,
    };
  }

  function onlineCard(cur, prev, first, from, to) {
    var s = onlineStats(cur.rows, first, from, to);
    var cp = comparePeriod();
    var ps = prev && cp ? onlineStats(prev.rows, first, cp.from, cp.to) : null;
    if (!s.total) return '<p class="app-empty">No appointments in this range yet.</p>';
    var pctOnline = Math.round((s.online / s.total) * 100);
    return stack([[pctOnline, "is-online"], [100 - pctOnline, "is-byyou"]]) +
      '<div class="app-ins-rows">' +
      '<div><span><i class="app-ins-dot is-online"></i>Clients booked themselves on your site</span><strong>' + s.online + " · " + pctOnline + "% " + delta(s.online, ps && ps.online) + "</strong></div>" +
      '<div><span><i class="app-ins-dot is-byyou"></i>You or your team added them</span><strong>' + s.byYou + " · " + (100 - pctOnline) + "%</strong></div>" +
      "<div><span>New clients from online booking</span><strong>" + s.newClients + " " + delta(s.newClients, ps && ps.newClients) + "</strong></div>" +
      "<div><span>Online no-shows · cancels</span><strong>" + s.noShows + " · " + s.cancels + "</strong></div>" +
      "</div>" + (s.online ? "" : '<p class="app-hint">Share your booking link so clients can book themselves.</p>');
  }

  /* ── Report builder (PDF or CSV) ── */

  var REPORT_SECTIONS = [
    { id: "summary", label: "Summary" },
    { id: "money", label: "Money", money: true },
    { id: "appointments", label: "Appointments" },
    { id: "schedule", label: "Schedule" },
    { id: "clients", label: "Clients" },
    { id: "team", label: "Team members", team: true },
    { id: "online", label: "How bookings came in" },
    { id: "ahead", label: "Next 30 days (deposits and balances)" },
    { id: "details", label: "Detail lists (every appointment, payment, and tip)" },
  ];

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    // Keep spreadsheet apps from treating a cell as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function shopName() {
    var s = state.session || {};
    return String(s.shopName || (s.tenant && (s.tenant.businessName || s.tenant.displayName)) || "Your shop");
  }

  function pctText(cur, prev) {
    var c = charts();
    if (state.compare === "none" || prev == null || !c.pct) return "";
    var p = c.pct(cur, prev);
    return p == null ? "" : (p >= 0 ? "▲ " : "▼ ") + Math.abs(p) + "%";
  }

  function ptsText(cur, prev) {
    if (state.compare === "none" || cur == null || prev == null) return "";
    var d = cur - prev;
    return d === 0 ? "same" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d) + " pt";
  }

  function phoneFmt(ten) {
    var d = String(ten || "").replace(/\D/g, "");
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : d;
  }

  /** Everything the report shows, for the current state (dates, compare, filters). */
  function reportModel() {
    var p = period();
    var cp = comparePeriod();
    var first = firstVisitByClient();
    var byClient = bookingsByClient();
    var cur = periodStats(p.from, p.to, first, byClient);
    var prev = cp ? periodStats(cp.from, cp.to, first, byClient) : null;
    var seeMoney = canSeeRevenue();
    var filtered = filtering();
    var m = { p: p, cp: cp, cur: cur, prev: prev, seeMoney: seeMoney, filtered: filtered };

    var revEntries = null;
    if (seeMoney && filtered) {
      revEntries = function (a, z) {
        return list().filter(function (b) { return isVisit(b) && inWindow(b, a, z); }).map(function (b) { return { date: b.start, value: valueCents(b) / 100 }; });
      };
    } else if (seeMoney && Array.isArray(state.revenue)) {
      revEntries = function (a, z) { return state.revenue.filter(function (e) { return e.date >= a && e.date < z; }); };
    }
    var sum = function (l) { return l.reduce(function (a, e) { return a + e.value; }, 0); };
    m.revLabel = filtered ? "Service value" : "Revenue";
    m.revenue = revEntries ? sum(revEntries(p.from, p.to)) : null;
    m.revenuePrev = revEntries && cp ? sum(revEntries(cp.from, cp.to)) : null;
    if (revEntries) {
      m.revBuckets = fill(buckets(p.from, p.to), revEntries(p.from, p.to));
      m.revCompare = compareSeries(m.revBuckets, revEntries);
    }
    var visitEntries = function (a, z) {
      return list().filter(function (b) { return isVisit(b) && inWindow(b, a, z); }).map(function (b) { return { date: b.start, value: 1 }; });
    };
    m.visitBuckets = fill(buckets(p.from, p.to), visitEntries(p.from, p.to));
    m.visitCompare = compareSeries(m.visitBuckets, visitEntries);

    var tipsIn = function (a, z) {
      return (Array.isArray(state.tips) ? state.tips : []).filter(function (t) {
        return t.date >= a && t.date < z && t.tipCents > 0 && (!state.staff || t.staffUid === state.staff);
      });
    };
    m.tips = tipsIn(p.from, p.to);
    m.tipTotal = m.tips.reduce(function (a, t) { return a + t.tipCents; }, 0) / 100;
    m.tipPrev = cp ? tipsIn(cp.from, cp.to).reduce(function (a, t) { return a + t.tipCents; }, 0) / 100 : null;
    var tipBase = m.tips.reduce(function (a, t) { return a + t.serviceCents; }, 0);
    m.tipAvgPct = tipBase ? Math.round(((m.tipTotal * 100) / tipBase) * 100) : 0;

    var today = new Date();
    var upcoming = list().filter(function (b) { return isVisit(b) && b.status !== "completed" && b.start > today; });
    var sumValue = function (l) { return l.reduce(function (a, b) { return a + valueCents(b); }, 0) / 100; };
    var sumDeposits = function (l) {
      return l.reduce(function (a, b) { var v = valueCents(b); return a + (v > 0 ? Math.min(b.paidCents, v) : b.paidCents); }, 0) / 100;
    };
    [7, 30].forEach(function (n) {
      var l = upcoming.filter(function (b) { return b.start <= new Date(today.getTime() + n * DAY); });
      m["up" + n] = { count: l.length, value: sumValue(l), deposits: sumDeposits(l) };
    });

    m.rates = rebookRates(cur.booked, byClient);
    m.newClients = Object.keys(first).filter(function (k) { return first[k] >= p.from && first[k] < p.to; }).length;
    m.winBack = winBack();
    var svc = {};
    cur.booked.forEach(function (b) { svc[b.service] = (svc[b.service] || 0) + 1; });
    m.services = Object.keys(svc).sort(function (a, b) { return svc[b] - svc[a]; }).map(function (k) { return [k, svc[k]]; });
    var slots = {};
    cur.booked.forEach(function (b) {
      var k = DAYS[b.start.getDay()] + " " + b.start.toLocaleTimeString("en-US", { hour: "numeric" });
      slots[k] = (slots[k] || 0) + 1;
    });
    m.busiest = Object.keys(slots).sort(function (a, b) { return slots[b] - slots[a]; }).slice(0, 5).map(function (k) { return [k, slots[k]]; });
    m.team = seesWholeTeam() && !state.staff ? teamRows(cur, p.from, p.to, byClient) : [];
    m.online = onlineStats(cur.rows, first, p.from, p.to);
    m.onlinePrev = prev && cp ? onlineStats(prev.rows, first, cp.from, cp.to) : null;
    m.appts = list().filter(function (b) { return inWindow(b, p.from, p.to) && (isBooked(b) || b.status === "cancelled"); })
      .sort(function (a, b) { return a.start - b.start; });
    m.ahead = aheadStats();
    m.payments = seeMoney && !filtered && Array.isArray(state.revenue)
      ? state.revenue.filter(function (e) { return e.date >= p.from && e.date < p.to; }).sort(function (a, b) { return a.date - b.date; })
      : [];
    return m;
  }

  function apptStatus(b) {
    return b.noShow ? "No-show" : b.status === "cancelled" ? "Canceled" : b.start <= new Date() ? "Completed" : "Upcoming";
  }

  function filterLabel() {
    var names = memberNames();
    return [state.staff ? names[state.staff] || "Team member" : "", state.service].filter(Boolean).join(" · ");
  }

  function reportCsv(m, on) {
    var names = memberNames();
    var lines = [];
    var row = function (cells) { lines.push((cells || []).map(csvCell).join(",")); };
    var cur = m.cur, prev = m.prev;
    row([shopName() + " · Insights report"]);
    row(["Dates", rangeLabel(m.p)]);
    if (m.cp) row(["Compared with", rangeLabel(m.cp)]);
    if (m.filtered) row(["Filters", filterLabel()]);
    if (on.summary) {
      row([]); row(["Summary"]); row(["Metric", "This period", m.cp ? "Compared period" : "", m.cp ? "Change" : ""]);
      if (m.seeMoney && m.revenue != null) row([m.revLabel, m.revenue.toFixed(2), m.revenuePrev != null ? m.revenuePrev.toFixed(2) : "", pctText(m.revenue, m.revenuePrev)]);
      row(["Visits", cur.count, prev ? prev.count : "", pctText(cur.count, prev && prev.count)]);
      if (m.seeMoney) row(["Avg ticket", cur.avgTicket.toFixed(2), prev ? prev.avgTicket.toFixed(2) : "", pctText(cur.avgTicket, prev && prev.avgTicket)]);
      row(["No-shows %", cur.noShowPct, prev ? prev.noShowPct : "", ptsText(cur.noShowPct, prev && prev.noShowPct)]);
      row(["Booked time %", cur.utilization, prev ? prev.utilization : "", ptsText(cur.utilization, prev && prev.utilization)]);
      row(["Returning %", cur.returningPct, prev ? prev.returningPct : "", ptsText(cur.returningPct, prev && prev.returningPct)]);
    }
    if (on.money && m.seeMoney) {
      row([]); row(["Money"]);
      if (m.revBuckets) {
        row(["Period", m.revLabel, m.revCompare ? "Compared" : ""]);
        m.revBuckets.forEach(function (b, i) { row([b.label, b.value.toFixed(2), m.revCompare ? m.revCompare[i].toFixed(2) : ""]); });
      }
      row(["Tips", m.tipTotal.toFixed(2), m.tipPrev != null ? m.tipPrev.toFixed(2) : "", pctText(m.tipTotal, m.tipPrev)]);
      row(["Booked ahead · next 7 days", m.up7.value.toFixed(2), m.up7.count + " appts", "Deposits paid " + m.up7.deposits.toFixed(2)]);
      row(["Booked ahead · next 30 days", m.up30.value.toFixed(2), m.up30.count + " appts", "Deposits paid " + m.up30.deposits.toFixed(2)]);
    }
    if (on.appointments) {
      row([]); row(["Appointments"]);
      row(["Completed", cur.completed]);
      row(["Canceled", cur.cancelled, cur.cancelPct == null ? "" : cur.cancelPct + "%"]);
      row(["No-show", cur.noShows, cur.noShowPct == null ? "" : cur.noShowPct + "%", "Healthy: under " + HEALTHY.noShow + "%"]);
      row(["Pre-booked %", cur.prebookPct, ptsText(cur.prebookPct, prev && prev.prebookPct), "Healthy: " + HEALTHY.prebook + "%+"]);
    }
    if (on.schedule) {
      row([]); row(["Schedule"]);
      row(["Booked vs open %", cur.utilization, cur.bookedHours + " of " + cur.openHours + " open hours", "Healthy: " + HEALTHY.booked + "%+"]);
      row(["Period", "Visits", m.visitCompare ? "Compared" : ""]);
      m.visitBuckets.forEach(function (b, i) { row([b.label, b.value, m.visitCompare ? m.visitCompare[i] : ""]); });
      row(["Busiest times", "Visits"]);
      m.busiest.forEach(function (r) { row(r); });
    }
    if (on.clients) {
      row([]); row(["Clients"]);
      row(["Returning %", cur.returningPct, "New clients", m.newClients]);
      [30, 60, 90].forEach(function (n) { row(["Rebooked within " + n + " days %", m.rates[n] == null ? "" : m.rates[n]]); });
      row(["Top services", "Visits"]);
      m.services.forEach(function (r) { row(r); });
      row(["Clients to win back (60+ days, from today)", "Phone", "Days since last visit"]);
      m.winBack.forEach(function (w) { row([w.name, phoneFmt(w.phone), Math.round((new Date() - w.last) / DAY)]); });
    }
    if (on.team && m.team.length) {
      row([]); row(["Team members"]); row(["Name", m.seeMoney ? "Service value" : "", "Visits", "Booked time %", "Pre-booked %"]);
      m.team.forEach(function (r) { row([r.name, m.seeMoney ? r.value.toFixed(2) : "", r.visits, r.busy, r.prebook]); });
    }
    if (on.online) {
      var o = m.online;
      row([]); row(["How bookings came in"]);
      row(["Clients booked themselves on your site", o.online, pctText(o.online, m.onlinePrev && m.onlinePrev.online)]);
      row(["You or your team added them", o.byYou]);
      row(["New clients from online booking", o.newClients]);
      row(["Online no-shows", o.noShows]);
      row(["Online cancels", o.cancels]);
    }
    if (on.ahead) {
      var ah = m.ahead;
      row([]); row(["Next 30 days (from today)"]);
      row(["Booked", ah.count]);
      if (m.seeMoney) {
        row(["Booked value", (ah.booked / 100).toFixed(2)]);
        row(["Deposits paid", (ah.paid / 100).toFixed(2)]);
        row(["Still due", (ah.due / 100).toFixed(2)]);
        row(["Deposits waiting", (ah.waitingCents / 100).toFixed(2), ah.waitingCount + " bookings"]);
        row(["Week", "Deposits paid", "Still due", "Bookings"]);
        ah.weeks.forEach(function (w) { row([shortDate(w.start) + " – " + shortDate(new Date(w.end.getTime() - 1)), (w.paid / 100).toFixed(2), (w.due / 100).toFixed(2), w.count]); });
      }
    }
    if (on.details) {
      row([]); row(["Appointments list"]);
      row(["Date", "Time", "Client", "Phone", "Email", "Service", "Team member", "Status", "Booked", "Price", "Deposit paid"]);
      m.appts.forEach(function (b) {
        row([iso(b.start), b.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), b.name, phoneFmt(b.phone), b.email, b.service, b.staff,
          apptStatus(b), b.online ? "Online" : "By shop", m.seeMoney ? (valueCents(b) / 100).toFixed(2) : "", m.seeMoney ? (b.paidCents / 100).toFixed(2) : ""]);
      });
      if (m.payments.length) {
        row([]); row(["Card payments (after Stripe fees)"]); row(["Date", "Amount"]);
        m.payments.forEach(function (e) { row([iso(e.date), e.value.toFixed(2)]); });
      }
      if (m.seeMoney && m.tips.length) {
        row([]); row(["Tips"]); row(["Date", "Tip", "Service amount", "Team member"]);
        m.tips.forEach(function (t) { row([iso(t.date), (t.tipCents / 100).toFixed(2), (t.serviceCents / 100).toFixed(2), names[t.staffUid] || "Shop"]); });
      }
    }
    return "﻿" + lines.join("\r\n");
  }

  function reportHtml(m, on) {
    var c = charts();
    var names = memberNames();
    var cur = m.cur, prev = m.prev;
    var cmpWord = m.cp ? (state.compare === "year" ? "Last year" : state.compare === "custom" ? "Compared dates" : "Previous period") : "";
    var chg = function (t) { return t ? ' <span class="chg' + (t.indexOf("▼") === 0 ? " dn" : "") + '">' + esc(t) + "</span>" : ""; };
    var tile = function (label, value, change) { return '<div class="tile"><span>' + esc(label) + "</span><strong>" + value + "</strong>" + chg(change) + "</div>"; };
    var tableRows = function (rows) {
      return rows.map(function (r) { return "<tr>" + r.map(function (x, i) { return "<td" + (i ? ' class="r"' : "") + ">" + x + "</td>"; }).join("") + "</tr>"; }).join("");
    };
    var chart = function (pts, cmp, fmt, title) {
      if (!c.bars) return "";
      return c.bars(pts, fmt, title, Object.assign({ width: 720, height: 170 }, cmp ? { compare: cmp } : {})) +
        (cmp ? '<p class="legend"><i class="bar"></i>This period <i class="line"></i>' + esc(cmpWord) + "</p>" : "");
    };
    var hint = function (text, ok) { return '<p class="hint' + (ok ? " ok" : "") + '">' + (ok ? "✓ " : "") + esc(text) + "</p>"; };
    var filters = filterLabel();
    var h = '<header><p class="shop">' + esc(shopName()) + '</p><h1>Insights report</h1><p class="meta">' + esc(rangeLabel(m.p)) +
      (m.cp ? " · compared with " + esc(rangeLabel(m.cp)) : "") + (filters ? " · " + esc(filters) : "") + "</p></header>";

    if (on.summary) {
      h += '<section><h2>Summary</h2><div class="tiles">';
      if (m.seeMoney && m.revenue != null) h += tile(m.revLabel, money(m.revenue, m.revenue >= 1000), pctText(m.revenue, m.revenuePrev));
      h += tile("Visits", String(cur.count), pctText(cur.count, prev && prev.count));
      if (m.seeMoney) h += tile("Avg ticket", cur.avgTicket ? money(cur.avgTicket, true) : "—", cur.avgTicket ? pctText(cur.avgTicket, prev && prev.avgTicket) : "");
      h += tile("No-shows", cur.noShowPct == null ? "—" : cur.noShowPct + "%", ptsText(cur.noShowPct, prev && prev.noShowPct));
      h += tile("Booked time", cur.utilization == null ? "—" : cur.utilization + "%", ptsText(cur.utilization, prev && prev.utilization));
      h += tile("Returning", cur.returningPct == null ? "—" : cur.returningPct + "%", ptsText(cur.returningPct, prev && prev.returningPct));
      h += "</div></section>";
    }
    if (on.money && m.seeMoney) {
      h += "<section><h2>Money</h2>";
      if (m.revBuckets) h += "<h3>" + esc(m.revLabel) + " by " + grain() + "</h3>" + chart(m.revBuckets, m.revCompare, function (v) { return money(v, false); }, m.revLabel);
      if (m.filtered) h += hint("Card payments can't be split by team member or service, so this shows the price of those visits.", false);
      h += '<table class="kv">' + tableRows([
        ["Tips", money(m.tipTotal, false) + chg(pctText(m.tipTotal, m.tipPrev)) + (m.tips.length ? " · avg " + m.tipAvgPct + "% · " + m.tips.length + (m.tips.length === 1 ? " tip" : " tips") : "")],
        ["Booked ahead · next 7 days (from today)", money(m.up7.value, true) + " · " + m.up7.count + " appts · " + money(m.up7.deposits, true) + " deposits paid"],
        ["Booked ahead · next 30 days (from today)", money(m.up30.value, true) + " · " + m.up30.count + " appts · " + money(m.up30.deposits, true) + " deposits paid"],
      ]) + "</table></section>";
    }
    if (on.appointments) {
      var ap = cur.appts || 0;
      var pc = function (n) { return ap ? Math.round((n / ap) * 100) + "%" : "—"; };
      h += '<section><h2>Appointments</h2><table class="kv">' + tableRows([
        ["Completed", cur.completed + " · " + pc(cur.completed)],
        ["Canceled", cur.cancelled + " · " + pc(cur.cancelled) + chg(ptsText(cur.cancelPct, prev && prev.cancelPct))],
        ["No-show", cur.noShows + " · " + pc(cur.noShows) + chg(ptsText(cur.noShowPct, prev && prev.noShowPct))],
        ["Pre-booked (next visit booked before leaving)", (cur.prebookPct == null ? "—" : cur.prebookPct + "%") + chg(ptsText(cur.prebookPct, prev && prev.prebookPct))],
      ]) + "</table>" + hint("Healthy: no-shows under " + HEALTHY.noShow + "%", cur.noShowPct != null && cur.noShowPct < HEALTHY.noShow) +
        hint("Healthy: pre-booked " + HEALTHY.prebook + "%+", cur.prebookPct != null && cur.prebookPct >= HEALTHY.prebook) + "</section>";
    }
    if (on.schedule) {
      h += '<section><h2>Schedule</h2><table class="kv">' + tableRows([
        ["Booked vs open", cur.utilization == null ? "Set weekly hours to see this" : cur.utilization + "% · " + cur.bookedHours + " of " + cur.openHours + " open hours"],
        ["Busiest times", m.busiest.length ? m.busiest.map(function (r) { return esc(r[0]) + " (" + r[1] + ")"; }).join(", ") : "—"],
      ]) + "</table>" + (cur.utilization != null ? hint("Healthy: " + HEALTHY.booked + "%+ booked", cur.utilization >= HEALTHY.booked) : "") +
        "<h3>Visits by " + grain() + "</h3>" + chart(m.visitBuckets, m.visitCompare, function (v) { return v === 1 ? "1 visit" : v + " visits"; }, "Visits") + "</section>";
    }
    if (on.clients) {
      h += '<section><h2>Clients</h2><table class="kv">' + tableRows([
        ["Returning", (cur.returningPct == null ? "—" : cur.returningPct + "%") + " · " + m.newClients + (m.newClients === 1 ? " new client" : " new clients")],
        ["Rebooked within 30 / 60 / 90 days", [30, 60, 90].map(function (n) { return m.rates[n] == null ? "—" : m.rates[n] + "%"; }).join(" / ")],
      ]) + "</table>" + (cur.returningPct != null ? hint("Healthy: " + HEALTHY.returning + "%+ returning", cur.returningPct >= HEALTHY.returning) : "");
      if (m.services.length) {
        h += '<h3>Top services</h3><table class="grid"><tr><th>Service</th><th class="r">Visits</th></tr>' +
          tableRows(m.services.slice(0, 10).map(function (r) { return [esc(r[0]), r[1]]; })) + "</table>";
      }
      h += "<h3>Clients to win back <small>(60+ days, from today)</small></h3>" + (m.winBack.length
        ? '<table class="grid"><tr><th>Client</th><th>Phone</th><th class="r">Days</th></tr>' + tableRows(m.winBack.slice(0, 20).map(function (w) {
            return [esc(w.name), esc(phoneFmt(w.phone)), Math.round((new Date() - w.last) / DAY)];
          })) + "</table>"
        : hint("Everyone's been in within the last " + WIN_BACK_DAYS + " days.", false)) + "</section>";
    }
    if (on.team && m.team.length) {
      h += '<section><h2>Team members</h2><table class="grid"><tr><th>Name</th>' + (m.seeMoney ? '<th class="r">Service value</th>' : "") +
        '<th class="r">Visits</th><th class="r">Booked time</th><th class="r">Pre-booked</th></tr>' +
        tableRows(m.team.map(function (r) {
          var cells = [esc(r.name)];
          if (m.seeMoney) cells.push(money(r.value, true));
          return cells.concat([r.visits, r.busy == null ? "—" : r.busy + "%", r.prebook == null ? "—" : r.prebook + "%"]);
        })) + "</table></section>";
    }
    if (on.online) {
      var o = m.online;
      var pctOn = o.total ? Math.round((o.online / o.total) * 100) : 0;
      h += '<section><h2>How bookings came in</h2><table class="kv">' + tableRows([
        ["Clients booked themselves on your site", o.online + " · " + pctOn + "%" + chg(pctText(o.online, m.onlinePrev && m.onlinePrev.online))],
        ["You or your team added them", o.byYou + " · " + (o.total ? 100 - pctOn : 0) + "%"],
        ["New clients from online booking", o.newClients],
        ["Online no-shows · cancels", o.noShows + " · " + o.cancels],
      ]) + "</table></section>";
    }
    if (on.ahead) {
      var ah2 = m.ahead;
      h += '<section><h2>Next 30 days <small>(from today)</small></h2><table class="kv">' + tableRows(m.seeMoney ? [
        ["Booked", ah2.count + " · " + money(ah2.booked / 100, true)],
        ["Deposits paid", money(ah2.paid / 100, true)],
        ["Still due", money(ah2.due / 100, true)],
        ["Deposits waiting", ah2.waitingCount ? money(ah2.waitingCents / 100, true) + " · " + ah2.waitingCount : "0"],
      ].concat(ah2.weeks.map(function (w) {
        return [esc(shortDate(w.start) + " – " + shortDate(new Date(w.end.getTime() - 1))), money(w.paid / 100, true) + " paid · " + money(w.due / 100, true) + " due · " + w.count];
      })) : [["Booked", ah2.count]]) + "</table></section>";
    }
    if (on.details) {
      var team = seesWholeTeam();
      h += '<section class="break"><h2>Appointments list</h2>' + (m.appts.length
        ? '<table class="grid small"><tr><th>Date</th><th>Client</th><th>Service</th>' + (team ? "<th>Team member</th>" : "") + "<th>Status</th>" +
          (m.seeMoney ? '<th class="r">Price</th><th class="r">Deposit</th>' : "") + "</tr>" +
          tableRows(m.appts.map(function (b) {
            var cells = [esc(shortDate(b.start) + " " + b.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })), esc(b.name), esc(b.service)];
            if (team) cells.push(esc(b.staff));
            cells.push(apptStatus(b));
            if (m.seeMoney) cells.push(money(valueCents(b) / 100, false), money(b.paidCents / 100, false));
            return cells;
          })) + "</table>"
        : hint("No appointments in this range.", false));
      if (m.payments.length) {
        h += '<h3>Card payments <small>(after Stripe fees)</small></h3><table class="grid small"><tr><th>Date</th><th class="r">Amount</th></tr>' +
          tableRows(m.payments.map(function (e) { return [esc(shortDate(e.date, true)), money(e.value, false)]; })) +
          '<tr class="total"><td>Total</td><td class="r">' + money(m.payments.reduce(function (a, e) { return a + e.value; }, 0), false) + "</td></tr></table>";
      }
      if (m.seeMoney && m.tips.length) {
        h += '<h3>Tips</h3><table class="grid small"><tr><th>Date</th><th>Team member</th><th class="r">Tip</th><th class="r">Service</th></tr>' +
          tableRows(m.tips.map(function (t) {
            return [esc(shortDate(t.date, true)), esc(names[t.staffUid] || "Shop"), money(t.tipCents / 100, false), money(t.serviceCents / 100, false)];
          })) + "</table>";
      }
      h += "</section>";
    }
    h += "<footer>Made with Get Bookking · " + esc(new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) + "</footer>";
    var css = "*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#2b211b;margin:0;padding:32px 40px;font-size:12px;line-height:1.45}" +
      "header{border-bottom:2px solid #2b211b;padding-bottom:12px;margin-bottom:8px}.shop{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#857563}h1{margin:2px 0 4px;font-size:26px}.meta{margin:0;color:#6b5f52}" +
      "section{margin-top:22px;page-break-inside:avoid}section.break{page-break-before:always;page-break-inside:auto}h2{font-size:15px;margin:0 0 10px;padding-bottom:4px;border-bottom:1px solid #e8e0d4}h3{font-size:12px;margin:14px 0 6px;color:#6b5f52}h3 small{font-weight:400}" +
      ".tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.tile{border:1px solid #e8e0d4;border-radius:8px;padding:8px 10px}.tile span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#857563}.tile strong{font-size:18px}" +
      ".chg{font-size:10px;font-weight:600;color:#4f7a52;margin-left:4px;text-transform:none;letter-spacing:0}.tile .chg{display:block;margin:2px 0 0;font-size:10px}.chg.dn{color:#a3432f}table{width:100%;border-collapse:collapse}.kv td{padding:5px 0;border-bottom:1px solid #f0e9df}.kv td.r{text-align:right;font-weight:600}" +
      ".grid th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#857563;border-bottom:1px solid #e8e0d4;padding:4px 6px 4px 0}.grid td{padding:4px 6px 4px 0;border-bottom:1px solid #f0e9df}.grid .r{text-align:right}.grid.small{font-size:11px}tr.total td{font-weight:700;border-top:1px solid #2b211b}" +
      ".hint{margin:6px 0 0;color:#857563;font-size:11px}.hint.ok{color:#4f7a52}.legend{margin:4px 0 0;font-size:10px;color:#857563}.legend i{display:inline-block;vertical-align:middle;margin-right:4px}.legend i.bar{width:9px;height:9px;background:#A3752F;border-radius:2px}.legend i.line{width:16px;border-top:1.6px dashed #857563;margin-left:10px}" +
      ".app-chart-plot svg{width:100%;height:auto;display:block}.app-chart-grid{stroke:#e8e0d4;stroke-dasharray:2 3}.app-chart-base{stroke:#e8e0d4}.app-chart-axis{font-size:10px;fill:#6b5f52}.app-chart-hit{fill:transparent}.app-chart-compare{stroke:#857563;stroke-width:1.6;stroke-dasharray:4 3;fill:none}.app-sr-only,.app-chart-tip{display:none}" +
      "footer{margin-top:28px;padding-top:8px;border-top:1px solid #e8e0d4;color:#857563;font-size:10px}@page{margin:14mm}@media print{body{padding:0}}";
    var title = shopName() + " Insights " + iso(m.p.from) + " to " + iso(new Date(m.p.to.getTime() - 1));
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>" + css + "</style></head><body>" + h + "</body></html>";
  }

  function saveFile(text, name, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /** Prints the report from a hidden frame; the browser's print window saves it as a PDF. */
  function printHtml(html) {
    var frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0";
    document.body.appendChild(frame);
    var doc = frame.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    var oldTitle = document.title;
    var cleaned = false;
    var done = function () {
      if (cleaned) return;
      cleaned = true;
      document.title = oldTitle;
      setTimeout(function () { frame.remove(); }, 1000);
    };
    setTimeout(function () {
      // Browsers name the PDF after the page title.
      document.title = doc.title;
      frame.contentWindow.addEventListener("afterprint", done);
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(done, 60000);
    }, 300);
  }

  function reportHost() {
    var host = $("insReport");
    if (!host) {
      host = document.createElement("div");
      host.id = "insReport";
      document.body.appendChild(host);
      host.addEventListener("click", function (ev) {
        if (ev.target.closest("[data-rep-close]")) { closeReport(); return; }
        var go = ev.target.closest("[data-rep-export]");
        if (go && !go.disabled) runReport(go);
      });
      host.addEventListener("change", function (ev) {
        if (ev.target && ev.target.name === "rcompare") {
          var box = host.querySelector(".app-rep-cmp");
          if (box) box.classList.toggle("hidden", ev.target.value !== "custom");
        }
      });
    }
    return host;
  }

  function openReport() {
    if (!state.bookings) return;
    var p = period();
    var cp = comparePeriod() || { from: new Date(p.from.getTime() - (p.to - p.from)), to: p.from };
    var names = memberNames();
    var opt = function (v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? " selected" : "") + ">" + esc(label) + "</option>"; };
    var counts = {};
    state.bookings.forEach(function (b) { if (isBooked(b)) counts[b.service] = (counts[b.service] || 0) + 1; });
    var services = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 40);
    var today = iso(new Date());
    var html = '<div class="app-rep-scrim" data-rep-close></div><div class="app-rep" role="dialog" aria-modal="true" aria-labelledby="repTitle">' +
      '<div class="app-rep-head"><h2 id="repTitle">Build a report</h2><button type="button" class="app-rep-x" data-rep-close aria-label="Close">×</button></div>' +
      '<div class="app-rep-body">' +
      '<fieldset><legend>Dates</legend><div class="app-rep-row">' +
      '<label>From <input type="date" name="rfrom" value="' + iso(p.from) + '" max="' + today + '"></label>' +
      '<label>To <input type="date" name="rto" value="' + iso(new Date(p.to.getTime() - 1)) + '" max="' + today + '"></label></div>' +
      '<label class="app-rep-full">Compare <select name="rcompare">' + COMPARES.map(function (cc) { return opt(cc.id, cc.label, state.compare); }).join("") + "</select></label>" +
      '<div class="app-rep-row app-rep-cmp' + (state.compare === "custom" ? "" : " hidden") + '">' +
      '<label>Compare from <input type="date" name="rcfrom" value="' + iso(cp.from) + '" max="' + today + '"></label>' +
      '<label>to <input type="date" name="rcto" value="' + iso(new Date(cp.to.getTime() - 1)) + '" max="' + today + '"></label></div></fieldset>' +
      '<fieldset><legend>Filters</legend><div class="app-rep-row">' +
      (seesWholeTeam() ? '<label>Team member <select name="rstaff">' + opt("", "All team", state.staff) +
        (state.session.members || []).filter(function (mm) { return mm.uid; }).map(function (mm) { return opt(mm.uid, names[mm.uid] || mm.email || "Team member", state.staff); }).join("") +
        "</select></label>" : "") +
      '<label>Service <select name="rservice">' + opt("", "All services", state.service) + services.map(function (sv) { return opt(sv, sv, state.service); }).join("") +
      "</select></label></div></fieldset>" +
      '<fieldset><legend>Include</legend><div class="app-rep-checks">' +
      REPORT_SECTIONS.filter(function (sec) { return (!sec.money || canSeeRevenue()) && (!sec.team || seesWholeTeam()); }).map(function (sec) {
        return '<label><input type="checkbox" name="rsec" value="' + sec.id + '" checked> ' + esc(sec.label) + "</label>";
      }).join("") + "</div></fieldset>" +
      '<fieldset><legend>Format</legend><div class="app-rep-formats">' +
      '<label class="app-rep-radio"><input type="radio" name="rformat" value="pdf" checked> <span><strong>PDF</strong>A clean report with charts. Pick "Save as PDF" in the print window.</span></label>' +
      '<label class="app-rep-radio"><input type="radio" name="rformat" value="csv"> <span><strong>CSV</strong>The same numbers and lists, for Excel or Google Sheets.</span></label></div></fieldset>' +
      '<p class="app-rep-error hidden" id="repError" role="alert"></p></div>' +
      '<div class="app-rep-foot"><button type="button" class="app-btn app-btn--ghost" data-rep-close>Cancel</button>' +
      '<button type="button" class="app-btn app-btn--primary" data-rep-export>Export</button></div></div>';
    var host = reportHost();
    host.innerHTML = html;
    var firstField = host.querySelector("input,select");
    if (firstField) firstField.focus();
  }

  function closeReport() {
    var host = $("insReport");
    if (host) host.innerHTML = "";
  }

  function runReport(btn) {
    var host = $("insReport");
    var val = function (n) { var el = host.querySelector('[name="' + n + '"]'); return el ? el.value : ""; };
    var err = $("repError");
    var fail = function (msg) { err.textContent = msg; err.classList.remove("hidden"); };
    err.classList.add("hidden");
    if (!val("rfrom") || !val("rto")) return fail("Pick a start and end date.");
    var from = fromIso(val("rfrom"));
    var to = fromIso(val("rto"));
    if (from > to) { var t = from; from = to; to = t; }
    var on = {};
    host.querySelectorAll('[name="rsec"]:checked').forEach(function (cb) { on[cb.value] = true; });
    if (!Object.keys(on).length) return fail("Pick at least one section to include.");
    var format = (host.querySelector('[name="rformat"]:checked') || {}).value || "pdf";
    var compare = val("rcompare") || "prev";
    if (compare === "custom" && (!val("rcfrom") || !val("rcto"))) return fail("Pick the dates to compare with.");

    // Use the report's choices for this export, then put the page back the way it was.
    var keep = {
      range: state.range, customFrom: state.customFrom, customTo: state.customTo, compare: state.compare,
      cmpFrom: state.cmpFrom, cmpTo: state.cmpTo, staff: state.staff, service: state.service, grain: state.grain,
    };
    var restore = function () { Object.keys(keep).forEach(function (k) { state[k] = keep[k]; }); };
    state.range = "custom";
    state.customFrom = from;
    state.customTo = to;
    state.compare = compare;
    state.grain = "auto";
    if (compare === "custom") { state.cmpFrom = fromIso(val("rcfrom")); state.cmpTo = fromIso(val("rcto")); }
    state.staff = val("rstaff");
    state.service = val("rservice");
    btn.disabled = true;
    btn.textContent = "Building…";
    Promise.all([loadRevenue(), loadTips()]).then(function () {
      var m = reportModel();
      var stamp = iso(m.p.from) + "-to-" + iso(new Date(m.p.to.getTime() - 1));
      var out = format === "csv" ? reportCsv(m, on) : reportHtml(m, on);
      restore();
      closeReport();
      paint();
      if (format === "csv") saveFile(out, "insights-report-" + stamp + ".csv", "text/csv;charset=utf-8");
      else printHtml(out);
    }).catch(function () {
      restore();
      btn.disabled = false;
      btn.textContent = "Export";
      fail("Couldn't build the report. Check your connection and try again.");
    });
  }

  /* ── Wiring ── */

  function refresh() {
    paint();
    return Promise.all([
      state.bookings ? Promise.resolve() : loadBookings(),
      loadServicePrices(),
      loadRevenue(),
      loadTips(),
    ]).then(paint);
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("insRange").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-ins-range]");
      if (!b) return;
      state.range = b.getAttribute("data-ins-range");
      state.grain = "auto";
      if (state.range === "custom" && !state.customFrom) {
        var t = dayStart(new Date());
        state.customTo = t;
        state.customFrom = addDays(t, -29);
      }
      refresh();
    });
    var body = $("insBody");
    body.addEventListener("click", function (ev) {
      var a = ev.target.closest("[data-ahead]");
      if (a) { state.aheadMode = a.getAttribute("data-ahead"); paint(); return; }
      var g = ev.target.closest("[data-grain]");
      if (g) { state.grain = g.getAttribute("data-grain"); paint(); return; }
      if (ev.target.closest("[data-ins-report]")) openReport();
    });
    body.addEventListener("change", function (ev) {
      var el = ev.target.closest("[data-ins]");
      if (!el) return;
      var key = el.getAttribute("data-ins");
      if (key === "compare") {
        state.compare = el.value;
        writePref("ins.compare", state.compare);
        if (state.compare === "custom" && !state.cmpFrom) {
          var p = period();
          var len = Math.max(1, Math.round((p.to - p.from) / DAY));
          state.cmpTo = addDays(dayStart(p.from), -1);
          state.cmpFrom = addDays(state.cmpTo, -(len - 1));
        }
        refresh();
      } else if (key === "staff" || key === "service") {
        state[key] = el.value;
        paint();
      } else if ((key === "cmpFrom" || key === "cmpTo") && el.value) {
        state[key] = fromIso(el.value);
        if (state.cmpFrom && state.cmpTo && state.cmpFrom > state.cmpTo) {
          var tmp = state.cmpFrom; state.cmpFrom = state.cmpTo; state.cmpTo = tmp;
        }
        refresh();
      }
    });
    document.addEventListener("keydown", function (ev) {
      var rep = $("insReport");
      if (ev.key === "Escape" && rep && rep.innerHTML) closeReport();
    });
    ["insFrom", "insTo"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        if (!el.value) return;
        var d = fromIso(el.value);
        if (id === "insFrom") state.customFrom = d; else state.customTo = d;
        if (state.customFrom && state.customTo && state.customFrom > state.customTo) {
          var tmp = state.customFrom; state.customFrom = state.customTo; state.customTo = tmp;
        }
        state.grain = "auto";
        refresh();
      });
    });
  }

  function load(session) {
    state.session = session;
    wire();
    return refresh();
  }

  global.ShopAppInsights = { load: load };
})(window);
