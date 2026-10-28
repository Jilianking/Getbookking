/**
 * Marketing-site events for GTM / GA4 (container GTM-PHZKXCNL).
 * Pushes dataLayer for Tag Manager Preview, and gtag() so GA4 records the event
 * without extra GTM tags. Do not send emails, names, or phone numbers.
 */
(function (global) {
  global.dataLayer = global.dataLayer || [];

  var PLAN_ITEMS = {
    solo: { item_id: "solo", item_name: "Solo", price: 39 },
    studio: { item_id: "studio", item_name: "Studio", price: 79 },
    shop: { item_id: "shop", item_name: "Shop", price: 149 },
    charter: { item_id: "charter", item_name: "Charter", price: 24 },
  };

  var SITELINK_PAGES = {
    "/pricing": "pricing",
    "/tap-to-pay": "tap_to_pay",
    "/templates": "templates",
    "/messaging": "messaging",
    "/contact": "contact",
  };

  function copyParams(params) {
    var out = {};
    if (!params) return out;
    Object.keys(params).forEach(function (key) {
      if (params[key] == null || params[key] === "") return;
      out[key] = params[key];
    });
    return out;
  }

  function fireGtag(name, params) {
    if (typeof global.gtag !== "function") return false;
    global.gtag("event", name, params);
    return true;
  }

  function bkTrack(name, params) {
    if (!name) return;
    var payload = copyParams(params);
    var row = { event: name };
    Object.keys(payload).forEach(function (key) {
      row[key] = payload[key];
    });
    global.dataLayer.push(row);
    if (fireGtag(name, payload)) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (fireGtag(name, payload) || tries > 25) clearInterval(timer);
    }, 200);
  }

  var onceKeys = {};
  function bkTrackOnce(key, name, params) {
    if (!key || onceKeys[key]) return;
    onceKeys[key] = true;
    bkTrack(name, params);
  }

  function normalizePlan(plan) {
    return (plan || "").toString().trim().toLowerCase();
  }

  function planItem(plan) {
    return PLAN_ITEMS[normalizePlan(plan)] || null;
  }

  function ecommerceForPlan(plan, extras) {
    var item = planItem(plan);
    var out = copyParams(extras);
    out.currency = "USD";
    if (!item) return out;
    out.value = item.price;
    out.items = [
      {
        item_id: item.item_id,
        item_name: item.item_name,
        price: item.price,
        quantity: 1,
      },
    ];
    return out;
  }

  function trackViewItem(plan) {
    var payload = ecommerceForPlan(plan);
    if (!payload.items) return;
    bkTrack("view_item", payload);
  }

  function trackBeginCheckout(plan, extras) {
    bkTrackOnce("begin_checkout", "begin_checkout", ecommerceForPlan(plan, extras));
  }

  function trackPurchase(plan, transactionId, extras) {
    var tid = (transactionId || "").toString().trim();
    var params = copyParams(extras);
    if (tid) params.transaction_id = tid;
    bkTrackOnce("purchase:" + (tid || "session"), "purchase", ecommerceForPlan(plan, params));
  }

  function hrefLooksLikeSignup(href) {
    if (!href) return false;
    var lower = href.toLowerCase();
    if (lower.indexOf("mailto:") === 0) return false;
    if (lower.indexOf("signup.html") !== -1) return true;
    try {
      var url = new URL(href, global.location.href);
      var path = (url.pathname || "").replace(/\/$/, "");
      return path === "/signup";
    } catch (err) {
      return false;
    }
  }

  function planFromHref(href) {
    try {
      var url = new URL(href, global.location.href);
      return normalizePlan(url.searchParams.get("plan"));
    } catch (err) {
      return "";
    }
  }

  function pathKey() {
    try {
      var path = (global.location.pathname || "").replace(/\/$/, "").toLowerCase();
      path = path.replace(/\.html$/, "");
      return path || "/";
    } catch (err) {
      return "";
    }
  }

  function trackSitelinkPage() {
    var id = SITELINK_PAGES[pathKey()];
    if (!id) return;
    bkTrackOnce("page:" + id, "select_content", {
      content_type: "sitelink_page",
      content_id: id,
    });
  }

  function trackPricingPlanFromQuery() {
    if (pathKey() !== "/pricing") return;
    try {
      var plan = normalizePlan(new URLSearchParams(global.location.search).get("plan"));
      if (planItem(plan)) trackViewItem(plan);
    } catch (err) {
      /* ignore */
    }
  }

  function onClick(ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (hrefLooksLikeSignup(href)) {
      bkTrack("select_content", {
        content_type: "cta",
        content_id: "signup",
      });
      var plan = planFromHref(href);
      if (planItem(plan)) trackViewItem(plan);
      return;
    }
    if (href.toLowerCase().indexOf("mailto:support@getbookking.com") === 0) {
      bkTrack("generate_lead", { method: "email" });
    }
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  global.bkTrack = bkTrack;
  global.bkTrackOnce = bkTrackOnce;
  global.bkTrackViewItem = trackViewItem;
  global.bkTrackBeginCheckout = trackBeginCheckout;
  global.bkTrackPurchase = trackPurchase;
  document.addEventListener("click", onClick, true);
  onReady(function () {
    trackSitelinkPage();
    trackPricingPlanFromQuery();
  });
})(window);
