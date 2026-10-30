/**
 * Shop portal Messages: client texting, same data and server function as the iPhone app.
 * Threads: tenants/{id}/smsThreads (newest first). Messages: tenants/{id}/smsLog by threadId.
 * Sending: sendClientSms. Owners and managers see the studio line; team members with their own
 * line see the threads assigned to them.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var state = {
    session: null,
    threads: [],
    openId: "",
    messages: [],
    unsubThreads: null,
    unsubMessages: null,
    query: "",
    wired: false,
    sending: false,
    pendingPhoto: null,
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
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function digits(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function e164(raw) {
    var d = digits(raw);
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10 ? "+1" + d : "";
  }

  function prettyPhone(raw) {
    var d = digits(raw);
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : String(raw || "");
  }

  /** Line-scoped thread ids (l…_c…) are used as-is; everything else is the client's phone. */
  function threadIdFor(raw) {
    var t = String(raw || "").trim();
    if (/^l\d+_c/.test(t)) return t;
    return e164(t) || t;
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }

  function when(d) {
    if (!d) return "";
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    var y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    if (now - d < 6 * 864e5) return d.toLocaleDateString("en-US", { weekday: "short" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function access() {
    return (state.session && state.session.access) || {};
  }

  function isStudioLine(t) {
    if (String(t.smsLineScope || "").toLowerCase() === "member") return false;
    if (String(t.assignedMemberUid || "").trim()) return false;
    if (/^l\d+_c/.test(t.threadId || t.id)) return false;
    return true;
  }

  /** Same rule as the app: owners and managers see the studio line; others see their own line's threads. */
  function visible(list) {
    var s = state.session;
    var a = access();
    if (s.isOwner || a.accessRole === "manager") return list.filter(isStudioLine);
    if (a.usesOwnSms) {
      var uid = s.user && s.user.uid;
      return list.filter(function (t) { return t.assignedMemberUid === uid; });
    }
    return [];
  }

  function canSend() {
    var s = state.session;
    return !!(s && (s.isOwner || access().canSendClientSms));
  }

  function mapThread(doc) {
    var d = doc.data() || {};
    var phone = d.counterpartPhone || doc.id;
    var name = String(d.clientName || "").trim();
    return {
      id: doc.id,
      threadId: String(d.threadId || doc.id),
      name: name || prettyPhone(phone),
      phone: phone,
      last: String(d.lastMessageBody || ""),
      at: toDate(d.lastMessageAt),
      assignedMemberUid: String(d.assignedMemberUid || ""),
      smsLineScope: d.smsLineScope || "",
    };
  }

  function mapMessage(doc) {
    var d = doc.data() || {};
    var out = String(d.direction || "").toLowerCase() === "outbound";
    var status = String(d.status || "").toLowerCase();
    return {
      id: doc.id,
      body: String(d.body || ""),
      out: out,
      at: toDate(d.createdAt),
      media: Array.isArray(d.mediaUrls) ? d.mediaUrls.filter(Boolean) : [],
      failed: out && (status === "failed" || status === "undelivered"),
      system: String(d.systemKind || ""),
      payUrl: String(d.paymentUrl || ""),
      payKind: String(d.paymentKind || ""),
      cents: typeof d.amountCents === "number" ? d.amountCents : 0,
    };
  }

  function col(name) {
    return firebase.firestore().collection("tenants").doc(state.session.tenantId).collection(name);
  }

  /* ── Thread list ── */

  function paintThreads() {
    var host = $("msgThreads");
    if (!host) return;
    var q = state.query.trim().toLowerCase();
    var list = visible(state.threads).filter(function (t) {
      if (!q) return true;
      return t.name.toLowerCase().indexOf(q) !== -1 || digits(t.phone).indexOf(digits(q) || "\u0000") !== -1 || t.last.toLowerCase().indexOf(q) !== -1;
    });
    if (!visible(state.threads).length) {
      var a = access();
      var noLine = !state.session.isOwner && a.accessRole !== "manager" && !a.usesOwnSms;
      host.innerHTML = '<div class="app-req-empty"><strong>' + (noLine ? "No texting line yet" : "No conversations yet") + "</strong><span>" +
        (noLine ? "Ask the owner about a texting line for you." : "Texts with clients show up here. Start one with New message.") + "</span></div>";
      return;
    }
    if (!list.length) {
      host.innerHTML = '<p class="app-empty">No conversations match that search.</p>';
      return;
    }
    host.innerHTML = list.map(function (t) {
      return '<button type="button" class="app-req-row app-msg-row' + (t.id === state.openId ? " is-active" : "") + '" data-msg-open="' + esc(t.id) + '">' +
        '<span class="app-req-avatar" aria-hidden="true">' + esc(initials(t.name)) + "</span>" +
        '<span class="app-req-copy"><strong>' + esc(t.name) + "</strong><span>" + esc(t.last || "Photo") + "</span></span>" +
        '<span class="app-req-side"><time>' + esc(when(t.at)) + "</time></span></button>";
    }).join("");
  }

  /* ── Conversation ── */

  function byId(id) {
    return state.threads.filter(function (t) { return t.id === id; })[0] || null;
  }

  function paintConversation() {
    var t = byId(state.openId) || state.draftThread;
    var host = $("msgConversation");
    if (!host) return;
    if (!t) return;
    $("msgTitle").textContent = t.name;
    $("msgSub").textContent = prettyPhone(t.phone);
    var call = $("msgCall");
    if (call) call.href = "tel:" + (e164(t.phone) || t.phone);
    var lastDay = "";
    host.innerHTML = state.messages.map(function (m) {
      var day = m.at ? m.at.toDateString() : "";
      var sep = "";
      if (day && day !== lastDay) {
        lastDay = day;
        sep = '<div class="app-msg-day">' + esc(m.at.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })) + "</div>";
      }
      if (m.system) {
        return sep + '<div class="app-msg-system">' + esc(m.body) + "</div>";
      }
      var media = m.media.map(function (u) {
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="Photo" loading="lazy"></a>';
      }).join("");
      var pay = m.payUrl && m.cents ? '<a class="app-msg-pay" href="' + esc(m.payUrl) + '" target="_blank" rel="noopener">' +
        esc((m.payKind === "deposit" ? "Deposit" : "Payment") + " request · $" + (m.cents / 100).toFixed(2)) + "</a>" : "";
      return sep + '<div class="app-msg ' + (m.out ? "is-out" : "is-in") + (m.failed ? " is-failed" : "") + '">' +
        (media ? '<div class="app-msg-media">' + media + "</div>" : "") +
        (m.body ? '<p>' + esc(m.body).replace(/\n/g, "<br>") + "</p>" : "") + pay +
        '<time>' + esc(m.at ? m.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "Sending…") +
        (m.failed ? " · Not delivered" : "") + "</time></div>";
    }).join("") || '<p class="app-empty">No messages yet. Say hello.</p>';
    host.scrollTop = host.scrollHeight;
    var composer = $("msgComposer");
    var note = $("msgCantSend");
    if (composer) composer.classList.toggle("hidden", !canSend());
    if (note) note.classList.toggle("hidden", canSend());
  }

  function setOpen(id) {
    state.openId = id || "";
    if (state.unsubMessages) {
      state.unsubMessages();
      state.unsubMessages = null;
    }
    state.messages = [];
    ["msgPanel", "msgScrim"].forEach(function (x) {
      var el = $(x);
      if (el) el.classList.toggle("hidden", !id && !state.draftThread);
    });
    var ph = $("msgPlaceholder");
    if (ph) ph.classList.toggle("hidden", !!id || !!state.draftThread);
    paintThreads();
    if (!id) return;
    state.draftThread = null;
    var t = byId(id);
    var tid = threadIdFor(t ? t.threadId : id);
    paintConversation();
    state.unsubMessages = col("smsLog").where("threadId", "==", tid).orderBy("createdAt", "asc").limitToLast(200)
      .onSnapshot(function (snap) {
        state.messages = snap.docs.map(mapMessage);
        paintConversation();
      }, function () {
        state.messages = [];
        paintConversation();
      });
    var input = $("msgInput");
    if (input) setTimeout(function () { input.focus(); }, 0);
  }

  /* ── Sending ── */

  function setError(msg) {
    var e = $("msgError");
    if (!e) return;
    e.textContent = msg || "";
    e.classList.toggle("hidden", !msg);
  }

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("Couldn't read that photo.")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn't read that photo."));
      };
      img.src = url;
    });
  }

  function paintPendingPhoto() {
    var box = $("msgAttachPreview");
    if (!box) return;
    if (!state.pendingPhoto) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = '<img src="' + esc(state.pendingPhoto.preview) + '" alt=""><button type="button" id="msgAttachRemove" aria-label="Remove photo">×</button>';
  }

  function send() {
    if (state.sending) return;
    var t = byId(state.openId) || state.draftThread;
    if (!t) return;
    var input = $("msgInput");
    var body = String(input.value || "").trim();
    var photo = state.pendingPhoto;
    if (!body && !photo) return;
    var to = e164(t.phone);
    if (!to) return setError("This conversation has no valid US phone number.");
    state.sending = true;
    setError("");
    $("msgSend").disabled = true;
    var s = state.session;
    var upload = photo
      ? (function () {
          var ref = firebase.storage().ref().child("tenants/" + s.tenantId + "/smsMedia/" + (global.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now()) + ".jpg");
          return ref.put(photo.blob, { contentType: "image/jpeg" }).then(function () { return ref.getDownloadURL(); });
        })()
      : Promise.resolve("");
    upload.then(function (mediaUrl) {
      var payload = { to: to, body: body, clientName: t.name, threadId: threadIdFor(t.threadId || to) };
      if (mediaUrl) {
        payload.mediaUrls = [mediaUrl];
        if (!body) payload.threadPreview = "Photo";
      }
      return firebase.app().functions(REGION).httpsCallable("sendClientSms")(payload);
    }).then(function (res) {
      input.value = "";
      autoGrow();
      state.pendingPhoto = null;
      paintPendingPhoto();
      var returned = res && res.data && res.data.threadId;
      if (state.draftThread) {
        // A brand-new conversation: open its thread once the server has created it.
        var id = returned ? threadIdFor(returned) : to;
        state.draftThread = null;
        setOpen(id);
      }
    }).catch(function (e) {
      setError((e && e.message) || "Couldn't send that text.");
    }).then(function () {
      state.sending = false;
      $("msgSend").disabled = false;
    });
  }

  function autoGrow() {
    var input = $("msgInput");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(160, input.scrollHeight) + "px";
  }

  /* ── New conversation ── */

  function setNewOpen(open) {
    ["msgNewSheet", "msgNewScrim"].forEach(function (x) {
      var el = $(x);
      if (el) el.classList.toggle("hidden", !open);
    });
    if (open) {
      $("msgNewName").value = "";
      $("msgNewPhone").value = "";
      $("msgNewError").classList.add("hidden");
      setTimeout(function () { $("msgNewName").focus(); }, 0);
    }
  }

  function startNew(ev) {
    ev.preventDefault();
    var name = $("msgNewName").value.trim();
    var phone = e164($("msgNewPhone").value);
    var err = $("msgNewError");
    if (!phone) {
      err.textContent = "Enter a 10-digit US phone number.";
      err.classList.remove("hidden");
      return;
    }
    setNewOpen(false);
    var existing = visible(state.threads).filter(function (t) { return e164(t.phone) === phone; })[0];
    if (existing) return setOpen(existing.id);
    state.draftThread = { id: "", threadId: phone, name: name || prettyPhone(phone), phone: phone };
    state.openId = "";
    if (state.unsubMessages) {
      state.unsubMessages();
      state.unsubMessages = null;
    }
    state.messages = [];
    ["msgPanel", "msgScrim"].forEach(function (x) { $(x).classList.remove("hidden"); });
    $("msgPlaceholder").classList.add("hidden");
    paintThreads();
    paintConversation();
    $("msgInput").focus();
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    $("msgThreads").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-msg-open]");
      if (b) setOpen(b.getAttribute("data-msg-open"));
    });
    $("msgSearch").addEventListener("input", function () {
      state.query = this.value || "";
      paintThreads();
    });
    ["msgClose", "msgScrim"].forEach(function (x) {
      $(x).addEventListener("click", function () {
        state.draftThread = null;
        setOpen("");
      });
    });
    $("msgSend").addEventListener("click", send);
    $("msgInput").addEventListener("keydown", function (ev) {
      // Enter sends; Shift+Enter adds a new line.
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    $("msgInput").addEventListener("input", autoGrow);
    $("msgPhoto").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (!f) return;
      shrink(f).then(function (blob) {
        state.pendingPhoto = { blob: blob, preview: URL.createObjectURL(blob) };
        paintPendingPhoto();
      }).catch(function (e) { setError(e.message); });
    });
    $("msgAttachPreview").addEventListener("click", function (ev) {
      if (!ev.target.closest("#msgAttachRemove")) return;
      state.pendingPhoto = null;
      paintPendingPhoto();
    });
    $("msgNewBtn").addEventListener("click", function () { setNewOpen(true); });
    ["msgNewClose", "msgNewScrim", "msgNewCancel"].forEach(function (x) {
      $(x).addEventListener("click", function () { setNewOpen(false); });
    });
    $("msgNewForm").addEventListener("submit", startNew);
  }

  /** Listens from sign-in so the sidebar count stays current. */
  function attach(session) {
    state.session = session;
    if (state.unsubThreads) return;
    state.unsubThreads = col("smsThreads").orderBy("lastMessageAt", "desc").limit(300).onSnapshot(function (snap) {
      state.threads = snap.docs.map(mapThread);
      paintThreads();
      if (state.openId) paintConversation();
    }, function () {
      state.threads = [];
      paintThreads();
    });
  }

  function load(session, opts) {
    state.session = session;
    wire();
    attach(session);
    var nb = $("msgNewBtn");
    if (nb) nb.classList.toggle("hidden", !canSend());
    paintThreads();
    if (opts && opts.phone) {
      var hit = visible(state.threads).filter(function (t) { return e164(t.phone) === e164(opts.phone); })[0];
      if (hit) setOpen(hit.id);
    }
  }

  global.ShopAppMessages = { attach: attach, load: load };
})(window);
