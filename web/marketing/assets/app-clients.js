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
        '<div class="app-row">' +
        '<span class="app-row-avatar" aria-hidden="true">' +
        esc(displayName(c).charAt(0).toUpperCase()) +
        "</span>" +
        '<span class="app-row-copy"><strong>' +
        esc(displayName(c)) +
        "</strong><span>" +
        esc(subtitle(c)) +
        "</span></span>" +
        (c.vip ? '<span class="app-row-meta">VIP</span>' : "") +
        "</div>";
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
    };
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
