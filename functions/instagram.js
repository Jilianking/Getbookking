/**
 * Instagram DMs (Instagram API with Instagram login).
 *
 * One Meta app. Each business, and each Studio/Shop teammate, connects their own
 * professional Instagram. Tokens stay in Firestore and are never returned to the app.
 *
 * Webhook (subscribe in the Meta dashboard only after this is deployed):
 *   https://us-central1-<PROJECT>.cloudfunctions.net/metaInstagramWebhook
 * OAuth redirect (save under Business login settings):
 *   https://us-central1-<PROJECT>.cloudfunctions.net/instagramOAuthCallback
 *
 * Secrets (set locally; do not paste them into chat):
 *   firebase functions:secrets:set META_APP_SECRET
 *   firebase functions:secrets:set META_INSTAGRAM_APP_SECRET
 *   firebase functions:secrets:set META_WEBHOOK_VERIFY_TOKEN
 */

const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const sms = require("./sms");

const metaAppSecret = defineSecret("META_APP_SECRET");
const metaInstagramAppSecret = defineSecret("META_INSTAGRAM_APP_SECRET");
const metaWebhookVerifyToken = defineSecret("META_WEBHOOK_VERIFY_TOKEN");

/** Instagram app id on the Get Bookking Meta app (public). */
const IG_APP_ID = "1646058753784138";
const IG_SCOPES = "instagram_business_basic,instagram_business_manage_messages";
const GRAPH = "https://graph.instagram.com";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 15 * 60 * 1000;
const REGION = "us-central1";

const PAID_OWNER_MESSAGE =
  "Your free trial includes the website builder. Start your paid Get Bookking plan to connect Instagram.";
const PAID_MEMBER_MESSAGE =
  "Instagram messages unlock on a paid plan. Ask the business owner to subscribe.";
const WINDOW_CLOSED_MESSAGE =
  "Instagram only allows a reply within 24 hours of their last message.";

function getDb() {
  return admin.firestore();
}

function projectId() {
  return (
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "test-app-96812"
  );
}

function functionUrl(name) {
  return `https://${REGION}-${projectId()}.cloudfunctions.net/${name}`;
}

function redirectUri() {
  return functionUrl("instagramOAuthCallback");
}

function secretValue(param) {
  try {
    return (param.value() || "").toString().trim();
  } catch (_) {
    return "";
  }
}

function instagramSecret() {
  return secretValue(metaInstagramAppSecret) || secretValue(metaAppSecret);
}

function signatureSecrets() {
  const out = [];
  const ig = secretValue(metaInstagramAppSecret);
  const app = secretValue(metaAppSecret);
  if (ig) out.push(ig);
  if (app && app !== ig) out.push(app);
  return out;
}

function planOf(tenant) {
  const p = ((tenant && tenant.subscriptionPlan) || "solo").toString().trim().toLowerCase();
  if (p === "studio" || p === "shop") return p;
  if (
    p === "charter" ||
    p === "charters" ||
    p === "boat" ||
    p === "fishing" ||
    p === "boating"
  ) {
    return "charter";
  }
  return "solo";
}

function allowsPersonalInstagram(plan) {
  return plan === "studio" || plan === "shop";
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readState(token, secret) {
  const raw = (token || "").toString().trim();
  const dot = raw.indexOf(".");
  if (dot <= 0 || !secret) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeEqualString(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (!payload.exp || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function hubParam(req, name) {
  const q = req.query || {};
  if (q[`hub.${name}`] != null) return String(q[`hub.${name}`]);
  if (q.hub && q.hub[name] != null) return String(q.hub[name]);
  return "";
}

function verifyHubSignature(rawBody, header) {
  const sig = (header || "").toString().trim();
  if (!sig.startsWith("sha256=")) return false;
  const hex = sig.slice("sha256=".length).trim().toLowerCase();
  const secrets = signatureSecrets();
  if (!secrets.length || !rawBody) return false;
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (timingSafeEqualString(expected, hex)) return true;
  }
  return false;
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

function graphErrorMessage(json, fallback) {
  if (!json || typeof json !== "object") return fallback;
  if (json.error && json.error.message) return String(json.error.message);
  if (json.error_message) return String(json.error_message);
  return fallback;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error_message: text.slice(0, 300) };
  }
}

function eventMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function threadIdFor(igUserId, scopedUserId) {
  return `ig:${igUserId}:${scopedUserId}`;
}

function logDocId(mid) {
  const raw = (mid || "").toString().trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 700);
  return cleaned || null;
}

function displayHandle(username) {
  const handle = (username || "").toString().trim().replace(/^@/, "");
  return handle ? `@${handle}` : "";
}

async function loadCaller(uid) {
  const userSnap = await getDb().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const userData = userSnap.data() || {};
  const tenantId = (userData.tenantId || "").toString().trim();
  if (!tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No business is linked to this account."
    );
  }
  const tenantSnap = await getDb().collection("tenants").doc(tenantId).get();
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
  const accessRole = isOwner
    ? "owner"
    : (userData.accessRole || userData.role || "member").toString().trim().toLowerCase();
  return {
    uid,
    tenantId,
    tenant,
    userData,
    ownerUserData,
    isOwner,
    accessRole,
    plan: planOf(tenant),
  };
}

function assertPaid(caller, memberFacing) {
  if (sms.tenantHasPaidSubscription(caller.tenant, caller.ownerUserData)) return;
  throw new functions.https.HttpsError(
    "failed-precondition",
    memberFacing && !caller.isOwner ? PAID_MEMBER_MESSAGE : PAID_OWNER_MESSAGE
  );
}

function accountRef(caller, scope) {
  if (scope === "member") {
    return getDb().collection("users").doc(caller.uid);
  }
  return getDb().collection("tenants").doc(caller.tenantId);
}

async function findInstagramAccount(igUserId) {
  const id = (igUserId || "").toString().trim();
  if (!id) return null;
  const tenantSnap = await getDb()
    .collection("tenants")
    .where("igUserId", "==", id)
    .limit(1)
    .get();
  if (!tenantSnap.empty) {
    const doc = tenantSnap.docs[0];
    const tenant = doc.data() || {};
    return {
      tenantId: doc.id,
      tenant,
      account: tenant,
      assignedMemberUid: "",
      smsLineScope: "tenant",
    };
  }
  const userSnap = await getDb()
    .collection("users")
    .where("igUserId", "==", id)
    .limit(1)
    .get();
  if (userSnap.empty) return null;
  const userDoc = userSnap.docs[0];
  const user = userDoc.data() || {};
  const tenantId = (user.tenantId || "").toString().trim();
  if (!tenantId) return null;
  const memberTenantSnap = await getDb().collection("tenants").doc(tenantId).get();
  return {
    tenantId,
    tenant: memberTenantSnap.exists ? memberTenantSnap.data() || {} : {},
    account: user,
    assignedMemberUid: userDoc.id,
    smsLineScope: "member",
  };
}

async function claimIgAccount(igUserId, claim) {
  const ref = getDb().collection("igAccounts").doc(igUserId);
  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const cur = snap.data() || {};
      const same =
        claim.scope === "tenant"
          ? cur.scope === "tenant" && cur.tenantId === claim.tenantId
          : cur.scope === "member" && cur.uid === claim.uid;
      if (!same) {
        throw new functions.https.HttpsError(
          "already-exists",
          "That Instagram account is already connected to another Get Bookking login."
        );
      }
    }
    tx.set(ref, {
      tenantId: claim.tenantId,
      uid: claim.uid,
      scope: claim.scope,
      username: claim.username || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function releaseIgAccount(igUserId, claim) {
  const id = (igUserId || "").toString().trim();
  if (!id) return;
  const ref = getDb().collection("igAccounts").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  const cur = snap.data() || {};
  const same =
    claim.scope === "tenant"
      ? cur.scope === "tenant" && cur.tenantId === claim.tenantId
      : cur.scope === "member" && cur.uid === claim.uid;
  if (same) await ref.delete();
}

async function exchangeCode(code) {
  const secret = instagramSecret();
  if (!secret) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Instagram is not configured yet."
    );
  }
  const body = new URLSearchParams({
    client_id: IG_APP_ID,
    client_secret: secret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code: code.toString(),
  });
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await readJson(res);
  if (!res.ok || !json.access_token) {
    throw new Error(graphErrorMessage(json, "Instagram did not return a token."));
  }
  return json.access_token.toString();
}

async function exchangeLongLived(shortToken) {
  const secret = instagramSecret();
  const url = new URL(`${GRAPH}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("access_token", shortToken);
  const res = await fetch(url);
  const json = await readJson(res);
  if (!res.ok || !json.access_token) {
    throw new Error(graphErrorMessage(json, "Instagram did not return a long-lived token."));
  }
  const expiresIn = Number(json.expires_in);
  return {
    token: json.access_token.toString(),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60,
  };
}

async function refreshLongLived(token) {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const json = await readJson(res);
  if (!res.ok || !json.access_token) {
    const err = new Error(graphErrorMessage(json, "Could not refresh the Instagram token."));
    err.graph = json;
    throw err;
  }
  const expiresIn = Number(json.expires_in);
  return {
    token: json.access_token.toString(),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60,
  };
}

async function fetchMe(token) {
  const url = new URL(`${GRAPH}/v21.0/me`);
  url.searchParams.set("fields", "user_id,username");
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const json = await readJson(res);
  if (!res.ok) {
    throw new Error(graphErrorMessage(json, "Instagram did not return the account."));
  }
  const igUserId = (json.user_id || json.id || "").toString().trim();
  const username = (json.username || "").toString().trim().replace(/^@/, "");
  if (!igUserId) {
    throw new Error("Instagram did not return an account id.");
  }
  return { igUserId, username };
}

async function fetchScopedProfile(scopedUserId, token) {
  try {
    const url = new URL(`${GRAPH}/v21.0/${encodeURIComponent(scopedUserId)}`);
    url.searchParams.set("fields", "username,name");
    url.searchParams.set("access_token", token);
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const json = await readJson(res);
    return {
      username: (json.username || "").toString().trim().replace(/^@/, ""),
      name: (json.name || "").toString().trim(),
    };
  } catch (_) {
    return null;
  }
}

async function subscribeMessages(token) {
  const url = new URL(`${GRAPH}/v21.0/me/subscribed_apps`);
  url.searchParams.set("subscribed_fields", "messages");
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { method: "POST" });
  const json = await readJson(res);
  if (!res.ok || json.success === false) {
    throw new Error(graphErrorMessage(json, "Instagram did not turn on message delivery."));
  }
}

async function unsubscribeMessages(token) {
  if (!token) return;
  try {
    const url = new URL(`${GRAPH}/v21.0/me/subscribed_apps`);
    url.searchParams.set("access_token", token);
    await fetch(url, { method: "DELETE" });
  } catch (e) {
    console.warn("unsubscribeMessages", e.message || e);
  }
}

function clearedIgFields() {
  const del = admin.firestore.FieldValue.delete();
  return {
    igStatus: "off",
    igUserId: del,
    igUsername: del,
    igToken: del,
    igTokenExpiresAt: del,
    igConnectedAt: del,
    igConnectedByUid: del,
    igProvisionError: del,
    igDisconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function maybeRefreshAccount(docRef, data) {
  const token = ((data && data.igToken) || "").toString().trim();
  if (!token) return data;
  const exp = data.igTokenExpiresAt;
  const expMs = exp && typeof exp.toMillis === "function" ? exp.toMillis() : 0;
  const refreshAfter = Date.now() + 10 * 24 * 60 * 60 * 1000;
  if (expMs && expMs > refreshAfter) return data;
  try {
    const refreshed = await refreshLongLived(token);
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + refreshed.expiresIn * 1000
    );
    await docRef.set(
      {
        igToken: refreshed.token,
        igTokenExpiresAt: expiresAt,
        igStatus: "connected",
        igProvisionError: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );
    return { ...data, igToken: refreshed.token, igTokenExpiresAt: expiresAt, igStatus: "connected" };
  } catch (e) {
    const graphCode = e.graph && e.graph.error && e.graph.error.code;
    if (graphCode === 190) {
      await docRef.set(
        {
          igStatus: "expired",
          igProvisionError: "Instagram login expired. Connect again.",
        },
        { merge: true }
      );
    }
    console.warn("maybeRefreshAccount", e.message || e);
    return data;
  }
}

function assertScope(caller, scope) {
  if (scope === "tenant") {
    if (!caller.isOwner) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the business owner can connect the business Instagram."
      );
    }
    return;
  }
  if (scope !== "member") {
    throw new functions.https.HttpsError("invalid-argument", "Unknown Instagram connection.");
  }
  if (caller.isOwner) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Connect the business Instagram from Messaging. Personal Instagram is for teammates."
    );
  }
  if (!allowsPersonalInstagram(caller.plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Personal Instagram is available on Studio and Shop."
    );
  }
}

const runtimeSecrets = [metaAppSecret, metaInstagramAppSecret, metaWebhookVerifyToken];

const metaInstagramWebhook = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onRequest(async (req, res) => {
    if (req.method === "GET") {
      const mode = hubParam(req, "mode");
      const token = hubParam(req, "verify_token");
      const challenge = hubParam(req, "challenge");
      const expected = secretValue(metaWebhookVerifyToken);
      if (!expected) {
        console.warn("metaInstagramWebhook: META_WEBHOOK_VERIFY_TOKEN is not set");
        res.status(403).send("Forbidden");
        return;
      }
      if (mode === "subscribe" && token && timingSafeEqualString(token, expected)) {
        res.status(200).type("text/plain").send(challenge);
        return;
      }
      res.status(403).send("Forbidden");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const rawBody = req.rawBody;
    if (!verifyHubSignature(rawBody, req.headers["x-hub-signature-256"])) {
      console.warn("metaInstagramWebhook: invalid signature");
      res.status(403).send("Forbidden");
      return;
    }

    let body = req.body;
    if (!body || typeof body !== "object") {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch (_) {
        res.status(200).send("ok");
        return;
      }
    }
    if ((body.object || "").toString() !== "instagram") {
      res.status(200).send("ok");
      return;
    }

    try {
      const entries = Array.isArray(body.entry) ? body.entry : [];
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        await handleWebhookEntry(entry);
      }
    } catch (e) {
      console.error("metaInstagramWebhook", e);
      res.status(500).send("error");
      return;
    }
    res.status(200).send("ok");
  });

async function handleWebhookEntry(entry) {
  const igUserId = ((entry && entry.id) || "").toString().trim();
  const messaging = entry && Array.isArray(entry.messaging) ? entry.messaging : [];
  if (!igUserId || !messaging.length) return;
  const located = await findInstagramAccount(igUserId);
  if (!located) {
    console.warn("metaInstagramWebhook: unknown ig user", igUserId);
    return;
  }
  const token = ((located.account && located.account.igToken) || "").toString().trim();
  for (const event of messaging) {
    // eslint-disable-next-line no-await-in-loop
    await handleMessagingEvent(located, igUserId, token, event);
  }
}

async function handleMessagingEvent(located, igUserId, token, event) {
  const message = event && event.message;
  if (!message) return;
  const isEcho = message.is_echo === true;
  const senderId = ((event.sender && event.sender.id) || "").toString().trim();
  const recipientId = ((event.recipient && event.recipient.id) || "").toString().trim();
  const customerId = isEcho ? recipientId : senderId;
  if (!customerId || customerId === igUserId) return;

  const text = (message.text || "").toString();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const mediaUrls = attachments
    .map((item) => {
      const url =
        (item && item.payload && item.payload.url) ||
        (item && item.payload && item.payload.story_media_url) ||
        "";
      return url.toString().trim();
    })
    .filter((url) => url.startsWith("https://"))
    .slice(0, 5);
  if (!text.trim() && !mediaUrls.length) return;

  const at = eventMs(event.timestamp);
  const threadId = threadIdFor(igUserId, customerId);
  let clientName = "";
  let igUsername = "";
  if (!isEcho && token) {
    const profile = await fetchScopedProfile(customerId, token);
    if (profile) {
      igUsername = profile.username || "";
      clientName = displayHandle(profile.username);
    }
  }
  if (!clientName) clientName = displayHandle(igUsername) || "Instagram";

  const preview = text.trim()
    ? text.trim().slice(0, 500)
    : mediaUrls.length
      ? "Photo"
      : "Attachment";
  const direction = isEcho ? "outbound" : "inbound";
  const logPayload = {
    channel: "instagram",
    direction,
    from: isEcho ? igUserId : customerId,
    to: isEcho ? customerId : igUserId,
    threadId,
    body: text.slice(0, 1000),
    clientName: clientName.slice(0, 120),
    igScopedUserId: customerId,
    assignedMemberUid: located.assignedMemberUid || "",
    smsLineScope: located.smsLineScope,
    createdAt: admin.firestore.Timestamp.fromMillis(at),
  };
  if (mediaUrls.length) logPayload.mediaUrls = mediaUrls;
  if (igUsername) logPayload.igUsername = igUsername;

  const logId = logDocId(message.mid);
  const logRef = logId
    ? getDb()
        .collection("tenants")
        .doc(located.tenantId)
        .collection("smsLog")
        .doc(logId)
    : getDb().collection("tenants").doc(located.tenantId).collection("smsLog").doc();

  let created = false;
  if (logId) {
    const existing = await logRef.get();
    if (!existing.exists) {
      await logRef.set(logPayload);
      created = true;
    }
  } else {
    await logRef.set(logPayload);
    created = true;
  }

  const threadPatch = {
    threadId,
    channel: "instagram",
    igScopedUserId: customerId,
    lastDirection: direction,
    lastMessageBody: preview.slice(0, 500),
    lastMessageAt: admin.firestore.Timestamp.fromMillis(at),
    assignedMemberUid: located.assignedMemberUid || "",
    smsLineScope: located.smsLineScope,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!isEcho) {
    threadPatch.igWindowExpiresAt = admin.firestore.Timestamp.fromMillis(at + WINDOW_MS);
    if (igUsername || (clientName && clientName !== "Instagram")) {
      threadPatch.clientName = clientName.slice(0, 120);
    }
    if (igUsername) threadPatch.igUsername = igUsername;
  }
  await getDb()
    .collection("tenants")
    .doc(located.tenantId)
    .collection("smsThreads")
    .doc(threadId)
    .set(threadPatch, { merge: true });

  if (!created || isEcho) return;
  await Promise.race([
    sms
      .notifyInboundClientSms(located.tenantId, {
        threadId,
        counterpartPhone: "",
        bodyPreview: preview,
        clientName,
        assignedMemberUid: located.assignedMemberUid,
        smsLineScope: located.smsLineScope,
        pushType: "instagram_message",
        fallbackName: clientName,
      })
      .catch((e) => {
        console.warn("instagram notify", e.message || e);
      }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

const instagramOAuthCallback = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onRequest(async (req, res) => {
    const params = req.method === "POST" ? req.body || {} : req.query || {};
    const error = (params.error_description || params.error || "").toString().trim();
    if (error) {
      res.status(400).type("html").send(htmlPage("Instagram was not connected", error));
      return;
    }
    const code = (params.code || "").toString().trim();
    const stateToken = (params.state || "").toString().trim();
    const secret = instagramSecret();
    const state = readState(stateToken, secret);
    if (!code || !state || (state.scope !== "tenant" && state.scope !== "member")) {
      res
        .status(400)
        .type("html")
        .send(
          htmlPage(
            "Connect link expired",
            "Go back to Get Bookking and tap Connect again."
          )
        );
      return;
    }

    try {
      const caller = await loadCaller(state.uid);
      if (caller.tenantId !== state.tenantId) {
        throw new Error("This connect link does not match the signed-in business.");
      }
      assertScope(caller, state.scope);
      assertPaid(caller, state.scope === "member");
      const shortToken = await exchangeCode(code);
      const longLived = await exchangeLongLived(shortToken);
      const profile = await fetchMe(longLived.token);
      await claimIgAccount(profile.igUserId, {
        tenantId: caller.tenantId,
        uid: caller.uid,
        scope: state.scope,
        username: profile.username,
      });
      let provisionError = "";
      try {
        await subscribeMessages(longLived.token);
      } catch (e) {
        provisionError = (e.message || "Instagram did not turn on message delivery.").toString();
      }
      const patch = {
        igStatus: "connected",
        igUserId: profile.igUserId,
        igUsername: profile.username,
        igToken: longLived.token,
        igTokenExpiresAt: admin.firestore.Timestamp.fromMillis(
          Date.now() + longLived.expiresIn * 1000
        ),
        igConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
        igConnectedByUid: caller.uid,
        igProvisionError: provisionError,
      };
      await accountRef(caller, state.scope).set(patch, { merge: true });
      const note = provisionError
        ? `Connected @${profile.username}. ${provisionError} You can close this and return to Get Bookking.`
        : `Connected @${profile.username || "Instagram"}. You can close this and return to Get Bookking.`;
      res.status(200).type("html").send(htmlPage("Instagram connected", note));
    } catch (e) {
      console.error("instagramOAuthCallback", e);
      const message =
        (e && e.message) || "Instagram could not be connected. Go back and try again.";
      if (state && state.uid) {
        try {
          const caller = await loadCaller(state.uid);
          await accountRef(caller, state.scope).set(
            {
              igStatus: "failed",
              igProvisionError: message.toString().slice(0, 300),
            },
            { merge: true }
          );
        } catch (_) {
          /* status is best-effort */
        }
      }
      res.status(400).type("html").send(htmlPage("Instagram was not connected", message));
    }
  });

const startInstagramConnect = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const scope = ((data && data.scope) || "tenant").toString().trim();
    const caller = await loadCaller(context.auth.uid);
    assertScope(caller, scope);
    assertPaid(caller, scope === "member");
    const secret = instagramSecret();
    if (!secret) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Instagram is not configured yet."
      );
    }
    await accountRef(caller, scope).set({ igStatus: "connecting" }, { merge: true });
    const state = signState(
      {
        tenantId: caller.tenantId,
        uid: caller.uid,
        scope,
        exp: Date.now() + STATE_TTL_MS,
      },
      secret
    );
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", IG_APP_ID);
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", IG_SCOPES);
    url.searchParams.set("state", state);
    return { authorizeUrl: url.toString() };
  });

const disconnectInstagram = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const scope = ((data && data.scope) || "tenant").toString().trim();
    const caller = await loadCaller(context.auth.uid);
    assertScope(caller, scope);
    const ref = accountRef(caller, scope);
    const snap = await ref.get();
    const current = snap.exists ? snap.data() || {} : {};
    const igUserId = (current.igUserId || "").toString().trim();
    const token = (current.igToken || "").toString().trim();
    await unsubscribeMessages(token);
    await releaseIgAccount(igUserId, {
      tenantId: caller.tenantId,
      uid: caller.uid,
      scope,
    });
    await ref.set(clearedIgFields(), { merge: true });
    return { ok: true };
  });

const sendClientInstagramMessage = functions
  .region(REGION)
  .runWith({ secrets: runtimeSecrets })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const caller = await loadCaller(context.auth.uid);
    assertPaid(caller, !caller.isOwner);
    const threadId = ((data && data.threadId) || "").toString().trim();
    const body = ((data && data.body) || "").toString().trim();
    if (!threadId.startsWith("ig:") || !body) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "A message and an Instagram conversation are required."
      );
    }
    if (body.length > 1000) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Instagram messages are limited to 1000 characters."
      );
    }
    const threadRef = getDb()
      .collection("tenants")
      .doc(caller.tenantId)
      .collection("smsThreads")
      .doc(threadId);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Conversation not found.");
    }
    const thread = threadSnap.data() || {};
    if ((thread.channel || "").toString() !== "instagram") {
      throw new functions.https.HttpsError("failed-precondition", "This is not an Instagram conversation.");
    }
    const scope = (thread.smsLineScope || "tenant").toString();
    const assigned = (thread.assignedMemberUid || "").toString().trim();
    if (scope === "member") {
      if (assigned !== caller.uid) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "You can only reply in your own Instagram conversations."
        );
      }
    } else if (!(caller.isOwner || caller.accessRole === "manager")) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You do not have permission to reply to the business Instagram."
      );
    }
    const exp = thread.igWindowExpiresAt;
    const expMs = exp && typeof exp.toMillis === "function" ? exp.toMillis() : 0;
    if (!expMs || expMs < Date.now()) {
      throw new functions.https.HttpsError("failed-precondition", WINDOW_CLOSED_MESSAGE);
    }
    const customerId = (thread.igScopedUserId || "").toString().trim();
    const parts = threadId.split(":");
    const businessIgId = parts.length >= 3 ? parts[1] : "";
    if (!customerId || !businessIgId) {
      throw new functions.https.HttpsError("failed-precondition", "This Instagram conversation is incomplete.");
    }

    const accountDoc =
      scope === "member"
        ? getDb().collection("users").doc(caller.uid)
        : getDb().collection("tenants").doc(caller.tenantId);
    let accountSnap = await accountDoc.get();
    let account = accountSnap.exists ? accountSnap.data() || {} : {};
    account = await maybeRefreshAccount(accountDoc, account);
    if ((account.igStatus || "") !== "connected" || (account.igUserId || "") !== businessIgId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Instagram is not connected for this conversation."
      );
    }
    const token = (account.igToken || "").toString().trim();
    if (!token) {
      throw new functions.https.HttpsError("failed-precondition", "Instagram login expired. Connect again.");
    }

    const url = new URL(`${GRAPH}/v21.0/${encodeURIComponent(businessIgId)}/messages`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: customerId },
        message: { text: body },
      }),
    });
    const json = await readJson(res);
    if (!res.ok) {
      const raw = graphErrorMessage(json, "Instagram could not send that message.");
      const lowered = raw.toLowerCase();
      const message =
        lowered.includes("24") || lowered.includes("window")
          ? WINDOW_CLOSED_MESSAGE
          : raw;
      throw new functions.https.HttpsError("failed-precondition", message);
    }

    const clientName = (
      displayHandle(thread.igUsername) ||
      (data && data.clientName) ||
      thread.clientName ||
      "Instagram"
    )
      .toString()
      .slice(0, 120);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const messageId = (json.message_id || "").toString().trim();
    const logId = logDocId(messageId);
    const logCollection = getDb()
      .collection("tenants")
      .doc(caller.tenantId)
      .collection("smsLog");
    const logRef = logId ? logCollection.doc(logId) : logCollection.doc();
    // The echo webhook uses this same message id. Skip if it already arrived.
    const existingLog = logId ? await logRef.get() : null;
    if (!existingLog || !existingLog.exists) {
      await logRef.set({
        channel: "instagram",
        direction: "outbound",
        from: businessIgId,
        to: customerId,
        threadId,
        body: body.slice(0, 1000),
        clientName,
        igScopedUserId: customerId,
        assignedMemberUid: assigned,
        smsLineScope: scope,
        createdAt: now,
      });
    }
    await threadRef.set(
      {
        lastDirection: "outbound",
        lastMessageBody: body.slice(0, 500),
        lastMessageAt: now,
        clientName,
        updatedAt: now,
      },
      { merge: true }
    );
    return { ok: true, threadId };
  });

const refreshInstagramTokens = functions
  .region(REGION)
  .pubsub.schedule("every 24 hours")
  .onRun(async () => {
    const tenants = await getDb().collection("tenants").where("igStatus", "==", "connected").get();
    for (const doc of tenants.docs) {
      // eslint-disable-next-line no-await-in-loop
      await maybeRefreshAccount(doc.ref, doc.data() || {});
    }
    const users = await getDb().collection("users").where("igStatus", "==", "connected").get();
    for (const doc of users.docs) {
      // eslint-disable-next-line no-await-in-loop
      await maybeRefreshAccount(doc.ref, doc.data() || {});
    }
    return null;
  });

module.exports = {
  metaInstagramWebhook,
  instagramOAuthCallback,
  startInstagramConnect,
  disconnectInstagram,
  sendClientInstagramMessage,
  refreshInstagramTokens,
  redirectUri,
};
