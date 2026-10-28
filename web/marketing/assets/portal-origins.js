/**
 * Where sign-in and password-reset links point. There is one site now; the separate admin and
 * beta portals were retired, so every "portal" resolves to the marketing site.
 */
(function (global) {
  var PROD_MARKETING = "https://getbookking.com";

  function isDevHost(hostname) {
    var h = (hostname || global.location.hostname || "").toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h.endsWith(".web.app") ||
      h.endsWith(".firebaseapp.com")
    );
  }

  function portalFromPath() {
    return "marketing";
  }

  function origins() {
    if (isDevHost()) {
      return { marketing: global.location.origin.replace(/\/+$/, "") };
    }
    return { marketing: PROD_MARKETING };
  }

  function originForPortal() {
    return origins().marketing;
  }

  function absoluteUrl(portal, pathAndQuery) {
    var base = originForPortal(portal).replace(/\/+$/, "");
    var path = (pathAndQuery || "").toString();
    if (!path) return base;
    if (path.indexOf("://") !== -1) return path;
    if (path.charAt(0) !== "/") path = "/" + path;
    return base + path;
  }

  /** Kept for callers; with a single site there is never a host to move to. */
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
