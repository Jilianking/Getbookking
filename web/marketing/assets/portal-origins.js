/**
 * Portal host isolation: marketing, admin, and beta each have their own origin
 * so Firebase Auth sessions do not overwrite each other in the same browser.
 */
(function (global) {
  var PROD_MARKETING = "https://getbookking.com";
  var PROD_ADMIN = "https://admin.getbookking.com";
  var PROD_BETA = "https://beta.getbookking.com";

  function isDevHost(hostname) {
    var h = (hostname || global.location.hostname || "").toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h.endsWith(".web.app") ||
      h.endsWith(".firebaseapp.com")
    );
  }

  function portalFromPath(pathname) {
    var p = pathname || global.location.pathname || "";
    if (p.indexOf("/admin") === 0) return "admin";
    if (p.indexOf("/beta") === 0) return "beta";
    return "marketing";
  }

  function origins() {
    if (isDevHost()) {
      var origin = global.location.origin.replace(/\/+$/, "");
      return { marketing: origin, admin: origin, beta: origin };
    }
    return {
      marketing: PROD_MARKETING,
      admin: PROD_ADMIN,
      beta: PROD_BETA,
    };
  }

  function originForPortal(portal) {
    var o = origins();
    if (portal === "admin") return o.admin;
    if (portal === "beta") return o.beta;
    return o.marketing;
  }

  function absoluteUrl(portal, pathAndQuery) {
    var base = originForPortal(portal).replace(/\/+$/, "");
    var path = (pathAndQuery || "").toString();
    if (!path) return base;
    if (path.indexOf("://") !== -1) return path;
    if (path.charAt(0) !== "/") path = "/" + path;
    return base + path;
  }

  /** Redirect admin/beta paths on main marketing host to their subdomains (production only). */
  function enforcePortalHost() {
    if (isDevHost()) return false;
    var host = (global.location.hostname || "").toLowerCase();
    if (host !== "getbookking.com" && host !== "www.getbookking.com") return false;

    var portal = portalFromPath();
    if (portal === "marketing") return false;

    var expected = originForPortal(portal);
    if (global.location.origin.replace(/\/+$/, "") === expected.replace(/\/+$/, "")) {
      return false;
    }

    global.location.replace(
      expected +
        global.location.pathname +
        global.location.search +
        global.location.hash
    );
    return true;
  }

  global.PortalOrigins = {
    origins: origins,
    originForPortal: originForPortal,
    absoluteUrl: absoluteUrl,
    portalFromPath: portalFromPath,
    enforcePortalHost: enforcePortalHost,
    isDevHost: isDevHost,
  };

  enforcePortalHost();
})(window);
