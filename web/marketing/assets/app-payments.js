/**
 * Shop Client payments: Stripe Connect status, balance, withdraw, activity.
 * Same Cloud Functions as iPhone PaymentsViewModel. Tap to Pay stays on iOS.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var TX_PAGE = 40;
  var TX_MAX = 100;
  var state = {
    session: null,
    wired: false,
    loading: false,
    loadingMore: false,
    savingDescriptor: false,
    status: null,
    balance: null,
    transactions: [],
    txLimit: TX_PAGE,
    filter: "all",
    query: "",
    detail: null,
  };

  var ICON_IN =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v8.5M4.5 8.5 8 12l3.5-3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_REFUND =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 6H3.2A6.2 6.2 0 1 0 8 2.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M5 3.2 5 6.8 8.2 6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_PAYOUT =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3.5M4.5 7.5 8 4l3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function $(id) {
    return document.getElementById(id);
  }

  function fns() {
    return firebase.app().functions(REGION);
  }

  function call(name, payload) {
    return fns().httpsCallable(name)(payload || {});
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatUSD(n) {
    var x = Number(n);
    if (!isFinite(x)) x = 0;
    return x.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function centsToUsd(cents) {
    return (Number(cents) || 0) / 100;
  }

  function parseAmount(raw) {
    var n = parseFloat(String(raw || "").replace(/[^0-9.]/g, ""));
    return isFinite(n) ? n : null;
  }

  function errMessage(err) {
    if (!err) return "Something went wrong.";
    return err.message || String(err);
  }

  function showError(text) {
    var el = $("payError");
    if (!el) return;
    if (!text) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function setHidden(id, hidden) {
    var el = $(id);
    if (el) el.classList.toggle("hidden", !!hidden);
  }

  function origin() {
    return window.location.origin.replace(/\/$/, "");
  }

  function isFeeRefund(tx) {
    var desc = String(tx.description || "").toLowerCase();
    if (desc.indexOf("application fee refund") !== -1) return true;
    var cat = String(tx.reportingCategory || "").toLowerCase();
    return tx.type === "adjustment" && tx.isCredit && cat === "fee";
  }

  function isPayout(tx) {
    return (
      tx.type === "payout" ||
      String(tx.reportingCategory || "").toLowerCase() === "payout"
    );
  }

  function isRefund(tx) {
    var desc = String(tx.description || "").toLowerCase();
    if (tx.type === "refund" || String(tx.reportingCategory || "").toLowerCase() === "refund") {
      return true;
    }
    return !tx.isCredit && desc.indexOf("refund") !== -1;
  }

  function isStudioShare(tx) {
    var desc = String(tx.description || "").toLowerCase();
    return tx.type === "studio_share" || desc.indexOf("studio share") !== -1;
  }

  /** Card payments with a charge open the details + refund sheet. */
  function canOpenDetail(tx) {
    return txKind(tx) === "payment" && !!tx.chargeId && !isFeeRefund(tx) && !isStudioShare(tx);
  }

  function txKind(tx) {
    if (isPayout(tx)) return "payout";
    if (isRefund(tx)) return "refund";
    return "payment";
  }

  function channelLabel(tx) {
    var desc = String(tx.description || "").toLowerCase();
    if (isStudioShare(tx)) return "Studio share";
    if (isRefund(tx)) return tx.status === "pending" ? "Refund pending" : "Refund";
    if (desc.indexOf("deposit") !== -1) return "Deposit";
    if (desc.indexOf("tap to pay") !== -1 || desc.indexOf("terminal") !== -1) {
      return "Tap to Pay on iPhone";
    }
    if (isPayout(tx)) return "Payout";
    if (tx.type === "charge" || tx.type === "payment") return "Payment";
    return tx.type ? String(tx.type).replace(/_/g, " ") : "Activity";
  }

  function txTitle(tx) {
    var name = String(tx.description || "").trim();
    if (isStudioShare(tx)) return "Studio share";
    if (isRefund(tx) && (!name || name.toLowerCase() === "refund")) return "Refund";
    if (name && name.toLowerCase() !== "payment" && name.toLowerCase().indexOf("application fee") === -1) {
      return name;
    }
    if (isPayout(tx)) {
      var dest =
        (state.balance && state.balance.standardPayoutDestinationLabel) || "";
      return dest ? "Payout to " + dest : "Payout";
    }
    return channelLabel(tx);
  }

  function txCreated(tx) {
    var sec = Number(tx.created) || 0;
    return sec > 0 ? new Date(sec * 1000) : null;
  }

  function txTimeLabel(d) {
    if (!d) return "";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function txSubtitle(tx) {
    var d = txCreated(tx);
    var time = txTimeLabel(d);
    var channel = channelLabel(tx);
    if (isStudioShare(tx) && tx.attributedMemberName) {
      var party = tx.isCredit
        ? "From " + tx.attributedMemberName
        : "To studio";
      return time ? party + " · " + time : party;
    }
    return time ? channel + " · " + time : channel;
  }

  function txAmountUsd(tx) {
    var net = tx.net != null ? Number(tx.net) : Number(tx.amount) || 0;
    return Math.abs(net) / 100;
  }

  function txFeeUsd(tx) {
    return Math.abs(Number(tx.fee) || 0) / 100;
  }

  function txSignedUsd(tx) {
    var n = txAmountUsd(tx);
    return tx.isCredit ? n : -n;
  }

  function txStatusLabel(tx) {
    var status = String(tx.status || "").toLowerCase();
    if (status === "pending" && isRefund(tx)) return "Pending";
    if (status === "pending" && !isPayout(tx) && !isRefund(tx)) return "Pending";
    if (isRefund(tx) && status !== "pending") return "Refunded";
    if (isPayout(tx) && (status === "pending" || status === "in_transit")) {
      return "In transit";
    }
    return "";
  }

  function txChipClass(label) {
    if (label === "Pending") return "is-pending";
    if (label === "Refunded") return "is-refunded";
    if (label === "In transit") return "is-transit";
    return "";
  }

  function feedTransactions() {
    return (state.transactions || []).filter(function (tx) {
      return !isFeeRefund(tx);
    });
  }

  function visibleTransactions() {
    var q = String(state.query || "")
      .trim()
      .toLowerCase();
    return feedTransactions().filter(function (tx) {
      var kind = txKind(tx);
      if (state.filter === "payments" && kind !== "payment") return false;
      if (state.filter === "refunds" && kind !== "refund") return false;
      if (state.filter === "payouts" && kind !== "payout") return false;
      if (!q) return true;
      var hay = [
        txTitle(tx),
        channelLabel(tx),
        tx.description,
        tx.chargeId,
        tx.type,
      ]
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function dayKey(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function dayHeading(d) {
    var now = new Date();
    var monthDay = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diff = Math.round((today - that) / 86400000);
    if (diff === 0) return "Today · " + monthDay;
    if (diff === 1) return "Yesterday · " + monthDay;
    return monthDay;
  }

  function monthEarnings(list) {
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
    var sum = 0;
    (list || []).forEach(function (tx) {
      if (isFeeRefund(tx) || !tx.isCredit) return;
      if ((Number(tx.created) || 0) < start) return;
      sum += txAmountUsd(tx);
    });
    return sum;
  }

  function availableUsd() {
    var b = state.balance || {};
    return Math.max(0, centsToUsd(b.availableCents));
  }

  function canEditDescriptor() {
    var s = state.status || {};
    if (s.canTakePayments === false || !s.chargesEnabled) return false;
    if (s.demoShowcase) return false;
    if (s.paymentScope === "user") return !!s.usesOwnPayments;
    return !!(state.session && state.session.isOwner);
  }

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvFilename() {
    var tenant = (state.session && state.session.tenant) || {};
    var raw = tenant.slug || (state.session && state.session.shopName) || "shop";
    var slug = String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    var d = new Date();
    var stamp =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    return (slug || "shop") + "-payments-" + stamp + ".csv";
  }

  function paintStatus() {
    var status = state.status || {};
    var canTake = status.canTakePayments !== false;
    var charges = !!status.chargesEnabled;
    var hasAccount = !!status.hasAccount;
    var submitted = !!status.detailsSubmitted;

    setHidden("payBlocked", canTake);
    setHidden("paySetup", !canTake || charges);
    setHidden("payHero", !canTake || !charges);
    setHidden("payMoreBtn", !canTake);
    setHidden("payTakeBtn", !canTake || !charges);

    if (!canTake) {
      closeMore();
      $("payBlockedMsg").textContent =
        "This account can’t take client payments. Team payouts stay with the shop owner.";
      $("payTxEmpty").textContent = "No payment activity on this login.";
      return;
    }

    var btn = $("payConnectBtn");
    var copy = $("paySetupCopy");
    if (!charges) {
      if (hasAccount && submitted) {
        copy.textContent =
          "Stripe is reviewing your account. Status updates here when charges are enabled.";
        btn.textContent = "Check Stripe status";
      } else if (hasAccount) {
        copy.textContent = "Finish Stripe setup to accept deposits and payment links.";
        btn.textContent = "Continue Stripe setup";
      } else {
        copy.textContent =
          "Set up Stripe to accept deposits, payment links, and in-person charges.";
        btn.textContent = "Set up Stripe";
      }
    }
  }

  function paintBalance() {
    var b = state.balance || {};
    var available = centsToUsd(b.availableCents);
    var pending = centsToUsd(b.pendingCents);
    var total = available + pending;
    var month = monthEarnings(state.transactions);
    $("payTotal").textContent = formatUSD(total);
    $("payAvailable").textContent = formatUSD(available);
    $("payPending").textContent = formatUSD(pending);
    $("payMonth").textContent = "+" + formatUSD(month);
    var dest = b.standardPayoutDestinationLabel
      ? " · " + b.standardPayoutDestinationLabel
      : "";
    $("paySub").textContent =
      "Available to pay out " +
      formatUSD(available) +
      " · Available soon " +
      formatUSD(pending) +
      dest;
  }

  function paintFilters() {
    document.querySelectorAll(".app-pay-filters button").forEach(function (btn) {
      btn.classList.toggle("is-on", btn.getAttribute("data-filter") === state.filter);
    });
  }

  function iconFor(kind) {
    if (kind === "refund") {
      return '<span class="app-pay-tx-icon is-refund">' + ICON_REFUND + "</span>";
    }
    if (kind === "payout") {
      return '<span class="app-pay-tx-icon is-payout">' + ICON_PAYOUT + "</span>";
    }
    return '<span class="app-pay-tx-icon is-in">' + ICON_IN + "</span>";
  }

  function paintTransactions() {
    var loaded = feedTransactions();
    var list = visibleTransactions();
    var wrap = $("payTxList");
    var empty = $("payTxEmpty");
    var foot = $("payTxFoot");
    wrap.innerHTML = "";
    paintFilters();

    if (!list.length) {
      empty.classList.remove("hidden");
      if (loaded.length && (state.query || state.filter !== "all")) {
        empty.textContent = "No matching activity.";
      } else if (state.status && state.status.chargesEnabled) {
        empty.textContent = "No charges yet this period.";
      } else {
        empty.textContent =
          "Charges and payouts will show here after Stripe is connected.";
      }
      setHidden("payTxFoot", true);
      return;
    }

    empty.classList.add("hidden");
    setHidden("payTxFoot", false);
    $("payTxCount").textContent =
      "Showing " + list.length + " of " + loaded.length + " transactions";

    var groups = [];
    var byKey = {};
    list.forEach(function (tx) {
      var d = txCreated(tx) || new Date(0);
      var key = dayKey(d);
      if (!byKey[key]) {
        byKey[key] = { key: key, date: d, rows: [] };
        groups.push(byKey[key]);
      }
      byKey[key].rows.push(tx);
    });

    groups.forEach(function (group) {
      var net = 0;
      group.rows.forEach(function (tx) {
        net += txSignedUsd(tx);
      });
      var head = document.createElement("div");
      head.className = "app-pay-day";
      head.innerHTML =
        "<strong>" +
        esc(dayHeading(group.date)) +
        "</strong><span>" +
        group.rows.length +
        " · net " +
        (net >= 0 ? "+" : "−") +
        formatUSD(Math.abs(net)) +
        "</span>";
      wrap.appendChild(head);
      group.rows.forEach(function (tx) {
        var kind = txKind(tx);
        var chip = txStatusLabel(tx);
        var fee = txFeeUsd(tx);
        var opensDetail = canOpenDetail(tx);
        var row = document.createElement(opensDetail ? "button" : "div");
        row.className = "app-pay-tx" + (opensDetail ? " is-link" : "");
        if (opensDetail) {
          row.type = "button";
          row.addEventListener("click", function () { openDetail(tx); });
        }
        row.innerHTML =
          iconFor(kind) +
          '<div class="app-pay-tx-copy">' +
          '<div class="app-pay-tx-title">' +
          "<span>" +
          esc(txTitle(tx)) +
          "</span>" +
          (chip
            ? '<span class="app-pay-chip ' +
              txChipClass(chip) +
              '">' +
              esc(chip) +
              "</span>"
            : "") +
          "</div>" +
          '<span class="app-pay-tx-meta">' +
          esc(txSubtitle(tx)) +
          "</span>" +
          "</div>" +
          '<div class="app-pay-tx-money ' +
          (tx.isCredit ? "" : "is-debit") +
          '">' +
          "<strong>" +
          (tx.isCredit ? "+" : "−") +
          formatUSD(txAmountUsd(tx)) +
          "</strong>" +
          "<em>" +
          (fee > 0 ? "Fee " + formatUSD(fee) : "No fee") +
          "</em>" +
          "</div>";
        wrap.appendChild(row);
      });
    });

    var more = $("payLoadMore");
    if (more) {
      more.disabled = state.txLimit >= TX_MAX || loaded.length < state.txLimit;
    }
    var exportBtn = $("payExportBtn");
    if (exportBtn) exportBtn.disabled = !list.length;
  }

  function paint() {
    paintStatus();
    paintBalance();
    paintTransactions();
  }

  function loadTransactions(limit) {
    return call("getConnectBalanceTransactions", { limit: limit }).then(function (r) {
      var data = (r && r.data) || {};
      state.transactions = data.transactions || [];
      state.txLimit = limit;
    });
  }

  function setRefreshBusy(busy) {
    var btn = $("payRefresh");
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle("is-busy", !!busy);
  }

  function descriptorSheetOpen() {
    var sheet = $("payDescSheet");
    return !!(sheet && !sheet.classList.contains("hidden"));
  }

  function fillDescriptorFieldFromStatus() {
    if (!descriptorSheetOpen()) return;
    var s = state.status || {};
    var input = $("payDescInput");
    var err = $("payDescError");
    var ok = $("payDescOk");
    if (input && !state.savingDescriptor) {
      input.value = String(s.statementDescriptor || "").trim().toUpperCase();
    }
    if (err) {
      err.classList.add("hidden");
      err.textContent = "";
    }
    if (ok) ok.classList.add("hidden");
  }

  /** Last loaded numbers for this shop, kept for this browser tab so the page paints instantly. */
  function cacheKey() {
    var t = state.session && state.session.tenantId;
    return t ? "bkPayments:" + t : "";
  }

  function saveCache() {
    var key = cacheKey();
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({ status: state.status, balance: state.balance, transactions: state.transactions }));
    } catch (e) {}
  }

  function restoreCache() {
    var key = cacheKey();
    if (!key || state.status) return;
    try {
      var c = JSON.parse(sessionStorage.getItem(key) || "null");
      if (c && c.status) {
        state.status = c.status;
        state.balance = c.balance || null;
        state.transactions = c.transactions || [];
        paint();
      }
    } catch (e) {}
  }

  function loadAll() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    showError("");
    setRefreshBusy(true);
    state.txLimit = TX_PAGE;
    // All three at once; balance and activity are only used when the shop can take payments.
    var status = call("getConnectAccountStatus", { skipEmailReconcile: true });
    var balance = call("getConnectBalance").then(function (r) { return (r && r.data) || {}; });
    var tx = call("getConnectBalanceTransactions", { limit: TX_PAGE }).then(function (r) {
      return ((r && r.data) || {}).transactions || [];
    });
    balance.catch(function () {});
    tx.catch(function () {});
    return status
      .then(function (res) {
        state.status = (res && res.data) || {};
        paintStatus();
        fillDescriptorFieldFromStatus();
        if (state.status.canTakePayments === false) {
          state.balance = null;
          state.transactions = [];
          paint();
          saveCache();
          return;
        }
        return Promise.all([balance, tx]).then(function (out) {
          state.balance = out[0];
          state.transactions = out[1];
          state.txLimit = TX_PAGE;
          paint();
          saveCache();
        });
      })
      .catch(function (err) {
        showError(errMessage(err));
        paint();
      })
      .finally(function () {
        state.loading = false;
        setRefreshBusy(false);
      });
  }

  function loadMore() {
    if (state.loadingMore || state.txLimit >= TX_MAX) return;
    var next = TX_MAX;
    state.loadingMore = true;
    $("payLoadMore").disabled = true;
    loadTransactions(next)
      .then(paint)
      .catch(function (err) {
        showError(errMessage(err));
      })
      .finally(function () {
        state.loadingMore = false;
        paintTransactions();
      });
  }

  function exportCsv() {
    var rows = visibleTransactions();
    if (!rows.length) return;
    var lines = [
      [
        "Date",
        "Type",
        "Description",
        "Amount",
        "Fee",
        "Net",
        "Status",
        "Charge ID",
      ].join(","),
    ];
    rows.forEach(function (tx) {
      var d = txCreated(tx);
      var iso = d
        ? d.getFullYear() +
          "-" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getDate()).padStart(2, "0") +
          " " +
          d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : "";
      var kind = txKind(tx);
      var typeLabel =
        kind === "refund"
          ? "Refund"
          : kind === "payout"
            ? "Payout"
            : isStudioShare(tx)
              ? "Studio share"
              : "Payment";
      var net = txSignedUsd(tx);
      var gross = Math.abs(Number(tx.amount) || Number(tx.net) || 0) / 100;
      if (!tx.isCredit) gross = -gross;
      var fee = txFeeUsd(tx);
      lines.push(
        [
          csvCell(iso),
          csvCell(typeLabel),
          csvCell(txTitle(tx)),
          csvCell(gross.toFixed(2)),
          csvCell(fee.toFixed(2)),
          csvCell(net.toFixed(2)),
          csvCell(txStatusLabel(tx) || channelLabel(tx)),
          csvCell(tx.chargeId || ""),
        ].join(",")
      );
    });
    var blob = new Blob(["\uFEFF" + lines.join("\n") + "\n"], {
      type: "text/csv;charset=utf-8",
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = csvFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function closeMore() {
    var menu = $("payMoreMenu");
    var btn = $("payMoreBtn");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function toggleMore(ev) {
    if (ev) ev.stopPropagation();
    var menu = $("payMoreMenu");
    var btn = $("payMoreBtn");
    if (!menu || !btn) return;
    var open = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function sanitizeDescriptor(raw) {
    return String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z0-9. ]/g, "")
      .replace(/\s+/g, " ");
  }

  function openDescriptor() {
    closeMore();
    var s = state.status || {};
    var input = $("payDescInput");
    var err = $("payDescError");
    var ok = $("payDescOk");
    var save = $("payDescSave");
    err.classList.add("hidden");
    ok.classList.add("hidden");
    input.value = String(s.statementDescriptor || "").trim().toUpperCase();
    var editable = canEditDescriptor();
    input.disabled = !editable;
    save.disabled = !editable;
    if (!s.chargesEnabled) {
      $("payDescHint").textContent =
        "Finish Stripe setup before setting a statement descriptor.";
    } else if (s.demoShowcase) {
      $("payDescHint").textContent = "Payment settings aren’t saved in demo mode.";
    } else if (!editable) {
      $("payDescHint").textContent =
        "Only the shop owner can edit the statement descriptor.";
    } else {
      $("payDescHint").textContent =
        "Shows on your customer’s bank or card statement. This is not the Tap to Pay screen name.";
    }
    setHidden("payDescScrim", false);
    setHidden("payDescSheet", false);
    if (editable) input.focus();
  }

  function closeDescriptor() {
    setHidden("payDescScrim", true);
    setHidden("payDescSheet", true);
  }

  function saveDescriptor() {
    var err = $("payDescError");
    var ok = $("payDescOk");
    err.classList.add("hidden");
    ok.classList.add("hidden");
    if (!canEditDescriptor()) {
      err.textContent = "You don’t have permission to edit the statement descriptor.";
      err.classList.remove("hidden");
      return;
    }
    var descriptor = sanitizeDescriptor($("payDescInput").value).trim();
    $("payDescInput").value = descriptor;
    if (descriptor.length < 5 || descriptor.length > 22) {
      err.textContent = "Statement descriptor must be 5–22 characters.";
      err.classList.remove("hidden");
      return;
    }
    var prefix = descriptor.slice(0, 10).trim();
    if (prefix.length < 2) {
      err.textContent = "Statement descriptor must be at least 5 characters.";
      err.classList.remove("hidden");
      return;
    }
    var save = $("payDescSave");
    save.disabled = true;
    state.savingDescriptor = true;
    call("updateStatementDescriptor", {
      statementDescriptor: descriptor,
      statementDescriptorPrefix: prefix,
    })
      .then(function (res) {
        var data = (res && res.data) || {};
        state.status = state.status || {};
        if (data.statementDescriptor) {
          state.status.statementDescriptor = data.statementDescriptor;
        }
        if (data.statementDescriptorPrefix) {
          state.status.statementDescriptorPrefix = data.statementDescriptorPrefix;
        }
        $("payDescInput").value = String(
          data.statementDescriptor || descriptor
        ).toUpperCase();
        ok.textContent = data.prefixOnly
          ? "Saved card prefix. The full bank line stays in Stripe dashboard."
          : "Saved — new charges will use this on bank/card statements.";
        ok.classList.remove("hidden");
      })
      .catch(function (e) {
        err.textContent = errMessage(e);
        err.classList.remove("hidden");
      })
      .finally(function () {
        state.savingDescriptor = false;
        save.disabled = !canEditDescriptor();
      });
  }

  function openConnect() {
    var btn = $("payConnectBtn");
    btn.disabled = true;
    showError("");
    var base = origin();
    return call("createConnectAccountLink", {
      returnBaseUrl: base,
      returnUrl: base + "/app/payments?stripe=success",
      refreshUrl: base + "/app/payments?stripe=refresh",
    })
      .then(function (res) {
        var data = (res && res.data) || {};
        if (data.alreadyConnected) {
          return openDashboard().then(loadAll);
        }
        if (data.pendingReview) {
          return loadAll();
        }
        if (data.url) {
          window.location.href = data.url;
          return;
        }
        throw new Error("Could not start Stripe Connect setup.");
      })
      .catch(function (err) {
        showError(errMessage(err));
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  function openDashboard() {
    var btn = $("payDashboardBtn");
    var label = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Opening…";
    }
    showError("");
    // Open the tab right away (browsers block tabs opened after a wait) and show a loading screen
    // until Stripe's sign-in link is ready.
    var win = window.open("", "_blank");
    if (win) {
      try {
        win.document.title = "Opening Stripe…";
        win.document.body.innerHTML =
          '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;color:#3b2a1f;gap:16px">' +
          '<div style="width:28px;height:28px;border:3px solid #e8dfd3;border-top-color:#A3752F;border-radius:50%;animation:s 0.8s linear infinite"></div>' +
          "<p style=\"margin:0;font-size:16px\">Loading your Stripe dashboard…</p>" +
          "<style>@keyframes s{to{transform:rotate(360deg)}}</style></div>";
      } catch (e) {}
    }
    return call("createExpressDashboardLink")
      .then(function (res) {
        var data = (res && res.data) || {};
        if (!data.url) throw new Error("Could not open Stripe dashboard.");
        if (win && !win.closed) {
          try { win.opener = null; } catch (e) {}
          win.location.href = data.url;
        } else {
          window.open(data.url, "_blank", "noopener,noreferrer");
        }
      })
      .catch(function (err) {
        if (win && !win.closed) win.close();
        showError(errMessage(err));
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
  }

  function openWithdraw() {
    var avail = availableUsd();
    $("payWithdrawHint").textContent =
      "Available to pay out " +
      formatUSD(avail) +
      (state.balance && state.balance.standardPayoutDestinationLabel
        ? " · " + state.balance.standardPayoutDestinationLabel
        : "");
    $("payWithdrawAmt").value = avail > 0 ? avail.toFixed(2) : "";
    $("payWithdrawError").classList.add("hidden");
    var instant = !!(state.balance && state.balance.instantPayoutEligible);
    setHidden("payInstantRow", !instant);
    var instLabel = $("payInstantLabel");
    if (instLabel) {
      instLabel.textContent =
        state.balance && state.balance.instantPayoutDestinationLabel
          ? "Instant · " + state.balance.instantPayoutDestinationLabel
          : "Instant";
    }
    var standard = document.querySelector('input[name="payMethod"][value="standard"]');
    if (standard) standard.checked = true;
    setHidden("payWithdrawScrim", false);
    setHidden("payWithdrawSheet", false);
    $("payWithdrawAmt").focus();
  }

  function closeWithdraw() {
    setHidden("payWithdrawScrim", true);
    setHidden("payWithdrawSheet", true);
  }

  function submitWithdraw() {
    var err = $("payWithdrawError");
    err.classList.add("hidden");
    var amount = parseAmount($("payWithdrawAmt").value);
    if (amount == null || amount < 0.5) {
      err.textContent = "Enter at least $0.50.";
      err.classList.remove("hidden");
      return;
    }
    var cents = Math.round(amount * 100);
    var availCents = Math.round(availableUsd() * 100);
    if (cents > availCents) {
      err.textContent = "That’s more than your available balance.";
      err.classList.remove("hidden");
      return;
    }
    var methodEl = document.querySelector('input[name="payMethod"]:checked');
    var method = methodEl && methodEl.value === "instant" ? "instant" : "standard";
    var save = $("payWithdrawSave");
    save.disabled = true;
    call("createPayout", { amountCents: cents, method: method })
      .then(function () {
        closeWithdraw();
        return loadAll();
      })
      .catch(function (e) {
        err.textContent = errMessage(e);
        err.classList.remove("hidden");
      })
      .finally(function () {
        save.disabled = false;
      });
  }

  function detailRow(label, value) {
    if (!value) return "";
    return "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>";
  }

  function newIdempotencyKey(chargeId) {
    var rand = "";
    try {
      rand = global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : "";
    } catch (e) {}
    return "web_refund_" + chargeId + "_" + (rand || Date.now() + "_" + Math.random().toString(36).slice(2));
  }

  function paintDetail() {
    var d = state.detail;
    if (!d) return;
    var tx = d.tx;
    var receipt = d.receipt || {};
    var refund = d.refund || {};
    $("payDetailAmount").textContent = formatUSD(txAmountUsd(tx));
    var when = txCreated(tx);
    $("payDetailWhen").textContent = when
      ? when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : "";

    var refundedCents = refund.amountRefundedCents || 0;
    var remainingCents = refund.remainingRefundableCents;
    var chip = $("payDetailChip");
    var chipText = "";
    if (refundedCents > 0) {
      chipText = remainingCents > 0 ? "Partly refunded" : "Refunded";
    } else {
      chipText = txStatusLabel(tx);
    }
    chip.textContent = chipText;
    chip.className = "app-pay-chip " + (refundedCents > 0 ? "is-refunded" : txChipClass(chipText));
    setHidden("payDetailChip", !chipText);

    setHidden("payDetailLoading", !d.loading);
    var fee = txFeeUsd(tx);
    $("payDetailRows").innerHTML = d.loading
      ? ""
      : detailRow("Client", receipt.customerName || "") +
        detailRow("Email", receipt.customerEmail || "") +
        detailRow("For", receipt.serviceLabel || "") +
        detailRow("Receipt", receipt.receiptNumber ? "#" + receipt.receiptNumber : "") +
        detailRow("Stripe fee", fee > 0 ? formatUSD(fee) : "") +
        detailRow("You received", formatUSD(txAmountUsd(tx) - fee)) +
        detailRow("Refunded", refundedCents > 0 ? formatUSD(refundedCents / 100) : "");

    var lines = receipt.lineItems || [];
    var linesEl = $("payDetailLines");
    if (!d.loading && lines.length > 1) {
      linesEl.innerHTML = lines
        .map(function (item) {
          return "<div><span>" + esc(item.name || "") + "</span><span>" + formatUSD((item.amountCents || 0) / 100) + "</span></div>";
        })
        .join("") +
        "<div class=\"is-total\"><span>Total</span><span>" + formatUSD((receipt.totalPaidCents || 0) / 100) + "</span></div>";
      setHidden("payDetailLines", false);
    } else {
      setHidden("payDetailLines", true);
    }

    var receiptLink = $("payDetailReceipt");
    if (receipt.stripeReceiptUrl) receiptLink.href = receipt.stripeReceiptUrl;
    setHidden("payDetailReceipt", d.loading || !receipt.stripeReceiptUrl);

    var canRefund = !d.loading && !refund.refundBlocked && remainingCents > 0;
    setHidden("payDetailRefundBtn", !canRefund || d.refundOpen);
    var err = $("payDetailError");
    if (!d.loading && refund.refundBlocked && refund.refundBlockedReason) {
      err.textContent = refund.refundBlockedReason;
      err.classList.remove("hidden");
    } else if (d.error) {
      err.textContent = d.error;
      err.classList.remove("hidden");
    } else {
      err.classList.add("hidden");
    }
    setHidden("payRefundPanel", !d.refundOpen);
  }

  function openDetail(tx) {
    state.detail = { tx: tx, loading: true, receipt: null, refund: null, refundOpen: false, error: "" };
    setHidden("payRefundPanel", true);
    setHidden("payDetailScrim", false);
    setHidden("payDetailSheet", false);
    paintDetail();
    loadDetail(state.detail);
  }

  function loadDetail(detail) {
    var chargeId = detail.tx.chargeId;
    return Promise.all([
      call("getPaymentReceiptDetail", { chargeId: chargeId }).then(function (r) { return (r && r.data) || {}; }, function () { return {}; }),
      call("getChargeRefundStatus", { chargeId: chargeId }).then(function (r) { return (r && r.data) || {}; })
    ])
      .then(function (results) {
        detail.receipt = results[0];
        detail.refund = results[1];
      })
      .catch(function (err) {
        detail.error = errMessage(err);
      })
      .finally(function () {
        detail.loading = false;
        // Ignore results for a sheet that was closed or replaced meanwhile.
        if (state.detail === detail) paintDetail();
      });
  }

  function closeDetail() {
    if (state.detail && state.detail.refunding) return;
    state.detail = null;
    setHidden("payDetailScrim", true);
    setHidden("payDetailSheet", true);
  }

  function openRefund() {
    var d = state.detail;
    if (!d || !d.refund) return;
    var remaining = (d.refund.remainingRefundableCents || 0) / 100;
    d.refundOpen = true;
    d.idempotencyKey = newIdempotencyKey(d.tx.chargeId);
    $("payRefundHint").textContent = "Up to " + formatUSD(remaining) + " can be refunded.";
    $("payRefundAmt").value = remaining.toFixed(2);
    $("payRefundReason").value = "requested_by_customer";
    $("payRefundError").classList.add("hidden");
    paintRefundButton();
    paintDetail();
    $("payRefundAmt").focus();
  }

  function closeRefund() {
    if (!state.detail || state.detail.refunding) return;
    state.detail.refundOpen = false;
    paintDetail();
  }

  function paintRefundButton() {
    var amount = parseAmount($("payRefundAmt").value);
    $("payRefundSubmit").textContent = amount != null && amount > 0 ? "Refund " + formatUSD(amount) : "Refund";
  }

  function submitRefund() {
    var d = state.detail;
    if (!d || d.refunding) return;
    var err = $("payRefundError");
    err.classList.add("hidden");
    var amount = parseAmount($("payRefundAmt").value);
    var cents = amount == null ? 0 : Math.round(amount * 100);
    var remainingCents = d.refund.remainingRefundableCents || 0;
    if (cents < 50) {
      err.textContent = "Enter at least $0.50.";
      err.classList.remove("hidden");
      return;
    }
    if (cents > remainingCents) {
      err.textContent = "That’s more than the " + formatUSD(remainingCents / 100) + " left on this payment.";
      err.classList.remove("hidden");
      return;
    }
    if (!global.confirm("Refund " + formatUSD(cents / 100) + " to the client? This can’t be undone.")) return;
    var btn = $("payRefundSubmit");
    d.refunding = true;
    btn.disabled = true;
    btn.textContent = "Refunding…";
    var params = {
      chargeId: d.tx.chargeId,
      reason: $("payRefundReason").value || "requested_by_customer",
      idempotencyKey: d.idempotencyKey
    };
    // Omit the amount for a full refund so the server refunds whatever remains.
    if (cents < remainingCents) params.amountCents = cents;
    call("createRefund", params)
      .then(function () {
        d.refunding = false;
        d.refundOpen = false;
        d.loading = true;
        paintDetail();
        loadDetail(d);
        return loadAll();
      })
      .catch(function (e) {
        d.refunding = false;
        err.textContent = errMessage(e);
        err.classList.remove("hidden");
      })
      .finally(function () {
        btn.disabled = false;
        paintRefundButton();
      });
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("payRefresh").addEventListener("click", loadAll);
    $("payMoreBtn").addEventListener("click", toggleMore);
    $("payDescriptorBtn").addEventListener("click", openDescriptor);
    $("payConnectBtn").addEventListener("click", openConnect);
    $("payDashboardBtn").addEventListener("click", openDashboard);
    $("payWithdrawBtn").addEventListener("click", openWithdraw);
    $("payWithdrawClose").addEventListener("click", closeWithdraw);
    $("payWithdrawCancel").addEventListener("click", closeWithdraw);
    $("payWithdrawScrim").addEventListener("click", closeWithdraw);
    $("payWithdrawSave").addEventListener("click", submitWithdraw);
    $("payWithdrawAmt").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitWithdraw();
      }
    });
    $("payTxSearch").addEventListener("input", function () {
      state.query = $("payTxSearch").value || "";
      paintTransactions();
    });
    document.querySelectorAll(".app-pay-filters button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.getAttribute("data-filter") || "all";
        paintTransactions();
      });
    });
    $("payExportBtn").addEventListener("click", exportCsv);
    $("payLoadMore").addEventListener("click", loadMore);
    $("payDetailClose").addEventListener("click", closeDetail);
    $("payDetailScrim").addEventListener("click", closeDetail);
    $("payDetailRefundBtn").addEventListener("click", openRefund);
    $("payRefundCancel").addEventListener("click", closeRefund);
    $("payRefundSubmit").addEventListener("click", submitRefund);
    $("payRefundAmt").addEventListener("input", paintRefundButton);
    $("payRefundAmt").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitRefund();
      }
    });
    $("payDescClose").addEventListener("click", closeDescriptor);
    $("payDescCancel").addEventListener("click", closeDescriptor);
    $("payDescScrim").addEventListener("click", closeDescriptor);
    $("payDescSave").addEventListener("click", saveDescriptor);
    $("payDescInput").addEventListener("input", function () {
      var el = $("payDescInput");
      var next = sanitizeDescriptor(el.value);
      if (el.value !== next) el.value = next;
    });
    $("payDescInput").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        saveDescriptor();
      }
    });
    document.addEventListener("click", function (ev) {
      var more = document.querySelector(".app-pay-more");
      if (more && !more.contains(ev.target)) closeMore();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      closeMore();
      if (!$("payDescSheet").classList.contains("hidden")) closeDescriptor();
      if (!$("payDetailSheet").classList.contains("hidden")) closeDetail();
    });
  }

  /* ── Take a payment: card right here (same server function as the iPhone app's manual card
     entry), or a pay link to copy or text. ── */

  var take = { wired: false, busy: false, tab: "card", url: "", urlKey: "", intent: null, intentKey: "", stripe: null, stripeKey: "", card: null };

  function canTextLinks() {
    var s = state.session || {};
    return !!(s.access && s.access.canSendClientSms);
  }

  function takeE164(raw) {
    var d = String(raw || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10 ? "+1" + d : "";
  }

  function money2(cents) {
    return "$" + (Math.round(cents) / 100).toFixed(2);
  }

  function takeErr(text) {
    var el = $("payTakeError");
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  }

  function setTakeOpen(open) {
    setHidden("payTakeScrim", !open);
    setHidden("payTakeSheet", !open);
    if (!open) return;
    closeMore();
    resetTake();
    $("payTakeAmt").focus();
  }

  function takeValues() {
    var amt = parseFloat(String($("payTakeAmt").value || "").replace(/[$,\s]/g, ""));
    return {
      cents: isFinite(amt) ? Math.round(amt * 100) : 0,
      what: $("payTakeFor").value.trim(),
      name: $("payTakeName").value.trim(),
      phone: $("payTakePhone").value.trim(),
    };
  }

  function clearIntent() {
    take.intent = null;
    take.intentKey = "";
    setHidden("payTakeSummary", true);
    setHidden("payTakeCardBox", true);
    setHidden("payTakeCharge", true);
    setHidden("payTakeContinue", false);
    if (take.card) {
      try { take.card.unmount(); } catch (e) {}
    }
  }

  function resetTake() {
    ["payTakeAmt", "payTakeFor", "payTakeName", "payTakePhone"].forEach(function (id) { $(id).value = ""; });
    take.url = "";
    take.urlKey = "";
    clearIntent();
    takeErr("");
    setHidden("payTakeCardNote", true);
    setHidden("payTakeForm", false);
    setHidden("payTakeDone", true);
    setHidden("payTakeText", !canTextLinks());
    setTakeTab("card");
  }

  function setTakeTab(tab) {
    take.tab = tab;
    $("payTakeTabCard").classList.toggle("is-on", tab === "card");
    $("payTakeTabLink").classList.toggle("is-on", tab === "link");
    $("payTakeTabCard").setAttribute("aria-selected", tab === "card" ? "true" : "false");
    $("payTakeTabLink").setAttribute("aria-selected", tab === "link" ? "true" : "false");
    setHidden("payTakeCardPane", tab !== "card");
    setHidden("payTakeLinkPane", tab !== "link");
    takeErr("");
  }

  function takeBusy(on, label) {
    take.busy = on;
    ["payTakeContinue", "payTakeCharge", "payTakeCopy", "payTakeText"].forEach(function (id) { $(id).disabled = on; });
    if (label) $(label[0]).textContent = label[1];
  }

  function loadStripeJs() {
    if (typeof global.Stripe === "function") return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tag = document.createElement("script");
      tag.src = "https://js.stripe.com/v3/";
      tag.onload = resolve;
      tag.onerror = function () { reject(new Error("Couldn't load Stripe. Check your connection and try again.")); };
      document.head.appendChild(tag);
    });
  }

  function summaryHtml(d) {
    var row = function (label, cents) { return "<div><span>" + label + "</span><span>" + money2(cents) + "</span></div>"; };
    return '<div class="app-take-sum">' +
      row("Amount", d.serviceCents) +
      (d.taxCents ? row("Sales tax", d.taxCents) : "") +
      (d.surchargeCents ? row("Card fee", d.surchargeCents) : "") +
      '<div class="is-total"><span>Total</span><span>' + money2(d.totalCents) + "</span></div></div>";
  }

  /** Step 1: get exact totals from the server and show Stripe's card field. */
  function continueToCard() {
    if (take.busy) return;
    var v = takeValues();
    if (v.cents < 50) return takeErr("Enter an amount of at least $0.50.");
    takeErr("");
    takeBusy(true, ["payTakeContinue", "Loading…"]);
    call("createPaymentIntentForManualCheckout", { serviceAmountCents: v.cents, paymentKind: "payment" })
      .then(function (res) {
        var d = (res && res.data) || {};
        if (!d.clientSecret || !d.publishableKey) throw new Error("Couldn't start the card payment.");
        // Stripe's live card field only loads on a secure (https) page.
        if (d.publishableKey.indexOf("pk_live") === 0 && location.protocol !== "https:") {
          var note = $("payTakeCardNote");
          note.textContent = "Card entry only works on the live site (getbookking.com). Use Send link here, or try it after deploy.";
          note.classList.remove("hidden");
          return;
        }
        return loadStripeJs().then(function () {
          var key = d.publishableKey + "|" + d.stripeAccountId;
          if (!take.stripe || take.stripeKey !== key) {
            take.stripe = global.Stripe(d.publishableKey, { stripeAccount: d.stripeAccountId });
            take.stripeKey = key;
            take.card = take.stripe.elements().create("card", {
              hidePostalCode: false,
              style: { base: { fontSize: "16px", color: "#2c2018", "::placeholder": { color: "#a39383" } } },
            });
          }
          take.intent = d;
          take.intentKey = String(v.cents);
          $("payTakeSummary").innerHTML = summaryHtml(d);
          setHidden("payTakeSummary", false);
          setHidden("payTakeCardBox", false);
          take.card.mount("#payTakeCardEl");
          setHidden("payTakeContinue", true);
          setHidden("payTakeCharge", false);
          $("payTakeCharge").textContent = "Charge " + money2(d.totalCents);
          setTimeout(function () { try { take.card.focus(); } catch (e) {} }, 50);
        });
      })
      .catch(function (err) { takeErr(errMessage(err)); })
      .then(function () { takeBusy(false, ["payTakeContinue", "Continue to card"]); });
  }

  /** Step 2: charge the card. */
  function chargeCard() {
    if (take.busy || !take.intent || !take.card) return;
    var v = takeValues();
    if (String(v.cents) !== take.intentKey) {
      clearIntent();
      return takeErr("The amount changed. Tap Continue to card again.");
    }
    takeErr("");
    var label = $("payTakeCharge").textContent;
    takeBusy(true, ["payTakeCharge", "Charging…"]);
    var billing = v.name ? { name: v.name } : undefined;
    var startedAt = Math.floor(Date.now() / 1000) - 120;
    take.stripe.confirmCardPayment(take.intent.clientSecret, {
      payment_method: { card: take.card, billing_details: billing },
    }).then(function (result) {
      if (result.error) throw new Error(result.error.message || "The card was declined.");
      var pi = result.paymentIntent || {};
      if (pi.status !== "succeeded" && pi.status !== "processing") throw new Error("The payment didn't go through.");
      var total = take.intent.totalCents;
      var pm = pi.payment_method && typeof pi.payment_method === "object" ? pi.payment_method.card : null;
      takeDone("Paid " + money2(total), [pm ? (cap(pm.brand) + " ending " + pm.last4) : "Card", v.what, v.name].filter(Boolean).join(" · "));
      take.intent = null;
      showReceiptFor(total, startedAt);
    }).catch(function (err) {
      takeErr(errMessage(err));
    }).then(function () {
      takeBusy(false, ["payTakeCharge", label]);
    });
  }

  /**
   * Right after a card charge: find the new payment in activity and open its receipt (the same
   * payment details sheet as tapping a payment, with Refund). Stripe can take a moment to list it.
   */
  function showReceiptFor(totalCents, sinceSec) {
    var tries = 0;
    $("payTakeDoneSub").textContent += " · Loading receipt…";
    function look() {
      tries += 1;
      return loadTransactions(TX_PAGE).then(function () {
        paint();
        saveCache();
        var hit = (state.transactions || []).filter(function (tx) {
          return tx.chargeId && txKind(tx) === "payment" && (Number(tx.created) || 0) >= sinceSec &&
            Math.abs(Number(tx.amount) || 0) === totalCents;
        }).sort(function (a, b) { return (Number(b.created) || 0) - (Number(a.created) || 0); })[0];
        if (hit) {
          setTakeOpen(false);
          openDetail(hit);
          return;
        }
        if (tries < 6) return new Promise(function (r) { setTimeout(r, 2000); }).then(look);
        var sub = $("payTakeDoneSub");
        sub.textContent = sub.textContent.replace(" · Loading receipt…", "") + " · The receipt will be in your activity in a moment.";
      }).catch(function () {});
    }
    look();
  }

  function cap(s) {
    s = String(s || "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  }

  /** Makes the pay link (once per amount, description and client). */
  function takeLink(v) {
    var key = v.cents + "|" + v.what + "|" + v.name;
    if (take.url && take.urlKey === key) return Promise.resolve(take.url);
    return call("createDepositLink", {
      serviceAmountCents: v.cents,
      paymentKind: "payment",
      productName: v.what || "Payment",
      productDescription: v.name || undefined,
    }).then(function (res) {
      var url = res && res.data && res.data.url;
      if (!url) throw new Error("Couldn't create the pay link.");
      take.url = url;
      take.urlKey = key;
      return url;
    });
  }

  function takeDone(title, sub, link) {
    $("payTakeDoneTitle").textContent = title;
    $("payTakeDoneSub").textContent = sub || "";
    $("payTakeLink").value = link || "";
    setHidden("payTakeLinkRow", !link);
    setHidden("payTakeReceipt", true);
    setHidden("payTakeForm", true);
    setHidden("payTakeDone", false);
  }

  function sendLink(mode) {
    if (take.busy) return;
    var v = takeValues();
    if (v.cents < 50) return takeErr("Enter an amount of at least $0.50.");
    var to = "";
    if (mode === "text") {
      to = takeE164(v.phone);
      if (!to) return takeErr("Enter the client's 10-digit phone number to text the link.");
    }
    takeErr("");
    takeBusy(true);
    var dollars = (v.cents / 100).toFixed(2);
    takeLink(v).then(function (url) {
      if (mode === "copy") {
        var done = function () { takeDone("Pay link copied", "Paste it anywhere to send it. It shows up here once paid.", url); };
        return (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(done, done);
      }
      return call("sendClientSms", {
        to: to,
        body: (v.what ? v.what + ": " : "Payment: ") + "$" + dollars + "\nPay here: " + url,
        clientName: v.name || undefined,
        threadId: to,
        paymentKind: "payment",
        amountCents: v.cents,
        paymentUrl: url,
        threadPreview: "Payment · $" + dollars,
      }).then(function () {
        takeDone("Pay link texted", (v.name ? "Sent to " + v.name + ". " : "") + "It shows up here once paid.", url);
      });
    }).catch(function (err) {
      takeErr(errMessage(err));
    }).then(function () { takeBusy(false); });
  }

  function wireTake() {
    if (take.wired || !$("payTakeBtn")) return;
    take.wired = true;
    $("payTakeBtn").addEventListener("click", function () { setTakeOpen(true); });
    ["payTakeClose", "payTakeScrim", "payTakeFinish"].forEach(function (id) {
      $(id).addEventListener("click", function () {
        if (take.busy) return;
        setTakeOpen(false);
        if (id === "payTakeFinish") loadAll();
      });
    });
    $("payTakeAgain").addEventListener("click", resetTake);
    $("payTakeTabCard").addEventListener("click", function () { setTakeTab("card"); });
    $("payTakeTabLink").addEventListener("click", function () { setTakeTab("link"); });
    $("payTakeContinue").addEventListener("click", continueToCard);
    $("payTakeCharge").addEventListener("click", chargeCard);
    $("payTakeCopy").addEventListener("click", function () { sendLink("copy"); });
    $("payTakeText").addEventListener("click", function () { sendLink("text"); });
    // A new amount needs fresh totals.
    $("payTakeAmt").addEventListener("input", function () { if (take.intent) clearIntent(); });
    $("payTakeAmt").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && take.tab === "card") (take.intent ? chargeCard : continueToCard)();
    });
    $("payTakeLink").addEventListener("focus", function () { this.select(); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("payTakeSheet").classList.contains("hidden") && !take.busy) setTakeOpen(false);
    });
  }

  /* ── Tax settings (owner only; same tenant fields as the iPhone app) ── */

  var taxWired = false;
  function setTaxOpen(open) {
    setHidden("payTaxScrim", !open);
    setHidden("payTaxSheet", !open);
    if (open) closeMore();
  }

  function loadTax() {
    var item = $("payTaxBtn");
    if (!item) return;
    var s = state.session;
    var owner = !!(s && s.isOwner && s.tenantId);
    item.classList.toggle("hidden", !owner);
    if (!owner) return;
    var ref = firebase.firestore().collection("tenants").doc(s.tenantId);
    if (!taxWired) {
      taxWired = true;
      item.addEventListener("click", function () { setTaxOpen(true); });
      ["payTaxClose", "payTaxScrim"].forEach(function (id) {
        $(id).addEventListener("click", function () { setTaxOpen(false); });
      });
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape" && !$("payTaxSheet").classList.contains("hidden")) setTaxOpen(false);
      });
      [["payTaxOnline", "shopTaxEnabled"], ["payTaxInPerson", "inPersonTaxEnabled"]].forEach(function (pair) {
        var box = $(pair[0]);
        box.addEventListener("change", function () {
          var patch = {};
          patch[pair[1]] = box.checked;
          box.disabled = true;
          var msg = $("payTaxMsg");
          ref.update(patch).then(function () {
            msg.textContent = "Saved";
            msg.classList.remove("hidden");
            setTimeout(function () { msg.classList.add("hidden"); }, 1500);
          }).catch(function (err) {
            box.checked = !box.checked;
            msg.textContent = errMessage(err);
            msg.classList.remove("hidden");
          }).then(function () { box.disabled = false; });
        });
      });
    }
    ref.get().then(function (snap) {
      var t = snap.data() || {};
      $("payTaxOnline").checked = t.shopTaxEnabled === true;
      $("payTaxInPerson").checked = t.inPersonTaxEnabled === true;
    }).catch(function () {});
  }

  function attach(session) {
    state.session = session;
    wire();
  }

  function load(session) {
    if (session) state.session = session;
    wire();
    var params = new URLSearchParams(location.search);
    if (params.get("stripe") === "success" || params.get("stripe") === "refresh") {
      try {
        history.replaceState({}, "", "/app/payments");
      } catch (e) {}
    }
    restoreCache();
    wireTake();
    loadTax();
    return loadAll();
  }

  global.ShopAppPayments = {
    attach: attach,
    load: load,
  };
})(window);
