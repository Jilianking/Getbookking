/**
 * Booking balances on the web calendar: the Payment section in an appointment's details
 * (price, payments, balance due, Text pay link, Mark paid in cash) and the "$ due" tag.
 * Server side: functions/balances.js (setBookingPrice, recordBookingCashPayment,
 * removeBookingCashPayment, createBookingBalanceLink). Card payments taken with Tap to Pay or
 * manual card in the iPhone app land in the booking's payments automatically.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var OPEN = ["confirmed", "completed", "pending_deposit", "pending_payment", "pending_consultation", "new", "pending"];
  var KIND = { card: "Card", tap: "Tap to Pay", link: "Pay link", cash: "Cash" };
  var ROLE = { deposit: "Deposit", balance: "Balance", payment: "Payment" };

  var ui = { id: null, mode: "view", busy: false, msg: "", msgOk: false, link: "" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(cents) {
    var v = (Number(cents) || 0) / 100;
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function call(name, data) {
    return firebase.app().functions(REGION).httpsCallable(name)(data).then(function (r) { return (r && r.data) || {}; });
  }

  /** Price, payments, and balance for a booking doc. `servicePriceCents` is the fallback price. */
  function model(raw, servicePriceCents) {
    raw = raw || {};
    var list = [];
    var p = raw.payments && typeof raw.payments === "object" ? raw.payments : null;
    if (p) {
      Object.keys(p).forEach(function (id) {
        var e = p[id] || {};
        var cents = Math.max(0, (Number(e.cents) || 0) - (Number(e.refundedCents) || 0));
        list.push({ id: id, kind: String(e.kind || "card"), role: String(e.role || "payment"), cents: cents, refunded: Number(e.refundedCents) || 0, at: toDate(e.at) });
      });
    } else if (Number(raw.paidCents) > 0) {
      // Older bookings: one payment, before balances existed.
      var cents0 = Number(raw.depositPartCents) > 0 ? Number(raw.depositPartCents) : Number(raw.paidCents);
      list.push({ id: "legacy", kind: "card", role: raw.depositPaidAt ? "deposit" : "payment", cents: cents0, refunded: 0, at: toDate(raw.paidAt || raw.depositPaidAt), legacy: true });
    }
    list.sort(function (a, b) { return (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0); });
    var price = null, fromService = false;
    if (raw.priceCents != null && isFinite(Number(raw.priceCents))) price = Math.round(Number(raw.priceCents));
    else if (Number(raw.tripCents) > 0) price = Math.round(Number(raw.tripCents) + (Number(raw.addonCents) || 0));
    else if (servicePriceCents > 0) { price = servicePriceCents; fromService = true; }
    var paid = list.reduce(function (a, e) { return a + e.cents; }, 0);
    // "Tracked": the shop set a price or money was taken, so an unpaid balance is real (not just "not recorded").
    var tracked = raw.priceCents != null || Number(raw.tripCents) > 0 || list.length > 0;
    return { price: price, fromService: fromService, list: list, paid: paid, balance: price == null ? null : Math.max(0, price - paid), tracked: tracked };
  }

  /** Balance to show on the calendar ("$100 due"), or 0. */
  function dueCents(raw, status, servicePriceCents) {
    if (["confirmed", "completed", "pending_deposit", "pending_payment"].indexOf(String(status || "")) === -1) return 0;
    if (raw && raw.noShowAt) return 0;
    var m = model(raw, servicePriceCents);
    return m.tracked && m.balance ? m.balance : 0;
  }

  function firstName(name) {
    var n = String(name || "").trim().split(/\s+/)[0];
    return n && n !== "Client" ? n : "";
  }

  function e164(raw) {
    var d = String(raw || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10 ? "+1" + d : "";
  }

  /**
   * Paints the Payment section. ctx = { host, id, raw, status, booking, session, servicePriceCents, may, canText, shopName, whenText }.
   */
  function render(ctx) {
    var host = ctx.host;
    if (!host) return;
    if (ui.id !== ctx.id) ui = { id: ctx.id, mode: "view", busy: false, msg: "", msgOk: false, link: "" };
    var status = String(ctx.status || "");
    if (status === "declined") { host.innerHTML = ""; host.classList.add("hidden"); return; }
    var m = model(ctx.raw, ctx.servicePriceCents);
    var live = OPEN.indexOf(status) !== -1;
    var may = !!ctx.may && live;
    host.classList.remove("hidden");
    var rows = "";
    rows += '<div class="app-pay-row"><span>Price' + (m.fromService ? ' <em>· from service</em>' : "") + "</span><strong>" +
      (m.price == null ? "Not set" : money(m.price)) + "</strong>" +
      (may && ui.mode === "view" ? '<button type="button" class="app-pay-link" data-pay="price">' + (m.price == null || m.fromService ? "Set" : "Edit") + "</button>" : "") + "</div>";
    if (ui.mode === "price") {
      rows += '<form class="app-pay-form" data-pay-form="price"><label>Total price <span class="app-pay-input"><i>$</i><input type="text" inputmode="decimal" name="amount" value="' +
        (m.price == null ? "" : (m.price / 100).toFixed(2)) + '" autocomplete="off" required></span></label>' +
        '<div class="app-pay-form-actions"><button type="button" class="app-btn app-btn--ghost" data-pay="cancel">Cancel</button><button type="submit" class="app-btn app-btn--primary">Save price</button></div></form>';
    }
    m.list.forEach(function (e) {
      var when = e.at ? e.at.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      var label = "Paid" + (when ? " " + when : "") + " · " + (e.kind === "cash" ? "Cash" : (ROLE[e.role] || "Payment") + (KIND[e.kind] && e.kind !== "card" ? " · " + KIND[e.kind] : ""));
      rows += '<div class="app-pay-row is-paid"><span>' + esc(label) + (e.refunded ? " <em>· " + money(e.refunded) + " refunded</em>" : "") + "</span><strong>" + money(e.cents) + "</strong>" +
        (may && e.kind === "cash" && !e.legacy && ui.mode === "view" ? '<button type="button" class="app-pay-link is-danger" data-pay="remove" data-id="' + esc(e.id) + '">Remove</button>' : "") + "</div>";
    });
    var reqCents = Number(ctx.raw && ctx.raw.depositRequestCents) || 0;
    if (status === "pending_deposit") {
      rows += '<div class="app-pay-row is-paid"><span>Deposit requested · waiting</span><strong>' + (reqCents ? money(reqCents) : "—") + "</strong></div>";
    }
    if (m.balance == null) {
      rows += '<div class="app-pay-row is-total"><span>Balance due</span><strong>Set a price</strong></div>';
    } else if (m.balance <= 0) {
      rows += '<div class="app-pay-row is-total is-done"><span>Paid in full</span><strong>✓</strong></div>';
    } else {
      rows += '<div class="app-pay-row is-total"><span>Balance due</span><strong>' + money(m.balance) + "</strong></div>";
    }
    if (ui.mode === "cash") {
      rows += '<form class="app-pay-form" data-pay-form="cash"><label>Cash received <span class="app-pay-input"><i>$</i><input type="text" inputmode="decimal" name="amount" value="' +
        (m.balance ? (m.balance / 100).toFixed(2) : "") + '" autocomplete="off" required></span></label>' +
        '<p class="app-pay-note">A smaller amount leaves the rest due.</p>' +
        '<div class="app-pay-form-actions"><button type="button" class="app-btn app-btn--ghost" data-pay="cancel">Cancel</button><button type="submit" class="app-btn app-btn--primary">Save cash</button></div></form>';
    }
    var actions = "";
    if (may && ui.mode === "view" && status === "pending_deposit" && ctx.resendDeposit) {
      actions += '<div class="app-pay-actions"><button type="button" class="app-btn app-btn--primary" data-pay="resend">Resend deposit link</button></div>';
    }
    if (may && ui.mode === "view" && status !== "pending_deposit" && m.balance && m.balance > 0) {
      actions += '<div class="app-pay-actions">' +
        '<button type="button" class="app-btn app-btn--ghost" data-pay="link">' + (ctx.canText && e164(ctx.booking.customerPhone) ? "Text pay link" : "Get pay link") + "</button>" +
        '<button type="button" class="app-btn app-btn--ghost" data-pay="cash">Mark paid in cash</button></div>' +
        '<p class="app-pay-note">To take a card in person, use Collect on this booking in the iPhone app.</p>';
    }
    var msg = ui.msg ? '<p class="app-pay-msg' + (ui.msgOk ? " is-ok" : "") + '" role="status">' + esc(ui.msg) + "</p>" : "";
    var link = ui.link ? '<div class="app-pay-linkbox"><input type="text" readonly value="' + esc(ui.link) + '" aria-label="Pay link"><button type="button" class="app-btn app-btn--ghost" data-pay="copy">Copy</button></div>' : "";
    host.innerHTML = '<h3 class="app-pay-title">Payment</h3>' + rows + actions + msg + link;
    host.querySelectorAll("button").forEach(function (b) { b.disabled = ui.busy; });
    host._ctx = ctx;
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onClick);
      host.addEventListener("submit", onSubmit);
    }
    if (ui.mode !== "view") {
      var input = host.querySelector('input[name="amount"]');
      if (input && document.activeElement !== input) { input.focus(); input.select(); }
    }
  }

  function repaint(host, patch) {
    Object.keys(patch || {}).forEach(function (k) { ui[k] = patch[k]; });
    if (host._ctx) render(host._ctx);
  }

  function parseCents(v) {
    var n = parseFloat(String(v || "").replace(/[$,\s]/g, ""));
    return isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  }

  /** Price from the service becomes the booking's price before money is recorded against it. */
  function ensurePrice(ctx) {
    var m = model(ctx.raw, ctx.servicePriceCents);
    if (!m.fromService || m.price == null) return Promise.resolve();
    return call("setBookingPrice", { requestId: ctx.id, priceCents: m.price });
  }

  function errText(e, fallback) {
    var msg = e && e.message ? String(e.message) : "";
    return msg && !/^internal$/i.test(msg) ? msg : fallback;
  }

  function onClick(ev) {
    var host = ev.currentTarget;
    var ctx = host._ctx;
    var b = ev.target.closest("[data-pay]");
    if (!b || !ctx || ui.busy) return;
    var act = b.getAttribute("data-pay");
    if (act === "price" || act === "cash") return repaint(host, { mode: act, msg: "", link: "" });
    if (act === "cancel") return repaint(host, { mode: "view", msg: "" });
    if (act === "copy") {
      var input = host.querySelector(".app-pay-linkbox input");
      var done = function () { repaint(host, { msg: "Link copied.", msgOk: true }); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ui.link).then(done, function () { input.select(); });
      else { input.select(); document.execCommand("copy"); done(); }
      return;
    }
    if (act === "remove") {
      if (!global.confirm("Remove this cash payment? Use this only if it was entered by mistake.")) return;
      repaint(host, { busy: true, msg: "" });
      call("removeBookingCashPayment", { requestId: ctx.id, paymentId: b.getAttribute("data-id") })
        .then(function () { repaint(host, { busy: false, msg: "Cash payment removed.", msgOk: true }); })
        .catch(function (e) { repaint(host, { busy: false, msg: errText(e, "Couldn't remove it. Try again."), msgOk: false }); });
      return;
    }
    if (act === "resend") {
      var cents = Number(ctx.raw && ctx.raw.depositRequestCents) || ctx.defaultDepositCents || 0;
      if (!cents) {
        var typed = global.prompt("Deposit amount (USD)", "");
        cents = parseCents(typed);
        if (!cents || cents < 50) return;
      }
      repaint(host, { busy: true, msg: "Making the deposit link…", msgOk: true, link: "" });
      ctx.resendDeposit(cents).then(function (res) {
        if (res.texted) repaint(host, { busy: false, msg: "Deposit link texted.", msgOk: true, link: res.url });
        else repaint(host, { busy: false, msg: "The text didn't send: " + res.error + " Copy the link below.", msgOk: false, link: res.url });
      }).catch(function (e) {
        repaint(host, { busy: false, msg: errText(e, "Couldn't make the deposit link."), msgOk: false });
      });
      return;
    }
    if (act === "link") {
      repaint(host, { busy: true, msg: "Making the pay link…", msgOk: true, link: "" });
      ensurePrice(ctx).then(function () {
        return call("createBookingBalanceLink", { requestId: ctx.id });
      }).then(function (res) {
        if (!res.url) throw new Error("No link came back. Try again.");
        var to = e164(ctx.booking.customerPhone);
        if (!(ctx.canText && to)) return repaint(host, { busy: false, msg: "Copy this link and send it to your client.", msgOk: true, link: res.url });
        var first = firstName(ctx.booking.customerName);
        var body = "Hi" + (first ? " " + first : "") + ", here's your link to pay the " + money(res.cents) + " balance for " +
          (ctx.booking.serviceName || "your appointment") + (ctx.whenText ? " on " + ctx.whenText : "") + ": " + res.url + " — " + (ctx.shopName || "us");
        return call("sendClientSms", { to: to, body: body, clientName: ctx.booking.customerName || "", threadId: to, threadPreview: "Pay link · " + money(res.cents) })
          .then(function () { repaint(host, { busy: false, msg: "Pay link texted to " + (first || "the client") + ".", msgOk: true, link: res.url }); })
          .catch(function () { repaint(host, { busy: false, msg: "The text didn't send. Copy the link and send it yourself.", msgOk: false, link: res.url }); });
      }).catch(function (e) {
        repaint(host, { busy: false, msg: errText(e, "Couldn't make the pay link. Check that card payments are set up."), msgOk: false });
      });
    }
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var host = ev.currentTarget;
    var ctx = host._ctx;
    var form = ev.target.closest("[data-pay-form]");
    if (!form || !ctx || ui.busy) return;
    var kind = form.getAttribute("data-pay-form");
    var cents = parseCents(form.amount.value);
    if (!cents) return repaint(host, { msg: "Enter an amount.", msgOk: false });
    if (cents > 5000000) return repaint(host, { msg: "That's more than $50,000.", msgOk: false });
    repaint(host, { busy: true, msg: "" });
    var job = kind === "price"
      ? call("setBookingPrice", { requestId: ctx.id, priceCents: cents })
      : ensurePrice(ctx).then(function () { return call("recordBookingCashPayment", { requestId: ctx.id, cents: cents }); });
    job.then(function () {
      repaint(host, { busy: false, mode: "view", msg: kind === "price" ? "Price saved." : money(cents) + " cash recorded.", msgOk: true });
    }).catch(function (e) {
      repaint(host, { busy: false, msg: errText(e, "Couldn't save. Try again."), msgOk: false });
    });
  }

  /** True while a price or cash form is open for this booking (live updates wait so typing isn't lost). */
  function isEditing(id) { return ui.id === id && ui.mode !== "view"; }

  global.ShopAppBalance = { render: render, model: model, dueCents: dueCents, money: money, isEditing: isEditing };
})(window);
