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
      if (smsOn()) business.push(row("Messaging", "", function () { openScreen("messaging"); }));
      business.push(row("Domain", "", function () { openScreen("domain"); }));
      if (team) business.push(row("Your booking profile", "", function () { openScreen("profile"); }));
      business.push(row("Scheduling & hours", "", function () { openScreen("schedule"); }));
      host.appendChild(section("Business", business));
      host.appendChild(section("Payments", [
        row("Payment settings", "", function () { openScreen("payments"); }),
      ]));
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
    };
    (screens[name] || paintBusiness)(body);
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
    card.appendChild(row("Messaging", "", function () { openScreen("messaging"); }));
    if (!isCharter()) card.appendChild(row("Notifications", "", function () { openScreen("notifications"); }));
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
    function syncDep() {
      var v = select.value;
      depWrap.style.display = (v === "deposit_to_confirm" || v === "approve_and_deposit") ? "" : "none";
    }
    select.addEventListener("change", syncDep);
    syncDep();
    form.appendChild(typeLabel);
    form.appendChild(select);
    form.appendChild(depWrap);

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
      var boxes = form.querySelectorAll('input[type="checkbox"]');
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
      if (chosen === "deposit_to_confirm" || chosen === "approve_and_deposit") {
        var amount = Number(dep.value);
        if (amount > 0) payload.depositAmount = amount;
      }
      save.disabled = true;
      fns.httpsCallable("updateTenantBookingWorkflow")(payload).then(function () {
        var next = Object.assign({}, workflow(), payload);
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
    var list = document.createElement("div");
    list.className = "acct-card";
    list.style.padding = "4px 16px 8px";
    body.appendChild(list);
    var form = document.createElement("form");
    form.className = "set-form acct-card";
    form.style.padding = "16px";
    form.style.marginTop = "16px";
    form.innerHTML = '<label>Name</label><input type="text" id="svcName" required />' +
      '<label class="set-toggle"><div><strong>Include duration</strong></div><input type="checkbox" id="svcDurOn" /></label>' +
      '<label>Duration (minutes)</label><input type="number" id="svcDur" min="5" step="5" value="60" />' +
      '<label class="set-toggle"><div><strong>Show starting price</strong></div><input type="checkbox" id="svcPriceOn" /></label>' +
      '<label>Price</label><input type="number" id="svcPrice" min="0" step="0.01" />' +
      '<div class="set-actions"><button type="submit" class="set-save">Add</button></div>';
    body.appendChild(form);

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
              .catch(function (err) { showMsg(form, callableError(err), false); });
          });
          rowEl.appendChild(rm);
          list.appendChild(rowEl);
        });
      }).catch(function (err) { showMsg(form, callableError(err), false); });
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
        form.reset();
        showMsg(form, "Saved", true);
        load();
      }).catch(function (err) { showMsg(form, callableError(err), false); });
    });
    load();
  }

  function paintShipping(body) {
    $("detailTitle").textContent = "Shipping & pickup";
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
    card.appendChild(toggleRow("Local pickup", "Clients can pick up shop orders.", state.tenant.shopPickupEnabled !== false, function (on) {
      saveFlag("shopPickupEnabled", on);
    }));
    card.appendChild(toggleRow("Shipping", "Offer shipping on shop orders.", state.tenant.shopShippingEnabled === true, function (on) {
      saveFlag("shopShippingEnabled", on);
    }));
    body.appendChild(card);
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
