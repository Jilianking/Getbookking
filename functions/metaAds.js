/**
 * Meta ads (Marketing API v27) for one ad account per business.
 *
 * Facebook Login, not the Instagram login used for DMs. The token is stored in
 * tenants/{id}/private/metaAds and is never returned to the app.
 *
 * OAuth redirect (Facebook Login → Valid OAuth Redirect URIs):
 *   https://us-central1-<PROJECT>.cloudfunctions.net/metaAdsOAuthCallback
 *
 * Uses the existing META_APP_SECRET (the Facebook app secret).
 * Permissions: ads_read, ads_management, business_management, pages_show_list,
 * pages_read_engagement, pages_manage_ads.
 */

const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const sms = require("./sms");
const lib = require("./metaAdsLib");

const metaAppSecret = defineSecret("META_APP_SECRET");

const REGION = "us-central1";
const STATE_TTL_MS = 15 * 60 * 1000;
// Must match MetaAdsLoginSession.callbackScheme in Test/AdsView.swift.
const APP_CALLBACK_SCHEME = "getbookking-meta";
const REFRESH_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;
const PAID_MESSAGE =
  "Your free trial includes the website builder. Start your paid Get Bookking plan to connect Meta ads.";

const runtimeSecrets = [metaAppSecret];

function getDb() {
  return admin.firestore();
}

function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "test-app-96812";
}

function redirectUri() {
  return `https://${REGION}-${projectId()}.cloudfunctions.net/metaAdsOAuthCallback`;
}

function secretValue() {
  try {
    return (metaAppSecret.value() || "").toString().trim();
  } catch (_) {
    return "";
  }
}

function privateRef(tenantId) {
  return getDb().collection("tenants").doc(tenantId).collection("private").doc("metaAds");
}

function tenantRef(tenantId) {
  return getDb().collection("tenants").doc(tenantId);
}

function graphErrorMessage(json, fallback) {
  if (!json || typeof json !== "object") return fallback;
  if (json.error && json.error.error_user_msg) return String(json.error.error_user_msg);
  if (json.error && json.error.message) return String(json.error.message);
  if (json.error_message) return String(json.error_message);
  return fallback;
}

function graphErrorCode(json) {
  const code = json && json.error && json.error.code;
  return Number(code) || 0;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error_message: text.slice(0, 300) };
  }
}

async function graph(path, { token, method, query, body, form } = {}) {
  const absolute = /^https:\/\//.test(path);
  const url = absolute
    ? new URL(path)
    : new URL(`https://graph.facebook.com/${lib.GRAPH_VERSION}/${path.replace(/^\//, "")}`);
  if (!absolute && query) {
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value == null || value === "") return;
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    });
  }
  if (token && !url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  let payload;
  let headers;
  if (form) {
    headers = { "Content-Type": "application/x-www-form-urlencoded" };
    const params = new URLSearchParams();
    Object.keys(form).forEach((key) => {
      if (form[key] != null) params.set(key, String(form[key]));
    });
    payload = params.toString();
  } else if (body) {
    headers = { "Content-Type": "application/json" };
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, {
    method: method || (payload ? "POST" : "GET"),
    headers,
    body: payload,
  });
  const json = await readJson(res);
  if (!res.ok || (json && json.error)) {
    const err = new Error(graphErrorMessage(json, "Meta could not complete that request."));
    err.graph = json;
    err.graphCode = graphErrorCode(json);
    throw err;
  }
  return json;
}

async function graphList(path, token, query) {
  const out = [];
  let next = path;
  let pageQuery = query || null;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const json = await graph(next, { token, query: pageQuery });
    if (Array.isArray(json.data)) out.push(...json.data);
    if (!json.paging || !json.paging.next) break;
    next = json.paging.next;
    pageQuery = null;
  }
  return out;
}

function htmlPage(title, message) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
    title
  )}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px;color:#2C2018"><h1 style="font-size:22px">${esc(
    title
  )}</h1><p>${esc(message)}</p></body></html>`;
}

function callableError(err) {
  if (err instanceof functions.https.HttpsError) return err;
  if (err && err.code === "invalid") {
    return new functions.https.HttpsError("invalid-argument", err.message);
  }
  const message = (err && err.message) || "Meta could not complete that request.";
  return new functions.https.HttpsError("failed-precondition", message);
}

async function loadCaller(uid) {
  const userSnap = await getDb().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const userData = userSnap.data() || {};
  const tenantId = (userData.tenantId || "").toString().trim();
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No business is linked to this account.");
  }
  const tenantSnap = await tenantRef(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data() || {};
  const isOwner = tenant.ownerUid === uid;
  let ownerUserData = userData;
  if (!isOwner && tenant.ownerUid) {
    const ownerSnap = await getDb().collection("users").doc(tenant.ownerUid).get();
    if (ownerSnap.exists) ownerUserData = ownerSnap.data() || {};
  }
  return { uid, tenantId, tenant, ownerUserData, isOwner };
}

function assertOwnerPaid(caller) {
  if (!caller.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can connect Meta ads."
    );
  }
  if (caller.tenant && caller.tenant.isDemoAccount === true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Meta ads are unavailable on the demo account."
    );
  }
  if (!sms.tenantHasPaidSubscription(caller.tenant, caller.ownerUserData)) {
    throw new functions.https.HttpsError("failed-precondition", PAID_MESSAGE);
  }
}

function publicPatch(status, extra) {
  return Object.assign({ metaAdsStatus: status }, extra || {});
}

function clearedPublicFields() {
  const del = admin.firestore.FieldValue.delete();
  return {
    metaAdsStatus: "off",
    metaAdAccountId: del,
    metaAdAccountName: del,
    metaAdsCurrency: del,
    metaAdsConnectedAt: del,
    metaAdsConnectedByUid: del,
    metaAdsProvisionError: del,
  };
}

function normalizeAccount(row) {
  const accountId = ((row && (row.account_id || row.id)) || "").toString().replace(/^act_/, "");
  return {
    id: accountId,
    name: ((row && row.name) || "Ad account").toString(),
    currency: ((row && row.currency) || "USD").toString().toUpperCase(),
    accountStatus: Number(row && row.account_status) || 0,
  };
}

async function fetchAdAccounts(token) {
  const rows = await graphList("/me/adaccounts", token, {
    fields: "name,account_id,currency,account_status",
    limit: 100,
  });
  return rows.map(normalizeAccount).filter((row) => row.id);
}

async function markExpired(tenantId) {
  await tenantRef(tenantId).set(
    publicPatch("expired", {
      metaAdsProvisionError: "Meta login expired. Connect again.",
    }),
    { merge: true }
  );
}

async function loadPrivate(tenantId) {
  const snap = await privateRef(tenantId).get();
  if (!snap.exists) return null;
  return snap.data() || {};
}

async function refreshTokenIfNeeded(tenantId, data) {
  const token = ((data && data.token) || "").toString().trim();
  if (!token) return data;
  const exp = data.tokenExpiresAt;
  const expMs = exp && typeof exp.toMillis === "function" ? exp.toMillis() : 0;
  if (expMs && expMs > Date.now() + REFRESH_WITHIN_MS) return data;
  const secret = secretValue();
  if (!secret) return data;
  try {
    const json = await graph("oauth/access_token", {
      query: {
        grant_type: "fb_exchange_token",
        client_id: lib.FB_APP_ID,
        client_secret: secret,
        fb_exchange_token: token,
      },
    });
    const next = (json.access_token || "").toString().trim();
    if (!next) return data;
    const expiresIn = Number(json.expires_in) || 60 * 24 * 60 * 60;
    const tokenExpiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + expiresIn * 1000);
    await privateRef(tenantId).set({ token: next, tokenExpiresAt }, { merge: true });
    return Object.assign({}, data, { token: next, tokenExpiresAt });
  } catch (e) {
    if (e.graphCode === 190) await markExpired(tenantId);
    console.warn("refreshMetaAdsToken", e.message || e);
    if (e.graphCode === 190) {
      const err = new functions.https.HttpsError("failed-precondition", "Meta login expired. Connect again.");
      throw err;
    }
    return data;
  }
}

async function requireSession(caller) {
  assertOwnerPaid(caller);
  const data = await refreshTokenIfNeeded(caller.tenantId, await loadPrivate(caller.tenantId));
  const token = ((data && data.token) || "").toString().trim();
  if (!token) {
    throw new functions.https.HttpsError("failed-precondition", "Connect Meta ads first.");
  }
  const accountId = ((data && data.selectedAdAccountId) || "").toString().trim();
  return { token, accountId, privateData: data };
}

function accountSummary(row) {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    accountStatus: row.accountStatus,
  };
}

function majorBudget(minor, currency) {
  if (minor == null || minor === "") return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / lib.currencyOffset(currency)) * 100) / 100;
}

async function writeSelectedAccount(caller, account) {
  await privateRef(caller.tenantId).set({ selectedAdAccountId: account.id }, { merge: true });
  await tenantRef(caller.tenantId).set(
    publicPatch("connected", {
      metaAdAccountId: `act_${account.id}`,
      metaAdAccountName: account.name,
      metaAdsCurrency: account.currency,
      metaAdsConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
      metaAdsConnectedByUid: caller.uid,
      metaAdsProvisionError: admin.firestore.FieldValue.delete(),
    }),
    { merge: true }
  );
}

const startMetaAdsConnect = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const caller = await loadCaller(context.auth.uid);
    assertOwnerPaid(caller);
    const secret = secretValue();
    if (!secret) {
      throw new functions.https.HttpsError("failed-precondition", "Meta ads are not configured yet.");
    }
    await tenantRef(caller.tenantId).set(publicPatch("connecting"), { merge: true });
    const fromApp = ((data && data.client) || "").toString() === "ios";
    const state = lib.signState(
      { tenantId: caller.tenantId, uid: caller.uid, app: fromApp ? 1 : 0, exp: Date.now() + STATE_TTL_MS },
      secret
    );
    const url = new URL(`https://www.facebook.com/${lib.GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", lib.FB_APP_ID);
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", lib.SCOPES);
    return { authorizeUrl: url.toString() };
  });

const metaAdsOAuthCallback = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onRequest(async (req, res) => {
    const params = req.method === "POST" ? req.body || {} : req.query || {};
    const secret = secretValue();
    const state = lib.readState((params.state || "").toString(), secret);
    const finish = (httpStatus, status, title, message) => {
      if (state && state.app) {
        const back = new URL(`${APP_CALLBACK_SCHEME}://meta-ads`);
        back.searchParams.set("status", status);
        back.searchParams.set("message", message);
        res.redirect(302, back.toString());
        return;
      }
      res.status(httpStatus).type("html").send(htmlPage(title, message));
    };
    const error = (params.error_description || params.error || "").toString().trim();
    if (error) {
      if (state && state.tenantId) {
        try {
          await tenantRef(state.tenantId).set(
            publicPatch("failed", { metaAdsProvisionError: error.slice(0, 300) }),
            { merge: true }
          );
        } catch (_) {
          /* status is best-effort */
        }
      }
      finish(400, "failed", "Meta ads were not connected", error);
      return;
    }
    const code = (params.code || "").toString().trim().replace(/#_=_\s*$/, "");
    if (!code || !state || !state.tenantId || !state.uid) {
      finish(400, "failed", "Connect link expired", "Go back to Get Bookking and tap Connect again.");
      return;
    }
    try {
      const caller = await loadCaller(state.uid);
      if (caller.tenantId !== state.tenantId) {
        throw new Error("This connect link does not match the signed-in business.");
      }
      assertOwnerPaid(caller);
      const shortLived = await graph("oauth/access_token", {
        query: {
          client_id: lib.FB_APP_ID,
          redirect_uri: redirectUri(),
          client_secret: secret,
          code,
        },
      });
      const shortToken = (shortLived.access_token || "").toString().trim();
      if (!shortToken) throw new Error("Meta did not return a login token.");
      const longLived = await graph("oauth/access_token", {
        query: {
          grant_type: "fb_exchange_token",
          client_id: lib.FB_APP_ID,
          client_secret: secret,
          fb_exchange_token: shortToken,
        },
      });
      const token = (longLived.access_token || shortToken).toString().trim();
      const expiresIn = Number(longLived.expires_in) || 60 * 24 * 60 * 60;
      const me = await graph("/me", { token, query: { fields: "id" } });
      const accounts = await fetchAdAccounts(token);
      if (!accounts.length) throw new Error("No Meta ad account was found for this login.");
      await privateRef(caller.tenantId).set({
        token,
        tokenExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + expiresIn * 1000),
        fbUserId: (me.id || "").toString(),
        selectedAdAccountId: "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const active = accounts.filter((row) => row.accountStatus === 1);
      const only = active.length === 1 ? active[0] : accounts.length === 1 ? accounts[0] : null;
      if (only) {
        await writeSelectedAccount(caller, only);
        finish(200, "connected", "Meta ads connected", `Connected ${only.name}. You can close this and return to Get Bookking.`);
        return;
      }
      await tenantRef(caller.tenantId).set(
        publicPatch("choose_account", {
          metaAdAccountId: admin.firestore.FieldValue.delete(),
          metaAdAccountName: admin.firestore.FieldValue.delete(),
          metaAdsCurrency: admin.firestore.FieldValue.delete(),
          metaAdsProvisionError: admin.firestore.FieldValue.delete(),
          metaAdsConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
          metaAdsConnectedByUid: caller.uid,
        }),
        { merge: true }
      );
      finish(
        200,
        "choose_account",
        "Choose an ad account",
        "Meta ads are connected. Go back to Get Bookking and choose which ad account to use."
      );
    } catch (e) {
      console.error("metaAdsOAuthCallback", e);
      const message = (e && e.message) || "Meta ads could not be connected. Go back and try again.";
      try {
        await tenantRef(state.tenantId).set(
          publicPatch("failed", { metaAdsProvisionError: message.toString().slice(0, 300) }),
          { merge: true }
        );
      } catch (_) {
        /* status is best-effort */
      }
      finish(400, "failed", "Meta ads were not connected", message.toString());
    }
  });

const disconnectMetaAds = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const caller = await loadCaller(context.auth.uid);
    if (!caller.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can disconnect Meta ads."
      );
    }
    await privateRef(caller.tenantId).delete();
    await tenantRef(caller.tenantId).set(clearedPublicFields(), { merge: true });
    return { ok: true };
  });

const selectMetaAdAccount = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const caller = await loadCaller(context.auth.uid);
      const session = await requireSession(caller);
      const wanted = ((data && data.accountId) || "").toString().replace(/^act_/, "").trim();
      const accounts = await fetchAdAccounts(session.token);
      const match = accounts.find((row) => row.id === wanted);
      if (!match) {
        throw new functions.https.HttpsError("not-found", "That ad account is not on this Meta login.");
      }
      await writeSelectedAccount(caller, match);
      return { account: accountSummary(match) };
    } catch (e) {
      throw callableError(e);
    }
  });

const getMetaAdsConnection = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const caller = await loadCaller(context.auth.uid);
      assertOwnerPaid(caller);
      const status = ((caller.tenant && caller.tenant.metaAdsStatus) || "off").toString();
      if (status === "off" || status === "failed" || status === "connecting") {
        return {
          status,
          error: ((caller.tenant && caller.tenant.metaAdsProvisionError) || "").toString(),
        };
      }
      const session = await requireSession(caller);
      const accounts = await fetchAdAccounts(session.token);
      const pages = await graphList("/me/accounts", session.token, {
        fields: "id,name,instagram_business_account{id,username}",
        limit: 100,
      });
      let pixels = [];
      if (session.accountId) {
        pixels = await graphList(`/${lib.actPath(session.accountId)}/adspixels`, session.token, {
          fields: "id,name",
          limit: 50,
        });
      }
      return {
        status: session.accountId ? "connected" : "choose_account",
        accountId: session.accountId || "",
        accountName: ((caller.tenant && caller.tenant.metaAdAccountName) || "").toString(),
        currency: ((caller.tenant && caller.tenant.metaAdsCurrency) || "").toString(),
        adAccounts: accounts.map(accountSummary),
        pages: pages.map((page) => {
          const ig = page.instagram_business_account || {};
          return {
            id: (page.id || "").toString(),
            name: (page.name || "").toString(),
            instagramUserId: (ig.id || "").toString(),
            instagramUsername: (ig.username || "").toString(),
          };
        }),
        pixels: pixels.map((pixel) => ({
          id: (pixel.id || "").toString(),
          name: (pixel.name || "Dataset").toString(),
        })),
      };
    } catch (e) {
      throw callableError(e);
    }
  });

async function accountForSession(session) {
  if (!session.accountId) {
    throw new functions.https.HttpsError("failed-precondition", "Choose an ad account first.");
  }
  const accounts = await fetchAdAccounts(session.token);
  const match = accounts.find((row) => row.id === session.accountId);
  if (!match) {
    throw new functions.https.HttpsError("failed-precondition", "That ad account is no longer on this Meta login.");
  }
  return match;
}

const getMetaAdsInsights = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const caller = await loadCaller(context.auth.uid);
      const session = await requireSession(caller);
      const account = await accountForSession(session);
      const since = lib.dateOnly(data && data.since);
      const until = lib.dateOnly(data && data.until);
      if (since > until) {
        throw lib.invalid("The start date has to be on or before the end date.");
      }
      const campaignId = ((data && data.campaignId) || "").toString().trim();
      const query = {
        fields: "spend,impressions,clicks,actions",
        time_range: { since, until },
        level: campaignId ? "campaign" : "account",
      };
      if (campaignId) query.filtering = [{ field: "campaign.id", operator: "EQUAL", value: campaignId }];
      const json = await graph(`/${lib.actPath(account.id)}/insights`, { token: session.token, query });
      const summary = lib.insightsSummary((json.data && json.data[0]) || {});
      return Object.assign({ account: accountSummary(account), since, until }, summary);
    } catch (e) {
      throw callableError(e);
    }
  });

const listMetaCampaigns = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    try {
      const caller = await loadCaller(context.auth.uid);
      const session = await requireSession(caller);
      const account = await accountForSession(session);
      const campaigns = await graphList(`/${lib.actPath(account.id)}/campaigns`, session.token, {
        fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget",
        limit: 50,
      });
      let stats = [];
      const since = data && data.since ? lib.dateOnly(data.since) : "";
      const until = data && data.until ? lib.dateOnly(data.until) : "";
      if (since && until) {
        if (since > until) throw lib.invalid("The start date has to be on or before the end date.");
        stats = await graphList(`/${lib.actPath(account.id)}/insights`, session.token, {
          level: "campaign",
          fields: "campaign_id,spend,impressions,clicks,actions",
          time_range: { since, until },
          limit: 100,
        });
      }
      const byId = {};
      stats.forEach((row) => {
        byId[(row.campaign_id || "").toString()] = lib.insightsSummary(row);
      });
      return {
        account: accountSummary(account),
        campaigns: campaigns.map((row) => {
          const id = (row.id || "").toString();
          const numbers = byId[id] || lib.insightsSummary({});
          return {
            id,
            name: (row.name || "").toString(),
            status: (row.status || "").toString(),
            delivery: (row.effective_status || "").toString(),
            objective: (row.objective || "").toString(),
            dailyBudget: majorBudget(row.daily_budget, account.currency),
            lifetimeBudget: majorBudget(row.lifetime_budget, account.currency),
            spend: numbers.spend,
            impressions: numbers.impressions,
            clicks: numbers.clicks,
            results: numbers.results,
            costPerResult: numbers.costPerResult,
          };
        }),
      };
    } catch (e) {
      throw callableError(e);
    }
  });

async function ownedPage(token, pageId) {
  const pages = await graphList("/me/accounts", token, { fields: "id,name", limit: 100 });
  return pages.find((page) => (page.id || "").toString() === pageId) || null;
}

async function ownedPixel(token, accountId, pixelId) {
  const pixels = await graphList(`/${lib.actPath(accountId)}/adspixels`, token, {
    fields: "id,name",
    limit: 50,
  });
  return pixels.find((pixel) => (pixel.id || "").toString() === pixelId) || null;
}

async function uploadImage(token, accountId, imageUrl) {
  const url = lib.httpsUrl(imageUrl, "The photo");
  const json = await graph(`/${lib.actPath(accountId)}/adimages`, {
    token,
    method: "POST",
    form: { url },
  });
  const images = json.images || {};
  const first = Object.keys(images)
    .map((key) => images[key] && images[key].hash)
    .find((hash) => hash);
  if (!first) throw new Error("Meta did not accept that photo.");
  return first.toString();
}

const publishMetaCampaign = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const created = {};
    let token = "";
    let accountId = "";
    try {
      const caller = await loadCaller(context.auth.uid);
      const session = await requireSession(caller);
      token = session.token;
      const account = await accountForSession(session);
      accountId = account.id;
      const input = data && typeof data === "object" ? data : {};
      const adSet = input.adSet && typeof input.adSet === "object" ? input.adSet : {};
      const ad = input.ad && typeof input.ad === "object" ? input.ad : {};
      const shared = {
        objective: input.objective,
        specialAdCategory: input.specialAdCategory,
        advantageCampaignBudget: input.advantageCampaignBudget,
        budgetType: input.budgetType,
        budget: input.budget,
        currency: account.currency,
        bidStrategy: input.bidStrategy,
        bidAmount: input.bidAmount,
        status: input.status,
        endTime: input.endTime || adSet.endTime,
      };
      const pageId = (ad.pageId || adSet.pageId || "").toString().trim();
      if (!pageId) throw lib.invalid("Choose a Facebook Page.");
      if (!(await ownedPage(token, pageId))) {
        throw new functions.https.HttpsError("permission-denied", "That Facebook Page is not on this Meta login.");
      }
      const pixelId = (adSet.pixelId || input.pixelId || "").toString().trim();
      if (pixelId && !(await ownedPixel(token, accountId, pixelId))) {
        throw new functions.https.HttpsError("permission-denied", "That dataset is not on this ad account.");
      }
      const adSetBudget = adSet.budget != null && adSet.budget !== "" ? adSet.budget : input.budget;
      const campaignBody = lib.buildCampaignBody(
        Object.assign({}, shared, { name: input.name, budget: input.budget })
      );
      const adSetDraft = Object.assign({}, adSet, shared, {
        name: adSet.name,
        campaignId: "0",
        pixelId,
        pageId,
        budget: adSetBudget,
      });
      lib.buildAdSetBody(adSetDraft, { objective: campaignBody.objective });
      const postId = (ad.postId || "").toString().trim();
      if (!postId) {
        lib.httpsUrl(ad.link, "The website URL");
        if (!(ad.message || "").toString().trim()) throw lib.invalid("Write the primary text.");
        if (!(ad.headline || "").toString().trim()) throw lib.invalid("Write a headline.");
        if (!(ad.imageHash || "").toString().trim()) lib.httpsUrl(ad.imageUrl, "The photo");
      }
      const campaign = await graph(`/${lib.actPath(accountId)}/campaigns`, {
        token,
        method: "POST",
        body: campaignBody,
      });
      created.campaignId = (campaign.id || "").toString();
      const adSetBody = lib.buildAdSetBody(
        Object.assign({}, adSetDraft, { campaignId: created.campaignId })
      );
      const adSetRes = await graph(`/${lib.actPath(accountId)}/adsets`, {
        token,
        method: "POST",
        body: adSetBody,
      });
      created.adSetId = (adSetRes.id || "").toString();
      let imageHash = (ad.imageHash || "").toString().trim();
      if (!imageHash && ad.imageUrl && !(ad.postId || "").toString().trim()) {
        imageHash = await uploadImage(token, accountId, ad.imageUrl);
      }
      const creativeBody = lib.buildCreativeBody(
        Object.assign({}, ad, { pageId, imageHash, name: ad.name || input.name })
      );
      const creative = await graph(`/${lib.actPath(accountId)}/adcreatives`, {
        token,
        method: "POST",
        body: creativeBody,
      });
      created.creativeId = (creative.id || "").toString();
      const adBody = lib.buildAdBody({
        name: ad.name || input.name,
        adSetId: created.adSetId,
        creativeId: created.creativeId,
        status: input.status,
      });
      const adRes = await graph(`/${lib.actPath(accountId)}/ads`, {
        token,
        method: "POST",
        body: adBody,
      });
      created.adId = (adRes.id || "").toString();
      return Object.assign({ status: campaignBody.status }, created);
    } catch (e) {
      if (created.campaignId && token && accountId) {
        try {
          await graph(`/${created.campaignId}`, {
            token,
            method: "POST",
            body: { status: "PAUSED" },
          });
        } catch (pauseErr) {
          console.warn("publishMetaCampaign pause", pauseErr.message || pauseErr);
        }
      }
      const wrapped = callableError(e);
      if (created.campaignId) {
        throw new functions.https.HttpsError(wrapped.code, wrapped.message, created);
      }
      throw wrapped;
    }
  });

const refreshMetaAdsTokens = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const tenants = await getDb().collection("tenants").where("metaAdsStatus", "in", ["connected", "choose_account"]).get();
    for (const doc of tenants.docs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await loadPrivate(doc.id);
        // eslint-disable-next-line no-await-in-loop
        await refreshTokenIfNeeded(doc.id, data);
      } catch (e) {
        console.warn("refreshMetaAdsTokens", doc.id, e.message || e);
      }
    }
    return null;
  });

module.exports = {
  startMetaAdsConnect,
  metaAdsOAuthCallback,
  disconnectMetaAds,
  selectMetaAdAccount,
  getMetaAdsConnection,
  getMetaAdsInsights,
  listMetaCampaigns,
  publishMetaCampaign,
  refreshMetaAdsTokens,
  redirectUri,
};
