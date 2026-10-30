/**
 * Dashboard lists: new requests, today's appointments, upcoming.
 * Reads tenants/{id}/bookingRequests (same docs as the iPhone app).
 */
(function (global) {
  "use strict";

  var NEW_STATUSES = { new: true };
  var HOLD_STATUSES = {
    confirmed: true,
    pending_deposit: true,
    pending_payment: true,
  };
  var CHARTER_HOLD = {
    new: true,
    pending: true,
    pending_consultation: true,
  };
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

  var HOUR_START = 8;
  var HOUR_COUNT = 11;
  var HOUR_PX = 56;
  var DASH_HOUR_START = 9;
  var DASH_HOUR_COUNT = 9;
  var DASH_HOUR_PX = 48;
  var DUE_STATUSES = {
    pending_deposit: true,
    pending_payment: true,
  };
  var REGION = "us-central1";
  var dashView = "day";
  /** One color per person, in team order (color-blind-safe set). Names always show beside the color. */
  var TEAM_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  var UNASSIGNED_COLOR = "#9A8A7A";

  var calState = {
    team: { hidden: {}, weekMode: "people", loadedFor: "" },
    session: null,
    bookings: [],
    day: null,
    view: "day",
    serviceFilter: "",
    services: [],
    wired: false,
    dashWired: false,
    col: null,
    applySnap: null,
    refreshing: false,
    walkIn: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
    if (v instanceof Date) return v;
    return null;
  }

  function normStatus(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function isCharter(tenant) {
    var plan = String((tenant && tenant.subscriptionPlan) || "").toLowerCase();
    var industry = String((tenant && tenant.industry) || "").toLowerCase();
    return plan.indexOf("charter") !== -1 || industry === "fishing" || industry === "charter";
  }

  function occupies(status, charter) {
    if (HOLD_STATUSES[status]) return true;
    if (charter && CHARTER_HOLD[status]) return true;
    return false;
  }

  function parsePreferredTime(slot, referenceDay) {
    var raw = String(slot || "").trim().replace(/\s+/g, " ");
    if (!raw) return null;
    var m = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (!m) return null;
    var hour = parseInt(m[1], 10);
    var minute = parseInt(m[2], 10);
    var ap = m[3].toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    var d = new Date(referenceDay);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  function appointmentStart(doc) {
    var requested = toDate(doc.requestedStartTime);
    if (requested) return requested;
    var iso = String(doc.scheduledDate || "").trim();
    var startMin = doc.scheduledStartMin;
    if (typeof startMin === "string") startMin = parseInt(startMin, 10);
    if (iso.length >= 10 && typeof startMin === "number" && !isNaN(startMin)) {
      var parts = iso.split("-");
      if (parts.length >= 3) {
        var d = new Date(
          parseInt(parts[0], 10),
          parseInt(parts[1], 10) - 1,
          parseInt(parts[2], 10),
          Math.floor(startMin / 60),
          startMin % 60,
          0,
          0
        );
        if (!isNaN(d.getTime())) return d;
      }
    }
    var created = toDate(doc.createdAt) || new Date();
    return parsePreferredTime(doc.preferredTime, created);
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function formatTime(d) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function formatWhen(d) {
    return (
      d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
      " · " +
      formatTime(d)
    );
  }

  function relative(d) {
    if (!d) return "";
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m ago";
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.round(hours / 24);
    if (days < 7) return days + "d ago";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function mapDoc(doc) {
    var data = doc.data() || {};
    var start = appointmentStart(data);
    return {
      id: doc.id,
      status: normStatus(data.status),
      customerName: String(data.customerName || "").trim() || "Client",
      customerEmail: String(data.customerEmail || "").trim(),
      customerPhone: String(data.customerPhone || "").trim(),
      notes: String(data.notes || "").trim(),
      serviceName: String(data.serviceName || "").trim(),
      assignedName: String(data.assignedMemberName || "").trim(),
      assignedUid: String(data.assignedMemberUid || "").trim(),
      readAt: toDate(data.readAt),
      createdAt: toDate(data.createdAt),
      start: start,
      durationMinutes: (function () {
        var n = data.durationMinutes;
        if (typeof n === "string") n = parseInt(n, 10);
        return typeof n === "number" && n > 0 ? n : 60;
      })(),
    };
  }

  function scoped(list, session) {
    if (session.isOwner) return list;
    var uid = session.user && session.user.uid;
    if (!uid) return [];
    return list.filter(function (b) {
      return b.assignedUid === uid;
    });
  }

  function rowHtml(item, opts) {
    var unread = opts.unread;
    var meta = opts.meta || "";
    var sub = opts.sub || "";
    var startAttr = opts.start
      ? ' data-cal-ms="' + opts.start.getTime() + '"'
      : "";
    if (opts.reqId) startAttr += ' data-req-id="' + esc(opts.reqId) + '"';
    return (
      '<button type="button" class="app-row' +
      (unread ? "" : " is-read") +
      '" data-open-calendar="1"' +
      startAttr +
      ">" +
      '<span class="app-row-dot" aria-hidden="true"></span>' +
      '<span class="app-row-copy"><strong>' +
      esc(item.customerName) +
      "</strong><span>" +
      esc(sub) +
      "</span></span>" +
      '<span class="app-row-meta">' +
      esc(meta) +
      "</span></button>"
    );
  }

  function paintList(wrapId, emptyId, html, emptyText) {
    var wrap = $(wrapId);
    var empty = $(emptyId);
    if (wrap) wrap.innerHTML = html || "";
    if (empty) {
      empty.textContent = emptyText;
      empty.classList.toggle("hidden", !!html);
    }
  }

  function goCalendar(date) {
    closeInbox();
    if (date) {
      calState.day = startOfDay(date);
      calState.view = "day";
    }
    paintCalendar();
    var link = document.querySelector('a.app-nav[data-route="calendar"]');
    if (link) link.click();
  }

  function bindRows(rootId) {
    var root = $(rootId);
    if (!root || root.dataset.bound) return;
    root.dataset.bound = "1";
    root.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-open-calendar]");
      if (!btn) return;
      var reqId = btn.getAttribute("data-req-id");
      if (reqId && global.ShopAppRequests) {
        // New requests open on the Requests page, where they can be confirmed or declined.
        closeInbox();
        var link = document.querySelector('a.app-nav[data-route="requests"]');
        if (link) link.click();
        global.ShopAppRequests.open(reqId);
        return;
      }
      var ms = parseInt(btn.getAttribute("data-cal-ms") || "", 10);
      goCalendar(ms ? new Date(ms) : null);
    });
  }

  function paint(session, bookings) {
    var charter = isCharter(session.tenant);
    var scopedList = scoped(bookings, session);
    if (global.ShopAppDashCharts) global.ShopAppDashCharts.paintBookings(scopedList);
    var now = new Date();
    var todayStart = startOfDay(now);
    var tomorrow = new Date(todayStart);
    tomorrow.setDate(tomorrow.getDate() + 1);

    var news = scopedList
      .filter(function (b) {
        return NEW_STATUSES[b.status];
      })
      .sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

    var badge = $("dashInboxBadge");
    if (badge) {
      badge.textContent = String(news.length);
      badge.classList.toggle("hidden", news.length === 0);
    }

    var notifHtml = news
      .slice(0, 8)
      .map(function (b) {
        var bits = [];
        if (b.serviceName) bits.push(b.serviceName);
        bits.push(STATUS_LABEL[b.status] || "New");
        return rowHtml(b, {
          unread: !b.readAt,
          sub: bits.join(" · "),
          meta: relative(b.createdAt),
          start: b.start,
          reqId: b.id,
        });
      })
      .join("");
    paintList(
      "notifList",
      "notifEmpty",
      notifHtml,
      "You’re caught up."
    );

    var occupying = scopedList.filter(function (b) {
      return occupies(b.status, charter) && b.start;
    });

    var today = occupying
      .filter(function (b) {
        return sameDay(b.start, now);
      })
      .sort(function (a, b) {
        return a.start - b.start;
      });

    var todayLabel = $("todayLabel");
    if (todayLabel) {
      var booked = today.length === 1 ? "1 booked" : today.length + " booked";
      todayLabel.textContent =
        now.toLocaleDateString("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
        }) +
        " · " +
        booked;
    }

    var due = scopedList
      .filter(function (b) {
        return DUE_STATUSES[b.status];
      })
      .sort(function (a, b) {
        return (a.start || 0) - (b.start || 0);
      });
    var dueHtml = due
      .slice(0, 6)
      .map(function (b) {
        var bits = [];
        if (b.serviceName) bits.push(b.serviceName);
        bits.push(STATUS_LABEL[b.status] || b.status);
        return rowHtml(b, {
          unread: true,
          sub: bits.join(" · "),
          meta: b.start ? formatWhen(b.start) : "",
          start: b.start,
        });
      })
      .join("");
    paintList(
      "dueList",
      "dueEmpty",
      dueHtml,
      "No outstanding invoices. Unpaid balances and overdue deposits show up here."
    );

    var upcoming = occupying
      .filter(function (b) {
        return b.start >= tomorrow;
      })
      .sort(function (a, b) {
        return a.start - b.start;
      });

    var upcomingHtml = upcoming
      .slice(0, 8)
      .map(function (b) {
        var bits = [];
        if (b.serviceName) bits.push(b.serviceName);
        if (session.teamMode && b.assignedName) bits.push(b.assignedName);
        bits.push(STATUS_LABEL[b.status] || b.status);
        return rowHtml(b, {
          unread: false,
          sub: bits.join(" · "),
          meta: formatWhen(b.start),
          start: b.start,
        });
      })
      .join("");
    paintList(
      "upcomingList",
      "upcomingEmpty",
      upcomingHtml,
      "Nothing on the books after today. Next 7 days are open."
    );

    var setup = $("dashSetup");
    if (setup) {
      setup.classList.toggle("hidden", (calState.services || []).length > 0);
    }

    paintClock();
    paintDashCalendar();
  }

  /* ── Team: who's shown, each person's color, and the saved choice ── */

  function teamKey(b) {
    return b.assignedUid || "unassigned";
  }

  function teamRoster(session) {
    var list = (session.members || []).map(function (m, i) {
      return {
        key: m.uid || "m" + i,
        uid: m.uid || "",
        name: (m.displayName || m.firstName || "").trim() || "Staff",
        color: TEAM_COLORS[i % TEAM_COLORS.length],
      };
    });
    list.push({ key: "unassigned", uid: "", name: "Unassigned", color: UNASSIGNED_COLOR });
    return list;
  }

  function teamColor(session, key) {
    var hit = teamRoster(session).filter(function (r) { return r.key === key; })[0];
    return hit ? hit.color : UNASSIGNED_COLOR;
  }

  function teamStoreKey(session) {
    return "bkCalTeam:" + (session.tenantId || "");
  }

  function loadTeamChoice(session) {
    if (calState.team.loadedFor === session.tenantId) return;
    calState.team.loadedFor = session.tenantId;
    try {
      var saved = JSON.parse(localStorage.getItem(teamStoreKey(session)) || "{}");
      calState.team.hidden = saved.hidden || {};
      calState.team.weekMode = saved.weekMode === "time" ? "time" : "people";
    } catch (e) { /* private window: keep defaults */ }
  }

  function saveTeamChoice(session) {
    try {
      localStorage.setItem(teamStoreKey(session), JSON.stringify({ hidden: calState.team.hidden, weekMode: calState.team.weekMode }));
    } catch (e) { /* ignore */ }
  }

  function teamShown(key) {
    return !calState.team.hidden[key];
  }

  function paintTeamControls(session) {
    var wrap = $("calTeamWrap");
    var seg = $("calWeekMode");
    var legend = $("calLegend");
    var team = !!session.teamMode;
    if (wrap) wrap.classList.toggle("hidden", !team);
    if (seg) {
      seg.classList.toggle("hidden", !team || calState.view !== "week");
      seg.querySelectorAll("[data-week-mode]").forEach(function (b) {
        b.classList.toggle("is-on", b.getAttribute("data-week-mode") === calState.team.weekMode);
      });
    }
    var roster = teamRoster(session).filter(function (r) { return r.key !== "unassigned"; });
    var hiddenCount = roster.filter(function (r) { return !teamShown(r.key); }).length;
    var btn = $("calTeam");
    if (btn) btn.textContent = (hiddenCount ? "Team · " + (roster.length - hiddenCount) + " of " + roster.length : "Team: everyone") + " ▾";
    var menu = $("calTeamMenu");
    if (menu) {
      menu.innerHTML =
        '<button type="button" class="app-pop-item" data-team-all="1">' + (hiddenCount ? "Show everyone" : "Everyone is shown") + "</button>" +
        teamRoster(session).map(function (r) {
          return '<label class="app-cal-team-opt"><input type="checkbox" data-team-key="' + esc(r.key) + '"' + (teamShown(r.key) ? " checked" : "") + ">" +
            '<i style="background:' + r.color + '"></i>' + esc(r.name) + "</label>";
        }).join("");
    }
    // A color key wherever people aren't already labeled as columns or rows.
    var showLegend = team && (calState.view === "month" || (calState.view === "week" && calState.team.weekMode === "time"));
    if (legend) {
      legend.classList.toggle("hidden", !showLegend);
      legend.innerHTML = showLegend ? teamRoster(session).filter(function (r) { return teamShown(r.key); }).map(function (r) {
        return '<span><i style="background:' + r.color + '"></i>' + esc(r.name) + "</span>";
      }).join("") : "";
    }
  }

  function staffColumns(session, dayBookings) {
    if (!session.teamMode) {
      return [
        {
          key: "shop",
          name: session.firstName || session.shopName || "Shop",
          uid: session.ownerUid || "",
        },
      ];
    }
    var cols = (session.members || []).map(function (m) {
      var name = (m.displayName || m.firstName || "").trim() || "Staff";
      return { key: m.uid || name, name: name, uid: m.uid || "" };
    });
    if (!cols.length) {
      cols.push({
        key: "shop",
        name: session.firstName || session.shopName || "Shop",
        uid: session.ownerUid || "",
      });
    }
    var hasUnassigned = dayBookings.some(function (b) {
      return !b.assignedUid;
    });
    if (hasUnassigned) {
      cols.push({ key: "unassigned", name: "Unassigned", uid: "" });
    }
    var shown = cols.filter(function (c) { return teamShown(c.key); });
    return shown.length ? shown : cols.slice(0, 1);
  }

  function columnFor(booking, cols, teamMode) {
    if (!teamMode) return cols[0];
    if (booking.assignedUid) {
      var hit = cols.filter(function (c) {
        return c.uid && c.uid === booking.assignedUid;
      })[0];
      if (hit) return hit;
    }
    var unassigned = cols.filter(function (c) {
      return c.key === "unassigned";
    })[0];
    return unassigned || cols[0];
  }

  function hourLabel(h) {
    var d = new Date();
    d.setHours(h, 0, 0, 0);
    return d.toLocaleTimeString("en-US", { hour: "numeric" });
  }

  function startOfWeek(d) {
    var x = startOfDay(d);
    x.setDate(x.getDate() - x.getDay());
    return x;
  }

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function isoDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function formatSlotLabel(d) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function phoneDigits(raw) {
    return String(raw || "").replace(/\D/g, "");
  }

  function formatPhone(raw) {
    var d = phoneDigits(raw);
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    if (d.length === 10) {
      return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
    }
    return String(raw || "").trim();
  }

  function last10Digits(raw) {
    var d = phoneDigits(raw);
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    return d.length >= 10 ? d.slice(-10) : d;
  }

  function e164US(raw) {
    var d = last10Digits(raw);
    return d.length === 10 ? "+1" + d : "";
  }

  function parseDepositAmount(raw) {
    var cleaned = String(raw || "")
      .replace(/[$,]/g, "")
      .trim();
    if (!cleaned) return null;
    var n = parseFloat(cleaned);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  }

  function accessOf(session) {
    return (session && session.access) || {};
  }

  function shopRequiresDeposit(session) {
    var t = String(accessOf(session).confirmationType || "").toLowerCase();
    return t === "deposit_to_confirm" || t === "approve_and_deposit";
  }

  function shopCanSms(session) {
    return !!accessOf(session).canSendClientSms;
  }

  function customerDocId(email, phone) {
    var ten = last10Digits(phone);
    if (ten.length >= 10) return ten;
    var normalized = String(email || "")
      .trim()
      .toLowerCase();
    if (normalized) {
      return normalized.replace(/[^a-z0-9]+/g, "_").slice(0, 120);
    }
    return "c" + Date.now();
  }

  function upsertCustomer(session, name, email, phone) {
    var id = customerDocId(email, phone);
    var data = {
      name: name,
      email: email,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (phone) data.phone = phone;
    return firebase
      .firestore()
      .collection("tenants")
      .doc(session.tenantId)
      .collection("customers")
      .doc(id)
      .set(data, { merge: true });
  }

  function depositUiState(session) {
    var requires = shopRequiresDeposit(session);
    var studioSms = shopCanSms(session);
    var phoneEl = $("calNewPhone");
    var digits = last10Digits(phoneEl && phoneEl.value);
    var hasPhone = digits.length >= 10;
    var canSend = studioSms && hasPhone;
    var amount = parseDepositAmount($("calNewDepositAmt") && $("calNewDepositAmt").value);
    var amountOk = amount != null && amount >= 0.5;
    return {
      requires: requires,
      studioSms: studioSms,
      hasPhone: hasPhone,
      canSend: canSend,
      amount: amount,
      amountOk: amountOk,
      willSend: requires && canSend && amountOk,
      blocks: requires && studioSms && !amountOk,
    };
  }

  function paintDepositUi() {
    var session = calState.session;
    var wrap = $("calNewDeposit");
    if (!wrap) return;
    var requires = shopRequiresDeposit(session);
    wrap.classList.toggle("hidden", !requires);
    if (!requires) return;
    var state = depositUiState(session);
    var hint = $("calNewDepositHint");
    var amtEl = $("calNewDepositAmt");
    var amtRaw = amtEl ? String(amtEl.value || "").trim() : "";
    if (hint) {
      if (amtRaw && !state.amountOk) {
        hint.textContent = "Enter at least $0.50 to send a payment link.";
        hint.classList.add("is-bad");
      } else {
        hint.textContent =
          "Set the deposit for this appointment — it can differ from your default in Settings.";
        hint.classList.remove("is-bad");
      }
    }
    var cap = $("calNewDepositCaption");
    if (cap) {
      if (!state.studioSms) {
        cap.textContent =
          "Shop texting isn’t set up — confirm without sending a link.";
      } else if (!state.hasPhone) {
        cap.textContent =
          "Add a phone number. The deposit link will be texted on confirm.";
      } else if (!state.amountOk) {
        cap.textContent = "Enter a deposit amount to text the payment link.";
      } else {
        cap.textContent = "The client will be texted a payment link on confirm.";
      }
    }
    var will = $("calNewDepositWillSend");
    if (will) will.classList.toggle("hidden", !state.willSend);
  }

  function sendDepositLink(requestId, name, phone, amount) {
    var cents = Math.round(amount * 100);
    if (cents < 50) {
      return Promise.reject(
        new Error("Deposit must be at least $0.50 to send a payment link.")
      );
    }
    var to = e164US(phone);
    if (!to) {
      return Promise.reject(
        new Error("Client has no phone number — deposit link was not sent.")
      );
    }
    var fns = firebase.app().functions(REGION);
    var dollars = (cents / 100).toFixed(2);
    return fns
      .httpsCallable("createDepositLink")({
        serviceAmountCents: cents,
        bookingRequestId: requestId,
      })
      .then(function (res) {
        var url = res && res.data && res.data.url;
        if (!url) throw new Error("Could not create deposit link.");
        return fns.httpsCallable("sendClientSms")({
          to: to,
          body: "Deposit: $" + dollars + "\nPay here: " + url,
          clientName: name,
          threadId: to,
          paymentKind: "deposit",
          amountCents: cents,
          paymentUrl: url,
          threadPreview: "Deposit · $" + dollars,
        });
      });
  }

  function occupyingAll(session) {
    var charter = isCharter(session.tenant);
    return scoped(calState.bookings, session).filter(function (b) {
      return occupies(b.status, charter) && b.start;
    });
  }

  function clockLabel(h) {
    return String(h) + ":00";
  }

  function nowTimeValue() {
    var d = new Date();
    var m = Math.floor(d.getMinutes() / 5) * 5;
    d.setMinutes(m, 0, 0);
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  function paintClock() {
    var el = $("dashSub");
    if (!el) return;
    var now = new Date();
    el.textContent =
      now
        .toLocaleDateString("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
        })
        .toUpperCase() +
      " · " +
      now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function dashBlockHtml(b, extra) {
    var hold = b.status !== "confirmed";
    var startMin = b.start.getHours() * 60 + b.start.getMinutes();
    var windowStart = DASH_HOUR_START * 60;
    var windowEnd = (DASH_HOUR_START + DASH_HOUR_COUNT) * 60;
    var endMin = startMin + b.durationMinutes;
    if (endMin <= windowStart || startMin >= windowEnd) return "";
    var topMin = Math.max(startMin, windowStart) - windowStart;
    var visEnd = Math.min(endMin, windowEnd) - windowStart;
    var top = (topMin / 60) * DASH_HOUR_PX;
    var height = Math.max(28, ((visEnd - topMin) / 60) * DASH_HOUR_PX - 4);
    var sub = extra || b.serviceName || formatTime(b.start);
    return (
      '<button type="button" class="app-dash-block' +
      (hold ? " is-hold" : "") +
      '" data-booking-id="' +
      esc(b.id) +
      '" style="top:' +
      top +
      "px;height:" +
      height +
      'px">' +
      "<strong>" +
      esc(b.customerName) +
      "</strong><span>" +
      esc(sub) +
      "</span></button>"
    );
  }

  function nowLineHtml(day) {
    var now = new Date();
    if (!sameDay(day, now)) return "";
    var startMin = DASH_HOUR_START * 60;
    var endMin = (DASH_HOUR_START + DASH_HOUR_COUNT) * 60;
    var nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < startMin || nowMin > endMin) return "";
    var top = ((nowMin - startMin) / 60) * DASH_HOUR_PX;
    return (
      '<div class="app-dash-now" style="top:' +
      top +
      'px"><span class="app-dash-now-time">' +
      esc(
        now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      ) +
      '</span><span class="app-dash-now-dot"></span><span class="app-dash-now-line"></span><span class="app-dash-now-tag">now</span></div>'
    );
  }

  function paintDashDay(session, occupying, board) {
    var day = calState.day || startOfDay(new Date());
    occupying = occupying.filter(function (b) {
      return sameDay(b.start, day);
    });
    var hours = "";
    for (var h = 0; h < DASH_HOUR_COUNT; h++) {
      hours +=
        '<div class="app-dash-hour"><span>' +
        esc(clockLabel(DASH_HOUR_START + h)) +
        "</span><i></i></div>";
    }
    var blocks = occupying
      .map(function (b) {
        var extra = b.serviceName || formatTime(b.start);
        if (session.teamMode && b.assignedName) extra += " · " + b.assignedName;
        return dashBlockHtml(b, extra);
      })
      .join("");
    board.innerHTML =
      '<div class="app-dash-timeline" style="--cal-hour:' +
      DASH_HOUR_PX +
      "px;--hour-count:" +
      DASH_HOUR_COUNT +
      '"><div class="app-dash-hours">' +
      hours +
      '</div><div class="app-dash-lane">' +
      blocks +
      nowLineHtml(day) +
      "</div></div>";
  }

  function ensureDashScaffold(board) {
    if (board.querySelector("#dashCalHead") && board.querySelector("#dashCalGrid")) {
      return;
    }
    board.innerHTML =
      '<div class="app-cal-head" id="dashCalHead"></div>' +
      '<div class="app-cal-grid" id="dashCalGrid"></div>';
  }

  function paintDashEmpty(occupying) {
    var empty = $("dashCalEmpty");
    if (!empty) return;
    var day = calState.day || startOfDay(new Date());
    var todayCount = occupying.filter(function (b) {
      return sameDay(b.start, day);
    }).length;
    var show = dashView === "day" && todayCount === 0;
    empty.classList.toggle("hidden", !show);
  }

  function paintDashCalendar() {
    var session = calState.session;
    var board = $("dashCalBoard");
    if (!session || !board) return;
    if (!calState.day) calState.day = startOfDay(new Date());
    document.querySelectorAll("[data-dash-view]").forEach(function (btn) {
      btn.classList.toggle(
        "is-on",
        btn.getAttribute("data-dash-view") === dashView
      );
    });
    var occupying = occupyingAll(session);
    if (dashView === "day") {
      board.className = "app-dash-cal is-day";
      paintDashDay(session, occupying, board);
    } else {
      board.className =
        "app-dash-cal app-cal-board " +
        (dashView === "week" ? "is-week" : "is-month");
      ensureDashScaffold(board);
      board.style.setProperty("--cal-hour", (dashView === "week" ? 40 : HOUR_PX) + "px");
      board.style.setProperty("--hour-count", String(HOUR_COUNT));
      var head = $("dashCalHead");
      var grid = $("dashCalGrid");
      if (dashView === "week") paintWeek(session, occupying, board, head, grid);
      else paintMonth(session, occupying, board, head, grid);
    }
    paintDashEmpty(occupying);
  }

  function openNewSheet(opts) {
    calState.walkIn = !!(opts && opts.walkIn);
    loadServices(calState.session).finally(function () {
      setSheetOpen(true);
      var c = opts && opts.client;
      if (c) {
        // "Book appointment" from a client profile fills in who it's for.
        if ($("calNewName")) $("calNewName").value = c.name || "";
        if ($("calNewEmail")) $("calNewEmail").value = c.email || "";
        if ($("calNewPhone")) $("calNewPhone").value = c.phone || "";
      }
    });
  }

  function occupyingFiltered(session) {
    var charter = isCharter(session.tenant);
    return scoped(calState.bookings, session).filter(function (b) {
      if (!occupies(b.status, charter) || !b.start) return false;
      if (calState.serviceFilter && b.serviceName !== calState.serviceFilter) return false;
      if (session.teamMode && !teamShown(teamKey(b))) return false;
      return true;
    });
  }

  function serviceNames(session) {
    var names = {};
    scoped(calState.bookings, session).forEach(function (b) {
      if (b.serviceName) names[b.serviceName] = true;
    });
    (calState.services || []).forEach(function (s) {
      if (s.name) names[s.name] = true;
    });
    return Object.keys(names).sort(function (a, b) {
      return a.localeCompare(b);
    });
  }

  function blockHtml(b, extra) {
    var hold = b.status !== "confirmed";
    var startMin = b.start.getHours() * 60 + b.start.getMinutes();
    var windowStart = HOUR_START * 60;
    var windowEnd = (HOUR_START + HOUR_COUNT) * 60;
    var endMin = startMin + b.durationMinutes;
    if (endMin <= windowStart || startMin >= windowEnd) return "";
    var topMin = Math.max(startMin, windowStart) - windowStart;
    var visEnd = Math.min(endMin, windowEnd) - windowStart;
    var top = (topMin / 60) * HOUR_PX;
    var height = Math.max(28, ((visEnd - topMin) / 60) * HOUR_PX - 4);
    var sub = extra || b.serviceName || formatTime(b.start);
    var session = calState.session;
    var member = session && session.teamMode ? "--member:" + teamColor(session, teamKey(b)) + ";" : "";
    return (
      '<button type="button" class="app-cal-block' +
      (member ? " has-member" : "") +
      (hold ? " is-hold" : "") +
      '" data-booking-id="' +
      esc(b.id) +
      '" style="' + member + "top:" +
      top +
      "px;height:" +
      height +
      'px">' +
      "<strong>" +
      esc(b.customerName) +
      "</strong><span>" +
      esc(sub) +
      "</span></button>"
    );
  }

  function timesHtml() {
    var times = '<div class="app-cal-times">';
    for (var h = 0; h < HOUR_COUNT; h++) {
      times += "<span>" + esc(hourLabel(HOUR_START + h)) + "</span>";
    }
    return times + "</div>";
  }

  function paintDay(session, occupying, board, head, grid) {
    var day = calState.day;
    occupying = occupying.filter(function (b) {
      return sameDay(b.start, day);
    });
    var cols = staffColumns(session, occupying);
    board.style.setProperty("--staff-count", String(cols.length));
    var headHtml = "<span></span>";
    cols.forEach(function (c) {
      headHtml += "<span>" + esc(c.name) + "</span>";
    });
    head.innerHTML = headHtml;
    var colHtml = cols
      .map(function (c) {
        var blocks = occupying
          .filter(function (b) {
            return columnFor(b, cols, session.teamMode) === c;
          })
          .map(function (b) {
            return blockHtml(b);
          })
          .join("");
        return '<div class="app-cal-col">' + blocks + "</div>";
      })
      .join("");
    grid.innerHTML = timesHtml() + colHtml;
  }

  /** Team week: a row per person, a column per day, appointments as chips. */
  function paintTeamWeek(session, occupying, board, head, grid) {
    var start = startOfWeek(calState.day);
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    var today = startOfDay(new Date());
    head.innerHTML = "<span>Team</span>" + days.map(function (d) {
      return '<span class="' + (sameDay(d, today) ? "is-today" : "") + '">' +
        esc(d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate()) + "</span>";
    }).join("");
    var weekEnd = new Date(days[6]);
    weekEnd.setDate(weekEnd.getDate() + 1);
    var inWeek = occupying.filter(function (b) {
      return b.start >= days[0] && b.start < weekEnd;
    });
    var roster = teamRoster(session).filter(function (r) {
      if (!teamShown(r.key)) return false;
      if (r.key !== "unassigned") return true;
      return inWeek.some(function (b) { return !b.assignedUid; });
    });
    grid.innerHTML = roster.map(function (r) {
      var mine = inWeek.filter(function (b) { return teamKey(b) === r.key; });
      var row = '<div class="app-cal-tw-name"><i style="background:' + r.color + '"></i><span><strong>' + esc(r.name) +
        "</strong><em>" + (mine.length === 1 ? "1 appointment" : mine.length + " appointments") + "</em></span></div>";
      days.forEach(function (d) {
        var chips = mine.filter(function (b) { return sameDay(b.start, d); })
          .sort(function (a, b) { return a.start - b.start; })
          .map(function (b) {
            return '<button type="button" class="app-cal-tw-chip' + (b.status !== "confirmed" ? " is-hold" : "") +
              '" style="--member:' + r.color + '" data-booking-id="' + esc(b.id) + '"><time>' + esc(formatTime(b.start)) +
              "</time><span>" + esc(b.customerName) + (b.serviceName ? " · " + esc(b.serviceName) : "") + "</span></button>";
          }).join("");
        row += '<div class="app-cal-tw-cell' + (sameDay(d, today) ? " is-today" : "") + '" data-cal-day="' + isoDate(d) + '">' + chips + "</div>";
      });
      return row;
    }).join("") || '<p class="app-empty">Pick at least one person in the Team menu.</p>';
  }

  function paintWeek(session, occupying, board, head, grid) {
    if (session.teamMode && calState.team.weekMode === "people") {
      paintTeamWeek(session, occupying, board, head, grid);
      return;
    }
    var start = startOfWeek(calState.day);
    board.style.setProperty("--staff-count", "7");
    var headHtml = "<span></span>";
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
      headHtml +=
        "<span>" +
        esc(
          d.toLocaleDateString("en-US", { weekday: "short" }) +
            " " +
            d.getDate()
        ) +
        "</span>";
    }
    head.innerHTML = headHtml;
    var colHtml = days
      .map(function (d) {
        var blocks = occupying
          .filter(function (b) {
            return sameDay(b.start, d);
          })
          .map(function (b) {
            var extra = b.serviceName || formatTime(b.start);
            if (session.teamMode && b.assignedName) extra += " · " + b.assignedName;
            return blockHtml(b, extra);
          })
          .join("");
        return '<div class="app-cal-col">' + blocks + "</div>";
      })
      .join("");
    grid.innerHTML = timesHtml() + colHtml;
  }

  function paintMonth(session, occupying, board, head, grid) {
    var month = startOfMonth(calState.day);
    var firstWeekday = month.getDay();
    var lastDate = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    var byDay = {};
    occupying.forEach(function (b) {
      if (b.start.getMonth() !== month.getMonth() || b.start.getFullYear() !== month.getFullYear()) {
        return;
      }
      var key = isoDate(b.start);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push(b);
    });
    var symbols = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    head.innerHTML = symbols
      .map(function (s) {
        return "<span>" + s + "</span>";
      })
      .join("");
    var cells = "";
    var leading = firstWeekday;
    var startPad = new Date(month);
    startPad.setDate(1 - leading);
    var total = leading + lastDate;
    var rows = Math.ceil(total / 7) * 7;
    var today = startOfDay(new Date());
    for (var i = 0; i < rows; i++) {
      var d = new Date(startPad);
      d.setDate(startPad.getDate() + i);
      var inMonth = d.getMonth() === month.getMonth();
      var key = isoDate(d);
      var events = byDay[key] || [];
      var cls = "app-cal-mday";
      if (!inMonth) cls += " is-out";
      if (sameDay(d, today)) cls += " is-today";
      if (sameDay(d, calState.day)) cls += " is-on";
      var bars = events
        .slice(0, 3)
        .map(function (b) {
          var member = session.teamMode ? ' style="--member:' + teamColor(session, teamKey(b)) + '"' : "";
          return (
            '<span class="app-cal-pill' +
            (member ? " has-member" : "") +
            (b.status !== "confirmed" ? " is-hold" : "") +
            '"' + member + ' data-booking-id="' +
            esc(b.id) +
            '">' +
            esc(b.customerName) +
            "</span>"
          );
        })
        .join("");
      if (events.length > 3) {
        bars += '<span class="app-cal-more">+' + (events.length - 3) + " more</span>";
      }
      cells +=
        '<button type="button" class="' +
        cls +
        '" data-cal-day="' +
        key +
        '"><span class="app-cal-mnum">' +
        d.getDate() +
        '</span><span class="app-cal-mbars">' +
        bars +
        "</span></button>";
    }
    grid.innerHTML = cells;
  }

  function paintDateLabel() {
    var dateEl = $("calDate");
    var prev = $("calPrev");
    var next = $("calNext");
    if (!dateEl || !calState.day) return;
    var day = calState.day;
    if (calState.view === "week") {
      var start = startOfWeek(day);
      var end = new Date(start);
      end.setDate(start.getDate() + 6);
      dateEl.textContent =
        start.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " – " +
        end.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      if (prev) prev.setAttribute("aria-label", "Previous week");
      if (next) next.setAttribute("aria-label", "Next week");
    } else if (calState.view === "month") {
      dateEl.textContent = day.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
      if (prev) prev.setAttribute("aria-label", "Previous month");
      if (next) next.setAttribute("aria-label", "Next month");
    } else {
      dateEl.textContent = day.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      if (prev) prev.setAttribute("aria-label", "Previous day");
      if (next) next.setAttribute("aria-label", "Next day");
    }
    document.querySelectorAll("[data-cal-view]").forEach(function (btn) {
      btn.classList.toggle("is-on", btn.getAttribute("data-cal-view") === calState.view);
    });
    var serviceBtn = $("calService");
    if (serviceBtn) {
      serviceBtn.textContent = calState.serviceFilter
        ? calState.serviceFilter + " ▾"
        : "Service ▾";
      serviceBtn.classList.toggle("is-filtered", !!calState.serviceFilter);
    }
  }

  function paintServiceMenu(session) {
    var menu = $("calServiceMenu");
    if (!menu) return;
    var names = serviceNames(session);
    var html =
      '<button type="button" data-service=""' +
      (calState.serviceFilter ? "" : ' class="is-on"') +
      ">All services</button>";
    names.forEach(function (name) {
      html +=
        '<button type="button" data-service="' +
        esc(name) +
        '"' +
        (calState.serviceFilter === name ? ' class="is-on"' : "") +
        ">" +
        esc(name) +
        "</button>";
    });
    menu.innerHTML = html;
  }

  function paintCalendar() {
    var session = calState.session;
    var board = $("calBoard");
    var head = $("calHead");
    var grid = $("calGrid");
    if (!session || !board || !head || !grid) return;
    if (!calState.day) calState.day = startOfDay(new Date());
    loadTeamChoice(session);
    var teamWeek = !!session.teamMode && calState.view === "week" && calState.team.weekMode === "people";
    board.classList.toggle("is-week", calState.view === "week" && !teamWeek);
    board.classList.toggle("is-teamweek", teamWeek);
    board.classList.toggle("is-month", calState.view === "month");
    paintTeamControls(session);
    board.style.setProperty("--cal-hour", HOUR_PX + "px");
    board.style.setProperty("--hour-count", String(HOUR_COUNT));
    paintDateLabel();
    paintServiceMenu(session);
    var occupying = occupyingFiltered(session);
    if (calState.view === "week") paintWeek(session, occupying, board, head, grid);
    else if (calState.view === "month") paintMonth(session, occupying, board, head, grid);
    else paintDay(session, occupying, board, head, grid);
    paintDashCalendar();
  }

  function shiftRange(dir) {
    if (!calState.day) calState.day = startOfDay(new Date());
    var next = new Date(calState.day);
    if (calState.view === "week") {
      next.setDate(next.getDate() + dir * 7);
    } else if (calState.view === "month") {
      var keep = next.getDate();
      next.setDate(1);
      next.setMonth(next.getMonth() + dir);
      var last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(keep, last));
    } else {
      next.setDate(next.getDate() + dir);
    }
    calState.day = startOfDay(next);
    paintCalendar();
  }

  function closePops() {
    var menu = $("calServiceMenu");
    var btn = $("calService");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
    var tmenu = $("calTeamMenu");
    var tbtn = $("calTeam");
    if (tmenu) tmenu.classList.add("hidden");
    if (tbtn) tbtn.setAttribute("aria-expanded", "false");
  }

  function togglePop(btnId, menuId) {
    var menu = $(menuId);
    var btn = $(btnId);
    if (!menu || !btn) return;
    var open = menu.classList.contains("hidden");
    closePops();
    if (open) {
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  }

  function setSheetOpen(open) {
    if (open) setDetailOpen(false);
    var sheet = $("calSheet");
    var scrim = $("calSheetScrim");
    if (sheet) sheet.classList.toggle("hidden", !open);
    if (scrim) scrim.classList.toggle("hidden", !open);
    if (open) {
      fillNewForm();
      var name = $("calNewName");
      if (name) name.focus();
    }
  }

  function durationLabel(mins) {
    var n = Number(mins) || 0;
    if (n <= 0) return "";
    if (n % 60 === 0) {
      var h = n / 60;
      return h === 1 ? "1 hr" : h + " hrs";
    }
    return n + " min";
  }

  function detailRow(label, value) {
    if (!value) return "";
    return (
      '<div class="app-detail-row"><dt>' +
      esc(label) +
      "</dt><dd>" +
      esc(value) +
      "</dd></div>"
    );
  }

  function bookingById(id) {
    var list = calState.bookings || [];
    return list.filter(function (b) {
      return b.id === id;
    })[0];
  }

  function setDetailOpen(open, booking) {
    var sheet = $("calDetailSheet");
    var scrim = $("calDetailScrim");
    if (sheet) sheet.classList.toggle("hidden", !open);
    if (scrim) scrim.classList.toggle("hidden", !open);
    if (!open || !booking) return;
    var title = $("calDetailTitle");
    if (title) title.textContent = booking.customerName || "Appointment";
    var status = $("calDetailStatus");
    if (status) {
      status.textContent = STATUS_LABEL[booking.status] || booking.status || "";
      status.classList.toggle("hidden", !status.textContent);
    }
    var when = "";
    if (booking.start) {
      when = formatWhen(booking.start);
      var dur = durationLabel(booking.durationMinutes);
      if (dur) when += " · " + dur;
    }
    var list = $("calDetailList");
    if (list) {
      list.innerHTML =
        detailRow("Service", booking.serviceName) +
        detailRow("When", when) +
        detailRow("Staff", booking.assignedName) +
        detailRow("Email", booking.customerEmail) +
        detailRow("Phone", booking.customerPhone) +
        detailRow("Notes", booking.notes);
    }
  }

  function openBookingDetail(id) {
    var booking = bookingById(id);
    if (!booking) return;
    setSheetOpen(false);
    closeInbox();
    setDetailOpen(true, booking);
  }

  function onCalendarClick(ev) {
    var hit = ev.target.closest("[data-booking-id]");
    if (hit) {
      ev.preventDefault();
      ev.stopPropagation();
      openBookingDetail(hit.getAttribute("data-booking-id"));
      return true;
    }
    return false;
  }

  function fillNewForm() {
    var session = calState.session;
    if (!session) return;
    var charter = isCharter(session.tenant);
    $("calNewServiceLabel").textContent = charter ? "Trip" : "Service";
    var svc = $("calNewService");
    var options = (calState.services || [])
      .map(function (s) {
        return (
          '<option value="' +
          esc(s.id) +
          '">' +
          esc(s.name) +
          "</option>"
        );
      })
      .join("");
    svc.innerHTML = options || '<option value="">No services yet</option>';
    var staffRow = $("calNewStaffRow");
    var staff = $("calNewStaff");
    if (session.teamMode) {
      staffRow.classList.remove("hidden");
      staff.innerHTML = (session.members || [])
        .map(function (m) {
          var uid = m.uid || "";
          var label = (m.displayName || m.firstName || "").trim() || "Staff";
          var selected = uid === session.user.uid ? " selected" : "";
          return (
            '<option value="' +
            esc(uid) +
            '"' +
            selected +
            ">" +
            esc(label) +
            "</option>"
          );
        })
        .join("");
    } else {
      staffRow.classList.add("hidden");
      staff.innerHTML = "";
    }
    var boats = (session.tenant && session.tenant.charterBoats) || [];
    var boatRow = $("calNewBoatRow");
    var boat = $("calNewBoat");
    if (charter) {
      boatRow.classList.remove("hidden");
      boat.innerHTML = boats
        .map(function (b) {
          var id = b.id || "";
          var label = (b.displayName || b.name || "Boat").trim();
          return '<option value="' + esc(id) + '">' + esc(label) + "</option>";
        })
        .join("");
    } else {
      boatRow.classList.add("hidden");
    }
    var day = calState.day || startOfDay(new Date());
    $("calSheetTitle").textContent = calState.walkIn
      ? "Walk-in"
      : charter
        ? "New charter"
        : "New booking";
    $("calNewDate").value = isoDate(calState.walkIn ? new Date() : day);
    $("calNewTime").value = calState.walkIn ? nowTimeValue() : "10:00";
    $("calNewName").value = "";
    $("calNewEmail").value = "";
    $("calNewPhone").value = "";
    $("calNewNotes").value = calState.walkIn ? "Walk-in" : "";
    $("calNewError").classList.add("hidden");
    $("calNewError").textContent = "";
    var depositAmt = $("calNewDepositAmt");
    var defaultDeposit = accessOf(session).depositAmount;
    if (depositAmt) {
      depositAmt.value =
        defaultDeposit && defaultDeposit > 0 ? defaultDeposit.toFixed(2) : "";
    }
    var saveBtn = $("calNewSave");
    saveBtn.disabled = false;
    saveBtn.textContent = charter ? "Confirm charter" : "Confirm";
    paintDepositUi();
  }

  function loadServices(session) {
    if (!session || !session.tenantId) return Promise.resolve();
    return firebase
      .firestore()
      .collection("tenants")
      .doc(session.tenantId)
      .collection("services")
      .get()
      .then(function (snap) {
        var list = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          if (d.isActive === false) return;
          var name = String(d.name || "").trim();
          if (!name) return;
          var dur = d.durationMinutes;
          if (typeof dur === "string") dur = parseInt(dur, 10);
          list.push({
            id: doc.id,
            name: name,
            slug: String(d.slug || "").trim(),
            durationMinutes: typeof dur === "number" && dur > 0 ? dur : 60,
            sortOrder: typeof d.sortOrder === "number" ? d.sortOrder : 999,
          });
        });
        list.sort(function (a, b) {
          if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
          return a.name.localeCompare(b.name);
        });
        calState.services = list;
        var setup = $("dashSetup");
        if (setup) setup.classList.toggle("hidden", list.length > 0);
        paintCalendar();
      })
      .catch(function () {
        calState.services = [];
      });
  }

  function memberForUid(session, uid) {
    var list = session.members || [];
    var hit = list.filter(function (m) {
      return m.uid === uid;
    })[0];
    if (hit) {
      return {
        uid: hit.uid,
        displayName: (hit.displayName || hit.firstName || "").trim() || "Staff",
        email: hit.email || "",
      };
    }
    return {
      uid: session.ownerUid || (session.user && session.user.uid) || "",
      displayName:
        session.user.displayName || session.firstName || session.shopName || "Owner",
      email: (session.user && session.user.email) || "",
    };
  }

  function saveAppointment(ev) {
    ev.preventDefault();
    var session = calState.session;
    var err = $("calNewError");
    var saveBtn = $("calNewSave");
    var charter = session ? isCharter(session.tenant) : false;
    var confirmLabel = charter ? "Confirm charter" : "Confirm";
    function fail(msg) {
      err.textContent = msg;
      err.classList.remove("hidden");
      saveBtn.disabled = false;
      saveBtn.textContent = confirmLabel;
    }
    if (!session) return;
    var name = $("calNewName").value.trim();
    var email = $("calNewEmail").value.trim();
    var phone = formatPhone($("calNewPhone").value);
    var digits = last10Digits(phone);
    var serviceId = $("calNewService").value;
    var dateVal = $("calNewDate").value;
    var timeVal = $("calNewTime").value;
    var notes = $("calNewNotes").value.trim();
    if (!name) return fail("Enter the client name.");
    if (!email || email.indexOf("@") === -1) return fail("Enter a valid email.");
    if (digits.length < 10) return fail("Enter a 10-digit phone number.");
    var service = (calState.services || []).filter(function (s) {
      return s.id === serviceId;
    })[0];
    if (!service) return fail("Add a service in the iPhone app before scheduling.");
    if (!dateVal || !timeVal) return fail("Pick a date and time.");
    var parts = timeVal.split(":");
    var start = new Date(dateVal + "T00:00:00");
    start.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    var staffUid = session.teamMode
      ? $("calNewStaff").value
      : session.ownerUid || session.user.uid;
    var member = memberForUid(session, staffUid);
    if (!member.uid) return fail("Choose a staff member.");
    var boatId = charter ? $("calNewBoat").value : "";
    if (charter && !boatId) return fail("Add a boat in Business settings before scheduling.");
    var deposit = depositUiState(session);
    if (deposit.blocks) {
      return fail("Enter at least $0.50 to send a payment link.");
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Confirming…";
    err.classList.add("hidden");
    var fns = firebase.app().functions(REGION);
    var col = firebase
      .firestore()
      .collection("tenants")
      .doc(session.tenantId)
      .collection("bookingRequests");
    var preferred = formatSlotLabel(start);
    var done = function () {
      setSheetOpen(false);
      calState.day = startOfDay(start);
      calState.view = "day";
      paintCalendar();
    };
    var afterConfirm = function (requestId) {
      var next = Promise.resolve();
      if (deposit.willSend && requestId) {
        next = sendDepositLink(requestId, name, phone, deposit.amount);
      }
      return next.then(done);
    };

    var created;
    if (charter) {
      created = fns
        .httpsCallable("syncCharterBookingSlot")({
          scheduledDate: isoDate(start),
          scheduledStartMin: start.getHours() * 60 + start.getMinutes(),
          preferredTime: preferred,
          durationMinutes: service.durationMinutes,
          status: "confirmed",
          assignedMemberUid: member.uid,
          assignedMemberName: member.displayName,
          assignedMemberEmail: member.email,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          serviceId: service.id,
          serviceSlug: service.slug,
          serviceName: service.name,
          notes: notes || null,
          boatId: boatId,
        })
        .then(function (res) {
          return res && res.data && res.data.requestId;
        });
    } else {
      created = col
        .add({
          status: "NEW",
          source: calState.walkIn ? "walk_in" : "admin_web",
          tenantId: session.tenantId,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          serviceId: service.id,
          serviceSlug: service.slug,
          serviceName: service.name,
          preferredTime: preferred,
          requestedStartTime: firebase.firestore.Timestamp.fromDate(start),
          durationMinutes: service.durationMinutes,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          notes: notes || "",
        })
        .then(function (ref) {
          return ref
            .update({
              assignedMemberUid: member.uid,
              assignedMemberName: member.displayName,
              assignedMemberEmail: member.email,
              requestedStartTime: firebase.firestore.Timestamp.fromDate(start),
              preferredTime: preferred,
              durationMinutes: service.durationMinutes,
            })
            .then(function () {
              return fns.httpsCallable("updateBookingRequestStatus")({
                requestId: ref.id,
                status: "confirmed",
                notes: notes || "",
              });
            })
            .then(function () {
              return ref.id;
            });
        });
    }

    created
      .then(function (requestId) {
        return upsertCustomer(session, name, email, phone).then(function () {
          return requestId;
        });
      })
      .then(afterConfirm)
      .catch(function (e) {
        fail((e && e.message) || "Could not save the appointment.");
      });
  }

  function refreshBookings() {
    if (!calState.col || !calState.applySnap || calState.refreshing) {
      paintCalendar();
      return;
    }
    calState.refreshing = true;
    var btn = $("calRefresh");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("is-busy");
    }
    var col = calState.col;
    col
      .orderBy("createdAt", "desc")
      .limit(250)
      .get({ source: "server" })
      .catch(function () {
        return col.limit(250).get({ source: "server" });
      })
      .then(function (snap) {
        calState.applySnap(snap);
      })
      .catch(function () {
        paintCalendar();
      })
      .then(function () {
        calState.refreshing = false;
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("is-busy");
        }
      });
  }

  function wireCalendar() {
    if (calState.wired) return;
    calState.wired = true;
    var prev = $("calPrev");
    var next = $("calNext");
    var today = $("calToday");
    var refresh = $("calRefresh");
    if (prev) prev.addEventListener("click", function () { shiftRange(-1); });
    if (next) next.addEventListener("click", function () { shiftRange(1); });
    if (today) {
      today.addEventListener("click", function () {
        calState.day = startOfDay(new Date());
        paintCalendar();
      });
    }
    if (refresh) {
      refresh.addEventListener("click", function () {
        refreshBookings();
      });
    }
    document.querySelectorAll("[data-cal-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        calState.view = btn.getAttribute("data-cal-view") || "day";
        closePops();
        paintCalendar();
      });
    });
    var teamBtn = $("calTeam");
    if (teamBtn) {
      teamBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        togglePop("calTeam", "calTeamMenu");
      });
    }
    var teamMenu = $("calTeamMenu");
    if (teamMenu) {
      teamMenu.addEventListener("change", function (ev) {
        var key = ev.target.getAttribute("data-team-key");
        if (!key) return;
        if (ev.target.checked) delete calState.team.hidden[key];
        else calState.team.hidden[key] = true;
        saveTeamChoice(calState.session);
        paintCalendar();
      });
      teamMenu.addEventListener("click", function (ev) {
        if (!ev.target.closest("[data-team-all]")) return;
        calState.team.hidden = {};
        saveTeamChoice(calState.session);
        paintCalendar();
      });
    }
    var weekMode = $("calWeekMode");
    if (weekMode) {
      weekMode.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-week-mode]");
        if (!b) return;
        calState.team.weekMode = b.getAttribute("data-week-mode");
        saveTeamChoice(calState.session);
        paintCalendar();
      });
    }
    var serviceBtn = $("calService");
    if (serviceBtn) {
      serviceBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        togglePop("calService", "calServiceMenu");
      });
    }
    var serviceMenu = $("calServiceMenu");
    if (serviceMenu) {
      serviceMenu.addEventListener("click", function (ev) {
        var btn = ev.target.closest("[data-service]");
        if (!btn) return;
        calState.serviceFilter = btn.getAttribute("data-service") || "";
        closePops();
        paintCalendar();
      });
    }
    var grid = $("calGrid");
    if (grid) {
      grid.addEventListener("click", function (ev) {
        if (onCalendarClick(ev)) return;
        var cell = ev.target.closest("[data-cal-day]");
        if (!cell) return;
        calState.day = startOfDay(new Date(cell.getAttribute("data-cal-day") + "T00:00:00"));
        calState.view = "day";
        paintCalendar();
      });
    }
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".app-pop-wrap")) closePops();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        closePops();
        setSheetOpen(false);
        setDetailOpen(false);
      }
    });
    var neu = $("calNew");
    if (neu) {
      neu.addEventListener("click", function () {
        openNewSheet();
      });
    }
    ["calSheetClose", "calSheetCancel", "calSheetScrim"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", function () { setSheetOpen(false); });
    });
    ["calDetailClose", "calDetailDone", "calDetailScrim"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", function () { setDetailOpen(false); });
    });
    var form = $("calNewForm");
    if (form) form.addEventListener("submit", saveAppointment);
    var phoneEl = $("calNewPhone");
    if (phoneEl) {
      phoneEl.addEventListener("input", function () {
        var formatted = formatPhone(phoneEl.value);
        if (formatted && formatted !== phoneEl.value && last10Digits(phoneEl.value).length === 10) {
          phoneEl.value = formatted;
        }
        paintDepositUi();
      });
    }
    var depositAmtEl = $("calNewDepositAmt");
    if (depositAmtEl) {
      depositAmtEl.addEventListener("input", paintDepositUi);
      depositAmtEl.addEventListener("change", paintDepositUi);
    }
  }

  function setInboxOpen(open) {
    var pop = $("dashInboxPop");
    var btn = $("dashInboxBtn");
    if (pop) pop.classList.toggle("hidden", !open);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeInbox() {
    setInboxOpen(false);
  }

  function wireDashboard() {
    if (calState.dashWired) return;
    calState.dashWired = true;
    function bind(id, fn) {
      var el = $(id);
      if (el) el.addEventListener("click", fn);
    }
    bind("dashNewAppt", function () {
      openNewSheet();
    });
    bind("dashWalkIn", function () {
      openNewSheet({ walkIn: true });
    });
    bind("dashEmptyWalkIn", function () {
      openNewSheet({ walkIn: true });
    });
    bind("dashEmptyAdd", function () {
      openNewSheet();
    });
    bind("dashNewClient", function () {
      if (window.ShopAppClients && ShopAppClients.openAdd) ShopAppClients.openAdd();
    });
    bind("dashRecordPay", function () {
      var link = document.querySelector('a.app-nav[data-route="payments"]');
      if (link) link.click();
    });
    bind("dashInboxBtn", function (ev) {
      ev.stopPropagation();
      var pop = $("dashInboxPop");
      setInboxOpen(pop && pop.classList.contains("hidden"));
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".app-dash-inbox-wrap")) closeInbox();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeInbox();
    });
    document.querySelectorAll("[data-dash-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        dashView = btn.getAttribute("data-dash-view") || "day";
        paintDashCalendar();
      });
    });
    var board = $("dashCalBoard");
    if (board) {
      board.addEventListener("click", function (ev) {
        if (onCalendarClick(ev)) return;
        var cell = ev.target.closest("[data-cal-day]");
        if (cell) {
          calState.day = startOfDay(
            new Date(cell.getAttribute("data-cal-day") + "T00:00:00")
          );
          dashView = "day";
          paintDashCalendar();
        }
      });
    }
    setInterval(function () {
      paintClock();
      if (dashView === "day") paintDashCalendar();
    }, 30000);
  }

  function load(session) {
    bindRows("notifList");
    bindRows("dueList");
    bindRows("upcomingList");
    wireCalendar();
    wireDashboard();
    if (!session || !session.tenantId) return;
    loadServices(session);
    var col = firebase
      .firestore()
      .collection("tenants")
      .doc(session.tenantId)
      .collection("bookingRequests");

    function applySnap(snap) {
      var list = [];
      snap.forEach(function (doc) {
        list.push(mapDoc(doc));
      });
      calState.session = session;
      calState.bookings = list;
      if (!calState.day) calState.day = startOfDay(new Date());
      paint(session, list);
      paintCalendar();
    }

    calState.col = col;
    calState.applySnap = applySnap;

    col
      .orderBy("createdAt", "desc")
      .limit(250)
      .onSnapshot(applySnap, function () {
        col.limit(250).get().then(applySnap).catch(function () {
          calState.session = session;
          calState.bookings = [];
          paint(session, []);
          paintCalendar();
        });
      });
  }

  global.ShopAppDashboard = {
    load: load,
    sendDepositLink: sendDepositLink,
    openNew: openNewSheet,
    goTo: function (date) {
      calState.day = startOfDay(date instanceof Date ? date : new Date(date));
      calState.view = "day";
      dashView = "day";
      paintCalendar();
      paintDashCalendar();
    },
  };
})(window);
