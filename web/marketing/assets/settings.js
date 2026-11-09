/**
 * Web Settings — same options as the iPhone Settings screen.
 * Tap to Pay screen name is intentionally omitted.
 */
(function () {
  "use strict";

  firebase.initializeApp(window.firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var fns = firebase.app().functions("us-central1");

  var PERM_DEFAULTS = {
    viewAllBookings: true,
    approveRejectRequests: true,
    editServicesPricing: false,
    manageBookingFormStyle: false,
    manageArtistSchedules: false,
    accessClientList: false,
    viewEarningsReports: false,
    sendClientNotifications: true,
  };
  var NOTE_DEFAULTS = {
    onNewBooking: true,
    onCancellation: true,
    dailySummaryEmail: false,
  };
  var DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var BOOKING_TYPES = [
    ["instant_book", "Instant book"],
    ["request_approve", "Request + approve"],
    ["deposit_to_confirm", "Deposit to confirm"],
    ["approve_and_deposit", "Approve and deposit"],
    ["consultation_first", "Consultation first"],
    ["pay_in_full", "Pay in full"],
    ["calendar_slots", "Calendar / slots"],
  ];
  var ZONES = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "America/Puerto_Rico",
  ];

  var state = {
    user: null,
    userData: {},
    tenantId: "",
    tenant: {},
    stack: [],
    connect: null,
  };

  function $(id) { return document.getElementById(id); }

  function plan() {
    return String(state.tenant.subscriptionPlan || state.tenant.plan || "").toLowerCase();
  }
  function isCharter() { return plan() === "charter"; }
  function isTeam() { return plan() === "studio" || plan() === "shop"; }
  function isOwner() { return !!(state.user && state.tenant.ownerUid === state.user.uid); }
  function workflow() {
    return state.tenant.workflow && typeof state.tenant.workflow === "object" ? state.tenant.workflow : {};
  }
  function managersLock() { return workflow().managersApproveAppointments === true; }
  function smsOn() {
    var status = String(state.tenant.smsStatus || "").toLowerCase();
    return status === "active" && String(state.tenant.smsPhoneNumber || "").trim() !== "";
  }
  function perms() {
    var raw = state.tenant.managerPermissions || {};
    var out = {};
    Object.keys(PERM_DEFAULTS).forEach(function (k) {
      out[k] = typeof raw[k] === "boolean" ? raw[k] : PERM_DEFAULTS[k];
    });
    return out;
  }
  function notes() {
    var raw = state.tenant.managerNotifications || {};
    var out = {};
    Object.keys(NOTE_DEFAULTS).forEach(function (k) {
      out[k] = typeof raw[k] === "boolean" ? raw[k] : NOTE_DEFAULTS[k];
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function callableError(err) {
    if (!err) return "Could not save.";
    return err.message || String(err);
  }

  function showMsg(root, text, ok) {
    var p = root.querySelector(".set-msg");
    if (!p) {
      p = document.createElement("p");
      p.className = "set-msg";
      root.appendChild(p);
    }
    p.textContent = text;
    p.classList.toggle("is-ok", !!ok);
    p.classList.toggle("is-err", !ok);
  }

  function row(label, hint, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "acct-row";
    btn.innerHTML = '<span class="acct-row-label">' + esc(label) + "</span><span class=\"acct-row-chevron\" aria-hidden=\"true\">›</span>";
    if (hint) btn.title = hint;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function linkRow(label, href) {
    var a = document.createElement("a");
    a.className = "acct-row";
    a.href = href;
    a.target = "_top";
    a.innerHTML = '<span class="acct-row-label">' + esc(label) + "</span><span class=\"acct-row-chevron\" aria-hidden=\"true\">›</span>";
    return a;
  }

  function section(title, nodes) {
    var wrap = document.createElement("section");
    wrap.className = "acct-section";
    var label = document.createElement("div");
    label.className = "acct-section-label";
    label.textContent = title;
    var card = document.createElement("div");
    card.className = "acct-card";
    nodes.forEach(function (n) { if (n) card.appendChild(n); });
    wrap.appendChild(label);
    wrap.appendChild(card);
    return wrap;
  }

  function openScreen(name) {
    state.stack.push(name);
    paint();
  }

  function paintHub() {
    $("hub").classList.remove("hidden");
    $("detail").classList.add("hidden");
    var host = $("hubRows");
    host.innerHTML = "";
    var owner = isOwner();
    var team = isTeam();

    if (owner) {
      var business = [
        row("Business settings", "", function () { openScreen("business"); }),
      ];
      if (smsOn()) business.push(row("Messaging settings", "", openMessagingSettings));
      business.push(row("Domain", "", function () { openScreen("domain"); }));
      if (team) business.push(row("Your booking profile", "", function () { openScreen("profile"); }));
      business.push(row("Scheduling & hours", "", function () { openScreen("schedule"); }));
      host.appendChild(section("Business", business));
      host.appendChild(section("Payments", [
        row("Payment settings", "", function () { openScreen("payments"); }),
      ]));
      // AI assistant: hidden until the shop is on early access (lawyer review pending before everyone).
      var aiSlot = document.createElement("div");
      host.appendChild(aiSlot);
      var showAi = function () {
        aiSlot.appendChild(section("AI assistant", [
          row("Connect an AI assistant", "", function () { openScreen("ai"); }),
        ]));
      };
      if (state.aiAllowed === true) showAi();
      else if (state.aiAllowed !== false) {
        fns.httpsCallable("listMcpKeys")({}).then(function (res) {
          state.aiAllowed = !!(res.data && res.data.allowed);
          if (state.aiAllowed) showAi();
        }).catch(function () { state.aiAllowed = false; });
      }
    } else {
      var mine = [];
      if (!managersLock()) mine.push(row("My booking type", "", function () { openScreen("profile"); }));
      mine.push(row("Scheduling & hours", "", function () { openScreen("schedule"); }));
      host.appendChild(section("Business", mine));
    }

    host.appendChild(section("Account", [
      linkRow("Change password", "/account"),
      linkRow("Support", "mailto:support@getbookking.com"),
      linkRow("Privacy Policy", "/privacy"),
      linkRow("Terms of Service", "/terms"),
      (function () {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "acct-row";
        btn.innerHTML = '<span class="acct-row-label">Log out</span><span class="acct-row-chevron" aria-hidden="true">›</span>';
        btn.addEventListener("click", function () {
          auth.signOut().then(function () {
            var top = window.top || window;
            top.location.href = "/login";
          });
        });
        return btn;
      })(),
      linkRow("Delete account", "/account"),
    ]));
  }

  function paintDetail() {
    $("hub").classList.add("hidden");
    $("detail").classList.remove("hidden");
    var name = state.stack[state.stack.length - 1];
    var body = $("detailBody");
    body.innerHTML = "";
    $("detailLead").textContent = "";
    var screens = {
      business: paintBusiness,
      booking: paintBooking,
      services: paintServices,
      shipping: paintShipping,
      messaging: paintMessaging,
      notifications: paintNotifications,
      boats: paintBoats,
      design: paintDesign,
      clients: paintClients,
      domain: paintDomain,
      profile: paintProfile,
      schedule: paintSchedule,
      payments: paintPayments,
      ai: paintAi,
    };
    (screens[name] || paintBusiness)(body);
  }

  /* ── AI assistant (MCP): personal keys for Claude and other assistants ── */
  function paintAi(body) {
    $("detailTitle").textContent = "AI assistant";
    $("detailLead").textContent = "Connect Claude or ChatGPT to your shop. It can read your schedule, requests, clients, payments, messages, and website. With actions on, it can also confirm bookings, send payment links, and text clients, but only after you say yes in the chat.";
    var card = document.createElement("div");
    card.className = "acct-card set-ai";
    card.innerHTML = '<p class="set-lead">Loading…</p>';
    body.appendChild(card);
    var help = document.createElement("p");
    help.className = "set-ai-help";
    help.innerHTML = 'New to this? <a href="/ai-assistant" target="_blank" rel="noopener">See how to connect, step by step</a>.';
    body.appendChild(help);

    function when(iso) {
      if (!iso) return "Never";
      return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function render(data) {
      if (!data.allowed) {
        card.innerHTML = '<p class="set-lead">The AI assistant is in early access and isn\'t on for your shop yet.</p>';
        return;
      }
      var keys = data.keys || [];
      card.innerHTML =
        '<form class="set-form set-ai-create">' +
        '<label for="aiKeyName">Name this connection</label>' +
        '<input type="text" id="aiKeyName" maxlength="40" placeholder="Claude or ChatGPT" />' +
        '<div class="set-actions"><button type="submit" class="set-save">Create connection link</button></div>' +
        '</form>' +
        '<div class="set-ai-new hidden" id="aiNew"></div>' +
        '<div class="set-ai-list">' +
        (keys.length ? keys.map(function (k) {
          return '<div class="set-item"><p><strong>' + esc(k.name) + '</strong><span>…' + esc(k.hint) + ' · Created ' + esc(when(k.createdAt)) + ' · Last used ' + esc(when(k.lastUsedAt)) + '</span></p>' +
            '<label class="set-ai-toggle"><input type="checkbox" data-actions="' + esc(k.id) + '"' + (k.actions !== false ? " checked" : "") + ' /> Can take actions</label>' +
            '<button type="button" data-revoke="' + esc(k.id) + '">Revoke</button></div>';
        }).join("") : '<p class="set-lead">No connections yet.</p>') +
        "</div>";
      card.querySelector(".set-ai-create").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var btn = card.querySelector(".set-save");
        btn.disabled = true;
        fns.httpsCallable("createMcpKey")({ name: $("aiKeyName").value.trim() }).then(function (res) {
          var d = res.data || {};
          load(function () {
            var box = $("aiNew");
            box.classList.remove("hidden");
            box.innerHTML =
              '<p><strong>Your connection link</strong> (shown only once, so copy it now):</p>' +
              '<div class="set-ai-url"><input type="text" readonly value="' + esc(d.connectorUrl) + '" id="aiUrl" /><button type="button" id="aiCopy">Copy</button></div>' +
              '<p class="set-ai-warn">Anyone with this link can read your shop data. Keep it private, and revoke it if it\'s ever shared.</p>';
            $("aiCopy").addEventListener("click", function () {
              var v = $("aiUrl").value;
              var b = this;
              (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () {
                b.textContent = "Copied";
                setTimeout(function () { b.textContent = "Copy"; }, 1500);
              }, function () { $("aiUrl").select(); });
            });
          });
        }).catch(function (err) {
          btn.disabled = false;
          showMsg(card, callableError(err), false);
        });
      });
      card.querySelectorAll("[data-actions]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          cb.disabled = true;
          fns.httpsCallable("setMcpKeyActions")({ id: cb.getAttribute("data-actions"), actions: cb.checked }).then(function () {
            cb.disabled = false;
          }).catch(function (err) {
            cb.checked = !cb.checked;
            cb.disabled = false;
            showMsg(card, callableError(err), false);
          });
        });
      });
      card.querySelectorAll("[data-revoke]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!window.confirm("Revoke this connection? The assistant using it stops working right away.")) return;
          b.disabled = true;
          fns.httpsCallable("revokeMcpKey")({ id: b.getAttribute("data-revoke") }).then(function () { load(); }).catch(function (err) {
            b.disabled = false;
            showMsg(card, callableError(err), false);
          });
        });
      });
    }

    function load(after) {
      fns.httpsCallable("listMcpKeys")({}).then(function (res) {
        render(res.data || {});
        if (after) after();
      }).catch(function (err) {
        card.innerHTML = "";
        showMsg(card, callableError(err), false);
      });
    }
    load();
  }

  function paint() {
    if (!state.stack.length) paintHub();
    else paintDetail();
  }

  function paintBusiness(body) {
    $("detailTitle").textContent = "Business settings";
    $("detailLead").textContent = isCharter()
      ? "Booking, boats, and client texting for your charters."
      : (isTeam()
        ? "Booking, services, and client texting for your whole business."
        : "Booking and client texting for your business.");
    var card = document.createElement("div");
    card.className = "acct-card";
    card.appendChild(row("Booking settings", "", function () { openScreen("booking"); }));
    if (isCharter()) card.appendChild(row("Boats", "", function () { openScreen("boats"); }));
    card.appendChild(row(isCharter() ? "Trips" : "Services", "", function () { openScreen("services"); }));
    card.appendChild(row("Shipping & pickup", "", function () { openScreen("shipping"); }));
    card.appendChild(row("Messaging settings", "", openMessagingSettings));
    body.appendChild(card);
    if (isTeam()) {
      // What managers can do now lives with the team.
      var team = document.createElement("div");
      team.className = "acct-card";
      team.style.marginTop = "16px";
      team.appendChild(linkRow("Team permissions and manager alerts", "/app/team?tab=permissions"));
      body.appendChild(team);
    }
  }

  function toggleRow(title, detail, checked, onChange) {
    var wrap = document.createElement("label");
    wrap.className = "set-toggle";
    var text = document.createElement("div");
    var strong = document.createElement("strong");
    strong.textContent = title;
    text.appendChild(strong);
    if (detail) {
      var span = document.createElement("span");
      span.textContent = detail;
      text.appendChild(span);
    }
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", function () { onChange(input.checked, input); });
    wrap.appendChild(text);
    wrap.appendChild(input);
    return wrap;
  }

  function savePolicy(patchPerm, patchNote, root) {
    var nextPerm = perms();
    var nextNote = notes();
    Object.keys(patchPerm || {}).forEach(function (k) { nextPerm[k] = !!patchPerm[k]; });
    Object.keys(patchNote || {}).forEach(function (k) { nextNote[k] = !!patchNote[k]; });
    return fns.httpsCallable("updateTenantManagerPolicy")({
      managerPermissions: nextPerm,
      managerNotifications: nextNote,
    }).then(function () {
      state.tenant.managerPermissions = nextPerm;
      state.tenant.managerNotifications = nextNote;
      if (root) showMsg(root, "Saved", true);
    }).catch(function (err) {
      if (root) showMsg(root, callableError(err), false);
      throw err;
    });
  }

  function paintBooking(body) {
    $("detailTitle").textContent = "Booking settings";
    var wf = workflow();
    var mode = String(wf.bookingMode || "form");
    var type = mode === "calendar_slots" ? "calendar_slots" : String(wf.confirmationType || "request_approve");
    var form = document.createElement("form");
    form.className = "set-form acct-card";
    form.style.padding = "16px";
    var typeLabel = document.createElement("label");
    typeLabel.textContent = "Booking type";
    var select = document.createElement("select");
    select.id = "bkType";
    BOOKING_TYPES.forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (opt.value === type) opt.selected = true;
      select.appendChild(opt);
    });
    var depWrap = document.createElement("div");
    var depLabel = document.createElement("label");
    depLabel.textContent = "Deposit amount";
    var dep = document.createElement("input");
    dep.type = "number";
    dep.min = "0";
    dep.step = "0.01";
    dep.value = wf.depositAmount ? String(wf.depositAmount) : "";
    depWrap.appendChild(depLabel);
    depWrap.appendChild(dep);

    // Different deposit per service: lists every service with its own deposit (blank = the default above).
    var perSvc = toggleRow(
      "Different deposit per service",
      "Set a deposit for each service. Leave one blank to use the amount above.",
      wf.depositPerService === true,
      function (on) { svcList.style.display = on ? "" : "none"; if (on) loadSvcDeposits(); }
    );
    perSvc.querySelector("input").setAttribute("data-dep", "");
    depWrap.appendChild(perSvc);
    var svcList = document.createElement("div");
    svcList.className = "set-dep-services";
    svcList.style.display = wf.depositPerService === true ? "" : "none";
    depWrap.appendChild(svcList);
    var svcInputs = [];
    var svcLoaded = false;
    function loadSvcDeposits() {
      if (svcLoaded) return;
      svcLoaded = true;
      svcList.innerHTML = '<p class="set-lead">Loading services…</p>';
      db.collection("tenants").doc(state.tenantId).collection("services").get().then(function (snap) {
        svcList.innerHTML = "";
        svcInputs = [];
        if (snap.empty) {
          svcList.innerHTML = '<p class="set-lead">Add services first, then set their deposits here.</p>';
          return;
        }
        snap.docs.forEach(function (d) {
          var sv = d.data() || {};
          var row = document.createElement("div");
          row.className = "set-dep-row";
          var name = document.createElement("span");
          name.textContent = sv.name || "Service";
          var inp = document.createElement("input");
          inp.type = "number";
          inp.min = "0";
          inp.step = "0.01";
          inp.placeholder = dep.value ? "$" + dep.value : "Default";
          inp.value = Number(sv.depositAmount) > 0 ? String(sv.depositAmount) : (dep.value || "");
          inp.setAttribute("aria-label", "Deposit for " + (sv.name || "service"));
          row.appendChild(name);
          row.appendChild(inp);
          svcList.appendChild(row);
          svcInputs.push({ id: d.id, input: inp, was: Number(sv.depositAmount) || 0 });
        });
      }).catch(function () {
        svcList.innerHTML = '<p class="set-lead">Couldn\'t load services.</p>';
        svcLoaded = false;
      });
    }
    if (wf.depositPerService === true) loadSvcDeposits();
    // Calendar shops keep their confirmation type, which can still take a deposit.
    function takesDeposit(v) {
      if (v === "calendar_slots") v = String(wf.confirmationType || "");
      return v === "deposit_to_confirm" || v === "approve_and_deposit";
    }
    function syncDep() {
      depWrap.style.display = takesDeposit(select.value) ? "" : "none";
    }
    select.addEventListener("change", syncDep);
    syncDep();
    form.appendChild(typeLabel);
    form.appendChild(select);
    form.appendChild(depWrap);

    var charterShop = String((state.tenant && state.tenant.subscriptionPlan) || "").toLowerCase() === "charter";
    function pick(labelText, id, options, value) {
      var l = document.createElement("label");
      l.setAttribute("for", id);
      l.textContent = labelText;
      var sel = document.createElement("select");
      sel.id = id;
      options.forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = String(o[0]);
        opt.textContent = o[1];
        if (String(o[0]) === String(value)) opt.selected = true;
        sel.appendChild(opt);
      });
      form.appendChild(l);
      form.appendChild(sel);
      return sel;
    }
    var balDue = pick("Balance due", "bkBalDue", [
      ["at", charterShop ? "At the trip" : "At the appointment"],
      ["before", charterShop ? "Before departure" : "Before the appointment"],
    ], wf.balanceDue || (charterShop ? "before" : "at"));
    var remindDays = pick("Balance reminder", "bkRemind", [
      [0, "Off"], [1, "1 day before"], [2, "2 days before"], [3, "3 days before"], [7, "1 week before"],
    ], wf.balanceReminderDays != null ? wf.balanceReminderDays : (charterShop ? 2 : 1));
    var depRefund = pick("Deposits when a booking is cancelled", "bkDepRefund", [
      ["yes", "Refundable"], ["no", "Non-refundable"],
    ], wf.depositRefundable === false ? "no" : "yes");

    if (isTeam()) {
      form.appendChild(toggleRow(
        "Set one booking type for the team",
        "When on, everyone uses this booking type.",
        managersLock(),
        function () {}
      ));
    }
    form.appendChild(toggleRow(
      "View all bookings",
      "When on, Requests includes every shop booking.",
      perms().viewAllBookings,
      function () {}
    ));
    form.appendChild(toggleRow(
      "Notify on new booking",
      "Push alerts for new bookings.",
      notes().onNewBooking,
      function () {}
    ));
    form.appendChild(toggleRow(
      "Notify on cancellation",
      "Push alerts when a booking is cancelled.",
      notes().onCancellation,
      function () {}
    ));

    var actions = document.createElement("div");
    actions.className = "set-actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "set-save";
    save.textContent = "Save";
    actions.appendChild(save);
    form.appendChild(actions);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var boxes = form.querySelectorAll('input[type="checkbox"]:not([data-dep])');
      var teamLock = isTeam() ? boxes[0].checked : managersLock();
      var viewAll = boxes[isTeam() ? 1 : 0].checked;
      var onNew = boxes[isTeam() ? 2 : 1].checked;
      var onCancel = boxes[isTeam() ? 3 : 2].checked;
      var chosen = select.value;
      var payload = { managersApproveAppointments: isTeam() ? teamLock : false };
      if (chosen === "calendar_slots") {
        payload.bookingMode = "calendar_slots";
        payload.confirmationType = String(wf.confirmationType || "request_approve");
      } else {
        payload.bookingMode = "form";
        payload.confirmationType = chosen;
      }
      if (takesDeposit(chosen)) {
        var amount = Number(dep.value);
        if (amount > 0) payload.depositAmount = amount;
      }
      save.disabled = true;
      var perSvcOn = perSvc.querySelector("input").checked;
      var balPayload = {
        balanceDue: balDue.value,
        balanceReminderDays: Number(remindDays.value),
        depositRefundable: depRefund.value === "yes",
        depositPerService: perSvcOn,
      };
      fns.httpsCallable("updateTenantBookingWorkflow")(payload).then(function () {
        return fns.httpsCallable("updateBalanceSettings")(balPayload);
      }).then(function () {
        if (!perSvcOn || !svcInputs.length) return null;
        var batch = db.batch();
        var changed = 0;
        svcInputs.forEach(function (row) {
          var v = Number(row.input.value);
          var next = v > 0 ? Math.round(v * 100) / 100 : null;
          if ((next || 0) === row.was) return;
          batch.update(db.collection("tenants").doc(state.tenantId).collection("services").doc(row.id), { depositAmount: next });
          row.was = next || 0;
          changed++;
        });
        return changed ? batch.commit() : null;
      }).then(function () {
        var next = Object.assign({}, workflow(), payload, balPayload);
        state.tenant.workflow = next;
        return savePolicy(
          { viewAllBookings: viewAll },
          { onNewBooking: onNew, onCancellation: onCancel },
          form
        );
      }).then(function () {
        showMsg(form, "Saved", true);
      }).catch(function (err) {
        showMsg(form, callableError(err), false);
      }).then(function () { save.disabled = false; });
    });
    body.appendChild(form);
  }

  function slugify(name) {
    var s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return s || "service";
  }

  function paintServices(body) {
    $("detailTitle").textContent = isCharter() ? "Trips" : "Services";
    $("detailLead").textContent = "Name, duration, and price shown on your site.";
    var noun = isCharter() ? "trip" : "service";
    // Add button on top; the form opens in a pop-up.
    var card = document.createElement("div");
    card.className = "acct-card set-list-card";
    var head = document.createElement("div");
    head.className = "set-list-head";
    var count = document.createElement("span");
    count.className = "set-list-count";
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "set-add-btn";
    addBtn.textContent = "+ Add " + noun;
    head.appendChild(count);
    head.appendChild(addBtn);
    card.appendChild(head);
    var list = document.createElement("div");
    list.className = "set-list";
    card.appendChild(list);
    body.appendChild(card);

    var backdrop = document.createElement("div");
    backdrop.className = "acct-modal-backdrop hidden";
    var modal = document.createElement("div");
    modal.className = "acct-modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = '<div class="acct-modal-card"><div class="acct-modal-head"><h2>New ' + noun + '</h2>' +
      '<button type="button" class="acct-modal-close" aria-label="Close">&times;</button></div></div>';
    var form = document.createElement("form");
    form.className = "set-form";
    form.innerHTML = '<label>Name</label><input type="text" id="svcName" required />' +
      '<label class="set-toggle"><div><strong>Include duration</strong></div><input type="checkbox" id="svcDurOn" /></label>' +
      '<label>Duration (minutes)</label><input type="number" id="svcDur" min="5" step="5" value="60" />' +
      '<label class="set-toggle"><div><strong>Show starting price</strong></div><input type="checkbox" id="svcPriceOn" /></label>' +
      '<label>Price</label><input type="number" id="svcPrice" min="0" step="0.01" />' +
      '<div class="set-actions"><button type="button" class="set-cancel">Cancel</button><button type="submit" class="set-save">Add ' + noun + '</button></div>';
    modal.querySelector(".acct-modal-card").appendChild(form);
    body.appendChild(backdrop);
    body.appendChild(modal);

    function setModal(open) {
      backdrop.classList.toggle("hidden", !open);
      modal.classList.toggle("hidden", !open);
      document.body.classList.toggle("acct-modal-open", open);
      if (open) {
        form.reset();
        var msg = form.querySelector(".set-msg");
        if (msg) msg.remove();
        form.querySelector("#svcName").focus();
      }
    }
    addBtn.addEventListener("click", function () { setModal(true); });
    backdrop.addEventListener("click", function () { setModal(false); });
    modal.addEventListener("click", function (ev) { if (ev.target === modal) setModal(false); });
    modal.querySelector(".acct-modal-close").addEventListener("click", function () { setModal(false); });
    form.querySelector(".set-cancel").addEventListener("click", function () { setModal(false); });
    modal.addEventListener("keydown", function (ev) { if (ev.key === "Escape") setModal(false); });

    function load() {
      list.innerHTML = "";
      db.collection("tenants").doc(state.tenantId).collection("services").get().then(function (snap) {
        var docs = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          if (d.isActive === false) return;
          docs.push({ id: doc.id, data: d });
        });
        docs.sort(function (a, b) {
          return String(a.data.name || "").localeCompare(String(b.data.name || ""));
        });
        count.textContent = docs.length + " " + noun + (docs.length === 1 ? "" : "s");
        if (!docs.length) {
          var empty = document.createElement("p");
          empty.className = "set-lead";
          empty.textContent = isCharter() ? "No trips yet." : "No services yet.";
          list.appendChild(empty);
        }
        docs.forEach(function (item) {
          var d = item.data;
          var rowEl = document.createElement("div");
          rowEl.className = "set-item";
          var bits = [];
          if (d.durationMinutes) bits.push(d.durationMinutes + " min");
          if (d.price) bits.push("$" + Number(d.price));
          rowEl.innerHTML = "<p><strong>" + esc(d.name || "Untitled") + "</strong><span>" + esc(bits.join(" · ")) + "</span></p>";
          var rm = document.createElement("button");
          rm.type = "button";
          rm.textContent = "Remove";
          rm.addEventListener("click", function () {
            db.collection("tenants").doc(state.tenantId).collection("services").doc(item.id)
              .update({ isActive: false })
              .then(load)
              .catch(function (err) { showMsg(list, callableError(err), false); });
          });
          rowEl.appendChild(rm);
          list.appendChild(rowEl);
        });
      }).catch(function (err) { showMsg(list, callableError(err), false); });
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = form.querySelector("#svcName").value.trim();
      if (!name) return;
      var includeDur = form.querySelector("#svcDurOn").checked;
      var showPrice = form.querySelector("#svcPriceOn").checked;
      var payload = {
        name: name,
        slug: slugify(name),
        isActive: true,
        sortOrder: Date.now(),
      };
      if (includeDur) payload.durationMinutes = Math.max(5, Number(form.querySelector("#svcDur").value) || 60);
      if (showPrice) {
        var price = Number(form.querySelector("#svcPrice").value);
        if (price > 0) payload.price = price;
      }
      db.collection("tenants").doc(state.tenantId).collection("services").add(payload).then(function () {
        setModal(false);
        load();
      }).catch(function (err) { showMsg(form, callableError(err), false); });
    });
    load();
  }

  function paintShipping(body) {
    $("detailTitle").textContent = "Shipping & pickup";
    $("detailLead").textContent = "How clients get shop orders. Saves to the same settings as the iPhone app.";
    var t = state.tenant;
    var card = document.createElement("div");
    card.className = "acct-card";
    card.style.padding = "4px 16px";
    function saveFlag(key, value) {
      var patch = {};
      patch[key] = value;
      db.collection("tenants").doc(state.tenantId).update(patch).then(function () {
        state.tenant[key] = value;
        showMsg(card, "Saved", true);
      }).catch(function (err) { showMsg(card, callableError(err), false); });
    }
    var pickupAddr = toggleRow("Show pickup address at checkout", "Clients see your business address when they choose pickup.", t.shopShowPickupAddressOnCheckout !== false, function (on) {
      saveFlag("shopShowPickupAddressOnCheckout", on);
    });
    pickupAddr.classList.add("set-toggle--sub");
    card.appendChild(toggleRow("Local pickup", "Clients can pick up shop orders.", t.shopPickupEnabled !== false, function (on) {
      saveFlag("shopPickupEnabled", on);
      pickupAddr.classList.toggle("hidden", !on);
    }));
    pickupAddr.classList.toggle("hidden", t.shopPickupEnabled === false);
    card.appendChild(pickupAddr);
    card.appendChild(toggleRow("Shipping", "Offer shipping on shop orders.", t.shopShippingEnabled === true, function (on) {
      saveFlag("shopShippingEnabled", on);
      ship.classList.toggle("hidden", !on);
    }));
    body.appendChild(card);

    // Shipping details: only while shipping is on.
    var ship = document.createElement("form");
    ship.className = "set-form acct-card set-ship" + (t.shopShippingEnabled === true ? "" : " hidden");
    var drop = t.shopDropOffLocation || t.shopShipFrom || {};
    var parcel = t.shopDefaultParcel || {};
    var origin = [
      [String(t.contactAddress || "").trim(), String(t.contactAddressSuite || "").trim()].filter(Boolean).join(", "),
      String(t.serviceArea || "").trim(),
    ].filter(Boolean).join(", ");
    var val = function (v) { return v == null || v === "" || v === 0 ? "" : esc(String(v)); };
    ship.innerHTML =
      '<h3 class="set-ship-title">Ships from</h3>' +
      '<p class="set-ship-origin' + (origin ? "" : " is-missing") + '">' +
        (origin ? esc(origin) : "Add your business address in the Website builder (Contact) so shipping can be quoted from your ZIP.") + "</p>" +
      '<h3 class="set-ship-title">Drop-off location</h3>' +
      '<p class="set-ship-hint">Where you drop off packages (a post office or carrier store). Optional.</p>' +
      '<label>Place name</label><input type="text" id="shipDropName" placeholder="e.g. USPS Main St" value="' + val(drop.name) + '" />' +
      '<label>Street</label><input type="text" id="shipDropStreet" value="' + val(drop.street1 || drop.line1) + '" />' +
      '<div class="set-ship-row">' +
        '<div><label>City</label><input type="text" id="shipDropCity" value="' + val(drop.city) + '" /></div>' +
        '<div><label>State</label><input type="text" id="shipDropState" maxlength="2" value="' + val(drop.state) + '" /></div>' +
        '<div><label>ZIP</label><input type="text" id="shipDropZip" inputmode="numeric" value="' + val(drop.zip || drop.postal_code) + '" /></div>' +
      "</div>" +
      '<h3 class="set-ship-title">Default box size</h3>' +
      '<p class="set-ship-hint">Used for products without their own size. Left blank, an order ships as 1 lb in a small box.</p>' +
      '<div class="set-ship-row set-ship-row--4">' +
        '<div><label>Weight (oz)</label><input type="text" inputmode="decimal" id="shipWeight" value="' + val(parcel.weightOz) + '" /></div>' +
        '<div><label>Length (in)</label><input type="text" inputmode="decimal" id="shipLength" value="' + val(parcel.lengthIn) + '" /></div>' +
        '<div><label>Width (in)</label><input type="text" inputmode="decimal" id="shipWidth" value="' + val(parcel.widthIn) + '" /></div>' +
        '<div><label>Height (in)</label><input type="text" inputmode="decimal" id="shipHeight" value="' + val(parcel.heightIn) + '" /></div>' +
      "</div>" +
      '<div class="set-actions"><button type="submit" class="set-save">Save shipping details</button></div>';
    body.appendChild(ship);

    ship.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var get = function (id) { return ship.querySelector("#" + id).value.trim(); };
      var num = function (id) {
        var n = parseFloat(get(id).replace(/[^0-9.]/g, ""));
        return n > 0 ? n : 0;
      };
      var del = firebase.firestore.FieldValue.delete();
      var dropOff = {};
      if (get("shipDropName")) dropOff.name = get("shipDropName");
      if (get("shipDropStreet")) dropOff.street1 = get("shipDropStreet");
      if (get("shipDropCity")) dropOff.city = get("shipDropCity");
      if (get("shipDropState")) dropOff.state = get("shipDropState").toUpperCase();
      if (get("shipDropZip")) dropOff.zip = get("shipDropZip");
      var box = {};
      [["shipWeight", "weightOz"], ["shipLength", "lengthIn"], ["shipWidth", "widthIn"], ["shipHeight", "heightIn"]].forEach(function (f) {
        var n = num(f[0]);
        if (n > 0) box[f[1]] = n;
      });
      // Same fields the iPhone app saves; quotes always use the business address, so the old custom origin is cleared.
      var patch = {
        shopShipFrom: del,
        shopDropOffLocation: Object.keys(dropOff).length ? dropOff : del,
        shopDefaultParcel: Object.keys(box).length ? box : del,
      };
      var btn = ship.querySelector(".set-save");
      btn.disabled = true;
      db.collection("tenants").doc(state.tenantId).update(patch).then(function () {
        state.tenant.shopDropOffLocation = Object.keys(dropOff).length ? dropOff : null;
        state.tenant.shopDefaultParcel = Object.keys(box).length ? box : null;
        delete state.tenant.shopShipFrom;
        showMsg(ship, "Saved", true);
      }).catch(function (err) {
        showMsg(ship, callableError(err), false);
      }).then(function () { btn.disabled = false; });
    });
  }

  /** One place for texting settings: the panel on the Messages page (same as the iPhone app's). */
  function openMessagingSettings() {
    var url = "/app/messages?settings=1";
    try {
      if (window.top !== window.self) { window.top.location.href = url; return; }
    } catch (e) {}
    window.location.href = url;
  }

  function paintMessaging(body) {
    $("detailTitle").textContent = "Messaging";
    var card = document.createElement("form");
    card.className = "set-form acct-card";
    card.style.padding = "16px";
    if (!smsOn()) {
      $("detailLead").textContent = "Client texting is off for this shop. Turn it on in the Get Bookking app to send texts from your number.";
    } else {
      var used = state.tenant.smsMonthlyLimit
        ? (Number(state.tenant.smsMonthlyLimit) - Number(state.tenant.smsMonthlyUsageRemaining || 0))
        : 0;
      $("detailLead").textContent = state.tenant.smsPhoneNumber + " · " + used + " of " + (state.tenant.smsMonthlyLimit || 0) + " texts this month.";
    }
    var cLabel = document.createElement("label");
    cLabel.textContent = "Confirmation text";
    var confirmed = document.createElement("textarea");
    confirmed.value = state.tenant.smsPresetConfirmed || "";
    var dLabel = document.createElement("label");
    dLabel.textContent = "Decline text";
    var declined = document.createElement("textarea");
    declined.value = state.tenant.smsPresetDeclined || "";
    card.appendChild(cLabel);
    card.appendChild(confirmed);
    card.appendChild(dLabel);
    card.appendChild(declined);
    var actions = document.createElement("div");
    actions.className = "set-actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "set-save";
    save.textContent = "Save";
    actions.appendChild(save);
    card.appendChild(actions);
    card.addEventListener("submit", function (ev) {
      ev.preventDefault();
      save.disabled = true;
      fns.httpsCallable("updateTenantMessagingPresets")({
        smsPresetConfirmed: confirmed.value,
        smsPresetDeclined: declined.value,
        smsQuickPresets: Array.isArray(state.tenant.smsQuickPresets) ? state.tenant.smsQuickPresets : undefined,
      }).then(function () {
        state.tenant.smsPresetConfirmed = confirmed.value;
        state.tenant.smsPresetDeclined = declined.value;
        showMsg(card, "Saved", true);
      }).catch(function (err) {
        showMsg(card, callableError(err), false);
      }).then(function () { save.disabled = false; });
    });
    body.appendChild(card);
  }

  function paintNotifications(body) {
    $("detailTitle").textContent = "Notifications";
    var card = document.createElement("div");
    card.className = "acct-card";
    card.style.padding = "4px 16px";
    if (!smsOn()) {
      var note = document.createElement("p");
      note.className = "set-lead";
      note.textContent = "Client texts require client texting.";
      card.appendChild(note);
    }
    card.appendChild(toggleRow(
      "Send client text notifications",
      smsOn() ? "Texts clients about their bookings." : "Requires client texting.",
      perms().sendClientNotifications,
      function (on, input) {
        if (!smsOn()) { input.checked = false; return; }
        savePolicy({ sendClientNotifications: on }, {}, card);
      }
    ));
    card.appendChild(toggleRow(
      "Daily summary email",
      "One email with the day’s bookings.",
      notes().dailySummaryEmail,
      function (on) { savePolicy({}, { dailySummaryEmail: on }, card); }
    ));
    body.appendChild(card);
  }

  function paintBoats(body) {
    $("detailTitle").textContent = "Boats";
    var boats = Array.isArray(state.tenant.charterBoats) ? state.tenant.charterBoats.slice() : [];
    var list = document.createElement("div");
    list.className = "acct-card";
    list.style.padding = "4px 16px 8px";
    function draw() {
      list.innerHTML = "";
      if (!boats.length) {
        var empty = document.createElement("p");
        empty.className = "set-lead";
        empty.textContent = "No boats yet.";
        list.appendChild(empty);
      }
      boats.forEach(function (boat, index) {
        var rowEl = document.createElement("div");
        rowEl.className = "set-item";
        rowEl.innerHTML = "<p><strong>" + esc(boat.boatType || "Boat") + "</strong><span>" + esc((boat.maxPeople || 1) + " people") + "</span></p>";
        var rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "Remove";
        rm.addEventListener("click", function () {
          boats.splice(index, 1);
          save();
        });
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
    }
    function save() {
      db.collection("tenants").doc(state.tenantId).update({ charterBoats: boats }).then(function () {
        state.tenant.charterBoats = boats;
        draw();
        showMsg(form, "Saved", true);
      }).catch(function (err) { showMsg(form, callableError(err), false); });
    }
    var form = document.createElement("form");
    form.className = "set-form acct-card";
    form.style.padding = "16px";
    form.style.marginTop = "16px";
    form.innerHTML = '<label>Boat type</label><input type="text" id="boatType" required />' +
      '<label>Max people</label><input type="number" id="boatPeople" min="1" max="50" value="6" />' +
      '<div class="set-actions"><button type="submit" class="set-save">Add boat</button></div>';
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var type = form.querySelector("#boatType").value.trim();
      if (!type) return;
      boats.push({
        id: "boat-" + Date.now(),
        boatType: type,
        maxPeople: Math.max(1, Math.min(50, Number(form.querySelector("#boatPeople").value) || 6)),
        imageUrl: "",
      });
      form.reset();
      save();
    });
    body.appendChild(list);
    body.appendChild(form);
    draw();
  }

  function paintDesign(body) {
    $("detailTitle").textContent = "Design & services";
    $("detailLead").textContent = "Controls editing services and pricing on Design.";
    var card = document.createElement("div");
    card.className = "acct-card";
    card.style.padding = "4px 16px";
    card.appendChild(toggleRow("Edit services & pricing", "Managers can edit services and prices.", perms().editServicesPricing, function (on) {
      savePolicy({ editServicesPricing: on }, {}, card);
    }));
    card.appendChild(linkRow("Open Design", "/design"));
    body.appendChild(card);
  }

  function paintClients(body) {
    $("detailTitle").textContent = "Clients & reports";
    var card = document.createElement("div");
    card.className = "acct-card";
    card.style.padding = "4px 16px";
    card.appendChild(toggleRow("Access client list", "Clients drawer.", perms().accessClientList, function (on) {
      savePolicy({ accessClientList: on }, {}, card);
    }));
    card.appendChild(toggleRow("View earnings & reports", "Insights and payments areas.", perms().viewEarningsReports, function (on) {
      savePolicy({ viewEarningsReports: on }, {}, card);
    }));
    body.appendChild(card);
  }

  function paintDomain(body) {
    $("detailTitle").textContent = "Domain";
    var slug = String(state.tenant.slug || "").trim();
    var custom = String(state.tenant.customDomain || "").trim();
    var card = document.createElement("div");
    card.className = "acct-card";
    card.style.padding = "16px";
    var book = document.createElement("p");
    book.innerHTML = "<strong>Get Bookking address</strong><br>" + esc(slug ? slug + ".getbookking.com" : "Not set");
    var own = document.createElement("p");
    own.style.marginTop = "12px";
    own.innerHTML = "<strong>Custom domain</strong><br>" + esc(custom || "None connected");
    var note = document.createElement("p");
    note.className = "set-lead";
    note.style.marginTop = "12px";
    note.textContent = "Buying or connecting a domain stays in the Get Bookking app.";
    card.appendChild(book);
    card.appendChild(own);
    card.appendChild(note);
    body.appendChild(card);
  }

  function paintProfile(body) {
    var owner = isOwner();
    $("detailTitle").textContent = owner ? "Your booking profile" : "My booking type";
    var personal = (state.userData.workflow && state.userData.workflow.confirmationType) || "request_approve";
    var form = document.createElement("form");
    form.className = "set-form acct-card";
    form.style.padding = "16px";
    if (!owner && managersLock()) {
      $("detailLead").textContent = "Your owner set the team booking type in Booking settings.";
      body.appendChild(form);
      return;
    }
    var label = document.createElement("label");
    label.textContent = "Booking type";
    var select = document.createElement("select");
    BOOKING_TYPES.forEach(function (pair) {
      if (pair[0] === "calendar_slots") return;
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (opt.value === personal) opt.selected = true;
      select.appendChild(opt);
    });
    var depLabel = document.createElement("label");
    depLabel.textContent = "Deposit amount";
    var dep = document.createElement("input");
    dep.type = "number";
    dep.min = "0";
    dep.step = "0.01";
    dep.value = state.userData.workflow && state.userData.workflow.depositAmount ? String(state.userData.workflow.depositAmount) : "";
    form.appendChild(label);
    form.appendChild(select);
    form.appendChild(depLabel);
    form.appendChild(dep);
    var actions = document.createElement("div");
    actions.className = "set-actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "set-save";
    save.textContent = "Save";
    actions.appendChild(save);
    form.appendChild(actions);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var wfData = {
        confirmationType: select.value,
        responseTimeHours: (state.userData.workflow && state.userData.workflow.responseTimeHours) || 24,
      };
      if (select.value === "deposit_to_confirm" || select.value === "approve_and_deposit") {
        var amount = Number(dep.value);
        if (amount > 0) wfData.depositAmount = amount;
      }
      db.collection("users").doc(state.user.uid).set({ workflow: wfData }, { merge: true }).then(function () {
        state.userData.workflow = wfData;
        showMsg(form, "Saved", true);
      }).catch(function (err) { showMsg(form, callableError(err), false); });
    });
    body.appendChild(form);
  }

  function defaultWeekly() {
    var weekly = {};
    DAY_KEYS.forEach(function (key, i) {
      var closed = i >= 5;
      weekly[key] = closed
        ? { closed: true, ranges: [] }
        : { closed: false, ranges: [{ openMin: 540, closeMin: 1020 }] };
    });
    return weekly;
  }

  function minutesToTime(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  function timeToMinutes(value) {
    var bits = String(value || "09:00").split(":");
    return (Number(bits[0]) || 0) * 60 + (Number(bits[1]) || 0);
  }
  function fmtMin(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    var ap = h >= 12 ? "PM" : "AM";
    var hr = h % 12;
    if (hr === 0) hr = 12;
    return hr + ":" + String(m).padStart(2, "0") + " " + ap;
  }

  function paintSchedule(body) {
    $("detailTitle").textContent = "Scheduling & hours";
    $("detailLead").textContent = "Weekly hours show on your public site. Days off block those dates.";
    var weekly = state.tenant.businessHoursWeekly && typeof state.tenant.businessHoursWeekly === "object"
      ? JSON.parse(JSON.stringify(state.tenant.businessHoursWeekly))
      : defaultWeekly();
    var form = document.createElement("form");
    form.className = "set-form acct-card";
    form.style.padding = "16px";
    DAY_KEYS.forEach(function (key, i) {
      var day = weekly[key] || { closed: true, ranges: [] };
      var range = (day.ranges && day.ranges[0]) || { openMin: 540, closeMin: 1020 };
      var line = document.createElement("div");
      line.className = "set-day";
      line.innerHTML = "<span>" + DAY_NAMES[i] + "</span>" +
        '<input type="time" data-open="' + key + '" value="' + minutesToTime(range.openMin || 540) + '" />' +
        '<input type="time" data-close="' + key + '" value="' + minutesToTime(range.closeMin || 1020) + '" />';
      var closed = document.createElement("label");
      closed.style.fontSize = "13px";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.closed = key;
      box.checked = day.closed !== false && !(day.ranges && day.ranges.length) ? true : !!day.closed;
      if (day.closed === false) box.checked = false;
      closed.appendChild(box);
      closed.appendChild(document.createTextNode(" Closed"));
      line.appendChild(closed);
      form.appendChild(line);
    });

    form.appendChild(toggleRow(
      "Show hours on site",
      "Uses the weekly hours on your public page.",
      state.tenant.showBusinessHoursOnPage !== false,
      function () {}
    ));

    var tzLabel = document.createElement("label");
    tzLabel.textContent = "Time zone";
    var tz = document.createElement("select");
    var currentTz = state.tenant.timeZone || (state.userData.availability && state.userData.availability.timeZone) || "America/New_York";
    var zoneList = ZONES.slice();
    if (zoneList.indexOf(currentTz) === -1) zoneList.unshift(currentTz);
    zoneList.forEach(function (z) {
      var opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      if (z === currentTz) opt.selected = true;
      tz.appendChild(opt);
    });
    form.appendChild(tzLabel);
    form.appendChild(tz);

    var offLabel = document.createElement("label");
    offLabel.textContent = "Add a day off";
    var off = document.createElement("input");
    off.type = "date";
    form.appendChild(offLabel);
    form.appendChild(off);
    var offList = document.createElement("div");
    var blocked = Array.isArray(state.tenant.blockedDates) ? state.tenant.blockedDates.slice() : [];
    function drawOff() {
      offList.innerHTML = "";
      blocked.forEach(function (ymd, index) {
        var line = document.createElement("div");
        line.className = "set-item";
        line.innerHTML = "<p><strong>" + esc(ymd) + "</strong></p>";
        var rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "Remove";
        rm.addEventListener("click", function () {
          blocked.splice(index, 1);
          drawOff();
        });
        line.appendChild(rm);
        offList.appendChild(line);
      });
    }
    off.addEventListener("change", function () {
      if (!off.value || blocked.indexOf(off.value) !== -1) return;
      blocked.push(off.value);
      blocked.sort();
      off.value = "";
      drawOff();
    });
    form.appendChild(offList);
    drawOff();

    var actions = document.createElement("div");
    actions.className = "set-actions";
    var save = document.createElement("button");
    save.type = "submit";
    save.className = "set-save";
    save.textContent = "Save";
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var nextWeekly = {};
      var lines = [];
      DAY_KEYS.forEach(function (key, i) {
        var closed = form.querySelector('[data-closed="' + key + '"]').checked;
        var openMin = timeToMinutes(form.querySelector('[data-open="' + key + '"]').value);
        var closeMin = timeToMinutes(form.querySelector('[data-close="' + key + '"]').value);
        if (closed) {
          nextWeekly[key] = { closed: true, ranges: [] };
          lines.push(DAY_NAMES[i].slice(0, 3) + " Closed");
        } else {
          nextWeekly[key] = { closed: false, ranges: [{ openMin: openMin, closeMin: closeMin }] };
          lines.push(DAY_NAMES[i].slice(0, 3) + " " + fmtMin(openMin) + "–" + fmtMin(closeMin));
        }
      });
      var show = form.querySelector('input[type="checkbox"]').checked;
      var showBox = form.querySelector(".set-toggle input");
      if (showBox) show = showBox.checked;
      var patch = {
        businessHoursWeekly: nextWeekly,
        businessHours: lines.join("\n"),
        showBusinessHoursOnPage: show,
        timeZone: tz.value,
        blockedDates: blocked,
      };
      var overrides = state.tenant.webCopyOverrides;
      if (overrides && typeof overrides === "object" && overrides["wc.contact.hours"] != null) {
        var copy = Object.assign({}, overrides);
        delete copy["wc.contact.hours"];
        patch.webCopyOverrides = copy;
      }
      var dayIndex = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
      var avail = Object.assign({}, state.userData.availability || {});
      avail.timeZone = tz.value;
      avail.blockedDates = blocked;
      avail.daysOpen = DAY_KEYS.filter(function (key) {
        return nextWeekly[key] && nextWeekly[key].closed !== true;
      }).map(function (key) { return dayIndex[key]; }).sort();
      save.disabled = true;
      db.collection("tenants").doc(state.tenantId).update(patch).then(function () {
        return db.collection("users").doc(state.user.uid).set({ availability: avail }, { merge: true });
      }).then(function () {
        Object.assign(state.tenant, patch);
        state.userData.availability = avail;
        showMsg(form, "Saved", true);
      }).catch(function (err) {
        showMsg(form, callableError(err), false);
      }).then(function () { save.disabled = false; });
    });
    body.appendChild(form);
  }

  function paintPayments(body) {
    $("detailTitle").textContent = "Payment settings";
    var card = document.createElement("div");
    card.className = "set-form acct-card";
    card.style.padding = "16px";
    var status = document.createElement("p");
    status.textContent = "Checking Stripe…";
    card.appendChild(status);

    var descLabel = document.createElement("label");
    descLabel.textContent = "Statement descriptor";
    var desc = document.createElement("input");
    desc.type = "text";
    desc.maxLength = 22;
    desc.placeholder = "5–22 letters, numbers, spaces";
    var descHelp = document.createElement("p");
    descHelp.className = "set-lead";
    descHelp.textContent = "Shown on bank and card statements. Letters, numbers, periods, and spaces.";
    var descSave = document.createElement("button");
    descSave.type = "button";
    descSave.className = "set-save";
    descSave.textContent = "Save descriptor";
    descSave.addEventListener("click", function () {
      descSave.disabled = true;
      fns.httpsCallable("updateStatementDescriptor")({
        statementDescriptor: desc.value,
      }).then(function (res) {
        var data = res.data || {};
        if (data.statementDescriptor) desc.value = data.statementDescriptor;
        showMsg(card, "Saved", true);
      }).catch(function (err) {
        showMsg(card, callableError(err), false);
      }).then(function () { descSave.disabled = false; });
    });

    card.appendChild(descLabel);
    card.appendChild(desc);
    card.appendChild(descHelp);
    var actions = document.createElement("div");
    actions.className = "set-actions";
    actions.appendChild(descSave);
    card.appendChild(actions);

    card.appendChild(toggleRow(
      "Online sales tax",
      "Shop and website checkout. Calculated by Stripe Tax.",
      state.tenant.shopTaxEnabled === true,
      function (on, input) {
        db.collection("tenants").doc(state.tenantId).update({ shopTaxEnabled: on }).then(function () {
          state.tenant.shopTaxEnabled = on;
          showMsg(card, "Saved", true);
        }).catch(function (err) {
          input.checked = !on;
          showMsg(card, callableError(err), false);
        });
      }
    ));
    card.appendChild(toggleRow(
      "In-person sales tax",
      "Manual payment and Tap to Pay. Shown on checkout and receipts.",
      state.tenant.inPersonTaxEnabled === true,
      function (on, input) {
        db.collection("tenants").doc(state.tenantId).update({ inPersonTaxEnabled: on }).then(function () {
          state.tenant.inPersonTaxEnabled = on;
          showMsg(card, "Saved", true);
        }).catch(function (err) {
          input.checked = !on;
          showMsg(card, callableError(err), false);
        });
      }
    ));
    card.appendChild(linkRow("Open client payments", "/app/payments"));
    body.appendChild(card);

    fns.httpsCallable("getConnectAccountStatus")({ skipEmailReconcile: true }).then(function (res) {
      var data = res.data || {};
      state.connect = data;
      if (data.chargesEnabled) status.textContent = "Stripe connected";
      else if (data.detailsSubmitted) status.textContent = "Stripe in review";
      else if (data.hasAccount) status.textContent = "Stripe setup started";
      else status.textContent = "Stripe not connected";
      if (data.statementDescriptor) desc.value = data.statementDescriptor;
    }).catch(function () {
      status.textContent = "Stripe not connected";
    });
  }

  $("backBtn").addEventListener("click", function () {
    state.stack.pop();
    paint();
  });

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    state.user = user;
    var name = user.displayName || user.email || "Account";
    $("whoName").textContent = name;
    $("whoEmail").textContent = user.email || "";
    $("avatar").textContent = name.trim().charAt(0).toUpperCase() || "?";
    db.collection("users").doc(user.uid).get().then(function (userSnap) {
      state.userData = userSnap.exists ? (userSnap.data() || {}) : {};
      state.tenantId = state.userData.tenantId || "";
      if (!state.tenantId) {
        $("hubRows").innerHTML = "<p class=\"set-lead\">No shop is linked to this account.</p>";
        return;
      }
      return db.collection("tenants").doc(state.tenantId).get();
    }).then(function (tenantSnap) {
      if (!tenantSnap) return;
      state.tenant = tenantSnap.exists ? (tenantSnap.data() || {}) : {};
      paint();
    }).catch(function (err) {
      $("hubRows").textContent = callableError(err);
    });
  });
})();
