/**
 * Shop portal Insights: how the shop is doing over a chosen range. Revenue comes from the same
 * Stripe source as the iPhone app (owners and managers); bookings and clients come from the
 * shop's booking requests.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var RANGES = [
    { id: "30", label: "30 days", days: 30, bucket: "week" },
    { id: "90", label: "90 days", days: 90, bucket: "week" },
    { id: "365", label: "12 months", days: 365, bucket: "month" },
  ];
  var BOOKED = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  var state = { session: null, range: "30", bookings: null, revenue: null, wired: false, revenueFor: "" };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function charts() {
    return global.ShopAppDashCharts || {};
  }

  function range() {
    return RANGES.filter(function (r) { return r.id === state.range; })[0] || RANGES[0];
  }

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

  /** Buckets (oldest first) covering the range: weeks for 30/90 days, months for 12 months. */
  function buckets() {
    var r = range();
    var now = new Date();
    var out = [];
    if (r.bucket === "month") {
      for (var i = 11; i >= 0; i--) {
        var s = new Date(now.getFullYear(), now.getMonth() - i, 1);
        var e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        out.push({ start: s, end: e, label: s.toLocaleDateString("en-US", { month: "short" }), value: 0 });
      }
      return out;
    }
    var weeks = Math.ceil(r.days / 7);
    var w0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    w0.setDate(w0.getDate() - w0.getDay());
    for (var j = weeks - 1; j >= 0; j--) {
      var ws = new Date(w0);
      ws.setDate(ws.getDate() - j * 7);
      var we = new Date(ws);
      we.setDate(we.getDate() + 7);
      out.push({ start: ws, end: we, label: ws.toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: 0 });
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

  function since() {
    var d = new Date();
    d.setDate(d.getDate() - range().days);
    return d;
  }

  function tipFor(p) {
    return range().bucket === "month" ? p.label : p.label + " week";
  }

  /* ── Data ── */

  function loadBookings() {
    var s = state.session;
    return firebase.firestore().collection("tenants").doc(s.tenantId).collection("bookingRequests")
      .orderBy("createdAt", "desc").limit(1500).get().then(function (snap) {
        var uid = s.user && s.user.uid;
        var perms = (s.access && s.access.managerPermissions) || {};
        var all = ShopAppAccess.can(s, "viewAllBookings");
        state.bookings = snap.docs.map(function (doc) {
          var d = doc.data() || {};
          return {
            status: String(d.status || "new").toLowerCase(),
            start: startOf(d),
            createdAt: toDate(d.createdAt),
            service: String(d.serviceName || "").trim() || "Other",
            staff: String(d.assignedMemberName || "").trim(),
            staffUid: String(d.assignedMemberUid || ""),
            client: String(d.customerPhone || d.customerEmail || d.customerName || "").replace(/\D/g, "").slice(-10) || String(d.customerEmail || d.customerName || "").toLowerCase(),
            paidCents: typeof d.paidCents === "number" ? d.paidCents : 0,
          };
        }).filter(function (b) { return all || b.staffUid === uid; });
      }).catch(function () {
        state.bookings = [];
      });
  }

  function loadRevenue() {
    if (!canSeeRevenue()) return Promise.resolve();
    var key = state.range;
    if (state.revenueFor === key && state.revenue) return Promise.resolve();
    state.revenue = null;
    return firebase.app().functions(REGION).httpsCallable("getConnectBalanceTransactions")({
      startTimestampSeconds: Math.floor(since().getTime() / 1000) - 86400 * 7,
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

  /* ── Paint ── */

  function card(title, body, extraClass) {
    return '<article class="app-card app-ins-card' + (extraClass ? " " + extraClass : "") + '">' +
      '<div class="app-card-head"><h2>' + esc(title) + '</h2><span class="app-chart-range">' + esc(range().label) + "</span></div>" +
      '<div class="app-ins-body">' + body + "</div></article>";
  }

  function rankList(counts, fmt) {
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 5);
    if (!keys.length) return '<p class="app-empty">Nothing in this range yet.</p>';
    var max = counts[keys[0]] || 1;
    return '<ol class="app-ins-rank">' + keys.map(function (k) {
      return '<li><span class="app-ins-rank-label">' + esc(k) + '</span><span class="app-ins-rank-bar"><i style="width:' +
        Math.max(4, Math.round((counts[k] / max) * 100)) + '%"></i></span><strong>' + esc(fmt(counts[k])) + "</strong></li>";
    }).join("") + "</ol>";
  }

  function paint() {
    var host = $("insBody");
    if (!host) return;
    var seg = $("insRange");
    if (seg) seg.innerHTML = RANGES.map(function (r) {
      return '<button type="button" data-ins-range="' + r.id + '" class="' + (r.id === state.range ? "is-on" : "") + '">' + esc(r.label) + "</button>";
    }).join("");
    if (!state.bookings) {
      host.innerHTML = '<p class="app-empty">Loading insights…</p>';
      return;
    }
    var c = charts();
    var from = since();
    var r = range();
    var booked = state.bookings.filter(function (b) { return b.start && b.start >= from && b.start <= new Date() && BOOKED.indexOf(b.status) !== -1; });
    var prevFrom = new Date(from.getTime() - r.days * 864e5);
    var prevBooked = state.bookings.filter(function (b) { return b.start && b.start >= prevFrom && b.start < from && BOOKED.indexOf(b.status) !== -1; });
    var requests = state.bookings.filter(function (b) { return b.createdAt && b.createdAt >= from; });
    var declined = requests.filter(function (b) { return b.status === "declined" || b.status === "cancelled"; }).length;

    // Clients whose first booking falls in the range.
    var firstSeen = {};
    state.bookings.forEach(function (b) {
      if (!b.client || !b.start || BOOKED.indexOf(b.status) === -1) return;
      if (!firstSeen[b.client] || b.start < firstSeen[b.client]) firstSeen[b.client] = b.start;
    });
    var newClients = Object.keys(firstSeen).filter(function (k) { return firstSeen[k] >= from; }).length;

    var revenueSum = null;
    if (canSeeRevenue() && Array.isArray(state.revenue)) {
      revenueSum = state.revenue.filter(function (e) { return e.date >= from; }).reduce(function (a, e) { return a + e.value; }, 0);
    }

    var tiles = [];
    if (canSeeRevenue()) {
      tiles.push(["Revenue", revenueSum == null ? (state.revenue && state.revenue.error ? "—" : "…") : c.money(revenueSum, revenueSum >= 1000), ""]);
    }
    tiles.push(["Bookings", String(booked.length), c.changeHtml(c.pct(booked.length, prevBooked.length))]);
    tiles.push(["New clients", String(newClients), ""]);
    tiles.push(["Requests", String(requests.length), declined ? '<span class="app-chart-change">' + declined + " declined</span>" : ""]);

    var html = '<div class="app-stats app-ins-tiles">' + tiles.map(function (t) {
      return "<div><span>" + esc(t[0]) + "</span><strong>" + t[1] + "</strong>" + t[2] + "</div>";
    }).join("") + "</div>";

    html += '<div class="app-ins-grid">';
    if (canSeeRevenue()) {
      var revBody;
      if (state.revenue && state.revenue.error) {
        revBody = '<p class="app-empty">Revenue shows here once card payments are set up. <a class="app-btn app-btn--warm" data-route="payments" href="/app/payments">Set up payments</a></p>';
      } else if (!Array.isArray(state.revenue)) {
        revBody = '<p class="app-empty">Loading revenue…</p>';
      } else {
        revBody = c.bars(fill(buckets(), state.revenue), function (v) { return c.money(v, false); }, "Revenue by " + r.bucket, { tipPrefix: tipFor, width: 720, height: 190 }) +
          (state.revenue.length >= 100 ? '<p class="app-hint">Showing your 100 most recent card payments.</p>' : "");
      }
      html += card("Revenue", revBody, "is-wide");
    }
    var bookBody = booked.length
      ? c.bars(fill(buckets(), booked.map(function (b) { return { date: b.start, value: 1 }; })), function (v) { return v === 1 ? "1 booking" : v + " bookings"; }, "Bookings by " + r.bucket, { tipPrefix: tipFor, width: 720, height: 190 })
      : '<div class="app-chart-empty"><strong>No bookings in this range</strong><span>Try a longer range, or share your booking link.</span></div>';
    html += card("Bookings", bookBody, "is-wide");

    var weekday = DAYS.map(function (d) { return { label: d, value: 0 }; });
    booked.forEach(function (b) { weekday[b.start.getDay()].value += 1; });
    html += card("Busiest days", booked.length
      ? c.bars(weekday, function (v) { return v === 1 ? "1 booking" : v + " bookings"; }, "Bookings by day of the week", { allLabels: true, tipPrefix: function (p) { return p.label; } })
      : '<p class="app-empty">Nothing in this range yet.</p>');

    var svc = {};
    booked.forEach(function (b) { svc[b.service] = (svc[b.service] || 0) + 1; });
    html += card("Top services", rankList(svc, function (n) { return String(n); }));

    if (state.session.teamMode) {
      var staff = {};
      booked.forEach(function (b) { if (b.staff) staff[b.staff] = (staff[b.staff] || 0) + 1; });
      html += card("Bookings by team member", rankList(staff, function (n) { return String(n); }));
    }
    html += "</div>";
    host.innerHTML = html;
    if (c.wireTips) host.querySelectorAll(".app-ins-body").forEach(function (b) { c.wireTips(b); });
  }

  function refresh() {
    paint();
    return Promise.all([state.bookings ? Promise.resolve() : loadBookings(), loadRevenue()]).then(paint);
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("insRange").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-ins-range]");
      if (!b) return;
      state.range = b.getAttribute("data-ins-range");
      refresh();
    });
  }

  function load(session) {
    state.session = session;
    wire();
    return refresh();
  }

  global.ShopAppInsights = { load: load };
})(window);
