/**
 * Shop portal Team: the people on this shop (same server functions as the iPhone app's Team tab).
 * Owners invite people with a link, set roles and job titles, choose who takes bookings, and remove
 * people. Managers can see the team.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var INVITE_ORIGIN = "https://join.getbookking.com";
  var ROLE_LABEL = { owner: "Owner", manager: "Manager", member: "Staff" };

  var state = { session: null, members: [], ownerUid: "", openUid: "", wired: false, loading: false, invite: null, tab: "people" };

  // Same names and defaults the server and iPhone app use (functions DEFAULT_MANAGER_*).
  var PERM_DEFAULTS = {
    viewAllBookings: true, approveRejectRequests: true, editServicesPricing: false, manageBookingFormStyle: false,
    manageArtistSchedules: false, accessClientList: false, viewEarningsReports: false, sendClientNotifications: true,
  };
  var NOTE_DEFAULTS = { onNewBooking: true, onCancellation: true, dailySummaryEmail: false };
  var PERM_GROUPS = [
    ["Bookings", [
      ["perm", "viewAllBookings", "View all bookings", "See every booking, not only their own."],
      ["perm", "approveRejectRequests", "Approve and reject requests", "Confirm or decline new booking requests."],
      ["perm", "manageArtistSchedules", "Manage staff schedules", "Change other people's hours and time off."],
    ]],
    ["Services and website", [
      ["perm", "editServicesPricing", "Edit services and prices", "Change the service list and pricing."],
      ["perm", "manageBookingFormStyle", "Edit the booking form", "Change the booking form's style and questions."],
    ]],
    ["Clients and money", [
      ["perm", "accessClientList", "See the client list", "Open Clients and client profiles."],
      ["perm", "viewEarningsReports", "See earnings and reports", "Open Insights and Payments."],
    ]],
    ["Manager alerts", [
      ["note", "onNewBooking", "New booking", "Managers get a notification for each new booking."],
      ["note", "onCancellation", "Cancellation", "Managers get a notification when a booking is cancelled."],
    ]],
  ];

  function current(kind) {
    var t = (state.session && state.session.tenant) || {};
    var raw = (kind === "perm" ? t.managerPermissions : t.managerNotifications) || {};
    var defs = kind === "perm" ? PERM_DEFAULTS : NOTE_DEFAULTS;
    var out = {};
    Object.keys(defs).forEach(function (k) { out[k] = typeof raw[k] === "boolean" ? raw[k] : defs[k]; });
    return out;
  }

  function paintPermissions() {
    var host = $("teamPermissions");
    if (!host) return;
    var canEdit = isOwner();
    var perm = current("perm");
    var note = current("note");
    host.innerHTML =
      '<p class="app-hint app-team-perm-lead">' + (canEdit
        ? "These apply to everyone with the Manager role. Staff always see their own bookings and clients."
        : "Only the owner can change these.") + "</p>" +
      PERM_GROUPS.map(function (g) {
        return '<article class="app-card app-team-perm-card"><div class="app-card-head"><h2>' + esc(g[0]) + "</h2></div><div class=\"app-team-perm-body\">" +
          g[1].map(function (r) {
            var on = r[0] === "perm" ? perm[r[1]] : note[r[1]];
            return toggleRow("perm_" + r[1], r[2], r[3], on, !canEdit).replace("<input ", '<input data-policy-kind="' + r[0] + '" data-policy-key="' + r[1] + '" ');
          }).join("") + "</div></article>";
      }).join("") +
      '<p class="app-sheet-error hidden" id="teamPermError"></p>';
  }

  function savePermission(input) {
    var kind = input.getAttribute("data-policy-kind");
    var key = input.getAttribute("data-policy-key");
    var perm = current("perm");
    var note = current("note");
    if (kind === "perm") perm[key] = input.checked;
    else note[key] = input.checked;
    input.disabled = true;
    fns().httpsCallable("updateTenantManagerPolicy")({ managerPermissions: perm, managerNotifications: note }).then(function () {
      state.session.tenant.managerPermissions = perm;
      state.session.tenant.managerNotifications = note;
    }).catch(function (e) {
      input.checked = !input.checked;
      var err = $("teamPermError");
      if (err) {
        err.textContent = (e && e.message) || "Couldn't save that change.";
        err.classList.remove("hidden");
      }
    }).then(function () {
      input.disabled = false;
    });
  }

  function setTab(tab) {
    state.tab = tab === "permissions" ? "permissions" : "people";
    document.querySelectorAll("[data-team-tab]").forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-team-tab") === state.tab);
    });
    $("teamPeoplePanel").classList.toggle("hidden", state.tab !== "people");
    $("teamPermissions").classList.toggle("hidden", state.tab !== "permissions");
    if (state.tab === "permissions") paintPermissions();
  }

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fns() {
    return firebase.app().functions(REGION);
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }

  function isOwner() {
    return !!(state.session && state.session.isOwner);
  }

  function role(m) {
    return String(m.accessRole || m.role || "member").toLowerCase();
  }

  function avatar(m, size) {
    var cls = "app-team-avatar" + (size === "lg" ? " is-lg" : "");
    if (m.profilePhotoUrl) return '<span class="' + cls + '"><img src="' + esc(m.profilePhotoUrl) + '" alt=""></span>';
    return '<span class="' + cls + '" aria-hidden="true">' + esc(initials(m.displayName)) + "</span>";
  }

  function byUid(uid) {
    return state.members.filter(function (m) { return m.uid === uid; })[0] || null;
  }

  /* ── List ── */

  function paintList() {
    var host = $("teamList");
    if (!host) return;
    var inviteBtn = $("teamInviteBtn");
    if (inviteBtn) inviteBtn.classList.toggle("hidden", !isOwner());
    if (state.loading && !state.members.length) {
      host.innerHTML = '<p class="app-empty">Loading your team…</p>';
      return;
    }
    if (!state.members.length) {
      host.innerHTML = '<div class="app-req-empty"><strong>Just you so far</strong><span>Invite someone to share bookings, the calendar, and payments.</span></div>';
      return;
    }
    host.innerHTML = state.members.map(function (m) {
      var r = role(m);
      var bits = [m.jobTitle || ROLE_LABEL[r] || "Staff"];
      if (m.email) bits.push(m.email);
      return '<button type="button" class="app-req-row' + (m.uid === state.openUid ? " is-active" : "") + '" data-team-open="' + esc(m.uid) + '">' +
        avatar(m) +
        '<span class="app-req-copy"><strong>' + esc(m.displayName || "Member") + "</strong><span>" + esc(bits.join(" · ")) + "</span></span>" +
        '<span class="app-req-side"><span class="app-req-chip' + (r === "owner" ? " is-ok" : r === "manager" ? " is-wait" : "") + '">' + esc(ROLE_LABEL[r] || "Staff") + "</span>" +
        (m.isBookable === false ? '<time>Not taking bookings</time>' : "") + "</span>" +
        "</button>";
    }).join("");
  }

  /* ── Detail ── */

  function toggleRow(id, label, hint, on, disabled) {
    return '<label class="app-team-toggle">' +
      '<span><strong>' + esc(label) + "</strong>" + (hint ? "<em>" + esc(hint) + "</em>" : "") + "</span>" +
      '<input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + (disabled ? " disabled" : "") + ">" +
      '<i aria-hidden="true"></i></label>';
  }

  function paintDetail() {
    var m = byUid(state.openUid);
    var body = $("teamDetailBody");
    if (!m || !body) return;
    var r = role(m);
    var canEdit = isOwner();
    var editingOwner = r === "owner";
    $("teamDetailTitle").textContent = m.displayName || "Member";
    var contact = [];
    if (m.phone) contact.push('<a class="app-btn app-btn--ghost app-btn--small" href="tel:' + esc(m.phone) + '">Call</a>');
    if (m.email) contact.push('<a class="app-btn app-btn--ghost app-btn--small" href="mailto:' + esc(m.email) + '">Email</a>');
    var html =
      '<div class="app-team-hero">' + avatar(m, "lg") +
      "<div><p>" + esc(m.jobTitle || ROLE_LABEL[r] || "Staff") + "</p><span>" + esc([m.email, m.phone].filter(Boolean).join(" · ")) + "</span></div></div>" +
      (contact.length ? '<div class="app-req-links">' + contact.join("") + "</div>" : "");

    if (canEdit && !editingOwner) {
      html +=
        '<h3 class="app-req-h">Role</h3>' +
        '<div class="app-seg app-team-role" role="radiogroup">' +
        '<button type="button" data-team-role="member" class="' + (r === "member" ? "is-on" : "") + '">Staff</button>' +
        '<button type="button" data-team-role="manager" class="' + (r === "manager" ? "is-on" : "") + '">Manager</button>' +
        "</div>" +
        '<p class="app-hint">' + (r === "manager"
          ? "Managers can help run the shop. Choose what they can do under Permissions."
          : "Staff see their own bookings and clients.") + ' <button type="button" class="app-btn app-btn--warm" data-team-goto="permissions">Manager permissions</button></p>';
    }
    if (canEdit) {
      html +=
        '<div class="app-field"><label for="teamJobTitle">Job title</label><input id="teamJobTitle" type="text" maxlength="40" value="' + esc(m.jobTitle || "") + '" placeholder="Barber"></div>' +
        '<h3 class="app-req-h">Booking and website</h3>' +
        toggleRow("teamBookable", "Takes bookings", "Clients can pick this person when they book.", m.isBookable !== false) +
        toggleRow("teamOnPage", "Show on the team page", "", m.showOnTeamPage !== false) +
        toggleRow("teamOnHome", "Show on the home page team section", "", m.showOnTeamHome !== false);
    }
    html += '<h3 class="app-req-h">Hours</h3><p class="app-hint">Working hours are set in Settings → Scheduling and hours.</p>' +
      '<a class="app-btn app-btn--ghost app-btn--small" href="/app?view=settings">Open scheduling</a>' +
      '<p class="app-sheet-error hidden" id="teamError"></p>';
    body.innerHTML = html;

    var acts = [];
    if (canEdit) acts.push('<button type="button" class="app-btn app-btn--primary" data-team-act="save">Save changes</button>');
    if (canEdit && !editingOwner) acts.push('<button type="button" class="app-btn app-btn--ghost app-btn--danger" data-team-act="remove">Remove from team</button>');
    $("teamDetailActions").innerHTML = acts.join("");
  }

  function setOpen(uid) {
    state.openUid = uid || "";
    ["teamDetailSheet", "teamDetailScrim"].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle("hidden", !uid);
    });
    var ph = $("teamPlaceholder");
    if (ph) ph.classList.toggle("hidden", !!uid);
    paintList();
    if (uid) paintDetail();
  }

  function fail(msg) {
    var e = $("teamError");
    if (e) {
      e.textContent = msg;
      e.classList.remove("hidden");
    }
    busy(false);
  }

  function busy(on) {
    document.querySelectorAll("#teamDetailActions button").forEach(function (b) { b.disabled = !!on; });
  }

  function save() {
    var m = byUid(state.openUid);
    if (!m) return;
    var payload = {
      memberUid: m.uid,
      jobTitle: ($("teamJobTitle") || {}).value || "",
      isBookable: !!($("teamBookable") || {}).checked,
      showOnTeamPage: !!($("teamOnPage") || {}).checked,
      showOnTeamHome: !!($("teamOnHome") || {}).checked,
    };
    var on = document.querySelector("[data-team-role].is-on");
    if (on && role(m) !== "owner") payload.accessRole = on.getAttribute("data-team-role");
    busy(true);
    fns().httpsCallable("updateTenantMember")(payload).then(function () {
      return load(state.session, true);
    }).then(function () {
      busy(false);
      paintDetail();
    }).catch(function (e) {
      fail((e && e.message) || "Couldn't save these changes.");
    });
  }

  function remove() {
    var m = byUid(state.openUid);
    if (!m) return;
    if (!global.confirm("Remove " + (m.displayName || "this person") + " from your team? They'll lose access right away.")) return;
    busy(true);
    fns().httpsCallable("removeTenantMember")({ memberUid: m.uid }).then(function () {
      setOpen("");
      return load(state.session, true);
    }).catch(function (e) {
      fail((e && e.message) || "Couldn't remove this person.");
    });
  }

  /* ── Invite ── */

  function setInviteOpen(open) {
    ["teamInviteSheet", "teamInviteScrim"].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle("hidden", !open);
    });
    if (!open) return;
    state.invite = null;
    $("teamInviteResult").classList.add("hidden");
    $("teamInviteForm").classList.remove("hidden");
    $("teamInviteError").classList.add("hidden");
    $("teamInviteTitle").value = "";
  }

  function createInvite(ev) {
    ev.preventDefault();
    var btn = $("teamInviteCreate");
    var err = $("teamInviteError");
    err.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Creating…";
    var on = document.querySelector("[data-invite-role].is-on");
    fns().httpsCallable("createTenantInvite")({
      accessRole: on ? on.getAttribute("data-invite-role") : "member",
      jobTitle: ($("teamInviteTitle").value || "").trim(),
      baseUrl: INVITE_ORIGIN,
    }).then(function (res) {
      var data = (res && res.data) || {};
      var url = data.joinUrl || (data.token ? INVITE_ORIGIN + "/join?t=" + encodeURIComponent(data.token) : "");
      if (!url) throw new Error("Couldn't create the invite link.");
      state.invite = url;
      $("teamInviteLink").value = url;
      $("teamInviteForm").classList.add("hidden");
      $("teamInviteResult").classList.remove("hidden");
    }).catch(function (e) {
      err.textContent = (e && e.message) || "Couldn't create the invite link.";
      err.classList.remove("hidden");
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "Create invite link";
    });
  }

  function copyInvite() {
    var input = $("teamInviteLink");
    var done = function () {
      var b = $("teamInviteCopy");
      b.textContent = "Copied";
      setTimeout(function () { b.textContent = "Copy link"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done).catch(function () { input.select(); });
    } else {
      input.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
    }
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("teamList").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-team-open]");
      if (b) setOpen(b.getAttribute("data-team-open"));
    });
    ["teamDetailClose", "teamDetailScrim"].forEach(function (id) {
      $(id).addEventListener("click", function () { setOpen(""); });
    });
    $("teamDetailBody").addEventListener("click", function (ev) {
      if (ev.target.closest("[data-team-goto]")) return setTab("permissions");
      var b = ev.target.closest("[data-team-role]");
      if (!b) return;
      document.querySelectorAll("[data-team-role]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
    });
    $("teamDetailActions").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-team-act]");
      if (!b) return;
      if (b.getAttribute("data-team-act") === "save") save();
      else remove();
    });
    $("teamInviteBtn").addEventListener("click", function () { setInviteOpen(true); });
    ["teamInviteClose", "teamInviteScrim", "teamInviteDone"].forEach(function (id) {
      $(id).addEventListener("click", function () { setInviteOpen(false); });
    });
    $("teamInviteForm").addEventListener("submit", createInvite);
    $("teamInviteForm").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-invite-role]");
      if (!b) return;
      document.querySelectorAll("[data-invite-role]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
    });
    $("teamInviteCopy").addEventListener("click", copyInvite);
    $("teamTabs").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-team-tab]");
      if (b) setTab(b.getAttribute("data-team-tab"));
    });
    $("teamPermissions").addEventListener("change", function (ev) {
      if (ev.target.matches("[data-policy-key]")) savePermission(ev.target);
    });
  }

  function load(session, force) {
    state.session = session;
    wire();
    if (!force) setTab(new URLSearchParams(location.search).get("tab") === "permissions" ? "permissions" : state.tab);
    if (state.loading && !force) return Promise.resolve();
    state.loading = true;
    paintList();
    return fns().httpsCallable("listTenantMembers")({}).then(function (res) {
      var data = (res && res.data) || {};
      state.members = data.members || [];
      state.ownerUid = data.ownerUid || "";
      session.members = state.members;
    }).catch(function () {
      state.members = session.members || [];
    }).then(function () {
      state.loading = false;
      paintList();
      if (state.openUid) paintDetail();
    });
  }

  global.ShopAppTeam = { load: load };
})(window);
