/**
 * Marketing-site events for GTM / GA4 (container GTM-PHZKXCNL).
 * Pushes dataLayer for Tag Manager Preview, and gtag() so GA4 records the event
 * without extra GTM tags. Do not send emails, names, or phone numbers.
 */
(function (global) {
  global.dataLayer = global.dataLayer || [];

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

  function onClick(ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (hrefLooksLikeSignup(href)) {
      bkTrack("select_content", {
        content_type: "cta",
        content_id: "signup",
      });
      return;
    }
    if (href.toLowerCase().indexOf("mailto:support@getbookking.com") === 0) {
      bkTrack("generate_lead", { method: "email" });
    }
  }

  global.bkTrack = bkTrack;
  global.bkTrackOnce = bkTrackOnce;
  document.addEventListener("click", onClick, true);
})(window);
