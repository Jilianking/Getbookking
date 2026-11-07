/**
 * Shop portal Requests: tenants/{id}/bookingRequests (same docs and server functions as the iPhone app).
 * Lists requests by status; the detail sheet shows the client's answers and photos and lets the
 * shop confirm (with a time and staff member), ask for a deposit, or decline.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var TABS = [
    { id: "new", label: "New", statuses: ["new", "pending"] },
    { id: "waiting", label: "Waiting", statuses: ["pending_deposit", "pending_payment", "pending_consultation"] },
    { id: "confirmed", label: "Confirmed", statuses: ["confirmed"] },
    { id: "closed", label: "Declined", statuses: ["declined", "cancelled"] },
  ];
  var STATUS_LABEL = {
    new: "New",
    pending: "Pending",
    pending_deposit: "Awaiting deposit",
    pending_payment: "Awaiting payment",
    pending_consultation: "Consult scheduled",
    confirmed: "Confirmed",
    declined: "Declined",
    cancelled: "Cancelled",
  };
  // Answers already shown elsewhere in the sheet.
  var SKIP_KEYS = { name: 1, email: 1, phone: 1, notes: 1, service: 1 };

  var state = {
    session: null,
    list: [],
    tab: "new",
    openId: "",
    unsub: null,
    wired: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function normStatus(raw) {
    return String(raw || "new").trim().toLowerCase();
  }

  function isCharter(tenant) {
    var plan = String((tenant && tenant.subscriptionPlan) || "").toLowerCase();
    var industry = String((tenant && tenant.industry) || "").toLowerCase();
    return plan.indexOf("charter") !== -1 || industry === "fishing" || industry === "charter";
  }

  function fns() {
    return firebase.app().functions(REGION);
  }

  function col() {
    return firebase.firestore().collection("tenants").doc(state.session.tenantId).collection("bookingRequests");
  }

  function startOf(d) {
    if (d.requestedStartTime) return toDate(d.requestedStartTime);
    if (d.scheduledDate && typeof d.scheduledStartMin === "number") {
      var p = String(d.scheduledDate).split("-");
      if (p.length === 3) {
        var day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        day.setMinutes(d.scheduledStartMin);
        return day;
      }
    }
    return null;
  }

  function mapDoc(doc) {
    var d = doc.data() || {};
    return {
      id: doc.id,
      raw: d,
      status: normStatus(d.status),
      name: String(d.customerName || "").trim() || "Client",
      email: String(d.customerEmail || "").trim(),
      phone: String(d.customerPhone || "").trim(),
      service: String(d.serviceName || "").trim(),
      notes: String(d.notes || "").trim(),
      preferredTime: String(d.preferredTime || "").trim(),
      preferredDays: Array.isArray(d.preferredDays) ? d.preferredDays : [],
      start: startOf(d),
      createdAt: toDate(d.createdAt),
      readAt: toDate(d.readAt),
      assignedUid: String(d.assignedMemberUid || "").trim(),
      assignedName: String(d.assignedMemberName || "").trim(),
      paidCents: typeof d.paidCents === "number" ? d.paidCents : 0,
      source: String(d.source || "").trim(),
      answers: d.formResponses && typeof d.formResponses === "object" ? d.formResponses : {},
    };
  }

  /** Staff without full access see the requests assigned to them, plus unassigned ones they can pick up. */
  function visible(list) {
    var s = state.session;
    if (global.ShopAppAccess && ShopAppAccess.can(s, "viewAllBookings")) return list;
    var uid = s.user && s.user.uid;
    return list.filter(function (r) {
      return !r.assignedUid || r.assignedUid === uid;
    });
  }

  function tabFor(status) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].statuses.indexOf(status) !== -1) return TABS[i].id;
    return "new";
  }

  function relative(d) {
    if (!d) return "";
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + " min ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + " hr ago";
    var days = Math.round(hrs / 24);
    if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function when(d) {
    if (!d) return "";
    return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }

  function isHoldingSlot(r) {
    return !!(r && r.holdUntil && (r.status === "pending_deposit" || r.status === "pending_payment"));
  }

  function chip(status, r) {
    if (isHoldingSlot(r)) return '<span class="app-req-chip is-wait">Holding slot – waiting for payment</span>';
    var tone = status === "confirmed" ? "ok" : status === "declined" || status === "cancelled" ? "off" : status === "new" || status === "pending" ? "new" : "wait";
    return '<span class="app-req-chip is-' + tone + '">' + esc(STATUS_LABEL[status] || status) + "</span>";
  }

  function money(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  /* ── List ── */

  function paintBadge() {
    var news = visible(state.list).filter(function (r) { return tabFor(r.status) === "new"; });
    var badge = $("navRequestsBadge");
    if (badge) {
      badge.textContent = String(news.length);
      badge.classList.toggle("hidden", !news.length);
    }
  }

  function paintTabs() {
    var all = visible(state.list);
    var host = $("reqTabs");
    if (!host) return;
    host.innerHTML = TABS.map(function (t) {
      var n = all.filter(function (r) { return tabFor(r.status) === t.id; }).length;
      return '<button type="button" data-req-tab="' + t.id + '" class="' + (t.id === state.tab ? "is-on" : "") + '">' +
        esc(t.label) + (n ? ' <span class="app-req-count">' + n + "</span>" : "") + "</button>";
    }).join("");
  }

  function paintList() {
    var host = $("reqList");
    if (!host) return;
    var rows = visible(state.list).filter(function (r) { return tabFor(r.status) === state.tab; });
    var empty = $("reqEmpty");
    if (empty) {
      var copy = {
        new: ["You're all caught up", "New bookings from your website show up here."],
        waiting: ["Nothing waiting", "Requests waiting on a deposit or payment show up here."],
        confirmed: ["No confirmed requests", "Requests you confirm move here."],
        closed: ["Nothing declined", "Declined and cancelled requests show up here."],
      }[state.tab];
      empty.innerHTML = '<i class="app-req-empty-icon" aria-hidden="true"></i><strong>' + esc(copy[0]) + "</strong><span>" + esc(copy[1]) + "</span>";
      empty.classList.toggle("hidden", rows.length > 0);
    }
    host.innerHTML = rows.map(function (r) {
      var bits = [];
      if (r.service) bits.push(r.service);
      if (r.start) bits.push(when(r.start));
      else if (r.preferredTime) bits.push(r.preferredTime);
      if (r.assignedName) bits.push(r.assignedName);
      return '<button type="button" class="app-req-row' + (r.readAt ? "" : " is-unread") + (r.id === state.openId ? " is-active" : "") + '" data-req-open="' + esc(r.id) + '">' +
        '<span class="app-req-avatar" aria-hidden="true">' + esc(initials(r.name)) + "</span>" +
        '<span class="app-req-copy"><strong>' + esc(r.name) + "</strong><span>" + esc(bits.join(" · ")) + "</span></span>" +
        '<span class="app-req-side"><time>' + esc(relative(r.createdAt)) + "</time>" + (state.tab === "new" ? (r.readAt ? "" : '<span class="app-req-new" aria-label="Unread"></span>') : chip(r.status, r)) + "</span>" +
        "</button>";
    }).join("");
  }

  function paint() {
    paintBadge();
    paintTabs();
    paintList();
    if (state.openId) paintDetail();
  }

  /* ── Detail ── */

  function byId(id) {
    return state.list.filter(function (r) { return r.id === id; })[0] || null;
  }

  function prettyKey(key) {
    var schema = (state.session.tenant && state.session.tenant.formSchema) || [];
    var hit = Array.isArray(schema) ? schema.filter(function (f) { return f && (f.key === key || f.id === key); })[0] : null;
    if (hit && (hit.label || hit.title)) return String(hit.label || hit.title);
    if (key === "referenceImages") return "Photos";
    if (key === "preferredDays") return "Preferred days";
    return String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function isUrl(v) {
    return typeof v === "string" && /^https:\/\//.test(v);
  }

  function answersHtml(r) {
    var photos = [];
    var rows = [];
    Object.keys(r.answers).forEach(function (k) {
      if (SKIP_KEYS[k]) return;
      var v = r.answers[k];
      if (v == null || v === "") return;
      var list = Array.isArray(v) ? v : [v];
      var urls = list.filter(isUrl);
      if (urls.length && urls.length === list.length) {
        photos = photos.concat(urls);
        return;
      }
      rows.push('<div class="app-req-answer"><span>' + esc(prettyKey(k)) + "</span><strong>" +
        esc(list.map(function (x) { return typeof x === "object" ? JSON.stringify(x) : String(x); }).join(", ")) + "</strong></div>");
    });
    var html = "";
    if (rows.length) html += '<h3 class="app-req-h">Their answers</h3>' + rows.join("");
    if (photos.length) {
      html += '<h3 class="app-req-h">Photos</h3><div class="app-req-photos">' + photos.map(function (u) {
        var pdf = /\.pdf(\?|$)/i.test(u);
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' +
          (pdf ? '<span class="app-req-pdf">PDF</span>' : '<img src="' + esc(u) + '" alt="" loading="lazy">') + "</a>";
      }).join("") + "</div>";
    }
    return html;
  }

  function memberOptions(selectedUid) {
    var s = state.session;
    var members = (s.members || []).filter(function (m) {
      return m && m.uid && String(m.status || "active").toLowerCase() !== "removed";
    });
    if (!members.length) {
      members = [{ uid: s.ownerUid || s.user.uid, displayName: s.user.displayName || s.firstName || "Owner", email: s.user.email || "" }];
    }
    var pick = selectedUid || (s.isOwner ? "" : s.user.uid) || members[0].uid;
    return members.map(function (m) {
      var name = (m.displayName || m.firstName || m.email || "Staff").trim();
      return '<option value="' + esc(m.uid) + '"' + (m.uid === pick ? " selected" : "") + ">" + esc(name) + "</option>";
    }).join("");
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function contactHtml(r) {
    var links = [];
    var digits = r.phone.replace(/\D/g, "");
    if (digits.length >= 10) {
      links.push('<a class="app-btn app-btn--ghost app-btn--small" href="sms:' + esc(r.phone) + '">Text</a>');
    }
    if (r.email) links.push('<a class="app-btn app-btn--ghost app-btn--small" href="mailto:' + esc(r.email) + '">Email</a>');
    return (
      '<p class="app-req-contact">' + esc([r.phone, r.email].filter(Boolean).join(" · ")) + "</p>" +
      (links.length ? '<div class="app-req-links">' + links.join("") + "</div>" : "")
    );
  }

  function paintDetail() {
    var r = byId(state.openId);
    var body = $("reqDetailBody");
    if (!r || !body) return;
    $("reqDetailTitle").textContent = r.name;
    var st = $("reqDetailStatus");
    if (st) st.outerHTML = chip(r.status, r).replace('class="app-req-chip', 'id="reqDetailStatus" class="app-req-chip');
    var charter = isCharter(state.session.tenant);
    // Confirming, declining, and cancelling follow the same rule as the app (owner, or a permitted manager).
    var mayAct = !!(global.ShopAppAccess && ShopAppAccess.can(state.session, "approveRequests"));
    var open = mayAct && ["new", "pending", "pending_consultation"].indexOf(r.status) !== -1;
    var waiting = mayAct && (r.status === "pending_deposit" || r.status === "pending_payment");
    var day = r.start || null;
    var dateVal = day ? day.getFullYear() + "-" + pad(day.getMonth() + 1) + "-" + pad(day.getDate()) : "";
    var timeVal = day ? pad(day.getHours()) + ":" + pad(day.getMinutes()) : "";
    var facts = [];
    facts.push(["Status", isHoldingSlot(r) ? "Holding slot – waiting for payment (cancels itself after 15 minutes if unpaid)" : (STATUS_LABEL[r.status] || r.status)]);
    if (r.service) facts.push(["Service", r.service]);
    if (r.start) facts.push(["Time", when(r.start)]);
    else if (r.preferredTime) facts.push(["Asked for", r.preferredTime]);
    if (r.preferredDays.length) facts.push(["Preferred days", r.preferredDays.join(", ")]);
    if (r.assignedName) facts.push(["With", r.assignedName]);
    if (r.paidCents) facts.push(["Paid", money(r.paidCents)]);
    if (r.createdAt) facts.push(["Requested", when(r.createdAt)]);

    facts = facts.filter(function (f) { return f[0] !== "Status"; });
    var html = contactHtml(r) +
      '<div class="app-req-facts">' + facts.map(function (f) {
        return '<div class="app-req-fact"><span>' + esc(f[0]) + "</span><strong>" + esc(f[1]) + "</strong></div>";
      }).join("") + "</div>" +
      (r.notes ? '<h3 class="app-req-h">Notes</h3><p class="app-req-notes">' + esc(r.notes).replace(/\n/g, "<br>") + "</p>" : "") +
      answersHtml(r);

    if (open && !charter) {
      html += '<h3 class="app-req-h">Schedule it</h3>' +
        '<div class="app-field-row">' +
        '<div class="app-field"><label for="reqDate">Date</label><input id="reqDate" type="date" value="' + dateVal + '"></div>' +
        '<div class="app-field"><label for="reqTime">Time</label><input id="reqTime" type="time" value="' + timeVal + '"></div>' +
        "</div>" +
        '<div class="app-field"><label for="reqStaff">With</label><select id="reqStaff">' + memberOptions(r.assignedUid) + "</select></div>" +
        '<div class="app-field app-req-deposit"><label for="reqDeposit">Deposit to hold the time (optional)</label>' +
        '<div class="app-deposit-amt"><input id="reqDeposit" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"><span>USD</span></div>' +
        '<p class="app-hint">With an amount, the client gets a text with a payment link and the booking waits for the deposit.</p></div>';
    } else if (open && charter) {
      html += '<p class="app-hint">Schedule charter trips from the Calendar so you can pick the boat.</p>';
    }
    if (!mayAct) html += '<p class="app-hint">Only the owner or a manager with permission can confirm or decline requests.</p>';
    html += '<p class="app-sheet-error hidden" id="reqError"></p>';
    body.innerHTML = html;

    var actions = [];
    if (open && !charter) actions.push('<button type="button" class="app-btn app-btn--primary" data-req-act="confirm">Confirm</button>');
    if (open || waiting) actions.push('<button type="button" class="app-btn app-btn--ghost" data-req-act="decline">' + (waiting ? "Cancel request" : "Decline") + "</button>");
    if (r.status === "confirmed") actions.push('<button type="button" class="app-btn app-btn--ghost" data-req-act="calendar">Open in calendar</button>');
    if (r.status === "confirmed" && mayAct) actions.push('<button type="button" class="app-btn app-btn--ghost" data-req-act="cancel">Cancel booking</button>');
    $("reqDetailActions").innerHTML = actions.join("");
  }

  function setOpen(id) {
    state.openId = id || "";
    var sheet = $("reqDetailSheet");
    var scrim = $("reqDetailScrim");
    var ph = $("reqPlaceholder");
    if (sheet) sheet.classList.toggle("hidden", !id);
    if (scrim) scrim.classList.toggle("hidden", !id);
    if (ph) ph.classList.toggle("hidden", !!id);
    paintList();
    if (!id) return;
    paintDetail();
    var r = byId(id);
    if (r && !r.readAt) {
      // Same as the app: opening a request marks it read without changing its status.
      col().doc(id).update({ readAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(function () {});
    }
  }

  function fail(msg) {
    var e = $("reqError");
    if (e) {
      e.textContent = msg;
      e.classList.remove("hidden");
    }
    busy(false);
  }

  function busy(on) {
    document.querySelectorAll("#reqDetailActions button").forEach(function (b) { b.disabled = !!on; });
  }

  function setStatus(id, status, notes) {
    var payload = { requestId: id, status: status };
    if (notes) payload.notes = notes;
    return fns().httpsCallable("updateBookingRequestStatus")(payload);
  }

  function confirmRequest(r) {
    var date = ($("reqDate") || {}).value;
    var time = ($("reqTime") || {}).value;
    if (!date || !time) return fail("Pick a date and time first.");
    var p = date.split("-");
    var t = time.split(":");
    var start = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(t[0]), Number(t[1]));
    var uid = ($("reqStaff") || {}).value;
    var m = (state.session.members || []).filter(function (x) { return x.uid === uid; })[0] || {};
    var name = (m.displayName || m.firstName || (uid === state.session.user.uid ? state.session.user.displayName : "") || "Staff").trim();
    var amountRaw = String(($("reqDeposit") || {}).value || "").replace(/[^0-9.]/g, "");
    var amount = amountRaw ? parseFloat(amountRaw) : 0;
    if (amountRaw && !(amount >= 0.5)) return fail("Deposit must be at least $0.50, or leave it empty.");
    var dash = global.ShopAppDashboard || {};
    if (amount && !dash.sendDepositLink) return fail("Deposit links aren't available right now.");
    busy(true);
    var label = start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    col().doc(r.id).update({
      assignedMemberUid: uid,
      assignedMemberName: name,
      assignedMemberEmail: m.email || "",
      requestedStartTime: firebase.firestore.Timestamp.fromDate(start),
      preferredTime: label,
    }).then(function () {
      return setStatus(r.id, amount ? "pending_deposit" : "confirmed");
    }).then(function () {
      if (amount) return dash.sendDepositLink(r.id, r.name, r.phone, amount);
    }).then(function () {
      setOpen("");
    }).catch(function (e) {
      fail((e && e.message) || "Could not confirm this request.");
    });
  }

  function onAction(act) {
    var r = byId(state.openId);
    if (!r) return;
    if (act === "confirm") return confirmRequest(r);
    if (act === "calendar") {
      setOpen("");
      if (global.ShopAppDashboard && ShopAppDashboard.goTo && r.start) ShopAppDashboard.goTo(r.start);
      var link = document.querySelector('a.app-nav[data-route="calendar"]');
      if (link) link.click();
      return;
    }
    var status = act === "decline" ? "declined" : "cancelled";
    var ask = act === "decline" ? "Decline this request? The client won't be booked." : "Cancel this booking? Any paid deposit follows your refund settings.";
    if (!global.confirm(ask)) return;
    busy(true);
    setStatus(r.id, status).then(function (res) {
      var data = (res && res.data) || {};
      if (data.refundError) return fail("Cancelled, but the refund didn't go through: " + data.refundError);
      setOpen("");
    }).catch(function (e) {
      fail((e && e.message) || "Could not update this request.");
    });
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    var tabs = $("reqTabs");
    if (tabs) tabs.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-req-tab]");
      if (!b) return;
      state.tab = b.getAttribute("data-req-tab");
      paint();
    });
    var list = $("reqList");
    if (list) list.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-req-open]");
      if (b) setOpen(b.getAttribute("data-req-open"));
    });
    ["reqDetailClose", "reqDetailScrim"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", function () { setOpen(""); });
    });
    var acts = $("reqDetailActions");
    if (acts) acts.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-req-act]");
      if (b) onAction(b.getAttribute("data-req-act"));
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.openId) setOpen("");
    });
  }

  /** Starts listening as soon as the shop loads, so the sidebar badge stays current on every page. */
  function attach(session) {
    state.session = session;
    wire();
    if (state.unsub) return;
    state.unsub = col().orderBy("createdAt", "desc").limit(300).onSnapshot(function (snap) {
      state.list = snap.docs.map(mapDoc);
      paint();
    }, function () {
      paint();
    });
  }

  function load(session, opts) {
    attach(session);
    if (opts && opts.openId) setOpen(opts.openId);
    paint();
  }

  global.ShopAppRequests = { attach: attach, load: load, open: setOpen, all: function () { return state.list.slice(); } };
})(window);
