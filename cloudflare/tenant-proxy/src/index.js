/**
 * Cloudflare Worker: tenant subdomains → Firebase Hosting path URLs.
 *
 * brandonsmith.getbookking.com/gallery  →  https://test-app-96812.web.app/brandonsmith/gallery
 * brandonsmith.getbookking.com/js/...   →  https://test-app-96812.web.app/js/...  (no tenant prefix)
 *
 * Team invites:
 *   - Apex / www: getbookking.com/join* → Firebase (when apex is proxied through Cloudflare).
 *   - Recommended: join.getbookking.com/join* (covered by *.getbookking.com/*): same upstream;
 *     add DNS CNAME `join` (proxied). Add `join.getbookking.com` to Firebase Auth authorized domains.
 *
 * Deploy: cd cloudflare/tenant-proxy && npx wrangler deploy
 * Routes: see wrangler.toml
 */
const UPSTREAM = "https://test-app-96812.web.app";
const TENANT_DOMAIN = "getbookking.com";

const RESERVED = new Set([
  "www",
  "join", // team invite host join.getbookking.com — not a tenant slug
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

function isApexOrWwwHost(hostname) {
  const h = hostname.toLowerCase();
  return h === TENANT_DOMAIN || h === "www." + TENANT_DOMAIN;
}

function isJoinDedicatedHost(hostname) {
  return hostname.toLowerCase() === "join." + TENANT_DOMAIN;
}

/** Team invite page: /join (and static assets under /join/ if any). */
function isJoinInvitePath(pathname) {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = "/" + p;
  return p === "/join" || p.startsWith("/join/");
}

function proxyToUpstream(request, pathname, search) {
  const upstreamUrl = UPSTREAM + pathname + search;
  return fetch(
    new Request(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    })
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname || "/";
    if (!pathname.startsWith("/")) pathname = "/" + pathname;

    if (isApexOrWwwHost(url.hostname) && isJoinInvitePath(pathname)) {
      return proxyToUpstream(request, pathname, url.search);
    }

    if (isJoinDedicatedHost(url.hostname)) {
      if (isJoinInvitePath(pathname) || isStaticPath(pathname)) {
        return proxyToUpstream(request, pathname, url.search);
      }
      return new Response("Not found", { status: 404 });
    }

    const sub = extractSubdomain(url.hostname);
    if (!sub) {
      return fetch(request);
    }

    let upstreamPath;
    if (isStaticPath(pathname)) {
      upstreamPath = pathname;
    } else {
      upstreamPath = "/" + encodeURIComponent(sub) + (pathname === "/" ? "" : pathname);
    }

    return proxyToUpstream(request, upstreamPath, url.search);
  },
};
