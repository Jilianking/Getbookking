/**
 * Team payouts (owner only): per-member totals and split activity from the payment ledger.
 * Data comes from the getTeamPayoutSummary Cloud Function.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var state = {
    session: null,
    wired: false,
    loading: false,
    period: "month",
    memberFilter: "",
    data: null,
    requestId: 0,
  };

  var PERIOD_LABELS = {
    month: "This month",
    lastMonth: "Last month",
    "30d": "Last 30 days",
    year: "This year",
  };

  var KIND_LABELS = {
    deposit: "Deposit",
    service: "Service",
    shop: "Shop order",
    tip: "Tip",
  };

  var STRIPE_LABELS = {
    active: { text: "Stripe active", cls: "is-ok" },
    restricted: { text: "Stripe restricted", cls: "is-warn" },
    incomplete: { text: "Setup incomplete", cls: "is-warn" },
    not_connected: { text: "Stripe not set up", cls: "is-warn" },
    unknown: { text: "Stripe status unknown", cls: "" },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function call(name, payload) {
    return firebase.app().functions(REGION).httpsCallable(name)(payload || {});
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function usd(cents) {
    return ((Number(cents) || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function setHidden(id, hidden) {
    var el = $(id);
    if (el) el.classList.toggle("hidden", !!hidden);
  }

  function showError(text) {
    var el = $("tpError");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  }

  function errMessage(err) {
    return (err && err.message) || "Something went wrong. Try again.";
  }

  function periodRange(period) {
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth();
    if (period === "lastMonth") {
      return { fromMs: new Date(y, m - 1, 1).getTime(), toMs: new Date(y, m, 1).getTime() - 1 };
    }
    if (period === "30d") {
      return { fromMs: now.getTime() - 30 * 24 * 60 * 60 * 1000, toMs: now.getTime() };
    }
    if (period === "year") {
      return { fromMs: new Date(y, 0, 1).getTime(), toMs: now.getTime() };
    }
    return { fromMs: new Date(y, m, 1).getTime(), toMs: now.getTime() };
  }

  function memberByUid(uid) {
    var list = (state.data && state.data.members) || [];
    for (var i = 0; i < list.length; i++) if (list[i].uid === uid) return list[i];
    return null;
  }

  function memberName(uid) {
    var m = memberByUid(uid);
    if (!m) return "Former member";
    return m.isOwner ? m.displayName + " (you)" : m.displayName;
  }

  function payoutModeLabel(m) {
    if (m.isOwner) return "Owner · studio account";
    if (!m.canTakePayments) return "Payments turned off";
    if (m.paymentSplitEnabled && m.paymentSplitPercent > 0) {
      var applies = m.paymentSplitAppliesTo === "both"
        ? "services and deposits"
        : m.paymentSplitAppliesTo === "deposit" ? "deposits" : "services";
      return "Keeps " + m.paymentSplitPercent + "% of " + applies + " · studio gets " + (100 - m.paymentSplitPercent) + "%";
    }
    return "Independent · keeps everything";
  }

  /** Where the studio's cut of one payment stands. */
  function studioStatus(entry) {
    if (!entry.splitApplied || entry.studioCents <= 0) return null;
    if (entry.studioReturnedCents > 0) {
      return entry.studioReturnedCents >= entry.studioCents
        ? { text: "Refunded", cls: "is-refunded" }
        : { text: "Partly refunded", cls: "is-refunded" };
    }
    if (entry.studioShareStatus === "transferred") return { text: "Sent to studio", cls: "is-ok" };
    if (entry.studioShareStatus === "failed") return { text: "Transfer failed · retrying", cls: "is-warn" };
    return { text: "Pending", cls: "is-pending" };
  }

  function visibleEntries() {
    var list = (state.data && state.data.entries) || [];
    if (!state.memberFilter) return list;
    return list.filter(function (e) { return e.memberUid === state.memberFilter; });
  }

  function paintPeriods() {
    document.querySelectorAll(".app-tp-periods button").forEach(function (btn) {
      btn.classList.toggle("is-on", btn.getAttribute("data-period") === state.period);
      btn.disabled = state.loading;
    });
  }

  function paintHero() {
    var members = (state.data && state.data.members) || [];
    var gross = 0, studio = 0, kept = 0, count = 0;
    members.forEach(function (m) {
      gross += m.totals.grossCents;
      studio += m.totals.studioCents - m.totals.studioReturnedCents;
      kept += m.totals.memberCents;
      count += m.totals.count;
    });
    $("tpPeriodLabel").textContent = PERIOD_LABELS[state.period] || "";
    $("tpGross").textContent = usd(gross);
    $("tpStudio").textContent = usd(studio);
    $("tpMembers").textContent = usd(kept);
    $("tpCount").textContent = String(count);
  }

  function paintTeam() {
    var wrap = $("tpTeamList");
    var members = (state.data && state.data.members) || [];
    wrap.innerHTML = members.map(function (m) {
      var stripe = m.canTakePayments ? STRIPE_LABELS[m.stripeStatus] || STRIPE_LABELS.unknown : null;
      var initial = esc((m.displayName || "?").trim().charAt(0).toUpperCase());
      var avatar = m.profilePhotoUrl
        ? '<img class="app-tp-avatar" src="' + esc(m.profilePhotoUrl) + '" alt="" />'
        : '<span class="app-tp-avatar">' + initial + "</span>";
      var studioNet = m.totals.studioCents - m.totals.studioReturnedCents;
      return (
        '<button type="button" class="app-tp-member' + (state.memberFilter === m.uid ? " is-on" : "") +
        '" data-member="' + esc(m.uid) + '" aria-pressed="' + (state.memberFilter === m.uid) + '">' +
          avatar +
          '<span class="app-tp-member-copy">' +
            '<span class="app-tp-member-name">' + esc(m.isOwner ? m.displayName + " (you)" : m.displayName) +
              (stripe ? ' <span class="app-pay-chip ' + stripe.cls + '">' + esc(stripe.text) + "</span>" : "") +
            "</span>" +
            '<span class="app-tp-member-mode">' + esc(payoutModeLabel(m)) + "</span>" +
          "</span>" +
          '<span class="app-tp-figures">' +
            "<span><em>Collected</em><strong>" + usd(m.totals.grossCents) + "</strong></span>" +
            "<span><em>" + (m.isOwner ? "Studio" : "Kept") + "</em><strong>" +
              usd(m.isOwner ? studioNet : m.totals.memberCents) + "</strong></span>" +
            (m.isOwner ? "" : "<span><em>To studio</em><strong>" + usd(studioNet) + "</strong></span>") +
          "</span>" +
        "</button>"
      );
    }).join("");
    wrap.querySelectorAll("[data-member]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var uid = btn.getAttribute("data-member");
        state.memberFilter = state.memberFilter === uid ? "" : uid;
        $("tpMemberFilter").value = state.memberFilter;
        paintTeam();
        paintActivity();
      });
    });
  }

  function paintMemberFilter() {
    var select = $("tpMemberFilter");
    var members = (state.data && state.data.members) || [];
    select.innerHTML = '<option value="">Everyone</option>' + members.map(function (m) {
      return '<option value="' + esc(m.uid) + '">' + esc(m.isOwner ? m.displayName + " (you)" : m.displayName) + "</option>";
    }).join("");
    if (state.memberFilter && !memberByUid(state.memberFilter)) state.memberFilter = "";
    select.value = state.memberFilter;
  }

  function paintActivity() {
    var list = visibleEntries();
    var wrap = $("tpActivityList");
    setHidden("tpActivityEmpty", list.length > 0);
    setHidden("tpTruncated", !(state.data && state.data.truncated));
    $("tpExportBtn").disabled = !list.length;
    wrap.innerHTML = list.map(function (e) {
      var when = e.createdAtMs ? new Date(e.createdAtMs) : null;
      var status = studioStatus(e);
      var split = e.splitApplied
        ? usd(e.memberCents) + " kept · " + usd(e.studioCents) + " studio"
        : memberByUid(e.memberUid) && memberByUid(e.memberUid).isOwner
          ? "Studio payment"
          : "No split";
      return (
        '<div class="app-tp-row">' +
          '<span class="app-tp-row-date">' +
            esc(when ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—") +
          "</span>" +
          '<span class="app-tp-row-copy">' +
            "<strong>" + esc(memberName(e.memberUid)) + "</strong>" +
            "<span>" + esc(KIND_LABELS[e.paymentKind] || "Payment") + " · " + esc(split) + "</span>" +
          "</span>" +
          (status ? '<span class="app-pay-chip ' + status.cls + '">' + esc(status.text) + "</span>" : "<span></span>") +
          '<strong class="app-tp-row-amt">' + usd(e.grossCents) + "</strong>" +
        "</div>"
      );
    }).join("");
  }

  function paint() {
    paintPeriods();
    var hasData = !!state.data;
    setHidden("tpHero", !hasData);
    setHidden("tpTeamCard", !hasData);
    setHidden("tpActivityCard", !hasData);
    if (!hasData) return;
    paintHero();
    paintMemberFilter();
    paintTeam();
    paintActivity();
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function localDate(ms) {
    var d = new Date(ms);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fileSafe(name) {
    return String(name || "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  }

  /** "Cameron-Walsh_2026-10-01_to_2026-10-09.csv" for one member, the shop name for everyone. */
  function csvFilename() {
    var member = state.memberFilter ? memberByUid(state.memberFilter) : null;
    var who = member
      ? member.displayName
      : (state.session && state.session.shopName) || "Team";
    var range = state.data && state.data.fromMs
      ? "_" + localDate(state.data.fromMs) + "_to_" + localDate(state.data.toMs)
      : "_" + localDate(Date.now());
    return fileSafe(who) + range + ".csv";
  }

  function exportCsv() {
    var rows = [["Date", "Team member", "Type", "Collected", "Member kept", "Studio share", "Studio share refunded", "Split %", "Studio share status", "Payment ID"]];
    visibleEntries().forEach(function (e) {
      var status = studioStatus(e);
      rows.push([
        e.createdAtMs ? new Date(e.createdAtMs).toISOString().slice(0, 10) : "",
        memberName(e.memberUid),
        KIND_LABELS[e.paymentKind] || e.paymentKind,
        (e.grossCents / 100).toFixed(2),
        (e.memberCents / 100).toFixed(2),
        (e.studioCents / 100).toFixed(2),
        (e.studioReturnedCents / 100).toFixed(2),
        e.splitApplied ? e.splitPercentApplied : "",
        status ? status.text : "",
        e.id,
      ]);
    });
    var blob = new Blob([rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = csvFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function loadAll() {
    if (state.session && state.session.isOwner === false) {
      setHidden("tpBlocked", false);
      state.data = null;
      paint();
      return Promise.resolve();
    }
    setHidden("tpBlocked", true);
    showError("");
    state.loading = true;
    var requestId = ++state.requestId;
    var btn = $("tpRefresh");
    if (btn) btn.disabled = true;
    paintPeriods();
    return call("getTeamPayoutSummary", periodRange(state.period))
      .then(function (r) {
        if (requestId !== state.requestId) return;
        state.data = (r && r.data) || null;
      })
      .catch(function (err) {
        if (requestId !== state.requestId) return;
        if (err && err.code === "functions/permission-denied") setHidden("tpBlocked", false);
        else showError(errMessage(err));
      })
      .finally(function () {
        if (requestId !== state.requestId) return;
        state.loading = false;
        if (btn) btn.disabled = false;
        paint();
      });
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("tpRefresh").addEventListener("click", loadAll);
    document.querySelectorAll(".app-tp-periods button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = btn.getAttribute("data-period");
        if (!next || next === state.period) return;
        state.period = next;
        loadAll();
      });
    });
    $("tpMemberFilter").addEventListener("change", function () {
      state.memberFilter = $("tpMemberFilter").value || "";
      paintTeam();
      paintActivity();
    });
    $("tpExportBtn").addEventListener("click", exportCsv);
  }

  function load(session) {
    if (session) state.session = session;
    wire();
    return loadAll();
  }

  global.ShopAppPayouts = { load: load };
})(window);
