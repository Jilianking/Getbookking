/**
 * Cloudflare Worker: tenant subdomains → Firebase Hosting path URLs.
 *
 * brandonsmith.getbookking.com/gallery  →  https://test-app-96812.web.app/brandonsmith/gallery
 * brandonsmith.getbookking.com/js/...   →  https://test-app-96812.web.app/js/...  (no tenant prefix)
 *
 * Deploy: cd cloudflare/tenant-proxy && npx wrangler deploy
 * Route in Cloudflare: *.getbookking.com/* (Workers). Keep apex + www on marketing site.
 *
 * Also in Firebase Console → Authentication → Settings → Authorized domains:
 *   add getbookking.com if missing.
 */
const UPSTREAM = "https://test-app-96812.web.app";
const TENANT_DOMAIN = "getbookking.com";

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
  const suffix = "." + TENANT_DOMAIN;
  if (!h.endsWith(suffix)) return null;
  if (h === TENANT_DOMAIN || h === "www." + TENANT_DOMAIN) return null;
  const sub = h.slice(0, -suffix.length);
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

    const upstreamUrl = UPSTREAM + upstreamPath + url.search;
    return fetch(new Request(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    }));
  },
};
