/**
 * Cloudflare Worker: tenant subdomains → Firebase Hosting path URLs.
 *
 * britney.getbookking.com/gallery  →  https://getbookking.com/britney/gallery
 * britney.getbookking.com/js/...  →  https://getbookking.com/js/...  (no tenant prefix)
 *
 * Deploy: cd cloudflare/tenant-proxy && npx wrangler deploy
 * Route in Cloudflare: *.getbookking.com/* (Workers). Keep apex + www on Firebase as today.
 *
 * Also in Firebase Console → Authentication → Settings → Authorized domains:
 *   add getbookking.com if missing, and *.getbookking.com if the console allows wildcards.
 */
const ORIGIN = "https://getbookking.com";
const ORIGIN_HOST = "getbookking.com";

const RESERVED = new Set([
  "www",
  "app",
  "api",
  "admin",
  "mail",
  "ftp",
  "cdn",
  "static",
  "firebase",
]);

function isStaticPath(pathname) {
  if (pathname.startsWith("/js/")) return true;
  if (pathname.startsWith("/fonts/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return true;
  if (pathname.startsWith("/.well-known/")) return true;
  return false;
}

function extractSubdomain(hostname) {
  const h = hostname.toLowerCase();
  if (!h.endsWith("." + ORIGIN_HOST)) return null;
  if (h === ORIGIN_HOST || h === "www." + ORIGIN_HOST) return null;
  const sub = h.slice(0, -(ORIGIN_HOST.length + 1));
  if (!sub || sub.includes(".")) return null;
  if (RESERVED.has(sub)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) return null;
  return sub;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const sub = extractSubdomain(url.hostname);
    if (!sub) {
      return fetch(request);
    }

    let pathname = url.pathname || "/";
    if (!pathname.startsWith("/")) pathname = "/" + pathname;

    let upstreamPath;
    if (isStaticPath(pathname)) {
      upstreamPath = pathname;
    } else {
      upstreamPath = "/" + encodeURIComponent(sub) + (pathname === "/" ? "" : pathname);
    }

    const upstreamUrl = ORIGIN + upstreamPath + url.search;
    return fetch(new Request(upstreamUrl, request));
  },
};
