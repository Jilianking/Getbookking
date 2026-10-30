/**
 * Dashboard charts under Upcoming: weekly revenue (same Stripe source as the iPhone app's
 * "Revenue over time") and weekly bookings with top services, both for the last 8 weeks.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var WEEKS = 8;
  var BAR = "#A3752F"; // brand gold, checked for contrast on white
  var BOOKED = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"];

  var state = { session: null, revenueLoaded: false, revenue: null };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function weekStart(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - x.getDay());
    return x;
  }

  /** The last WEEKS weeks (oldest first), each { start, end, label }. */
  function weeks() {
    var out = [];
    var thisWeek = weekStart(new Date());
    for (var i = WEEKS - 1; i >= 0; i--) {
      var s = new Date(thisWeek);
      s.setDate(s.getDate() - i * 7);
      var e = new Date(s);
      e.setDate(e.getDate() + 7);
      out.push({ start: s, end: e, label: s.toLocaleDateString("en-US", { month: "short", day: "numeric" }) });
    }
    return out;
  }

  function bucket(entries) {
    var ws = weeks();
    return ws.map(function (w) {
      var sum = 0;
      entries.forEach(function (e) {
        if (e.date >= w.start && e.date < w.end) sum += e.value;
      });
      return { label: w.label, start: w.start, value: sum };
    });
  }

  function money(n, compact) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: compact ? 0 : 2, minimumFractionDigits: compact ? 0 : 2 });
  }

  function pct(cur, prior) {
    if (!prior) return null;
    return Math.round(((cur - prior) / prior) * 100);
  }

  function changeHtml(p) {
    if (p == null) return "";
    var up = p >= 0;
    return '<span class="app-chart-change ' + (up ? "is-up" : "is-down") + '">' + (up ? "▲ " : "▼ ") + Math.abs(p) + "%</span>";
  }

  /** Thin rounded bars on a shared baseline, a recessive grid, labels in text ink, and a hover tooltip. */
  function barsSvg(points, fmt, title, opts) {
    opts = opts || {};
    var W = opts.width || 320, H = opts.height || 150, padL = 4, padR = 4, padT = 10, padB = 22;
    var max = Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0]));
    var top = max > 0 ? max : 1;
    var slot = (W - padL - padR) / points.length;
    var bw = Math.min(opts.width ? 22 : 14, slot * 0.45);
    var plotH = H - padT - padB;
    var grid = [0.5, 1].map(function (f) {
      var y = padT + plotH * (1 - f);
      return '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '" class="app-chart-grid"/>';
    }).join("");
    var bars = points.map(function (p, i) {
      var h = p.value > 0 ? Math.max(3, (p.value / top) * plotH) : 0;
      var x = padL + slot * i + (slot - bw) / 2;
      var y = padT + plotH - h;
      var r = Math.min(4, h / 2);
      // Rounded top only; the bottom sits square on the baseline.
      var path = h ? "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
        "H" + (x + bw - r) + "Q" + (x + bw) + "," + y + " " + (x + bw) + "," + (y + r) + "V" + (y + h) + "Z" : "";
      var tip = esc((opts.tipPrefix ? opts.tipPrefix(p) : p.label + " week") + ": " + fmt(p.value));
      var showLabel = opts.allLabels || i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2);
      return '<g class="app-chart-bar" data-tip="' + tip + '">' +
        '<rect class="app-chart-hit" x="' + (padL + slot * i) + '" y="' + padT + '" width="' + slot + '" height="' + (plotH + padB) + '"/>' +
        (path ? '<path d="' + path + '" fill="' + BAR + '"/>' : "") +
        (showLabel ? '<text x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" class="app-chart-axis">' + esc(p.label) + "</text>" : "") +
        "</g>";
    }).join("");
    var base = '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + plotH) + '" y2="' + (padT + plotH) + '" class="app-chart-base"/>';
    var table = '<table class="app-sr-only"><caption>' + esc(title) + "</caption><tr><th>" + (opts.allLabels ? "Group" : "Week of") + "</th><th>Value</th></tr>" +
      points.map(function (p) { return "<tr><td>" + esc(p.label) + "</td><td>" + esc(fmt(p.value)) + "</td></tr>"; }).join("") + "</table>";
    return '<div class="app-chart-plot"><svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(title) + '">' +
      grid + base + bars + '</svg><div class="app-chart-tip hidden" role="status"></div></div>' + table;
  }

  function wireTips(root) {
    if (!root || root.dataset.tips) return;
    root.dataset.tips = "1";
    root.addEventListener("mousemove", function (ev) {
      var g = ev.target.closest && ev.target.closest(".app-chart-bar");
      var plot = ev.target.closest && ev.target.closest(".app-chart-plot");
      if (!plot) return;
      var tip = plot.querySelector(".app-chart-tip");
      plot.querySelectorAll(".app-chart-bar.is-hover").forEach(function (n) { if (n !== g) n.classList.remove("is-hover"); });
      if (!g) { tip.classList.add("hidden"); return; }
      g.classList.add("is-hover");
      tip.textContent = g.getAttribute("data-tip");
      tip.classList.remove("hidden");
      var box = plot.getBoundingClientRect();
      var x = Math.min(Math.max(ev.clientX - box.left, 60), box.width - 60);
      tip.style.left = x + "px";
    });
    root.addEventListener("mouseleave", function () {
      root.querySelectorAll(".app-chart-tip").forEach(function (t) { t.classList.add("hidden"); });
      root.querySelectorAll(".app-chart-bar.is-hover").forEach(function (n) { n.classList.remove("is-hover"); });
    }, true);
  }

  /* ── Revenue ── */

  function canSeeRevenue(s) {
    var a = s.access || {};
    return s.isOwner || a.accessRole === "manager";
  }

  function paintRevenue() {
    var card = $("dashRevenue");
    if (!card) return;
    var body = $("dashRevenueBody");
    if (!canSeeRevenue(state.session)) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    var r = state.revenue;
    if (!r) {
      body.innerHTML = '<p class="app-empty">Loading revenue…</p>';
      return;
    }
    if (r.error) {
      body.innerHTML = '<p class="app-empty">Revenue shows here once card payments are set up. ' +
        '<a class="app-btn app-btn--warm" data-route="payments" href="/app/payments">Set up payments</a></p>';
      return;
    }
    var pts = r.points;
    var thisWeek = pts[pts.length - 1].value;
    var lastWeek = pts[pts.length - 2].value;
    var avg = pts.reduce(function (a, p) { return a + p.value; }, 0) / pts.length;
    var compact = Math.max(thisWeek, r.thisMonth) >= 1000;
    body.innerHTML =
      '<div class="app-chart-stats">' +
      '<div><span>This week</span><strong>' + money(thisWeek, compact) + "</strong>" + changeHtml(pct(thisWeek, lastWeek)) + "</div>" +
      '<div><span>This month</span><strong>' + money(r.thisMonth, compact) + "</strong>" + changeHtml(pct(r.thisMonth, r.lastMonth)) + "</div>" +
      '<div><span>Avg / week</span><strong>' + money(avg, true) + "</strong></div>" +
      "</div>" +
      barsSvg(pts, function (v) { return money(v, false); }, "Revenue by week, last 8 weeks");
    wireTips(body);
  }

  function loadRevenue() {
    if (state.revenueLoaded || !canSeeRevenue(state.session)) return;
    state.revenueLoaded = true;
    var start = new Date();
    start.setDate(start.getDate() - 70);
    firebase.app().functions(REGION).httpsCallable("getConnectBalanceTransactions")({
      startTimestampSeconds: Math.floor(start.getTime() / 1000),
      limit: 100,
    }).then(function (res) {
      var list = (res && res.data && res.data.transactions) || [];
      var entries = list.filter(function (t) {
        return String(t.type || "").toLowerCase() === "charge" && t.created > 0;
      }).map(function (t) {
        var cents = typeof t.net === "number" ? t.net : (t.amount || 0);
        return { date: new Date(t.created * 1000), value: Math.abs(cents) / 100 };
      });
      var now = new Date();
      var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      var prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var sum = function (a, b) {
        return entries.filter(function (e) { return e.date >= a && e.date < b; }).reduce(function (t, e) { return t + e.value; }, 0);
      };
      state.revenue = { points: bucket(entries), thisMonth: sum(monthStart, now), lastMonth: sum(prevStart, monthStart) };
      paintRevenue();
    }).catch(function () {
      state.revenue = { error: true };
      paintRevenue();
    });
  }

  /* ── Bookings ── */

  /** Called by the dashboard with the bookings it already loaded (scoped to what this person can see). */
  function paintBookings(list) {
    var body = $("dashBookingsBody");
    if (!body) return;
    var booked = (list || []).filter(function (b) { return b.start && BOOKED.indexOf(b.status) !== -1; });
    var pts = bucket(booked.map(function (b) { return { date: b.start, value: 1 }; }));
    var thisWeek = pts[pts.length - 1].value;
    var lastWeek = pts[pts.length - 2].value;
    var since = pts[0].start;
    var counts = {};
    booked.forEach(function (b) {
      if (b.start < since) return;
      var k = b.serviceName || "Other";
      counts[k] = (counts[k] || 0) + 1;
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 3);
    var count = function (v) { return v === 1 ? "1 booking" : v + " bookings"; };
    var total = pts.reduce(function (a, p) { return a + p.value; }, 0);
    if (!total) {
      body.innerHTML = '<div class="app-chart-empty"><strong>No bookings yet</strong><span>This fills in as clients book. Share your booking link to get started.</span></div>';
      return;
    }
    body.innerHTML =
      '<div class="app-chart-stats">' +
      '<div><span>This week</span><strong>' + thisWeek + "</strong>" + changeHtml(pct(thisWeek, lastWeek)) + "</div>" +
      '<div><span>Last 8 weeks</span><strong>' + total + "</strong></div>" +
      "</div>" +
      barsSvg(pts, count, "Bookings by week, last 8 weeks") +
      (top.length
        ? '<h3 class="app-chart-sub">Top services</h3><ol class="app-chart-top">' + top.map(function (k) {
            return "<li><span>" + esc(k) + "</span><strong>" + counts[k] + "</strong></li>";
          }).join("") + "</ol>"
        : "");
    wireTips(body);
  }

  function load(session) {
    state.session = session;
    paintRevenue();
    loadRevenue();
  }

  global.ShopAppDashCharts = { load: load, paintBookings: paintBookings, bars: barsSvg, wireTips: wireTips, money: money, pct: pct, changeHtml: changeHtml };
})(window);
