/**
 * "Sign in with Get Bookking" for ChatGPT, Claude and other AI apps (OAuth 2.1 for MCP).
 *
 * People connect at https://getbookking.com/mcp. The app finds these pages on its own:
 *   /.well-known/oauth-protected-resource      which sign-in server to use
 *   /.well-known/oauth-authorization-server    where to sign in and get tokens
 *   /oauth/register                            apps register themselves (dynamic client registration)
 *   /oauth/authorize                           sends the person to /ai-connect to sign in and tap Allow
 *   /oauth/token                               swaps the sign-in code (with PKCE) for tokens; renews tokens
 *   /oauth/revoke                              the app can disconnect itself
 * Apps that identify themselves with a URL (client ID metadata documents) are supported too.
 *
 * Each approval is one connection in mcpKeys (kind "oauth"), so it shares the link keys' limits,
 * logging, "Can take actions" switch and Revoke. Tokens and codes are only stored as SHA-256 hashes.
 */
const functions = require("firebase-functions");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const publicOrigin = defineString("MCP_PUBLIC_ORIGIN", { default: "https://getbookking.com" });

const ACCESS_PREFIX = "gbk_at_";
const REFRESH_PREFIX = "gbk_rt_";
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 90;
const CODE_MINUTES = 5;
const REQUEST_MINUTES = 15;
const SCOPE = "shop";

let dbOverride = null; // tests only
function db() {
  return dbOverride || admin.firestore();
}
function sha(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}
function token(prefix) {
  return prefix + crypto.randomBytes(32).toString("base64url");
}
function origin() {
  return String(publicOrigin.value() || "https://getbookking.com").replace(/\/+$/, "");
}
function resourceUrl() {
  return origin() + "/mcp";
}
function prmUrl() {
  return origin() + "/.well-known/oauth-protected-resource";
}
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function sameResource(a) {
  if (!a) return true; // older clients may leave it out
  const norm = (u) => String(u).trim().replace(/\/+$/, "").replace(/^https?:\/\/[^/]+/i, (m) => m.toLowerCase());
  return norm(a) === norm(resourceUrl());
}

/* ── Metadata ── */

function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [origin()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Get Bookking",
    resource_documentation: origin() + "/ai-assistant",
  };
}

function authServerMetadata() {
  const o = origin();
  return {
    issuer: o,
    authorization_endpoint: o + "/oauth/authorize",
    token_endpoint: o + "/oauth/token",
    registration_endpoint: o + "/oauth/register",
    revocation_endpoint: o + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE, "offline_access"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: o + "/ai-assistant",
  };
}

/** Header that tells ChatGPT / Claude to show "Connect". */
function wwwAuthenticate(error) {
  let h = `Bearer resource_metadata="${prmUrl()}", scope="${SCOPE}"`;
  if (error) h += `, error="${error}"`;
  return h;
}

/* ── Clients ── */

function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    // Desktop apps sometimes use a loopback address.
    return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  } catch (_) {
    return false;
  }
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
}

/** Client ID metadata document: the client_id is an https URL that describes the app. */
async function fetchClientMetadata(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hash || u.username || u.password) throw new Error("bad client_id URL");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("client_id host not allowed");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "error", headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("client metadata " + r.status);
    const text = await r.text();
    if (text.length > 20000) throw new Error("client metadata too large");
    const m = JSON.parse(text);
    if (m.client_id !== url) throw new Error("client_id mismatch");
    const redirects = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter(validRedirect) : [];
    if (!redirects.length) throw new Error("no redirect_uris");
    return { clientName: String(m.client_name || u.hostname).slice(0, 60), redirectUris: redirects, secretHash: null };
  } finally {
    clearTimeout(timer);
  }
}

async function getClient(clientId) {
  clientId = String(clientId || "");
  if (!clientId) return null;
  if (/^https:\/\//i.test(clientId)) {
    const ref = db().collection("mcpOAuthClients").doc("url_" + sha(clientId));
    const snap = await ref.get();
    const c = snap.exists ? snap.data() : null;
    if (c && toDate(c.fetchedAt) > new Date(Date.now() - 24 * 3600 * 1000)) return { clientId, ...c };
    const fresh = await fetchClientMetadata(clientId);
    await ref.set({ ...fresh, kind: "url", fetchedAt: new Date() });
    return { clientId, ...fresh };
  }
  const snap = await db().collection("mcpOAuthClients").doc(clientId).get();
  return snap.exists ? { clientId, ...snap.data() } : null;
}

/** Checks client_secret for apps that registered with one. Public apps (PKCE only) pass. */
function clientSecretOk(client, req) {
  if (!client.secretHash) return true;
  let secret = req.body && req.body.client_secret;
  const h = String(req.get("authorization") || "");
  const m = h.match(/^Basic\s+(.+)$/i);
  if (m) {
    const [, pass] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    secret = decodeURIComponent(pass || "");
  }
  if (!secret) return false;
  const a = Buffer.from(sha(secret));
  const b = Buffer.from(client.secretHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIdFrom(req) {
  const h = String(req.get("authorization") || "");
  const m = h.match(/^Basic\s+(.+)$/i);
  if (m) return decodeURIComponent(Buffer.from(m[1], "base64").toString("utf8").split(":")[0] || "");
  return String((req.body && req.body.client_id) || "");
}

/* ── HTTP endpoints ── */

function oauthError(res, status, error, description) {
  return res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

async function handleRegister(req, res) {
  const b = req.body || {};
  const redirects = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!redirects.length || redirects.length > 10 || !redirects.every(validRedirect)) {
    return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https URLs.");
  }
  const method = ["client_secret_post", "client_secret_basic"].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : "none";
  const clientId = "gbc_" + crypto.randomBytes(16).toString("hex");
  const secret = method === "none" ? null : "gbs_" + crypto.randomBytes(24).toString("base64url");
  const clientName = String(b.client_name || "AI assistant").trim().slice(0, 60) || "AI assistant";
  await db().collection("mcpOAuthClients").doc(clientId).set({
    kind: "registered",
    clientName,
    redirectUris: redirects,
    secretHash: secret ? sha(secret) : null,
    authMethod: method,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return res.status(201).json({
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  });
}

async function handleAuthorize(req, res) {
  const q = req.query || {};
  let client;
  try {
    client = await getClient(q.client_id);
  } catch (e) {
    console.warn("mcp oauth client lookup", e.message || e);
  }
  const redirectUri = String(q.redirect_uri || "");
  // Without a known app and an exact redirect match, never redirect anywhere.
  if (!client) return res.status(400).send("Unknown app. Remove the Get Bookking connection in your AI app and add it again.");
  if (!client.redirectUris.includes(redirectUri)) return res.status(400).send("This app's return address doesn't match. Remove the connection and add it again.");

  const back = (params) => {
    const u = new URL(redirectUri);
    Object.entries({ ...params, state: q.state, iss: origin() }).forEach(([k, v]) => v != null && v !== "" && u.searchParams.set(k, v));
    return res.redirect(302, u.toString());
  };
  if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required." });
  if (!sameResource(q.resource)) return back({ error: "invalid_target", error_description: "Unknown resource." });

  const reqId = crypto.randomBytes(16).toString("base64url");
  await db().collection("mcpOAuthRequests").doc(reqId).set({
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    state: q.state ? String(q.state).slice(0, 500) : null,
    codeChallenge: String(q.code_challenge),
    resource: q.resource ? String(q.resource) : resourceUrl(),
    expiresAt: new Date(Date.now() + REQUEST_MINUTES * 60000),
    usedAt: null,
  });
  return res.redirect(302, origin() + "/ai-connect?req=" + encodeURIComponent(reqId));
}

async function issueTokens(grantId, clientId, resource) {
  const access = token(ACCESS_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  const batch = db().batch();
  batch.set(db().collection("mcpTokens").doc(sha(access)), {
    grantId,
    clientId,
    resource,
    expiresAt: new Date(Date.now() + ACCESS_SECONDS * 1000),
  });
  batch.set(db().collection("mcpRefresh").doc(sha(refresh)), {
    grantId,
    clientId,
    resource,
    expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000),
    usedAt: null,
  });
  await batch.commit();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE };
}

async function handleToken(req, res) {
  res.set("Pragma", "no-cache");
  const b = req.body || {};
  const clientId = clientIdFrom(req);
  let client;
  try {
    client = await getClient(clientId);
  } catch (_) {
    client = null;
  }
  if (!client) return oauthError(res, 401, "invalid_client");
  if (!clientSecretOk(client, req)) return oauthError(res, 401, "invalid_client");
  if (!sameResource(b.resource)) return oauthError(res, 400, "invalid_target");

  if (b.grant_type === "authorization_code") {
    const ref = db().collection("mcpOAuthCodes").doc(sha(b.code || ""));
    let c;
    try {
      c = await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : null;
        if (!d || d.usedAt || toDate(d.expiresAt) < new Date()) throw { e: "invalid_grant" };
        tx.update(ref, { usedAt: new Date() });
        return d;
      });
    } catch (e) {
      if (e && e.e) return oauthError(res, 400, e.e);
      throw e;
    }
    if (c.clientId !== client.clientId || c.redirectUri !== String(b.redirect_uri || "")) return oauthError(res, 400, "invalid_grant");
    const challenge = crypto.createHash("sha256").update(String(b.code_verifier || "")).digest("base64url");
    if (!b.code_verifier || challenge !== c.codeChallenge) return oauthError(res, 400, "invalid_grant", "PKCE check failed.");
    const grant = await db().collection("mcpKeys").doc(c.grantId).get();
    if (!grant.exists || grant.data().revokedAt) return oauthError(res, 400, "invalid_grant");
    return res.json(await issueTokens(c.grantId, client.clientId, c.resource));
  }

  if (b.grant_type === "refresh_token") {
    const ref = db().collection("mcpRefresh").doc(sha(b.refresh_token || ""));
    let r;
    try {
      r = await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : null;
        if (!d || toDate(d.expiresAt) < new Date() || d.clientId !== client.clientId) throw { e: "invalid_grant" };
        if (d.usedAt) {
          // A used refresh token came back: someone may have copied it. Turn the connection off.
          tx.set(db().collection("mcpKeys").doc(d.grantId), { revokedAt: new Date(), revokedReason: "refresh_reuse" }, { merge: true });
          throw { e: "invalid_grant" };
        }
        tx.update(ref, { usedAt: new Date() });
        return d;
      });
    } catch (e) {
      if (e && e.e) return oauthError(res, 400, e.e);
      throw e;
    }
    const grant = await db().collection("mcpKeys").doc(r.grantId).get();
    if (!grant.exists || grant.data().revokedAt) return oauthError(res, 400, "invalid_grant");
    return res.json(await issueTokens(r.grantId, client.clientId, r.resource));
  }

  return oauthError(res, 400, "unsupported_grant_type");
}

async function handleRevoke(req, res) {
  const b = req.body || {};
  const t = String(b.token || "");
  let client = null;
  try {
    client = await getClient(clientIdFrom(req));
  } catch (_) {}
  if (!client || !clientSecretOk(client, req)) return oauthError(res, 401, "invalid_client");
  const col = t.startsWith(REFRESH_PREFIX) ? "mcpRefresh" : t.startsWith(ACCESS_PREFIX) ? "mcpTokens" : null;
  if (col) {
    const snap = await db().collection(col).doc(sha(t)).get();
    const d = snap.exists ? snap.data() : null;
    if (d && d.clientId === client.clientId) {
      await db().collection("mcpKeys").doc(d.grantId).set({ revokedAt: new Date(), revokedReason: "app_disconnected" }, { merge: true });
    }
  }
  return res.status(200).send(""); // always 200, per RFC 7009
}

/** Routes /.well-known/* and /oauth/*. Returns true if it answered. */
async function handleOAuthHttp(req, res) {
  const path = String(req.path || "").replace(/\/+$/, "");
  const isOAuth = path.startsWith("/.well-known/") || path.startsWith("/oauth/");
  if (!isOAuth) return false;
  res.set("Cache-Control", "no-store");
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.status(204).send("");
    return true;
  }
  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) res.json(protectedResourceMetadata());
    else if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) res.json(authServerMetadata());
    else if (path === "/oauth/register" && req.method === "POST") await handleRegister(req, res);
    else if (path === "/oauth/authorize" && req.method === "GET") await handleAuthorize(req, res);
    else if (path === "/oauth/token" && req.method === "POST") await handleToken(req, res);
    else if (path === "/oauth/revoke" && req.method === "POST") await handleRevoke(req, res);
    else res.status(404).json({ error: "not_found" });
  } catch (e) {
    console.error("mcp oauth", path, e);
    if (!res.headersSent) oauthError(res, 500, "server_error");
  }
  return true;
}

/** For mcp.js: turns an access token into its connection id, or throws { status, message }. */
async function grantForAccessToken(raw) {
  const snap = await db().collection("mcpTokens").doc(sha(raw)).get();
  const d = snap.exists ? snap.data() : null;
  if (!d || toDate(d.expiresAt) < new Date()) throw { status: 401, message: "Sign-in expired. Reconnect Get Bookking.", oauth: "invalid_token" };
  if (!sameResource(d.resource)) throw { status: 401, message: "This sign-in is for a different server.", oauth: "invalid_token" };
  return d.grantId;
}

/* ── Approve page (web/marketing/ai-connect.html) ── */

function registerMcpOAuthCallables(exportsObj, { ownerContext }) {
  async function loadRequest(reqId) {
    const ref = db().collection("mcpOAuthRequests").doc(String(reqId || "").slice(0, 64) || "none");
    const snap = await ref.get();
    const r = snap.exists ? snap.data() : null;
    if (!r || r.usedAt || toDate(r.expiresAt) < new Date()) {
      throw new functions.https.HttpsError("not-found", "This sign-in link expired. Go back to your AI app and tap Connect again.");
    }
    return { ref, r };
  }

  function returnUrl(r, params) {
    const u = new URL(r.redirectUri);
    Object.entries({ ...params, state: r.state, iss: origin() }).forEach(([k, v]) => v != null && v !== "" && u.searchParams.set(k, v));
    return u.toString();
  }

  exportsObj.mcpOAuthRequestInfo = functions.https.onCall(async (data, context) => {
    const { r } = await loadRequest(data && data.req);
    const o = await ownerContext(context);
    return {
      appName: r.clientName,
      appHost: (() => {
        try {
          return new URL(r.redirectUri).hostname;
        } catch (_) {
          return "";
        }
      })(),
      shopName: String(o.tenant.businessName || o.tenant.name || "your shop"),
      allowed: o.allowed,
    };
  });

  exportsObj.mcpOAuthDecide = functions.https.onCall(async (data, context) => {
    const { ref, r } = await loadRequest(data && data.req);
    const o = await ownerContext(context);
    if (data.allow !== true) {
      await ref.set({ usedAt: new Date(), decision: "denied" }, { merge: true });
      return { redirect: returnUrl(r, { error: "access_denied" }) };
    }
    if (!o.allowed) throw new functions.https.HttpsError("permission-denied", "The AI assistant is in early access and isn't on for this shop yet.");

    // One connection per app per owner: connecting again replaces the old one.
    const old = await db().collection("mcpKeys").where("uid", "==", o.uid).where("clientId", "==", r.clientId).get();
    const grantId = crypto.randomBytes(32).toString("hex");
    const code = crypto.randomBytes(32).toString("base64url");
    const batch = db().batch();
    old.docs.forEach((d) => !d.data().revokedAt && batch.set(d.ref, { revokedAt: new Date(), revokedReason: "reconnected" }, { merge: true }));
    batch.set(db().collection("mcpKeys").doc(grantId), {
      kind: "oauth",
      uid: o.uid,
      tenantId: o.tenantId,
      clientId: r.clientId,
      name: r.clientName,
      hint: "",
      actions: data.actions === true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedAt: null,
    });
    batch.set(db().collection("mcpOAuthCodes").doc(sha(code)), {
      grantId,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      resource: r.resource,
      expiresAt: new Date(Date.now() + CODE_MINUTES * 60000),
      usedAt: null,
    });
    batch.set(ref, { usedAt: new Date(), decision: "allowed" }, { merge: true });
    await batch.commit();
    return { redirect: returnUrl(r, { code }) };
  });
}

module.exports = {
  handleOAuthHttp,
  grantForAccessToken,
  registerMcpOAuthCallables,
  wwwAuthenticate,
  resourceUrl,
  ACCESS_PREFIX,
  _test: { setDb: (d) => { dbOverride = d; }, protectedResourceMetadata, authServerMetadata, validRedirect, privateAddress },
};
