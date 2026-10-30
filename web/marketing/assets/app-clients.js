/**
 * Shop portal Clients: tenants/{id}/customers (same docs as the iPhone app).
 */
(function (global) {
  "use strict";

  var state = {
    session: null,
    clients: [],
    wired: false,
    query: "",
    openId: "",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function digits(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function customerId(email, phone) {
    var d = digits(phone);
    if (d.length >= 10) return d.slice(-10);
    var e = String(email || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    if (e) return e.slice(0, 120);
    return "c_" + Date.now();
  }

  function letter(name) {
    var ch = String(name || "?").trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : "#";
  }

  function displayName(c) {
    var name = String(c.name || "").trim();
    if (name) return name;
    return c.email || c.phone || "Client";
  }

  function subtitle(c) {
    var parts = [];
    if (c.email) parts.push(c.email);
    if (c.phone) parts.push(c.phone);
    var n = Number(c.totalAppointments) || 0;
    if (n === 1) parts.push("1 visit");
    else if (n > 1) parts.push(n + " visits");
    return parts.join(" · ") || "No contact yet";
  }

  function filtered() {
    var q = state.query.trim().toLowerCase();
    var list = state.clients.slice().sort(function (a, b) {
      return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" });
    });
    if (!q) return list;
    return list.filter(function (c) {
      return (
        displayName(c).toLowerCase().indexOf(q) !== -1 ||
        String(c.email || "").toLowerCase().indexOf(q) !== -1 ||
        digits(c.phone).indexOf(digits(q)) !== -1
      );
    });
  }

  function render() {
    var list = $("clientList");
    var empty = $("clientEmpty");
    if (!list || !empty) return;
    var rows = filtered();
    if (!rows.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      empty.textContent = state.clients.length
        ? "No clients match that search."
        : "No clients yet. Add a customer to start a record.";
      return;
    }
    empty.classList.add("hidden");
    var html = "";
    var last = "";
    rows.forEach(function (c) {
      var L = letter(displayName(c));
      if (L !== last) {
        html += '<div class="app-dir-letter">' + esc(L) + "</div>";
        last = L;
      }
      html +=
        '<button type="button" class="app-req-row' + (c.id === state.openId ? " is-active" : "") + '" data-client-open="' + esc(c.id) + '">' +
        '<span class="app-req-avatar" aria-hidden="true">' + esc(initialsOf(displayName(c))) + "</span>" +
        '<span class="app-req-copy"><strong>' + esc(displayName(c)) + "</strong><span>" + esc(subtitle(c)) + "</span></span>" +
        (c.vip ? '<span class="app-req-side"><span class="app-req-chip is-wait">VIP</span></span>' : "") +
        "</button>";
    });
    list.innerHTML = html;
  }

  function mapDoc(doc) {
    var d = doc.data() || {};
    return {
      id: doc.id,
      name: d.name || "",
      email: d.email || "",
      phone: d.phone || "",
      totalAppointments: d.totalAppointments || 0,
      vip: !!d.vip,
      notes: d.notes || "",
      noteEntries: Array.isArray(d.noteEntries) ? d.noteEntries : [],
      createdAt: d.createdAt && d.createdAt.toDate ? d.createdAt.toDate() : null,
      birthday: d.birthday || "",
      smsOptedOutAt: d.smsOptedOutAt || null,
    };
  }

  function initialsOf(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }

  /* ── Client profile ── */

  var BOOKED = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"];
  var STATUS_LABEL = {
    new: "Requested", pending: "Requested", pending_deposit: "Awaiting deposit", pending_payment: "Awaiting payment",
    pending_consultation: "Consult", confirmed: "Confirmed", completed: "Completed", declined: "Declined", cancelled: "Cancelled",
  };

  function byId(id) {
    return state.clients.filter(function (c) { return c.id === id; })[0] || null;
  }

  /** Their bookings, matched the way the app does: by phone (last 10 digits) or email. */
  function bookingsFor(c) {
    var all = (global.ShopAppRequests && global.ShopAppRequests.all && global.ShopAppRequests.all()) || [];
    var phone = digits(c.phone).slice(-10);
    var email = String(c.email || "").trim().toLowerCase();
    return all.filter(function (r) {
      var rp = digits(r.phone).slice(-10);
      return (phone && rp === phone) || (email && String(r.email || "").toLowerCase() === email);
    });
  }

  function whenLabel(d) {
    return d ? d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No time set";
  }

  function noteDate(n) {
    var v = n.updatedAt || n.createdAt;
    var d = v && v.toDate ? v.toDate() : v ? new Date(v) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  }

  function notesOf(c) {
    var list = c.noteEntries.slice();
    if (!list.length && String(c.notes || "").trim()) list = [{ id: "legacy", body: c.notes, createdAt: c.createdAt }];
    return list.sort(function (a, b) {
      var da = a.updatedAt || a.createdAt, db = b.updatedAt || b.createdAt;
      return (db && db.toDate ? db.toDate() : new Date(db || 0)) - (da && da.toDate ? da.toDate() : new Date(da || 0));
    });
  }

  function paintProfile() {
    var c = byId(state.openId);
    var body = $("clientDetailBody");
    if (!c || !body) return;
    $("clientDetailTitle").textContent = displayName(c);
    var vip = $("clientDetailVip");
    if (vip) {
      vip.textContent = c.vip ? "VIP" : "Mark VIP";
      vip.classList.toggle("is-on", c.vip);
    }
    var now = new Date();
    var bookings = bookingsFor(c);
    var upcoming = bookings.filter(function (b) { return b.start && b.start >= now && BOOKED.indexOf(b.status) !== -1; })
      .sort(function (a, b) { return a.start - b.start; });
    var past = bookings.filter(function (b) { return !(b.start && b.start >= now && BOOKED.indexOf(b.status) !== -1); })
      .sort(function (a, b) { return (b.start || b.createdAt || 0) - (a.start || a.createdAt || 0); });
    var visits = bookings.filter(function (b) { return b.start && b.start < now && BOOKED.indexOf(b.status) !== -1; }).length;
    var paid = bookings.reduce(function (t, b) { return t + (b.paidCents || 0); }, 0);

    var links = [];
    var d = digits(c.phone);
    if (d.length >= 10) {
      links.push('<a class="app-btn app-btn--ghost app-btn--small" href="sms:' + esc(c.phone) + '">Text</a>');
    }
    if (c.email) links.push('<a class="app-btn app-btn--ghost app-btn--small" href="mailto:' + esc(c.email) + '">Email</a>');

    var row = function (b) {
      return '<div class="app-client-booking"><span><strong>' + esc(b.service || "Appointment") + "</strong><em>" +
        esc(whenLabel(b.start || b.createdAt) + (b.assignedName ? " · " + b.assignedName : "")) + "</em></span>" +
        '<span class="app-req-chip' + (b.status === "confirmed" || b.status === "completed" ? " is-ok" : b.status === "declined" || b.status === "cancelled" ? " is-off" : "") + '">' +
        esc(STATUS_LABEL[b.status] || b.status) + "</span></div>";
    };
    var notes = notesOf(c);
    body.innerHTML =
      '<p class="app-req-contact">' + esc([c.phone, c.email].filter(Boolean).join(" · ") || "No contact info") + "</p>" +
      (links.length ? '<div class="app-req-links">' + links.join("") + "</div>" : "") +
      (c.smsOptedOutAt ? '<p class="app-hint">This client replied STOP, so texts to them are off.</p>' : "") +
      '<div class="app-req-facts">' +
      '<div class="app-req-fact"><span>Visits</span><strong>' + visits + "</strong></div>" +
      '<div class="app-req-fact"><span>Upcoming</span><strong>' + upcoming.length + "</strong></div>" +
      '<div class="app-req-fact"><span>Paid online</span><strong>$' + (paid / 100).toFixed(2) + "</strong></div>" +
      '<div class="app-req-fact"><span>Client since</span><strong>' + esc(c.createdAt ? c.createdAt.toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "—") + "</strong></div>" +
      "</div>" +
      '<h3 class="app-req-h">Upcoming</h3>' + (upcoming.length ? upcoming.slice(0, 5).map(row).join("") : '<p class="app-hint">Nothing booked.</p>') +
      '<h3 class="app-req-h">History</h3>' + (past.length ? past.slice(0, 8).map(row).join("") : '<p class="app-hint">No past bookings yet.</p>') +
      '<h3 class="app-req-h">Notes</h3>' +
      '<div class="app-client-note-new"><textarea id="clientNoteInput" rows="2" placeholder="Prefers a low fade, allergic to…"></textarea>' +
      '<button type="button" class="app-btn app-btn--ghost app-btn--small" id="clientNoteAdd">Add note</button></div>' +
      (notes.length ? notes.map(function (n) {
        return '<div class="app-client-note"><p>' + esc(n.body).replace(/\n/g, "<br>") + "</p><span>" + esc([noteDate(n), n.authorName].filter(Boolean).join(" · ")) + "</span></div>";
      }).join("") : '<p class="app-hint">No notes yet.</p>') +
      '<p class="app-sheet-error hidden" id="clientDetailError"></p>';
  }

  function setProfileOpen(id) {
    state.openId = id || "";
    ["clientDetailSheet", "clientDetailScrim"].forEach(function (x) {
      var el = $(x);
      if (el) el.classList.toggle("hidden", !id);
    });
    var ph = $("clientPlaceholder");
    if (ph) ph.classList.toggle("hidden", !!id);
    render();
    if (id) paintProfile();
  }

  function customerRef(c) {
    return firebase.firestore().collection("tenants").doc(state.session.tenantId).collection("customers").doc(c.id);
  }

  function profileError(msg) {
    var e = $("clientDetailError");
    if (e) {
      e.textContent = msg;
      e.classList.remove("hidden");
    }
  }

  function addNote() {
    var c = byId(state.openId);
    var input = $("clientNoteInput");
    if (!c || !input) return;
    var text = String(input.value || "").trim();
    if (!text) return profileError("Write a note first.");
    var s = state.session;
    var entry = {
      id: (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : "n_" + Date.now(),
      body: text,
      createdAt: firebase.firestore.Timestamp.now(),
      authorName: (s.user && (s.user.displayName || s.user.email)) || "",
    };
    // Keep an older single note by turning it into the first entry, like the app does.
    var existing = c.noteEntries.slice();
    if (!existing.length && String(c.notes || "").trim()) {
      existing.push({ id: "legacy", body: c.notes, createdAt: firebase.firestore.Timestamp.now() });
    }
    var next = [entry].concat(existing);
    customerRef(c).set({ noteEntries: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .then(function () {
        c.noteEntries = next;
        paintProfile();
      }).catch(function (e) {
        profileError((e && e.message) || "Couldn't save the note.");
      });
  }

  function toggleVip() {
    var c = byId(state.openId);
    if (!c) return;
    var next = !c.vip;
    customerRef(c).set({ vip: next }, { merge: true }).then(function () {
      c.vip = next;
      render();
      paintProfile();
    }).catch(function (e) {
      profileError((e && e.message) || "Couldn't update this client.");
    });
  }

  function bookAgain() {
    var c = byId(state.openId);
    if (!c || !global.ShopAppDashboard || !ShopAppDashboard.openNew) return;
    ShopAppDashboard.openNew({ client: { name: displayName(c), email: c.email, phone: c.phone } });
  }

  function load(session) {
    state.session = session;
    if (!session || !session.tenantId) return;
    var db = firebase.firestore();
    return db
      .collection("tenants")
      .doc(session.tenantId)
      .collection("customers")
      .get()
      .then(function (snap) {
        state.clients = snap.docs.map(mapDoc);
        render();
      })
      .catch(function (err) {
        state.clients = [];
        render();
        if ($("clientEmpty")) {
          $("clientEmpty").classList.remove("hidden");
          $("clientEmpty").textContent =
            (err && err.message) || "Could not load clients.";
        }
      });
  }

  function setSheetOpen(open) {
    $("clientSheet").classList.toggle("hidden", !open);
    $("clientSheetScrim").classList.toggle("hidden", !open);
    if (open) {
      $("clientNewError").classList.add("hidden");
      $("clientNewForm").reset();
      $("clientNewName").focus();
    }
  }

  function saveClient(ev) {
    ev.preventDefault();
    var session = state.session;
    if (!session || !session.tenantId) return;
    var name = ($("clientNewName").value || "").trim();
    var email = ($("clientNewEmail").value || "").trim();
    var phone = ($("clientNewPhone").value || "").trim();
    var err = $("clientNewError");
    err.classList.add("hidden");
    if (!name) {
      err.textContent = "Enter the customer’s name.";
      err.classList.remove("hidden");
      return;
    }
    if (!email && !digits(phone)) {
      err.textContent = "Enter an email or phone number.";
      err.classList.remove("hidden");
      return;
    }
    var id = customerId(email, phone);
    var payload = {
      name: name,
      email: email,
      phone: phone,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    var ref = firebase
      .firestore()
      .collection("tenants")
      .doc(session.tenantId)
      .collection("customers")
      .doc(id);
    ref
      .get()
      .then(function (snap) {
        if (!snap.exists) {
          payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
          payload.totalAppointments = 0;
          payload.vip = false;
        }
        return ref.set(payload, { merge: true });
      })
      .then(function () {
        setSheetOpen(false);
        return load(session);
      })
      .catch(function (e) {
        err.textContent = (e && e.message) || "Could not save this customer.";
        err.classList.remove("hidden");
      });
  }

  function attach(session) {
    state.session = session;
    $("clientList").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-client-open]");
      if (b) setProfileOpen(b.getAttribute("data-client-open"));
    });
    ["clientDetailClose", "clientDetailScrim"].forEach(function (x) {
      $(x).addEventListener("click", function () { setProfileOpen(""); });
    });
    $("clientDetailVip").addEventListener("click", toggleVip);
    $("clientDetailBook").addEventListener("click", bookAgain);
    $("clientDetailBody").addEventListener("click", function (ev) {
      if (ev.target.closest("#clientNoteAdd")) addNote();
    });
    if (state.wired) return;
    state.wired = true;
    $("clientAddBtn").addEventListener("click", function () {
      setSheetOpen(true);
    });
    $("clientSheetClose").addEventListener("click", function () {
      setSheetOpen(false);
    });
    $("clientSheetCancel").addEventListener("click", function () {
      setSheetOpen(false);
    });
    $("clientSheetScrim").addEventListener("click", function () {
      setSheetOpen(false);
    });
    $("clientNewForm").addEventListener("submit", saveClient);
    $("clientSearch").addEventListener("input", function () {
      state.query = $("clientSearch").value || "";
      render();
    });
  }

  global.ShopAppClients = {
    attach: attach,
    load: load,
    openAdd: function () {
      setSheetOpen(true);
    },
  };
})(window);
