/**
 * End-to-end check of "Sign in with Get Bookking" (no network, no real database).
 * Plays the part of ChatGPT/Claude: discover → register → authorize → Allow → token → use a tool
 * → renew → reuse detection → revoke. Run: node scripts/test-mcp-oauth.js
 */
process.env.MCP_PUBLIC_ORIGIN = "https://www.getbookking.com";
const assert = require("assert");
const crypto = require("crypto");
const mcp = require("../mcp");
const oauth = require("../mcpOAuth");

/* ── Tiny in-memory Firestore ── */
function makeDb() {
  const store = new Map(); // "col/id" -> data
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => (data === undefined ? undefined : { ...data }) });
  function ref(col, id) {
    const key = col + "/" + id;
    const r = {
      id,
      path: key,
      get: async () => snap(id, store.get(key)),
      set: async (d, o) => { store.set(key, o && o.merge ? { ...(store.get(key) || {}), ...d } : { ...d }); },
      update: async (d) => { if (!store.has(key)) throw new Error("no doc " + key); store.set(key, { ...store.get(key), ...d }); },
      collection: (sub) => collection(key + "/" + sub),
    };
    return r;
  }
  function collection(col) {
    const filters = [];
    const q = {
      doc: (id) => ref(col, id || crypto.randomBytes(8).toString("hex")),
      add: async (d) => { const r = ref(col, crypto.randomBytes(8).toString("hex")); await r.set(d); return r; },
      where: (f, op, v) => { filters.push([f, v]); return q; },
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        const docs = [];
        for (const [k, d] of store) {
          const i = k.lastIndexOf("/");
          if (k.slice(0, i) !== col) continue;
          if (filters.every(([f, v]) => (d[f] === undefined ? null : d[f]) === v)) {
            const id = k.slice(i + 1);
            docs.push({ ...snap(id, d), ref: ref(col, id) });
          }
        }
        return { docs, size: docs.length, empty: !docs.length };
      },
    };
    return q;
  }
  const db = {
    store,
    collection,
    batch: () => {
      const ops = [];
      return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const op of ops) await op(); } };
    },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d) }),
  };
  return db;
}

/* ── Fake HTTP ── */
function call(handler, { method = "GET", path = "/", query = {}, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method, path, query, body, get: (n) => h[String(n).toLowerCase()] };
    const out = { status: 200, headers: {}, body: undefined };
    const res = {
      headersSent: false,
      set: (k, v) => { out.headers[k.toLowerCase()] = v; return res; },
      status: (s) => { out.status = s; return res; },
      json: (b) => { out.body = b; res.headersSent = true; resolve(out); return res; },
      send: (b) => { out.body = b; res.headersSent = true; resolve(out); return res; },
      redirect: (s, url) => { out.status = s; out.headers.location = url; res.headersSent = true; resolve(out); return res; },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const db = makeDb();
  mcp._test.setDb(db);
  oauth._test.setDb(db);
  const exportsObj = {};
  mcp.registerMcpFunctions(exportsObj, {});
  const server = exportsObj.mcpServer;

  // Owner on early access with a shop.
  db.store.set("users/owner1", { tenantId: "shop1", email: "owner@example.com" });
  db.store.set("tenants/shop1", { ownerUid: "owner1", businessName: "Harbor Charters", mcpEnabled: true });
  const ownerCtx = { auth: { uid: "owner1", token: { email: "owner@example.com" } } };
  let pass = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log("  ✓", msg); };

  // 1. Not signed in → 401 with the sign-in pointer.
  let r = await call(server, { method: "POST", path: "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  ok(r.status === 401 && /resource_metadata="https:\/\/www\.getbookking\.com\/\.well-known\/oauth-protected-resource"/.test(r.headers["www-authenticate"]), "unsigned request gets 401 + WWW-Authenticate");

  // 2. Discovery.
  r = await call(server, { path: "/.well-known/oauth-protected-resource/mcp" });
  ok(r.body.resource === "https://www.getbookking.com/mcp" && r.body.authorization_servers[0] === "https://www.getbookking.com", "protected resource metadata");
  r = await call(server, { path: "/.well-known/oauth-authorization-server" });
  ok(r.body.code_challenge_methods_supported.includes("S256") && r.body.registration_endpoint.endsWith("/oauth/register"), "authorization server metadata");

  // 3. Register like ChatGPT.
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  r = await call(server, { method: "POST", path: "/oauth/register", body: { client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none" } });
  ok(r.status === 201 && r.body.client_id.startsWith("gbc_"), "dynamic client registration");
  const clientId = r.body.client_id;
  r = await call(server, { method: "POST", path: "/oauth/register", body: { redirect_uris: ["javascript:alert(1)"] } });
  ok(r.status === 400, "rejects bad redirect_uris");

  // 4. Authorize → our approve page.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authQ = { response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: "https://www.getbookking.com/mcp", scope: "shop" };
  r = await call(server, { path: "/oauth/authorize", query: { ...authQ, redirect_uri: "https://evil.example/cb" } });
  ok(r.status === 400 && !r.headers.location, "wrong redirect_uri never redirects");
  r = await call(server, { path: "/oauth/authorize", query: { ...authQ, code_challenge_method: "plain" } });
  ok(r.status === 302 && /error=invalid_request/.test(r.headers.location), "PKCE S256 required");
  r = await call(server, { path: "/oauth/authorize", query: authQ });
  ok(r.status === 302 && r.headers.location.startsWith("https://www.getbookking.com/ai-connect?req="), "authorize sends owner to /ai-connect");
  const reqId = new URL(r.headers.location).searchParams.get("req");

  // 5. Approve page.
  const info = await exportsObj.mcpOAuthRequestInfo.run({ req: reqId }, ownerCtx);
  ok(info.appName === "ChatGPT" && info.shopName === "Harbor Charters" && info.allowed === true, "approve page shows app + shop");
  const decided = await exportsObj.mcpOAuthDecide.run({ req: reqId, allow: true, actions: false }, ownerCtx);
  const back = new URL(decided.redirect);
  ok(back.origin + back.pathname === redirect && back.searchParams.get("state") === "xyz" && back.searchParams.get("iss") === "https://www.getbookking.com", "Allow returns code + state + iss");
  await assert.rejects(exportsObj.mcpOAuthDecide.run({ req: reqId, allow: true }, ownerCtx));
  ok(true, "approve link can't be used twice");
  const code = back.searchParams.get("code");

  // 6. Token exchange.
  const tokenBody = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, resource: "https://www.getbookking.com/mcp" };
  r = await call(server, { method: "POST", path: "/oauth/token", body: { ...tokenBody, code_verifier: "wrong" } });
  ok(r.status === 400, "wrong PKCE verifier rejected");
  // The code was burned by the failed attempt; run a fresh authorize for the real exchange.
  r = await call(server, { path: "/oauth/authorize", query: authQ });
  const req2 = new URL(r.headers.location).searchParams.get("req");
  const code2 = new URL((await exportsObj.mcpOAuthDecide.run({ req: req2, allow: true, actions: false }, ownerCtx)).redirect).searchParams.get("code");
  r = await call(server, { method: "POST", path: "/oauth/token", body: { ...tokenBody, code: code2, code_verifier: verifier } });
  ok(r.status === 200 && r.body.access_token.startsWith("gbk_at_") && r.body.refresh_token.startsWith("gbk_rt_"), "code + verifier → tokens");
  const t1 = r.body;
  r = await call(server, { method: "POST", path: "/oauth/token", body: { ...tokenBody, code: code2, code_verifier: verifier } });
  ok(r.status === 400, "code can't be reused");

  // Reconnecting replaced the first connection: only one active for ChatGPT.
  const list = await exportsObj.listMcpKeys.run({}, ownerCtx);
  ok(list.keys.length === 1 && list.keys[0].kind === "signin" && list.keys[0].name === "ChatGPT" && list.keys[0].actions === false, "one ChatGPT connection listed, actions off");

  // 7. Use the server.
  const bearer = (t) => ({ authorization: "Bearer " + t });
  r = await call(server, { method: "POST", path: "/mcp", headers: bearer(t1.access_token), body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  ok(r.status === 200 && r.body.result.tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean" && t.title), "tools/list works; every tool has a title + annotations");
  r = await call(server, { method: "POST", path: "/mcp", headers: bearer(t1.access_token), body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "text_client", arguments: { client: "x", message: "hi" } } } });
  ok(r.body.result.isError && /Actions are turned off/.test(r.body.result.content[0].text), "actions respect the switch");

  // 8. Renew, and catch a copied refresh token.
  r = await call(server, { method: "POST", path: "/oauth/token", body: { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId } });
  ok(r.status === 200 && r.body.access_token !== t1.access_token, "refresh gives new tokens");
  const t2 = r.body;
  r = await call(server, { method: "POST", path: "/oauth/token", body: { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId } });
  ok(r.status === 400, "old refresh token rejected");
  r = await call(server, { method: "POST", path: "/mcp", headers: bearer(t2.access_token), body: { jsonrpc: "2.0", id: 4, method: "ping" } });
  ok(r.status === 401 && /invalid_token/.test(r.headers["www-authenticate"]), "reused refresh token turns the connection off");

  // 9. Owner revokes in Settings.
  r = await call(server, { path: "/oauth/authorize", query: authQ });
  const req3 = new URL(r.headers.location).searchParams.get("req");
  const code3 = new URL((await exportsObj.mcpOAuthDecide.run({ req: req3, allow: true, actions: true }, ownerCtx)).redirect).searchParams.get("code");
  const t3 = (await call(server, { method: "POST", path: "/oauth/token", body: { ...tokenBody, code: code3, code_verifier: verifier } })).body;
  r = await call(server, { method: "POST", path: "/mcp", headers: bearer(t3.access_token), body: { jsonrpc: "2.0", id: 5, method: "ping" } });
  ok(r.status === 200, "new connection works");
  const keys = (await exportsObj.listMcpKeys.run({}, ownerCtx)).keys;
  await exportsObj.revokeMcpKey.run({ id: keys[0].id }, ownerCtx);
  r = await call(server, { method: "POST", path: "/mcp", headers: bearer(t3.access_token), body: { jsonrpc: "2.0", id: 6, method: "ping" } });
  ok(r.status === 401, "Revoke in Settings cuts it off right away");

  // 10. Cancel, and shops not on early access.
  r = await call(server, { path: "/oauth/authorize", query: authQ });
  const req4 = new URL(r.headers.location).searchParams.get("req");
  const denied = new URL((await exportsObj.mcpOAuthDecide.run({ req: req4, allow: false }, ownerCtx)).redirect);
  ok(denied.searchParams.get("error") === "access_denied" && !denied.searchParams.get("code"), "Cancel returns access_denied");
  db.store.set("tenants/shop1", { ownerUid: "owner1", businessName: "Harbor Charters", mcpEnabled: false });
  r = await call(server, { path: "/oauth/authorize", query: authQ });
  const req5 = new URL(r.headers.location).searchParams.get("req");
  await assert.rejects(exportsObj.mcpOAuthDecide.run({ req: req5, allow: true }, ownerCtx), /early access/);
  ok(true, "shops not on early access can't approve");

  // 11. Link keys still work.
  db.store.set("tenants/shop1", { ownerUid: "owner1", businessName: "Harbor Charters", mcpEnabled: true });
  const made = await exportsObj.createMcpKey.run({ name: "Claude" }, ownerCtx);
  r = await call(server, { method: "POST", path: "/mcp/k/" + made.key, body: { jsonrpc: "2.0", id: 7, method: "ping" } });
  ok(r.status === 200, "pasted links still work");

  console.log(`\nAll ${pass} checks passed.`);
})().catch((e) => {
  console.error("\nFAILED:", e && e.message ? e.message : e);
  process.exit(1);
});
