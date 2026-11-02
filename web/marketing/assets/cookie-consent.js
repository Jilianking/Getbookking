/**
 * Cookie consent (wording and buttons from Get Bookking's lawyer).
 * Essential cookies always run. Analytics (Google Tag Manager) and advertising (ChatGPT Ads pixel)
 * stay off until the visitor chooses. The choice is saved in this browser, so the banner shows once.
 * "Cookie preferences" in the footer reopens it.
 */
(function () {
  "use strict";
  var KEY = "bkCookieConsent";
  var GTM_ID = "GTM-PHZKXCNL";
  var PIXEL_ID = "Hq1QRMn1nHgCjhGbki399G";
  var loaded = { analytics: false, marketing: false };
  var embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "null");
      return v && typeof v === "object" ? v : null;
    } catch (e) { return null; }
  }

  function save(analytics, marketing) {
    var v = { analytics: !!analytics, marketing: !!marketing, at: new Date().toISOString(), v: 1 };
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
    return v;
  }

  function gtag() { window.dataLayer = window.dataLayer || []; window.dataLayer.push(arguments); }

  /** Turns on only what the visitor allowed. */
  function apply(choice) {
    if (!choice) return;
    window.dataLayer = window.dataLayer || [];
    gtag("consent", "update", {
      analytics_storage: choice.analytics ? "granted" : "denied",
      ad_storage: choice.marketing ? "granted" : "denied",
      ad_user_data: choice.marketing ? "granted" : "denied",
      ad_personalization: choice.marketing ? "granted" : "denied",
    });
    if (choice.analytics && !loaded.analytics) {
      loaded.analytics = true;
      window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
      var g = document.createElement("script");
      g.async = true;
      g.src = "https://www.googletagmanager.com/gtm.js?id=" + GTM_ID;
      document.head.appendChild(g);
    }
    if (choice.marketing && !loaded.marketing) {
      loaded.marketing = true;
      if (!window.oaiq) {
        var q = function () { q.q.push(arguments); };
        q.q = [];
        window.oaiq = q;
        var p = document.createElement("script");
        p.async = true;
        p.src = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
        document.head.appendChild(p);
      }
      window.oaiq("init", { pixelId: PIXEL_ID });
    }
  }

  // Everything optional starts denied until the visitor chooses.
  gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });

  var CSS =
    ".bk-cc{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483000;width:min(460px,calc(100vw - 32px));" +
    "background:#fff;color:#2c2018;border:1px solid #e5ddd2;border-radius:12px;box-shadow:0 12px 34px rgba(26,20,16,.16);" +
    "padding:12px 14px;font:12px/1.45 'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif}" +
    ".bk-cc p{margin:0 0 10px}.bk-cc a{color:#8B6F47;text-decoration:underline}" +
    ".bk-cc-btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}" +
    ".bk-cc button{font:inherit;font-size:12px;font-weight:500;border-radius:999px;padding:6px 12px;cursor:pointer;" +
    "border:1px solid #2c2018;background:#fff;color:#2c2018}" +
    ".bk-cc button.bk-cc-primary{background:#2c2018;color:#fff}" +
    ".bk-cc button:focus-visible{outline:2px solid #8B6F47;outline-offset:2px}" +
    ".bk-cc-prefs{border-top:1px solid #efe8de;margin:2px 0 10px;padding-top:8px;display:flex;flex-direction:column;gap:6px}" +
    ".bk-cc-prefs[hidden]{display:none}" +
    ".bk-cc-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}" +
    ".bk-cc-row strong{display:block;font-size:12.5px}.bk-cc-row span{display:block;font-size:11.5px;color:#7a6b5c}" +
    ".bk-cc-row input{width:16px;height:16px;margin-top:1px;accent-color:#2c2018;flex:none}" +
    "@media (max-width:560px){.bk-cc{left:8px;right:8px;bottom:8px;width:auto;transform:none;padding:12px}.bk-cc-btns button{flex:1 1 auto}}";

  var box = null;

  function close() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  function choose(analytics, marketing) {
    var c = save(analytics, marketing);
    close();
    apply(c);
    // Turning something off after it loaded needs a fresh page to fully stop it.
    if ((!analytics && loaded.analytics) || (!marketing && loaded.marketing)) location.reload();
  }

  function show(openPrefs) {
    if (box) return;
    if (!document.getElementById("bk-cc-style")) {
      var st = document.createElement("style");
      st.id = "bk-cc-style";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var prior = read();
    box = document.createElement("div");
    box.className = "bk-cc";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Cookie preferences");
    box.innerHTML =
      "<p>We use essential cookies to operate and secure this site. With your permission, we also use analytics and other " +
      "optional technologies to understand how the site is used and improve our services. You may accept all cookies, reject " +
      "non-essential cookies, or manage your preferences. Please review our <a href=\"/privacy.html\">Privacy Policy</a> for more information.</p>" +
      "<div class=\"bk-cc-prefs\" hidden>" +
      "<label class=\"bk-cc-row\"><span><strong>Essential</strong><span>Needed to sign in and keep the site secure. Always on.</span></span>" +
      "<input type=\"checkbox\" checked disabled></label>" +
      "<label class=\"bk-cc-row\"><span><strong>Analytics</strong><span>Helps us understand how the site is used.</span></span>" +
      "<input type=\"checkbox\" data-cc=\"analytics\"></label>" +
      "<label class=\"bk-cc-row\"><span><strong>Advertising and marketing</strong><span>Measures our ads and marketing.</span></span>" +
      "<input type=\"checkbox\" data-cc=\"marketing\"></label>" +
      "</div>" +
      "<div class=\"bk-cc-btns\">" +
      "<button type=\"button\" data-cc-act=\"manage\">Manage Preferences</button>" +
      "<button type=\"button\" data-cc-act=\"reject\">Reject Non-Essential</button>" +
      "<button type=\"button\" class=\"bk-cc-primary\" data-cc-act=\"accept\">Accept All</button>" +
      "</div>";
    var a = box.querySelector('[data-cc="analytics"]');
    var m = box.querySelector('[data-cc="marketing"]');
    a.checked = prior ? !!prior.analytics : false;
    m.checked = prior ? !!prior.marketing : false;
    var prefs = box.querySelector(".bk-cc-prefs");
    var manage = box.querySelector('[data-cc-act="manage"]');
    function openPanel() {
      prefs.hidden = false;
      manage.textContent = "Save Choices";
      manage.setAttribute("data-cc-act", "save");
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-cc-act]");
      if (!b) return;
      var act = b.getAttribute("data-cc-act");
      if (act === "accept") choose(true, true);
      else if (act === "reject") choose(false, false);
      else if (act === "manage") openPanel();
      else if (act === "save") choose(a.checked, m.checked);
    });
    document.body.appendChild(box);
    if (openPrefs) openPanel();
  }

  /** Adds "Cookie preferences" next to Privacy / Terms in the footer. */
  function addFooterLink() {
    var privacy = document.querySelector('footer a[href="privacy.html"], footer a[href="/privacy.html"], footer a[href="/privacy"]');
    var list = privacy && privacy.closest("ul");
    if (!list || list.querySelector("[data-cc-open]")) return;
    var li = document.createElement("li");
    li.innerHTML = '<a href="#" data-cc-open>Cookie preferences</a>';
    li.firstChild.addEventListener("click", function (ev) { ev.preventDefault(); show(true); });
    list.appendChild(li);
  }

  window.bkCookiePreferences = function () { show(true); };

  function start() {
    var choice = read();
    if (choice) apply(choice);
    // Pages shown inside the shop app follow the saved choice but don't show their own banner.
    if (embedded) return;
    addFooterLink();
    if (!choice) show(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
