/**
 * Shop portal Insights: how the shop is doing over a chosen range.
 * Summary row (with "vs last period"), then Money, Schedule, and Clients sections.
 * Revenue comes from the same Stripe source as the iPhone app; tips from the payment ledger;
 * bookings, clients, and booked time from the shop's booking requests and weekly hours.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var RANGES = [
    { id: "30", label: "30 days", days: 30, bucket: "week" },
    { id: "90", label: "90 days", days: 90, bucket: "week" },
    { id: "365", label: "12 months", days: 365, bucket: "month" },
    { id: "custom", label: "Custom", days: 0, bucket: "auto" },
  ];
  var BOOKED = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  var WIN_BACK_DAYS = 60;

  var state = {
    session: null, range: "30", bookings: null, revenue: null, revenueFor: "",
    tips: null, tipsFor: "", servicePrices: null, wired: false,
    customFrom: null, customTo: null,
  };

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

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  /** Period end: now, or the day after the custom end date. */
  function periodEnd() {
    if (state.range === "custom" && state.customTo) {
      var end = dayStart(state.customTo);
      end.setDate(end.getDate() + 1);
      return end < new Date() ? end : new Date();
    }
    return new Date();
  }

  function since() {
    if (state.range === "custom" && state.customFrom) return dayStart(state.customFrom);
    var d = new Date();
    d.setDate(d.getDate() - (range().days || 30));
    return d;
  }

  /** Same number of days just before the period. */
  function prevSince() {
    return new Date(since().getTime() - (periodEnd().getTime() - since().getTime()));
  }

  function usesMonths() {
    var r = range();
    if (r.bucket === "auto") return (periodEnd() - since()) / 864e5 > 120;
    return r.bucket === "month";
  }

  function bucketWord() { return usesMonths() ? "month" : "week"; }

  /** Buckets (oldest first) covering the range: weeks for 30/90 days, months for 12 months. */
  function buckets() {
    var from = since();
    var to = periodEnd();
    var out = [];
    if (usesMonths()) {
      var m = new Date(from.getFullYear(), from.getMonth(), 1);
      while (m < to && out.length < 36) {
        var me = new Date(m.getFullYear(), m.getMonth() + 1, 1);
        out.push({ start: m, end: me, label: m.toLocaleDateString("en-US", { month: "short" }), value: 0 });
        m = me;
      }
      return out;
    }
    var ws = dayStart(from);
    ws.setDate(ws.getDate() - ws.getDay());
    while (ws < to && out.length < 30) {
      var we = new Date(ws);
      we.setDate(we.getDate() + 7);
      out.push({ start: ws, end: we, label: ws.toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: 0 });
      ws = we;
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

  function tipFor(p) { return usesMonths() ? p.label : p.label + " week"; }

  function rangeLabel() {
    if (state.range !== "custom") return range().label;
    var end = new Date(periodEnd().getTime() - 864e5);
    var f = function (d) { return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
    return f(since()) + " – " + f(end);
  }

  function money(n, compact) { return charts().money ? charts().money(n, compact) : "$" + Math.round(n); }

  /* ── Data ── */

  function loadBookings() {
    var s = state.session;
    return firebase.firestore().collection("tenants").doc(s.tenantId).collection("bookingRequests")
      .orderBy("createdAt", "desc").limit(1500).get().then(function (snap) {
        var uid = s.user && s.user.uid;
        var all = ShopAppAccess.can(s, "viewAllBookings");
        state.bookings = snap.docs.map(function (doc) {
          var d = doc.data() || {};
          var phone = String(d.customerPhone || "").replace(/\D/g, "").slice(-10);
          var dur = typeof d.durationMinutes === "string" ? parseInt(d.durationMinutes, 10) : d.durationMinutes;
          return {
            status: String(d.status || "new").toLowerCase(),
            start: startOf(d),
            createdAt: toDate(d.createdAt),
            service: String(d.serviceName || "").trim() || "Other",
            serviceId: String(d.serviceId || ""),
            staff: String(d.assignedMemberName || "").trim(),
            staffUid: String(d.assignedMemberUid || ""),
            name: String(d.customerName || "").trim() || "Client",
            phone: phone,
            client: phone || String(d.customerEmail || d.customerName || "").toLowerCase(),
            priceCents: typeof d.priceCents === "number" ? d.priceCents : 0,
            paidCents: typeof d.paidCents === "number" ? d.paidCents : 0,
            minutes: typeof dur === "number" && dur > 0 ? dur : 60,
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

  function loadRevenue() {
    if (!canSeeRevenue()) return Promise.resolve();
    var key = state.range;
    if (state.revenueFor === key && state.revenue) return Promise.resolve();
    state.revenue = null;
    return firebase.app().functions(REGION).httpsCallable("getConnectBalanceTransactions")({
      // Back to the start of the previous period, for "vs last period".
      startTimestampSeconds: Math.floor(prevSince().getTime() / 1000) - 86400,
      limit: 100,
    }).then(function (res) {
      var list = (res && res.data && res.data.transactions) || [];
      state.revenue = list.filter(function (t) {
        return String(t.type || "").toLowerCase() === "charge" && t.created > 0;
      }).map(function (t) {
        var cents = typeof t.net === "number" ? t.net : (t.amount || 0);
        return { date: new Date(t.created * 1000), value: Math.abs(cents) / 100 };
      });
      state.revenueFor = key;
    }).catch(function () {
      state.revenue = { error: true };
      state.revenueFor = key;
    });
  }

  /** Tips (owners and managers who see earnings), from the server since the previous period's start. */
  function loadTips() {
    if (!canSeeRevenue()) return Promise.resolve();
    var key = state.range;
    if (state.tipsFor === key && state.tips) return Promise.resolve();
    return firebase.app().functions(REGION).httpsCallable("getTipsSummary")({ fromMs: prevSince().getTime() })
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
        state.tipsFor = key;
      }).catch(function () {
        state.tips = [];
        state.tipsFor = key;
      });
  }

  /* ── Math ── */

  function valueCents(b) {
    if (b.priceCents > 0) return b.priceCents;
    var p = state.servicePrices || {};
    return p[b.serviceId] || p["name:" + b.service.toLowerCase()] || b.paidCents || 0;
  }

  function isBooked(b) { return BOOKED.indexOf(b.status) !== -1 && b.start; }

  function inWindow(b, from, to) { return b.start >= from && b.start < to; }

  /** Open minutes between two dates from the weekly hours, minus days off and blocked time. */
  function openMinutes(from, to) {
    var t = (state.session && state.session.tenant) || {};
    var weekly = t.businessHoursWeekly || null;
    var blockedDays = Array.isArray(t.blockedDates) ? t.blockedDates : [];
    var blocks = Array.isArray(t.blockedTimeRanges) ? t.blockedTimeRanges : [];
    var total = 0;
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (d < to) {
      var ymd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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
      d.setDate(d.getDate() + 1);
    }
    return Math.max(0, total);
  }

  function staffCount() {
    var s = state.session;
    var all = ShopAppAccess.can(s, "viewAllBookings");
    if (!s.teamMode || !all) return 1;
    return Math.max(1, (s.members || []).length);
  }

  function firstVisitByClient() {
    var first = {};
    state.bookings.forEach(function (b) {
      if (!b.client || !isBooked(b)) return;
      if (!first[b.client] || b.start < first[b.client]) first[b.client] = b.start;
    });
    return first;
  }

  function periodStats(from, to, first) {
    var booked = state.bookings.filter(function (b) { return isBooked(b) && inWindow(b, from, to); });
    var value = booked.reduce(function (a, b) { return a + valueCents(b); }, 0);
    var priced = booked.filter(function (b) { return valueCents(b) > 0; });
    var minutes = booked.reduce(function (a, b) { return a + b.minutes; }, 0);
    var open = openMinutes(from, to) * staffCount();
    var returning = booked.filter(function (b) { return b.client && first[b.client] && first[b.client] < from; }).length;
    return {
      booked: booked,
      count: booked.length,
      avgTicket: priced.length ? value / priced.length / 100 : 0,
      utilization: open > 0 ? Math.min(100, Math.round((minutes / open) * 100)) : null,
      bookedHours: Math.round(minutes / 60),
      openHours: Math.round(open / 60),
      returningPct: booked.length ? Math.round((returning / booked.length) * 100) : null,
    };
  }

  /* ── Paint helpers ── */

  function delta(cur, prev) {
    var c = charts();
    return c.changeHtml && c.pct ? c.changeHtml(c.pct(cur, prev)) : "";
  }

  function card(title, body, extraClass, sub) {
    return '<article class="app-card app-ins-card' + (extraClass ? " " + extraClass : "") + '">' +
      '<div class="app-card-head"><h2>' + esc(title) + '</h2><span class="app-chart-range">' + esc(sub || rangeLabel()) + "</span></div>" +
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
    state.bookings.forEach(function (b) {
      if (!b.client || !isBooked(b)) return;
      var c = byClient[b.client] || (byClient[b.client] = { name: b.name, phone: b.phone, last: null, visits: 0, upcoming: false });
      if (b.start > now) { c.upcoming = true; return; }
      c.visits += 1;
      if (!c.last || b.start > c.last) { c.last = b.start; c.name = b.name; }
    });
    return Object.keys(byClient).map(function (k) { return byClient[k]; }).filter(function (c) {
      return c.last && !c.upcoming && (now - c.last) / 864e5 >= WIN_BACK_DAYS;
    }).sort(function (a, b) { return b.visits - a.visits || a.last - b.last; });
  }

  /** Of visits in the range, the share followed by another booking within N days. */
  function rebookRates(booked) {
    var byClient = {};
    state.bookings.forEach(function (b) {
      if (!b.client || !isBooked(b)) return;
      (byClient[b.client] = byClient[b.client] || []).push(b.start);
    });
    Object.keys(byClient).forEach(function (k) { byClient[k].sort(function (a, b) { return a - b; }); });
    var out = {};
    [30, 60, 90].forEach(function (n) {
      var eligible = 0, hit = 0;
      booked.forEach(function (b) {
        if (!b.client) return;
        var list = byClient[b.client] || [];
        var next = list.filter(function (d) { return d > b.start; })[0];
        var measurable = (new Date() - b.start) / 864e5 >= n || next;
        if (!measurable) return;
        eligible += 1;
        if (next && (next - b.start) / 864e5 <= n) hit += 1;
      });
      out[n] = eligible ? Math.round((hit / eligible) * 100) : null;
    });
    return out;
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
      var iso = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      if (state.customFrom) $("insFrom").value = iso(state.customFrom);
      if (state.customTo) $("insTo").value = iso(state.customTo);
      $("insFrom").max = $("insTo").max = iso(new Date());
    }
    if (!state.bookings) {
      host.innerHTML = '<p class="app-empty">Loading insights…</p>';
      return;
    }
    var c = charts();
    var r = range();
    var today = new Date();
    var now = periodEnd();
    var from = since();
    var prevFrom = prevSince();
    var first = firstVisitByClient();
    var cur = periodStats(from, now, first);
    var prev = periodStats(prevFrom, from, first);
    var seeMoney = canSeeRevenue();

    var revenueSum = null, revenuePrev = null;
    if (seeMoney && Array.isArray(state.revenue)) {
      revenueSum = state.revenue.filter(function (e) { return e.date >= from && e.date < now; }).reduce(function (a, e) { return a + e.value; }, 0);
      revenuePrev = state.revenue.filter(function (e) { return e.date >= prevFrom && e.date < from; }).reduce(function (a, e) { return a + e.value; }, 0);
    }

    // Upcoming is always the next 7 / 30 days from today.
    var in7 = new Date(today.getTime() + 7 * 864e5);
    var in30 = new Date(today.getTime() + 30 * 864e5);
    var upcoming = state.bookings.filter(function (b) { return isBooked(b) && b.status !== "completed" && b.start > today; });
    var up7 = upcoming.filter(function (b) { return b.start <= in7; });
    var up30 = upcoming.filter(function (b) { return b.start <= in30; });
    var sumValue = function (list) { return list.reduce(function (a, b) { return a + valueCents(b); }, 0) / 100; };

    // Summary row.
    var tiles = [];
    if (seeMoney) {
      tiles.push(["Revenue", revenueSum == null ? (state.revenue && state.revenue.error ? "—" : "…") : money(revenueSum, revenueSum >= 1000),
        revenueSum == null ? "" : delta(revenueSum, revenuePrev)]);
    }
    tiles.push(["Bookings", String(cur.count), delta(cur.count, prev.count)]);
    if (seeMoney) tiles.push(["Avg ticket", cur.avgTicket ? money(cur.avgTicket, true) : "—", cur.avgTicket ? delta(cur.avgTicket, prev.avgTicket) : ""]);
    tiles.push(["Booked time", cur.utilization == null ? "—" : cur.utilization + "%", cur.utilization == null ? "" : delta(cur.utilization, prev.utilization)]);
    tiles.push(["Returning", cur.returningPct == null ? "—" : cur.returningPct + "%", cur.returningPct == null ? "" : delta(cur.returningPct, prev.returningPct)]);
    tiles.push(["Upcoming · 7 days", seeMoney ? money(sumValue(up7), true) : String(up7.length), '<span class="app-ins-tile-sub">' + up7.length + (up7.length === 1 ? " appt" : " appts") + "</span>"]);

    var html = '<div class="app-stats app-ins-tiles">' + tiles.map(function (t) {
      return "<div><span>" + esc(t[0]) + "</span><strong>" + t[1] + "</strong>" + (t[2] || "") + "</div>";
    }).join("") + "</div>";

    // Money.
    if (seeMoney) {
      html += section("Money") + '<div class="app-ins-grid app-ins-grid--money">';
      var revBody;
      if (state.revenue && state.revenue.error) {
        revBody = '<p class="app-empty">Revenue shows here once card payments are set up. <a class="app-btn app-btn--warm" data-route="payments" href="/app/payments">Set up payments</a></p>';
      } else if (!Array.isArray(state.revenue)) {
        revBody = '<p class="app-empty">Loading revenue…</p>';
      } else {
        revBody = c.bars(fill(buckets(), state.revenue.filter(function (e) { return e.date >= from && e.date < now; })), function (v) { return money(v, false); }, "Revenue by " + bucketWord(), { tipPrefix: tipFor, width: 720, height: 190 }) +
          (state.revenue.length >= 100 ? '<p class="app-hint">Showing your 100 most recent card payments.</p>' : "");
      }
      html += card("Revenue", revBody, "is-span2", "by " + bucketWord());
      html += '<div class="app-ins-stack">';
      html += card("Booked ahead",
        '<p class="app-ins-figure">' + money(sumValue(up7), true) + "</p>" +
        '<p class="app-ins-line">Next 7 days · ' + up7.length + (up7.length === 1 ? " appt" : " appts") + "</p>" +
        '<p class="app-ins-line">Next 30 days · ' + money(sumValue(up30), true) + " · " + up30.length + " appts</p>", "", "confirmed");
      var tipsBody;
      if (!Array.isArray(state.tips)) {
        tipsBody = '<p class="app-empty">Loading tips…</p>';
      } else {
        var curTips = state.tips.filter(function (t) { return t.date >= from && t.date < now; });
        var tipTotal = curTips.reduce(function (a, t) { return a + t.tipCents; }, 0);
        var tipped = curTips.filter(function (t) { return t.tipCents > 0; });
        var tipBase = tipped.reduce(function (a, t) { return a + t.serviceCents; }, 0);
        var avgPct = tipBase ? Math.round((tipped.reduce(function (a, t) { return a + t.tipCents; }, 0) / tipBase) * 100) : 0;
        var names = {};
        (state.session.members || []).forEach(function (m) { if (m.uid) names[m.uid] = (m.displayName || m.firstName || "").trim(); });
        var byStaff = {};
        tipped.forEach(function (t) {
          var n = names[t.staffUid] || "Shop";
          byStaff[n] = (byStaff[n] || 0) + t.tipCents;
        });
        var staffLine = state.session.teamMode
          ? Object.keys(byStaff).sort(function (a, b) { return byStaff[b] - byStaff[a]; }).slice(0, 3).map(function (n) { return esc(n) + " " + money(byStaff[n] / 100, true); }).join(" · ")
          : "";
        tipsBody = tipTotal
          ? '<p class="app-ins-figure">' + money(tipTotal / 100, tipTotal >= 100000) + '</p><p class="app-ins-line">Avg ' + avgPct + "% · " + tipped.length + (tipped.length === 1 ? " tip" : " tips") + "</p>" +
            (staffLine ? '<p class="app-ins-line">' + staffLine + "</p>" : "")
          : '<p class="app-ins-figure">$0</p><p class="app-ins-line">Tips show here as clients add them at checkout.</p>';
      }
      html += card("Tips", tipsBody);
      html += "</div></div>";
    }

    // Schedule.
    html += section("Schedule") + '<div class="app-ins-grid app-ins-grid--sched">';
    html += card("Booked vs open", cur.utilization == null
      ? '<p class="app-empty">Set your weekly hours in Scheduling to see this.</p>'
      : '<div class="app-ins-gauge-wrap">' + gauge(cur.utilization) + '<p class="app-ins-line">' + cur.bookedHours + " of " + cur.openHours + " open hours" + (staffCount() > 1 ? " (whole team)" : "") + "</p></div>");
    html += card("Busiest times", cur.count ? heatmap(cur.booked) : '<p class="app-empty">Nothing in this range yet.</p>', "is-span2");
    html += card("Bookings", cur.count
      ? c.bars(fill(buckets(), cur.booked.map(function (b) { return { date: b.start, value: 1 }; })), function (v) { return v === 1 ? "1 booking" : v + " bookings"; }, "Bookings by " + bucketWord(), { tipPrefix: tipFor, width: 720, height: 170 })
      : '<div class="app-chart-empty"><strong>No bookings in this range</strong><span>Try a longer range, or share your booking link.</span></div>', "is-wide", "by " + bucketWord());
    html += "</div>";

    // Clients.
    html += section("Clients") + '<div class="app-ins-grid">';
    var newCount = Object.keys(first).filter(function (k) { return first[k] >= from && first[k] < now; }).length;
    var retPct = cur.returningPct == null ? 0 : cur.returningPct;
    var rates = rebookRates(cur.booked);
    html += card("Coming back",
      '<div class="app-ins-split"><i style="width:' + retPct + '%"></i></div>' +
      '<p class="app-ins-line">' + retPct + "% returning · " + (100 - retPct) + "% new · " + newCount + (newCount === 1 ? " new client" : " new clients") + "</p>" +
      '<div class="app-ins-rows">' + [30, 60, 90].map(function (n) {
        return "<div><span>Rebooked within " + n + " days</span><strong>" + (rates[n] == null ? "—" : rates[n] + "%") + "</strong></div>";
      }).join("") + "</div>");
    var wb = winBack();
    html += card("Clients to win back", wb.length
      ? '<div class="app-ins-rows">' + wb.slice(0, 5).map(function (w) {
          var days = Math.round((now - w.last) / 864e5);
          var link = w.phone ? '<a class="app-ins-text" href="/app/messages?phone=%2B1' + esc(w.phone) + '">Text ›</a>' : "";
          return "<div><span>" + esc(w.name) + ' <em>· ' + days + " days</em></span>" + link + "</div>";
        }).join("") + "</div>" + (wb.length > 5 ? '<p class="app-ins-line">+ ' + (wb.length - 5) + " more</p>" : "")
      : '<p class="app-empty">Everyone\'s been in within the last ' + WIN_BACK_DAYS + " days.</p>", "", WIN_BACK_DAYS + "+ days");

    var svc = {};
    cur.booked.forEach(function (b) { svc[b.service] = (svc[b.service] || 0) + 1; });
    html += card("Top services", rankList(svc, function (n) { return String(n); }));

    if (state.session.teamMode) {
      var staffN = {}, staffV = {};
      cur.booked.forEach(function (b) {
        if (!b.staff) return;
        staffN[b.staff] = (staffN[b.staff] || 0) + 1;
        staffV[b.staff] = (staffV[b.staff] || 0) + valueCents(b);
      });
      html += card("Team", rankList(staffN, function (n, k) {
        return n + (n === 1 ? " appt" : " appts") + (seeMoney && staffV[k] ? " · " + money(staffV[k] / 100, true) : "");
      }));
    }
    html += "</div>";
    host.innerHTML = html;
    if (c.wireTips) host.querySelectorAll(".app-ins-body").forEach(function (b) { c.wireTips(b); });
  }

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
      if (state.range === "custom" && !state.customFrom) {
        var t = new Date();
        state.customTo = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        state.customFrom = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29);
      }
      refresh();
    });
    ["insFrom", "insTo"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        var v = el.value;
        if (!v) return;
        var p = v.split("-");
        var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        if (id === "insFrom") state.customFrom = d; else state.customTo = d;
        if (state.customFrom && state.customTo && state.customFrom > state.customTo) {
          var tmp = state.customFrom; state.customFrom = state.customTo; state.customTo = tmp;
        }
        // Revenue and tips reload for the new dates.
        state.revenueFor = ""; state.tipsFor = "";
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
