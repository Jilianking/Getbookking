/**
 * Shop portal shell: auth gate, Harbor rail, client routes.
 */
(function () {
  "use strict";

  firebase.initializeApp(window.firebaseConfig);
  var auth = firebase.auth();

  function $(id) {
    return document.getElementById(id);
  }

  function showGate(id) {
    ["gateLoading", "gateLogin", "gateNoShop", "appShell"].forEach(function (gid) {
      $(gid).classList.toggle("hidden", gid !== id);
    });
  }

  var ROUTES = [
    "dashboard",
    "requests",
    "team",
    "insights",
    "calendar",
    "clients",
    "shop",
    "payments",
    "payouts",
    "website",
    "billing",
    "account",
    "settings",
  ];
  var FRAME_SRC = {
    billing: "/billing?embed=1",
    account: "/account?embed=1",
    settings: "/settings?embed=1",
  };
  var FRAME_FILE = {
    billing: "billing.html?embed=1",
    account: "account.html?embed=1",
    settings: "settings.html?embed=1",
  };
  var FRAME_ID = {
    billing: "frameBilling",
    account: "frameAccount",
    settings: "frameSettings",
  };

  function frameUrl(route) {
    if (location.protocol === "file:") return FRAME_FILE[route] || "";
    return FRAME_SRC[route] || "";
  }

  function routeFromLocation() {
    var path = (location.pathname || "").replace(/\/+$/, "") || "/app";
    var view = new URLSearchParams(location.search).get("view");
    if (view && ROUTES.indexOf(view) !== -1 && (path === "/app" || path.indexOf("app.html") !== -1)) {
      return view;
    }
    if (path.indexOf("app.html") !== -1) {
      var q = new URLSearchParams(location.search).get("view");
      if (ROUTES.indexOf(q) !== -1) return q;
      return "dashboard";
    }
    if (path.indexOf("/app/requests") !== -1) return "requests";
    if (path.indexOf("/app/team") !== -1) return "team";
    if (path.indexOf("/app/insights") !== -1) return "insights";
    if (path.indexOf("/app/calendar") !== -1) return "calendar";
    if (path.indexOf("/app/clients") !== -1) return "clients";
    if (path.indexOf("/app/shop") !== -1) return "shop";
    if (path.indexOf("/app/payouts") !== -1) return "payouts";
    if (path.indexOf("/app/payments") !== -1) return "payments";
    if (path.indexOf("/app/website") !== -1) return "website";
    if (path.indexOf("/app/billing") !== -1) return "billing";
    if (path.indexOf("/app/settings") !== -1) return "settings";
    if (path.indexOf("/app/account") !== -1) return "account";
    return "dashboard";
  }

  function hrefFor(route) {
    if (route === "website") {
      return location.protocol === "file:" ? "design.html" : "/design";
    }
    if (location.protocol === "file:") {
      return "app.html" + (route === "dashboard" ? "" : "?view=" + route);
    }
    if (route === "dashboard") return "/app";
    if (route === "settings") return "/app?view=settings";
    return "/app/" + route;
  }

  function viewId(name) {
    return "view" + name.charAt(0).toUpperCase() + name.slice(1);
  }

  function ensureFrame(route) {
    var id = FRAME_ID[route];
    if (!id) return;
    var frame = $(id);
    if (!frame) return;
    var url = frameUrl(route);
    if (frame.getAttribute("src") === url) return;
    frame.src = url;
  }

  function isNarrow() {
    return window.matchMedia("(max-width: 960px)").matches;
  }

  function setRailCollapsed(collapsed) {
    var shell = $("appShell");
    if (!shell) return;
    shell.classList.toggle("is-rail-collapsed", collapsed);
    var btn = $("railToggle");
    if (btn) {
      btn.textContent = collapsed ? "›" : "‹";
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
    }
    try {
      sessionStorage.setItem("bk-rail-collapsed", collapsed ? "1" : "0");
    } catch (e) {}
  }

  function initRail() {
    var stored = null;
    try {
      stored = sessionStorage.getItem("bk-rail-collapsed");
    } catch (e) {}
    var collapsed;
    if (stored === "1") collapsed = true;
    else if (stored === "0") collapsed = false;
    else collapsed = isNarrow();
    setRailCollapsed(collapsed);
  }

  var ROUTE_ACCESS = { team: "team", clients: "clients", website: "website", billing: "billing", shop: "shop", payments: "payments", payouts: "payments" };

  function setRoute(route, session) {
    // A link or bookmark to a page this person can't use lands on the dashboard.
    if (session && ROUTE_ACCESS[route] && window.ShopAppAccess && !ShopAppAccess.can(session, ROUTE_ACCESS[route])) {
      route = "dashboard";
    }
    if (route === "website") {
      window.location.replace(hrefFor("website"));
      return;
    }
    if (route === "payouts" && session && !session.teamMode) {
      route = "payments";
    }
    ROUTES.forEach(function (name) {
      var view = $(viewId(name));
      if (view) view.classList.toggle("hidden", name !== route);
    });
    ensureFrame(route);
    var canvas = $("appCanvas");
    if (canvas) canvas.classList.toggle("is-frame", !!FRAME_ID[route]);
    document.querySelectorAll(".app-nav[data-route]").forEach(function (link) {
      link.classList.toggle("is-active", link.getAttribute("data-route") === route);
    });
    var folder = $("paymentsFolder");
    if (folder) {
      folder.classList.toggle("is-open", route === "payments" || route === "payouts");
    }
    var titles = {
      dashboard: "Dashboard",
      requests: "Requests",
      team: "Team",
      insights: "Insights",
      calendar: "Calendar",
      clients: "Clients",
      shop: "Shop",
      payments: "Client payments",
      payouts: "Team payouts",
      website: "Website builder",
      billing: "Plan & billing",
      account: "Your account",
      settings: "Settings",
    };
    document.title = (titles[route] || "Shop") + " — Get Bookking";
    if (route === "payments" && window.ShopAppPayments) {
      ShopAppPayments.load(session);
    }
    if (route === "payouts" && window.ShopAppPayouts) {
      ShopAppPayouts.load(session);
    }
    if (route === "team" && window.ShopAppTeam) {
      ShopAppTeam.load(session);
    }
    if (route === "insights" && window.ShopAppInsights) {
      ShopAppInsights.load(session);
    }
    if (route === "requests" && window.ShopAppRequests) {
      ShopAppRequests.load(session);
    }
    if (route === "clients" && window.ShopAppClients) {
      ShopAppClients.load(session);
    }
    if (route === "shop" && window.ShopAppShop) {
      ShopAppShop.load(session);
    }
  }

  function formatToday() {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }

  function paintSession(session) {
    $("shopName").textContent = session.shopName;
    $("shopKind").textContent = session.shopKind;
    $("userName").textContent =
      session.user.displayName || session.firstName || session.user.email || "Account";
    $("userRole").textContent = session.isOwner ? "Owner" : "Team";
    var initial = ($("userName").textContent || "?").charAt(0).toUpperCase();
    $("userInitial").textContent = initial;

    // Hide what this person isn't allowed to open (Team → Permissions for managers).
    [["dashRecordPay", "payments"], ["dashDue", "payments"], ["dashNewClient", "clients"]].forEach(function (pair) {
      var el = $(pair[0]);
      if (el) el.classList.toggle("hidden", !ShopAppAccess.can(session, pair[1]));
    });
    var can = function (w) { return ShopAppAccess.can(session, w); };
    var navFor = function (route) { return document.querySelectorAll('.app-nav[data-route="' + route + '"]'); };
    [["team", "team"], ["clients", "clients"], ["website", "website"], ["billing", "billing"], ["shop", "shop"], ["payouts", "payments"]]
      .forEach(function (pair) {
        navFor(pair[0]).forEach(function (el) { el.classList.toggle("hidden", !can(pair[1])); });
      });
    $("paymentsFolder").classList.toggle("hidden", !session.teamMode);
    $("paymentsFlat").classList.toggle("hidden", session.teamMode);
    if (!can("payments")) {
      $("paymentsFlat").classList.add("hidden");
      $("paymentsFolder").classList.add("hidden");
    }

    var greet = session.salutation;
    if (session.firstName) greet += ", " + session.firstName;
    $("dashGreeting").textContent = greet;
    if ($("todayLabel")) $("todayLabel").textContent = formatToday();
    $("calDate").textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    document.querySelectorAll("a[data-route]").forEach(function (a) {
      a.setAttribute("href", hrefFor(a.getAttribute("data-route")));
    });
  }

  function wireNav(session) {
    document.querySelectorAll("a[data-route]").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var route = a.getAttribute("data-route");
        if (route === "website") return;
        ev.preventDefault();
        var href = hrefFor(route);
        if (location.pathname + location.search !== href) {
          history.pushState({ route: route }, "", href);
        }
        setRoute(route, session);
        if (isNarrow()) setRailCollapsed(true);
      });
    });
    window.addEventListener("popstate", function () {
      setRoute(routeFromLocation(), session);
    });
    initRail();
    $("railToggle").addEventListener("click", function () {
      setRailCollapsed(!$("appShell").classList.contains("is-rail-collapsed"));
    });
    $("railScrim").addEventListener("click", function () {
      setRailCollapsed(true);
    });
    $("railSignOut").addEventListener("click", function () {
      auth.signOut().then(function () {
        window.location.href = "/";
      });
    });
  }

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      showGate("gateLogin");
      return;
    }
    ShopAppSession.load(user)
      .then(function (session) {
        paintSession(session);
        wireNav(session);
        showGate("appShell");
        if (window.ShopAppPayments) ShopAppPayments.attach(session);
        if (window.ShopAppClients) ShopAppClients.attach(session);
        if (window.ShopAppShop) ShopAppShop.attach(session);
        if (window.ShopAppRequests) ShopAppRequests.attach(session);
        setRoute(routeFromLocation(), session);
        if (window.ShopAppDashboard) ShopAppDashboard.load(session);
        if (window.ShopAppDashCharts) ShopAppDashCharts.load(session);
      })
      .catch(function (err) {
        if (err && err.code === "no-shop") {
          showGate("gateNoShop");
          return;
        }
        $("gateNoShopMsg").textContent =
          (err && err.message) || "Could not load your shop.";
        showGate("gateNoShop");
      });
  });
})();
