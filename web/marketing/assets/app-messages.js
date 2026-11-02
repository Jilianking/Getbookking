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
    pendingPhotos: [],
    trayOpen: false,
    composing: false,
    contacts: null,
    suggest: [],
    suggestIndex: -1,
    draftThread: null,
    consent: null,
    pending: [],
    consentFor: "",
    popKind: "",
    menuFor: "",
    readMap: {},
    readSince: 0,
    readSinceSet: false,
    unsubReads: null,
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

  var PERSON_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="8.5" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20c.9-3.8 4-6 7.5-6s6.6 2.2 7.5 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  /** Initials for a saved name; the person outline (like iPhone) when it's only a number. */
  function avatarHtml(name) {
    var hasLetters = /[A-Za-z]/.test(String(name || ""));
    return '<span class="app-req-avatar' + (hasLetters ? "" : " is-person") + '" aria-hidden="true">' + (hasLetters ? esc(initials(name)) : PERSON_ICON) + "</span>";
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

  /* ── Read / unread, saved per person on their own user record (follows them to any computer) ── */

  function readKey(t) {
    return String(t.id || "").replace(/[.\/\[\]*~]/g, "_");
  }

  function isUnread(t) {
    var v = state.readMap[readKey(t)];
    if (v === -1) return true;
    if (!t.at) return false;
    var seen = Math.max(typeof v === "number" ? v : 0, state.readSince || 0);
    return seen > 0 && t.at.getTime() > seen;
  }

  function saveRead(t, value) {
    var uid = state.session && state.session.user && state.session.user.uid;
    if (!uid || !t) return;
    var key = readKey(t);
    state.readMap[key] = value;
    var patch = {};
    patch[key] = value;
    firebase.firestore().collection("users").doc(uid).set({ smsThreadRead: patch }, { merge: true }).catch(function () {});
    paintThreads();
  }

  function markRead(t) {
    if (t && isUnread(t)) saveRead(t, Date.now());
  }

  function paintBadge() {
    var badge = $("navMessagesBadge");
    if (!badge) return;
    var n = visible(state.threads).filter(function (t) { return isUnread(t) && t.id !== state.openId; }).length;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", !n);
  }

  function watchReads(session) {
    var uid = session.user && session.user.uid;
    if (!uid || state.unsubReads) return;
    var ref = firebase.firestore().collection("users").doc(uid);
    state.unsubReads = ref.onSnapshot(function (snap) {
      var d = (snap && snap.data && snap.data()) || {};
      state.readMap = d.smsThreadRead || {};
      // Conversations from before read tracking started count as read.
      if (typeof d.smsReadSince === "number") state.readSince = d.smsReadSince;
      else if (!state.readSinceSet) {
        state.readSinceSet = true;
        state.readSince = Date.now();
        ref.set({ smsReadSince: state.readSince }, { merge: true }).catch(function () {});
      }
      paintThreads();
    }, function () {});
  }

  /* ── Thread list ── */

  function paintThreads() {
    paintBadge();
    var host = $("msgThreads");
    if (!host) return;
    var q = state.query.trim().toLowerCase();
    var qd = digits(q);
    var list = visible(state.threads).filter(function (t) {
      if (!q) return true;
      // Name, last message, or the number typed any way: "615 500", "(615) 500-1337", "5001337".
      if (t.name.toLowerCase().indexOf(q) !== -1) return true;
      if (t.last.toLowerCase().indexOf(q) !== -1) return true;
      return qd.length >= 2 && digits(t.phone).indexOf(qd) !== -1;
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
      var unread = isUnread(t) && t.id !== state.openId;
      return '<div class="app-msg-rowwrap' + (t.id === state.openId ? " is-active" : "") + (unread ? " is-unread" : "") + '" data-row-id="' + esc(t.id) + '">' +
        '<button type="button" class="app-req-row app-msg-row' + (t.id === state.openId ? " is-active" : "") + (unread ? " is-unread" : "") + '" data-msg-open="' + esc(t.id) + '">' +
        (unread ? '<span class="app-msg-dot" aria-label="Unread"></span>' : "") +
        avatarHtml(t.name) +
        '<span class="app-req-copy"><strong>' + esc(t.name) + "</strong><span>" + esc(t.last || "Photo") + "</span></span>" +
        '<span class="app-req-side"><time>' + esc(when(t.at)) + "</time></span></button>" +
        '<button type="button" class="app-msg-more" data-row-more="' + esc(t.id) + '" aria-label="More for ' + esc(t.name) + '" aria-haspopup="menu">⋯</button></div>';
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
    if (!state.openId && state.draftThread) {
      host.innerHTML = '<p class="app-empty">New conversation with ' + esc(t.name) + ". Write your first text below.</p>";
      return;
    }
    $("msgTitle").textContent = t.name;
    // Don't repeat the number under itself when there's no saved name.
    $("msgSub").textContent = t.name === prettyPhone(t.phone) ? "" : prettyPhone(t.phone);
    var lastDay = "";
    var tidNow = threadIdFor(t.threadId || t.phone);
    var shown = state.messages.concat(state.pending.filter(function (p) { return p.threadKey === tidNow; }));
    host.innerHTML = shown.map(function (m) {
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
      return sep + '<div class="app-msg ' + (m.out ? "is-out" : "is-in") + (m.failed || m.error ? " is-failed" : "") + (m.sending ? " is-sending" : "") + '">' +
        (media ? '<div class="app-msg-media">' + media + "</div>" : "") +
        (m.body ? '<p>' + esc(m.body).replace(/\n/g, "<br>") + "</p>" : "") + pay +
        '<time>' + esc(m.sending ? (m.error ? "Not sent" : "Sending…") : m.at ? m.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "") +
        (m.failed ? " · Not delivered" : "") + "</time></div>";
    }).join("") || '<p class="app-empty">No messages yet. Say hello.</p>';
    if (state.pending.some(function (p) { return p.threadKey === tidNow; })) host.scrollTop = host.scrollHeight;
    host.scrollTop = host.scrollHeight;
    var composer = $("msgComposer");
    var note = $("msgCantSend");
    if (composer) composer.classList.toggle("hidden", !canSend());
    if (note) note.classList.toggle("hidden", canSend());
  }

  function setOpen(id) {
    if (id) endCompose();
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
    state.unsubMessages = col("smsLog").where("threadId", "==", tid).orderBy("createdAt", "asc")
      .onSnapshot(function (snap) {
        state.messages = snap.docs.map(mapMessage);
        if (!document.hidden) markRead(byId(state.openId));
        // Drop "sending" bubbles once the real text has arrived.
        state.pending = state.pending.filter(function (p) {
          return p.threadKey === tid && !state.messages.some(function (m) { return m.out && m.body === p.body && m.at && m.at >= p.since; });
        });
        paintConversation();
      }, function (err) {
        console.warn("Messages: couldn't load this conversation", err && err.message);
        state.messages = [];
        paintConversation();
      });
    markRead(t);
    loadConsent(tid);
    closePop();
    setTray(false);
    state.pendingPhotos = [];
    paintPendingPhoto();
    var input = $("msgInput");
    if (input) setTimeout(function () { input.focus(); }, 0);
  }

  /* ── Opt-in status (same rules as the app; unknown never blocks, the server still checks) ── */

  function paintConsent() {
    var box = $("msgConsent");
    var st = state.consent;
    var blocked = !!(st && st.state && st.state !== "opted_in");
    if (!box) return blocked;
    if (!st || st.state === "opted_in") {
      box.classList.add("hidden");
      box.innerHTML = "";
      return false;
    }
    var text = st.state === "opted_out"
      ? "Client opted out (replied STOP). They can text YES or START to opt back in."
      : st.state === "waiting"
        ? "Waiting for the client to reply YES."
        : "The client must text you first, or opt in when booking.";
    var canResend = st.state === "waiting" && !st.canResendAtMs;
    box.classList.remove("hidden");
    box.innerHTML = "<span>" + esc(text) + "</span>" +
      (canResend ? '<button type="button" class="app-btn app-btn--ghost app-btn--small" id="msgResend">Resend opt-in text</button>' : "") +
      (st.state === "waiting" && st.canResendAtMs ? "<em>You can resend after " + esc(new Date(st.canResendAtMs).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })) + ".</em>" : "");
    return blocked;
  }

  function loadConsent(threadId) {
    state.consent = null;
    paintConsent();
    if (!threadId || !canSend()) return;
    var asked = threadId;
    firebase.app().functions(REGION).httpsCallable("getSmsConsentStatus")({ threadId: threadId }).then(function (res) {
      if (state.consentFor !== asked) return;
      state.consent = (res && res.data) || null;
      paintComposerLock();
    }).catch(function () { /* unknown: don't block */ });
    state.consentFor = asked;
  }

  function paintComposerLock() {
    var blocked = paintConsent();
    var input = $("msgInput");
    var sendBtn = $("msgSend");
    if (input) input.disabled = blocked;
    if (sendBtn) sendBtn.disabled = blocked || state.sending;
    document.querySelectorAll("[data-msg-action]").forEach(function (b) {
      var a = b.getAttribute("data-msg-action");
      b.disabled = blocked && a !== "book";
    });
    if (blocked) setTray(false);
  }

  function resendConsent() {
    var t = byId(state.openId);
    if (!t) return;
    var btn = $("msgResend");
    if (btn) btn.disabled = true;
    firebase.app().functions(REGION).httpsCallable("resendSmsConsentPrompt")({ threadId: threadIdFor(t.threadId) }).then(function () {
      loadConsent(threadIdFor(t.threadId));
    }).catch(function (e) {
      setError((e && e.message) || "Couldn't resend the opt-in text.");
      if (btn) btn.disabled = false;
    });
  }

  /* ── Composer actions: quick reply, booking link, pay requests, book session ── */

  var DEFAULT_QUICK = [
    "Thanks for reaching out! We'll get back to you shortly.",
    "See you at your appointment!",
    "Can you share your preferred date and time?",
  ];

  function quickReplies() {
    var list = state.session && state.session.tenant && state.session.tenant.smsQuickPresets;
    return Array.isArray(list) && list.length ? list : DEFAULT_QUICK;
  }

  function businessName() {
    var t = (state.session && state.session.tenant) || {};
    return t.displayName || t.businessName || state.session.shopName || "";
  }

  function fillPlaceholders(text) {
    return String(text || "").replace(/\{business(Name)?\}/g, businessName()).replace(/\{service(Name)?\}/g, "your appointment");
  }

  function bookingLink() {
    var t = (state.session && state.session.tenant) || {};
    if (t.customDomain && t.customDomainStatus === "active") return "https://www." + t.customDomain + "/book";
    return t.slug ? "https://" + t.slug + ".getbookking.com/book" : "";
  }

  function insertText(text) {
    var input = $("msgInput");
    if (!input || !text) return;
    var cur = input.value;
    input.value = cur ? cur.replace(/\s*$/, "") + (/\s$/.test(cur) || !cur ? "" : " ") + text : text;
    autoGrow();
    input.focus();
  }

  function closePop() {
    var pop = $("msgPop");
    if (pop) {
      pop.classList.add("hidden");
      pop.innerHTML = "";
    }
    state.popKind = "";
  }

  function openPop(kind) {
    var pop = $("msgPop");
    if (state.popKind === kind) return closePop();
    state.popKind = kind;
    if (kind === "quick") {
      pop.innerHTML = '<div class="app-msg-pop-list">' + quickReplies().map(function (q, i) {
        return '<button type="button" data-quick="' + i + '">' + esc(fillPlaceholders(q)) + "</button>";
      }).join("") + "</div>";
    } else {
      var title = kind === "deposit" ? "Request a deposit" : "Request a payment";
      pop.innerHTML = '<div class="app-msg-pay-form"><strong>' + title + "</strong>" +
        '<div class="app-msg-pay-row"><span>$</span><input id="msgPayAmount" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>' +
        '<div class="app-msg-pay-chips">' + [25, 50, 100].map(function (n) { return '<button type="button" data-pay-amt="' + n + '">$' + n + "</button>"; }).join("") + "</div>" +
        '<button type="button" class="app-btn app-btn--primary app-btn--small" id="msgPaySend">Send ' + (kind === "deposit" ? "deposit" : "payment") + " link</button>" +
        '<p class="app-hint">The client gets a secure pay link by text. Money goes to your connected payments account.</p></div>';
      setTimeout(function () { var a = $("msgPayAmount"); if (a) a.focus(); }, 0);
    }
    pop.classList.remove("hidden");
  }

  function sendPayRequest(kind) {
    var t = byId(state.openId) || state.draftThread;
    if (!t || state.sending) return;
    var raw = String(($("msgPayAmount") || {}).value || "").replace(/[^0-9.]/g, "");
    var cents = Math.round(parseFloat(raw || "0") * 100);
    if (!(cents >= 50)) return setError("Enter at least $0.50.");
    var to = e164(t.phone);
    if (!to) return setError("This conversation has no valid US phone number.");
    state.sending = true;
    setError("");
    var btn = $("msgPaySend");
    if (btn) btn.disabled = true;
    var fns = firebase.app().functions(REGION);
    fns.httpsCallable("createDepositLink")({ serviceAmountCents: cents }).then(function (res) {
      var url = res && res.data && res.data.url;
      if (!url) throw new Error("Couldn't create the pay link.");
      // Same message the app sends: an empty body with the pay link and amount attached.
      return fns.httpsCallable("sendClientSms")({
        to: to,
        body: "",
        clientName: t.name,
        threadId: threadIdFor(t.threadId || to),
        paymentKind: kind,
        amountCents: cents,
        paymentUrl: url,
        threadPreview: (kind === "deposit" ? "Deposit" : "Payment") + " · $" + (cents / 100).toFixed(2),
      });
    }).then(function (res) {
      closePop();
      if (state.draftThread) {
        var returned = res && res.data && res.data.threadId;
        var id = returned ? threadIdFor(returned) : to;
        state.draftThread = null;
        endCompose();
        setOpen(id);
      }
    }).catch(function (e) {
      setError((e && e.message) || "Couldn't send the pay link.");
      if (btn) btn.disabled = false;
    }).then(function () {
      state.sending = false;
    });
  }

  function setTray(open) {
    state.trayOpen = !!open;
    var tray = $("msgActions");
    var plus = $("msgPlus");
    if (tray) tray.classList.toggle("hidden", !open);
    if (plus) {
      plus.classList.toggle("is-open", !!open);
      plus.setAttribute("aria-expanded", open ? "true" : "false");
      plus.setAttribute("aria-label", open ? "Close actions" : "Message actions");
    }
  }

  function onAction(kind) {
    setError("");
    setTray(false);
    if (kind === "photo") {
      closePop();
      return $("msgPhoto").click();
    }
    if (kind === "link") {
      var link = bookingLink();
      if (!link) return setError("Your booking page address isn't set yet.");
      closePop();
      return insertText(link);
    }
    if (kind === "book") {
      var t = byId(state.openId) || state.draftThread;
      closePop();
      if (t && global.ShopAppDashboard && ShopAppDashboard.openNew) {
        ShopAppDashboard.openNew({ client: { name: t.name, phone: e164(t.phone) || t.phone, email: "" } });
      }
      return;
    }
    openPop(kind);
  }

  /* ── Conversation menu (⋯ on a row, or right-click) ── */

  function openRowMenu(id, anchor, x, y) {
    var menu = $("msgRowMenu");
    var list = $("msgThreads");
    if (!menu || !list) return;
    state.menuFor = id;
    menu.querySelector('[data-row-act="delete"]').classList.toggle("hidden", !canSend());
    var tr = byId(id);
    menu.querySelector('[data-row-act="unread"]').textContent = tr && isUnread(tr) && tr.id !== state.openId ? "Mark as read" : "Mark as unread";
    var box = list.parentNode.getBoundingClientRect();
    var top, left;
    if (anchor) {
      var r = anchor.getBoundingClientRect();
      top = r.bottom - box.top + list.parentNode.scrollTop + 4;
      left = r.right - box.left - 180;
    } else {
      top = y - box.top + list.parentNode.scrollTop;
      left = x - box.left;
    }
    menu.style.top = Math.max(4, top) + "px";
    menu.style.left = Math.max(4, Math.min(left, box.width - 190)) + "px";
    menu.classList.remove("hidden");
  }

  function closeRowMenu() {
    var menu = $("msgRowMenu");
    if (menu) menu.classList.add("hidden");
    state.menuFor = "";
  }

  function deleteConversation(id) {
    var t = byId(id || state.openId);
    if (!t) return;
    if (!global.confirm("Delete this conversation with " + t.name + "? This removes it for everyone on your team.")) return;
    firebase.app().functions(REGION).httpsCallable("deleteSmsThreads")({ threadIds: [threadIdFor(t.threadId)] }).then(function () {
      state.threads = state.threads.filter(function (x) { return x.id !== t.id; });
      if (state.openId === t.id) setOpen("");
      else paintThreads();
    }).catch(function (e) {
      setError((e && e.message) || "Couldn't delete this conversation.");
    });
  }

  /* ── Texting settings panel ── */

  function settingsOpen(open) {
    ["msgSettingsSheet", "msgSettingsScrim"].forEach(function (x) {
      var el = $(x);
      if (el) el.classList.toggle("hidden", !open);
    });
    if (open) paintSettings();
  }

  function usageLine(count, limit) {
    if (limit == null) return "";
    var pct = limit ? Math.min(100, Math.round((count / limit) * 100)) : 0;
    return '<div class="app-msg-usage"><div><span>Texts this month</span><strong>' + (count || 0) + " of " + limit + '</strong></div><i><b style="width:' + pct + '%"></b></i></div>';
  }

  function paintSettings() {
    var body = $("msgSettingsBody");
    if (!body) return;
    var s = state.session;
    var a = access();
    var t = s.tenant || {};
    var owner = s.isOwner;
    var html = "";
    // Your line
    if (owner || a.accessRole === "manager") {
      var on = String(t.smsStatus || "").toLowerCase() === "active" && t.smsPhoneNumber;
      html += '<section class="app-msg-set"><h3 class="app-req-h">Shop texting line</h3>' +
        (on
          ? '<p class="app-msg-line"><strong>' + esc(prettyPhone(t.smsPhoneNumber)) + "</strong><span>Clients see this number when you text them.</span></p>"
          : '<p class="app-hint">Client texting isn\'t turned on for this shop yet.</p>') +
        '<div id="msgSetUsage"></div>' +
        (owner ? '<a class="app-btn app-btn--ghost app-btn--small" href="/billing#messaging" target="_top">' + (on ? "Manage numbers and billing" : "Turn on client texting") + "</a>" +
          '<p class="app-hint">Adding numbers beyond your plan is charged in Plan and billing, with the price shown before you confirm.</p>' : "") +
        "</section>";
    } else if (a.usesOwnSms) {
      html += '<section class="app-msg-set"><h3 class="app-req-h">Your texting line</h3>' +
        '<p class="app-msg-line"><strong>' + esc(prettyPhone(a.memberSmsPhoneNumber || "")) + "</strong><span>Clients see this number when you text them.</span></p>" +
        '<div id="msgSetUsage"></div></section>';
    } else {
      html += '<section class="app-msg-set"><h3 class="app-req-h">Your texting line</h3><p class="app-hint">You don\'t have a texting number yet. Ask the owner to set one up for you.</p></section>';
    }
    // Quick replies and presets
    var quick = quickReplies();
    html += '<section class="app-msg-set"><h3 class="app-req-h">Quick replies</h3>' +
      '<p class="app-hint">Saved texts you can drop into any conversation. Use {business} for your business name.</p>' +
      '<div class="app-msg-quick" id="msgQuickList">' + quick.map(function (q, i) {
        return '<div class="app-msg-quick-row"><textarea data-quick-edit="' + i + '" rows="2" maxlength="300"' + (owner ? "" : " disabled") + ">" + esc(q) + "</textarea>" +
          (owner ? '<button type="button" class="app-icon-btn" data-quick-remove="' + i + '" aria-label="Remove">×</button>' : "") + "</div>";
      }).join("") + "</div>" +
      (owner && quick.length < 12 ? '<button type="button" class="app-btn app-btn--ghost app-btn--small" id="msgQuickAdd">+ Add quick reply</button>' : "") +
      "</section>";
    html += '<section class="app-msg-set"><h3 class="app-req-h">Automatic texts</h3>' +
      '<div class="app-field"><label for="msgPresetConfirmed">When you confirm a booking</label><textarea id="msgPresetConfirmed" rows="2" maxlength="300"' + (owner ? "" : " disabled") + ">" + esc(t.smsPresetConfirmed || "{business}: Your appointment request for {service} is confirmed. Reply STOP to opt out.") + "</textarea></div>" +
      '<div class="app-field"><label for="msgPresetDeclined">When you decline a request</label><textarea id="msgPresetDeclined" rows="2" maxlength="300"' + (owner ? "" : " disabled") + ">" + esc(t.smsPresetDeclined || "") + "</textarea></div>" +
      '<p class="app-hint">Use {business} and {service}. They fill in automatically.</p></section>';
    html += '<p class="app-sheet-error hidden" id="msgSetError"></p>';
    html += owner ? '<div class="app-sheet-actions"><button type="button" class="app-btn app-btn--primary" id="msgSetSave">Save</button></div>' :
      '<p class="app-hint">Only the owner can change these.</p>';
    body.innerHTML = html;
    loadUsage();
  }

  function loadUsage() {
    var box = $("msgSetUsage");
    if (!box) return;
    var s = state.session;
    var fns = firebase.app().functions(REGION);
    if (s.isOwner) {
      fns.httpsCallable("getBillingSummary")({}).then(function (res) {
        var m = (res && res.data && res.data.messaging) || {};
        box.innerHTML = usageLine(m.smsMonthlyUsageCount, m.smsMonthlyLimit) +
          (m.smsLinesUsed != null ? '<p class="app-hint">Numbers in use: ' + m.smsLinesUsed + " of " + (m.smsMaxLines || m.smsLinesUsed) + (m.smsFreeIncluded != null ? " · " + m.smsFreeIncluded + " included with your plan" : "") + ".</p>" : "");
      }).catch(function () {});
      return;
    }
    fns.httpsCallable("listTenantMembers")({}).then(function (res) {
      var me = ((res && res.data && res.data.members) || []).filter(function (x) { return x.uid === s.user.uid; })[0];
      if (me && me.smsMonthlyLimit != null) box.innerHTML = usageLine(me.smsMonthlyUsageCount, me.smsMonthlyLimit);
    }).catch(function () {});
  }

  function readQuick() {
    return [].map.call(document.querySelectorAll("[data-quick-edit]"), function (el) { return el.value.trim(); }).filter(Boolean);
  }

  function saveSettings() {
    var btn = $("msgSetSave");
    var err = $("msgSetError");
    btn.disabled = true;
    err.classList.add("hidden");
    var payload = {
      smsPresetConfirmed: $("msgPresetConfirmed").value.trim(),
      smsPresetDeclined: $("msgPresetDeclined").value.trim(),
      smsQuickPresets: readQuick(),
    };
    firebase.app().functions(REGION).httpsCallable("updateTenantMessagingPresets")(payload).then(function () {
      var t = state.session.tenant || (state.session.tenant = {});
      t.smsPresetConfirmed = payload.smsPresetConfirmed;
      t.smsPresetDeclined = payload.smsPresetDeclined;
      t.smsQuickPresets = payload.smsQuickPresets;
      btn.textContent = "Saved";
      setTimeout(function () { btn.textContent = "Save"; btn.disabled = false; }, 1400);
    }).catch(function (e) {
      err.textContent = (e && e.message) || "Couldn't save your messaging settings.";
      err.classList.remove("hidden");
      btn.disabled = false;
    });
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

  var MAX_PHOTOS = 5;

  function paintPendingPhoto() {
    var box = $("msgAttachPreview");
    if (!box) return;
    var list = state.pendingPhotos;
    if (!list.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = list.map(function (p, i) {
      return '<figure><img src="' + esc(p.preview) + '" alt=""><button type="button" data-photo-remove="' + i + '" aria-label="Remove photo">×</button></figure>';
    }).join("");
  }

  function send() {
    if (state.sending) return;
    if (state.composing && !state.draftThread) {
      var picked = recipientFromField();
      if (!picked) return setError("Add who this text is to.");
      chooseRecipient(picked);
      if (!state.draftThread) return;
    }
    var t = byId(state.openId) || state.draftThread;
    if (!t) return;
    var input = $("msgInput");
    var body = String(input.value || "").trim();
    var photos = state.pendingPhotos.slice();
    if (!body && !photos.length) return;
    if (state.consent && state.consent.state && state.consent.state !== "opted_in" && state.openId) {
      return setError("This client hasn't opted in to texts yet.");
    }
    var to = e164(t.phone);
    if (!to) return setError("This conversation has no valid US phone number.");
    state.sending = true;
    setError("");
    $("msgSend").disabled = true;
    var s = state.session;
    // Show it in the chat right away, like iPhone; it's replaced by the saved text when it lands.
    var pending = {
      threadKey: threadIdFor(t.threadId || to),
      body: body,
      out: true,
      sending: true,
      at: null,
      since: new Date(Date.now() - 5000),
      media: photos.map(function (p) { return p.preview; }),
    };
    state.pending.push(pending);
    if (state.openId) saveRead(byId(state.openId), Date.now() + 60000);
    input.value = "";
    autoGrow();
    paintConversation();
    state.pendingPhotos = [];
    paintPendingPhoto();
    var upload = Promise.all(photos.map(function (photo) {
      var ref = firebase.storage().ref().child("tenants/" + s.tenantId + "/smsMedia/" + (global.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()) + ".jpg");
      return ref.put(photo.blob, { contentType: "image/jpeg" }).then(function () { return ref.getDownloadURL(); });
    }));
    upload.then(function (mediaUrls) {
      var payload = { to: to, body: body, clientName: t.name, threadId: threadIdFor(t.threadId || to) };
      if (mediaUrls.length) {
        payload.mediaUrls = mediaUrls;
        if (!body) payload.threadPreview = "Photo";
      }
      return firebase.app().functions(REGION).httpsCallable("sendClientSms")(payload);
    }).then(function (res) {
      var returned = res && res.data && res.data.threadId;
      if (state.draftThread) {
        // A brand-new conversation: open its thread once the server has created it.
        var id = returned ? threadIdFor(returned) : to;
        state.draftThread = null;
        endCompose();
        setOpen(id);
      }
    }).catch(function (e) {
      pending.error = true;
      if (!input.value) input.value = body;
      if (!state.pendingPhotos.length) {
        state.pendingPhotos = photos;
        paintPendingPhoto();
      }
      paintConversation();
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

  /* ── New message: a To: field like iPhone Messages ── */

  function loadContacts() {
    if (state.contacts || !(global.ShopAppAccess && ShopAppAccess.can(state.session, "clients"))) return Promise.resolve();
    return col("customers").get().then(function (snap) {
      state.contacts = snap.docs.map(function (doc) {
        var d = doc.data() || {};
        return { name: String(d.name || "").trim(), phone: d.phone || "" };
      }).filter(function (c) { return e164(c.phone); });
    }).catch(function () {
      state.contacts = [];
    });
  }

  /** Matching conversations first, then clients, then "Text this number". Deduped by phone. */
  function suggestions(q) {
    var query = q.trim().toLowerCase();
    var qd = digits(q);
    if (!query) return [];
    var seen = {};
    var out = [];
    var add = function (name, phone, thread) {
      var key = e164(phone);
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ name: name || prettyPhone(phone), phone: key, thread: thread || null });
    };
    var match = function (name, phone) {
      return (name && name.toLowerCase().indexOf(query) !== -1) || (qd.length >= 3 && digits(phone).indexOf(qd) !== -1);
    };
    visible(state.threads).forEach(function (t) { if (match(t.name, t.phone)) add(t.name, t.phone, t); });
    (state.contacts || []).forEach(function (c) { if (match(c.name, c.phone)) add(c.name, c.phone); });
    if (e164(q) && !seen[e164(q)]) out.push({ name: "Text " + prettyPhone(q), phone: e164(q), thread: null, raw: true });
    return out.slice(0, 8);
  }

  function paintSuggestions() {
    var box = $("msgToSuggest");
    var list = suggestions($("msgTo").value || "");
    state.suggest = list;
    state.suggestIndex = list.length ? 0 : -1;
    if (!list.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = list.map(function (o, i) {
      return '<button type="button" role="option" class="app-msg-to-opt' + (i === 0 ? " is-on" : "") + '" data-suggest="' + i + '">' +
        avatarHtml(o.raw ? "" : o.name) +
        "<span><strong>" + esc(o.name) + "</strong><em>" + esc(o.raw ? "New conversation" : prettyPhone(o.phone) + (o.thread ? " · Conversation" : "")) + "</em></span></button>";
    }).join("");
  }

  function moveSuggest(dir) {
    if (!state.suggest || !state.suggest.length) return;
    state.suggestIndex = (state.suggestIndex + dir + state.suggest.length) % state.suggest.length;
    document.querySelectorAll(".app-msg-to-opt").forEach(function (b, i) { b.classList.toggle("is-on", i === state.suggestIndex); });
  }

  function chooseRecipient(o) {
    if (!o) return;
    $("msgToSuggest").classList.add("hidden");
    if (o.thread) {
      // Already texting this person: go to that conversation, like the iPhone does.
      endCompose();
      return setOpen(o.thread.id);
    }
    state.draftThread = { id: "", threadId: o.phone, name: o.raw ? prettyPhone(o.phone) : o.name, phone: o.phone };
    var chip = $("msgToChip");
    chip.innerHTML = esc(state.draftThread.name) + ' <button type="button" id="msgToClear" aria-label="Change recipient">×</button>';
    chip.classList.remove("hidden");
    $("msgTo").value = "";
    $("msgTo").classList.add("hidden");
    paintConversation();
    $("msgInput").focus();
  }

  /** Typing a full number and pressing Enter (or sending) uses it even without picking a suggestion. */
  function recipientFromField() {
    var v = ($("msgTo").value || "").trim();
    if (!v) return null;
    if (state.suggest && state.suggest.length) return state.suggest[Math.max(0, state.suggestIndex)];
    if (e164(v)) return { name: prettyPhone(v), phone: e164(v), raw: true };
    return null;
  }

  function startCompose() {
    state.composing = true;
    state.draftThread = null;
    state.openId = "";
    if (state.unsubMessages) {
      state.unsubMessages();
      state.unsubMessages = null;
    }
    state.messages = [];
    ["msgPanel", "msgScrim"].forEach(function (x) { $(x).classList.remove("hidden"); });
    $("msgPlaceholder").classList.add("hidden");
    $("msgToRow").classList.remove("hidden");
    $("msgHead").classList.add("hidden");
    $("msgToChip").classList.add("hidden");
    $("msgTo").classList.remove("hidden");
    $("msgTo").value = "";
    $("msgToSuggest").classList.add("hidden");
    $("msgConversation").innerHTML = '<p class="app-empty">Type a name or number above.</p>';
    paintThreads();
    loadContacts();
    setTimeout(function () { $("msgTo").focus(); }, 0);
  }

  function endCompose() {
    state.composing = false;
    $("msgToRow").classList.add("hidden");
    $("msgHead").classList.remove("hidden");
    $("msgToSuggest").classList.add("hidden");
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
        endCompose();
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
      var files = Array.prototype.slice.call(this.files || [], 0, Math.max(0, MAX_PHOTOS - state.pendingPhotos.length));
      this.value = "";
      if (!files.length) return setError("Up to " + MAX_PHOTOS + " photos per text.");
      Promise.all(files.map(shrink)).then(function (blobs) {
        blobs.forEach(function (blob) { state.pendingPhotos.push({ blob: blob, preview: URL.createObjectURL(blob) }); });
        paintPendingPhoto();
        $("msgInput").focus();
      }).catch(function (e) { setError(e.message); });
    });
    $("msgAttachPreview").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-photo-remove]");
      if (!b) return;
      state.pendingPhotos.splice(Number(b.getAttribute("data-photo-remove")), 1);
      paintPendingPhoto();
    });
    $("msgPlus").addEventListener("click", function () {
      if (state.popKind) closePop();
      setTray(!state.trayOpen);
    });
    document.addEventListener("click", function (ev) {
      if (state.trayOpen && !ev.target.closest("#msgActions, #msgPlus")) setTray(false);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.trayOpen) setTray(false);
    });
    $("msgNewBtn").addEventListener("click", startCompose);
    $("msgActions").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-msg-action]");
      if (b && !b.disabled) onAction(b.getAttribute("data-msg-action"));
    });
    $("msgPop").addEventListener("click", function (ev) {
      var q = ev.target.closest("[data-quick]");
      if (q) {
        insertText(fillPlaceholders(quickReplies()[Number(q.getAttribute("data-quick"))]));
        return closePop();
      }
      var amt = ev.target.closest("[data-pay-amt]");
      if (amt) {
        $("msgPayAmount").value = amt.getAttribute("data-pay-amt") + ".00";
        return;
      }
      if (ev.target.closest("#msgPaySend")) sendPayRequest(state.popKind);
    });
    $("msgPop").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && ev.target.id === "msgPayAmount") {
        ev.preventDefault();
        sendPayRequest(state.popKind);
      } else if (ev.key === "Escape") {
        closePop();
      }
    });
    $("msgConsent").addEventListener("click", function (ev) {
      if (ev.target.closest("#msgResend")) resendConsent();
    });
    $("msgThreads").addEventListener("click", function (ev) {
      var more = ev.target.closest("[data-row-more]");
      if (!more) return;
      ev.stopPropagation();
      var id = more.getAttribute("data-row-more");
      if (state.menuFor === id) return closeRowMenu();
      openRowMenu(id, more);
    }, true);
    $("msgThreads").addEventListener("contextmenu", function (ev) {
      var row = ev.target.closest("[data-row-id]");
      if (!row) return;
      ev.preventDefault();
      openRowMenu(row.getAttribute("data-row-id"), null, ev.clientX, ev.clientY);
    });
    $("msgRowMenu").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-row-act]");
      if (!b) return;
      var id = state.menuFor;
      var act = b.getAttribute("data-row-act");
      closeRowMenu();
      var t = byId(id);
      if (act === "open") setOpen(id);
      else if (act === "unread" && t) {
        if (isUnread(t) && t.id !== state.openId) saveRead(t, Date.now());
        else {
          // Marking the open conversation unread closes it, like Mail and Messages.
          saveRead(t, -1);
          if (state.openId === t.id) setOpen("");
        }
      }
      else if (act === "delete") deleteConversation(id);
    });
    document.addEventListener("click", function (ev) {
      if (state.menuFor && !ev.target.closest("#msgRowMenu, [data-row-more]")) closeRowMenu();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && state.menuFor) closeRowMenu();
    });
    $("msgSettingsBtn").addEventListener("click", function () { settingsOpen(true); });
    ["msgSettingsClose", "msgSettingsScrim"].forEach(function (x) {
      $(x).addEventListener("click", function () { settingsOpen(false); });
    });
    $("msgSettingsBody").addEventListener("click", function (ev) {
      if (ev.target.closest("#msgSetSave")) return saveSettings();
      if (ev.target.closest("#msgQuickAdd")) {
        var listEl = $("msgQuickList");
        if (listEl.children.length >= 12) return;
        var row = document.createElement("div");
        row.className = "app-msg-quick-row";
        row.innerHTML = '<textarea data-quick-edit="new" rows="2" maxlength="300" placeholder="Type a quick reply"></textarea>' +
          '<button type="button" class="app-icon-btn" data-quick-remove="new" aria-label="Remove">×</button>';
        listEl.appendChild(row);
        row.querySelector("textarea").focus();
        return;
      }
      var rm = ev.target.closest("[data-quick-remove]");
      if (rm) {
        var row = rm.closest(".app-msg-quick-row");
        if (row) row.parentNode.removeChild(row);
      }
    });
    $("msgTo").addEventListener("input", paintSuggestions);
    $("msgTo").addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); moveSuggest(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSuggest(-1); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        var r = recipientFromField();
        if (r) chooseRecipient(r);
      } else if (ev.key === "Escape") {
        $("msgToSuggest").classList.add("hidden");
      }
    });
    $("msgToSuggest").addEventListener("mousedown", function (ev) {
      var b = ev.target.closest("[data-suggest]");
      if (!b) return;
      ev.preventDefault();
      chooseRecipient(state.suggest[Number(b.getAttribute("data-suggest"))]);
    });
    $("msgToChip").addEventListener("click", function (ev) {
      if (!ev.target.closest("#msgToClear")) return;
      state.draftThread = null;
      $("msgToChip").classList.add("hidden");
      $("msgTo").classList.remove("hidden");
      $("msgTo").focus();
      $("msgConversation").innerHTML = '<p class="app-empty">Type a name or number above.</p>';
    });
    $("msgToCancel").addEventListener("click", function () {
      endCompose();
      state.draftThread = null;
      setOpen("");
    });
  }

  /** Listens from sign-in so the sidebar count stays current. */
  function attach(session) {
    state.session = session;
    watchReads(session);
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
    // Settings → Messaging settings lands here with ?settings=1.
    var qs = new URLSearchParams(location.search);
    if (qs.get("settings") === "1") {
      try { history.replaceState(null, "", "/app/messages"); } catch (e) {}
      settingsOpen(true);
    }
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
