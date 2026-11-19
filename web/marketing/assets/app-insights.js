/**
 * Shop portal Insights: how the shop is doing over a chosen range.
 * Toolbar (compare, team member, service, download), summary tiles, then Money, Appointments,
 * Schedule, Clients, and Online bookings sections. Every number covers only the chosen dates
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
    html += '<button type="button" class="app-btn app-btn--ghost app-ins-dl" data-ins-download>Download CSV</button></div>';
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

    // Online bookings.
    html += section("Online bookings") + '<div class="app-ins-grid">' + card("From your website", onlineCard(cur, prev, first, from, now), "is-wide") + "</div>";

    host.innerHTML = html;
    if (c.wireTips) host.querySelectorAll(".app-ins-body").forEach(function (b) { c.wireTips(b); });
  }

  function memberNames() {
    var names = {};
    (state.session.members || []).forEach(function (m) { if (m.uid) names[m.uid] = (m.displayName || m.firstName || "").trim(); });
    return names;
  }

  function teamTable(cur, from, to, byClient, seeMoney) {
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
    var keys = Object.keys(rows).sort(function (a, b) { return (rows[b].value - rows[a].value) || (rows[b].visits.length - rows[a].visits.length); });
    if (!keys.length) return '<p class="app-empty">No visits with a team member in this range.</p>';
    return '<div class="app-ins-table' + (seeMoney ? "" : " is-4") + '" role="table"><div class="is-head" role="row"><span>Team member</span>' + (seeMoney ? "<span>Service value</span>" : "") +
      "<span>Visits</span><span>Booked time</span><span>Pre-booked</span></div>" +
      keys.map(function (k) {
        var r = rows[k];
        var busy = open > 0 ? Math.min(100, Math.round((r.minutes / open) * 100)) + "%" : "—";
        var pb = prebookPct(r.visits, byClient);
        return '<div role="row"><span>' + esc(r.name) + "</span>" + (seeMoney ? "<span>" + money(r.value / 100, true) + "</span>" : "") +
          "<span>" + r.visits.length + "</span><span>" + busy + "</span><span>" + (pb == null ? "—" : pb + "%") + "</span></div>";
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
      '<div><span><i class="app-ins-dot is-online"></i>From your website</span><strong>' + s.online + " · " + pctOnline + "% " + delta(s.online, ps && ps.online) + "</strong></div>" +
      '<div><span><i class="app-ins-dot is-byyou"></i>Booked by you</span><strong>' + s.byYou + " · " + (100 - pctOnline) + "%</strong></div>" +
      "<div><span>New clients who booked online</span><strong>" + s.newClients + " " + delta(s.newClients, ps && ps.newClients) + "</strong></div>" +
      "<div><span>Online no-shows · cancels</span><strong>" + s.noShows + " · " + s.cancels + "</strong></div>" +
      "</div>";
  }

  /* ── Download ── */

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    // Keep spreadsheet apps from treating a cell as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download() {
    if (!state.bookings) return;
    var p = period();
    var names = memberNames();
    var seeMoney = canSeeRevenue();
    var lines = [];
    var row = function (cells) { lines.push(cells.map(csvCell).join(",")); };
    row(["Insights", rangeLabel(p) + (filtering() ? " (filtered)" : "")]);
    row([]);
    row(["Appointments"]);
    row(["Date", "Time", "Client", "Phone", "Email", "Service", "Team member", "Status", "Booked", "Price", "Deposit paid"]);
    list().filter(function (b) { return inWindow(b, p.from, p.to) && (isBooked(b) || b.status === "cancelled"); })
      .sort(function (a, b) { return a.start - b.start; })
      .forEach(function (b) {
        row([
          iso(b.start),
          b.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          b.name, b.phone, b.email, b.service, b.staff,
          b.noShow ? "No-show" : b.status === "cancelled" ? "Canceled" : b.start <= new Date() ? "Completed" : "Upcoming",
          b.online ? "Online" : "By shop",
          seeMoney ? (valueCents(b) / 100).toFixed(2) : "",
          seeMoney ? (b.paidCents / 100).toFixed(2) : "",
        ]);
      });
    if (seeMoney && Array.isArray(state.revenue) && !filtering()) {
      row([]);
      row(["Card payments (after Stripe fees)"]);
      row(["Date", "Amount"]);
      state.revenue.filter(function (e) { return e.date >= p.from && e.date < p.to; })
        .sort(function (a, b) { return a.date - b.date; })
        .forEach(function (e) { row([iso(e.date), e.value.toFixed(2)]); });
    }
    if (seeMoney && Array.isArray(state.tips)) {
      row([]);
      row(["Tips"]);
      row(["Date", "Tip", "Service amount", "Team member"]);
      state.tips.filter(function (t) { return t.date >= p.from && t.date < p.to && t.tipCents > 0 && (!state.staff || t.staffUid === state.staff); })
        .sort(function (a, b) { return a.date - b.date; })
        .forEach(function (t) { row([iso(t.date), (t.tipCents / 100).toFixed(2), (t.serviceCents / 100).toFixed(2), names[t.staffUid] || "Shop"]); });
    }
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "insights-" + iso(p.from) + "-to-" + iso(new Date(p.to.getTime() - 1)) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
      if (ev.target.closest("[data-ins-download]")) download();
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
