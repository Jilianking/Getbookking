/**
 * Twilio client texting (ISV subaccount per tenant, opt-in, paid subscription only).
 */

const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");

const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const MAX_TENANT_OUTBOUND_SMS = 1000;

function getDb() {
  return admin.firestore();
}

/** US E.164 for Twilio; matches index.js normalizeCustomerPhone display rules. */
function toE164US(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return null;
  const hasPlus = s.charAt(0) === "+";
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.charAt(0) === "1") return `+${digits}`;
  if (hasPlus && digits.length >= 7) return `+${digits}`;
  if (digits.length >= 7) return `+${digits}`;
  return null;
}

function resolveSubscriptionStatus(tenant, userData) {
  const u = (userData && userData.subscriptionStatus) || "";
  const t = (tenant && tenant.subscriptionStatus) || "";
  return (u || t || "").toString().trim().toLowerCase();
}

/** Paid subscription: charged (active). Free trial (trialing) does not qualify. */
function tenantHasPaidSubscription(tenant, userData) {
  const hasStripe = !!((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!hasStripe) return false;
  return resolveSubscriptionStatus(tenant, userData) === "active";
}

function tenantIsTrialing(tenant, userData) {
  const hasStripe = !!((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!hasStripe) return false;
  return resolveSubscriptionStatus(tenant, userData) === "trialing";
}

function tenantCanUseSms(tenant, userData, managerPermissions) {
  const billingUser =
    userData || { subscriptionStatus: (tenant && tenant.subscriptionStatus) || "" };
  if (!tenantHasPaidSubscription(tenant, billingUser)) return false;
  if (tenant.smsEnabled !== true) return false;
  if ((tenant.smsStatus || "").toString() !== "active") return false;
  if (!(tenant.smsPhoneNumber || "").toString().trim()) return false;
  const perms = managerPermissions || {};
  if (perms.sendClientNotifications === false) return false;
  return true;
}

function getMasterTwilioClient() {
  const sid = twilioAccountSid.value();
  const token = twilioAuthToken.value();
  if (!sid || !token) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN secrets."
    );
  }
  // eslint-disable-next-line global-require
  return require("twilio")(sid, token);
}

function inboundWebhookUrl() {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) return "";
  return `https://us-central1-${project}.cloudfunctions.net/twilioInboundSms`;
}

function threadIdFromPhone(phone) {
  const normalized = toE164US(phone);
  return normalized || (phone || "").toString().trim();
}

async function upsertSmsThread(tenantId, threadId, patch) {
  if (!tenantId || !threadId) return;
  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsThreads")
    .doc(threadId)
    .set(
      {
        threadId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...patch,
      },
      { merge: true }
    );
}

function pickAreaCode(tenant) {
  const explicit = (tenant.smsAreaCode || "").toString().replace(/\D/g, "").slice(0, 3);
  if (explicit.length === 3) return explicit;
  const state = (tenant.contactState || "").toString().trim().toUpperCase();
  const stateArea = {
    PA: "215",
    NY: "212",
    CA: "415",
    TX: "512",
    FL: "305",
    IL: "312",
    GA: "404",
    MA: "617",
    WA: "206",
    CO: "303",
    AZ: "480",
    NJ: "201",
  };
  if (state && stateArea[state]) return stateArea[state];
  return "415";
}

async function getSubaccountClient(master, subaccountSid) {
  if (!subaccountSid) return master;
  const sub = await master.api.accounts(subaccountSid).fetch();
  // eslint-disable-next-line global-require
  return require("twilio")(sub.sid, sub.authToken);
}

/**
 * Provision Twilio subaccount + local SMS number + messaging service for a tenant.
 */
async function provisionTenantSms(tenantId, tenant) {
  const master = getMasterTwilioClient();
  const businessName = ((tenant.businessName || tenant.displayName || "Bookking") + "")
    .toString()
    .slice(0, 64);
  const areaCode = pickAreaCode(tenant);
  const webhook = inboundWebhookUrl();

  let subaccountSid = (tenant.twilioSubaccountSid || "").toString().trim();
  let subClient = master;

  if (!subaccountSid) {
    const created = await master.api.accounts.create({ friendlyName: businessName });
    subaccountSid = created.sid;
    subClient = require("twilio")(created.sid, created.authToken);
  } else {
    subClient = await getSubaccountClient(master, subaccountSid);
  }

  const available = await master.availablePhoneNumbers("US").local.list({
    areaCode,
    smsEnabled: true,
    limit: 5,
  });
  if (!available || available.length === 0) {
    const fallback = await master.availablePhoneNumbers("US").local.list({
      smsEnabled: true,
      limit: 1,
    });
    if (!fallback || fallback.length === 0) {
      throw new Error("No SMS-capable phone numbers available from Twilio.");
    }
    available.push(...fallback);
  }

  const picked = available[0].phoneNumber;
  const numberResource = await subClient.incomingPhoneNumbers.create({
    phoneNumber: picked,
    smsUrl: webhook || undefined,
    smsMethod: "POST",
  });

  let messagingServiceSid = (tenant.twilioMessagingServiceSid || "").toString().trim();
  if (!messagingServiceSid) {
    const svc = await subClient.messaging.v1.services.create({
      friendlyName: `${businessName} SMS`.slice(0, 64),
    });
    messagingServiceSid = svc.sid;
  }

  try {
    await subClient.messaging.v1
      .services(messagingServiceSid)
      .phoneNumbers.create({ phoneNumberSid: numberResource.sid });
  } catch (e) {
    if (!String(e.message || e).includes("already")) {
      console.warn("messaging service phone attach", e.message || e);
    }
  }

  const e164 = numberResource.phoneNumber;
  await getDb().collection("tenants").doc(tenantId).set(
    {
      twilioSubaccountSid: subaccountSid,
      twilioMessagingServiceSid: messagingServiceSid,
      smsPhoneNumber: e164,
      smsPhoneNumberSid: numberResource.sid,
      smsAreaCode: areaCode,
      smsStatus: "active",
      smsEnabled: true,
      smsEnabledAt: admin.firestore.FieldValue.serverTimestamp(),
      smsProvisionError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { phoneNumber: e164, subaccountSid, messagingServiceSid };
}

async function sendTenantSms(tenantId, tenant, toE164, body, meta) {
  const billingUser = { subscriptionStatus: (tenant && tenant.subscriptionStatus) || "" };
  if (!tenantCanUseSms(tenant, billingUser, tenant.managerPermissions)) {
    throw new Error("Tenant cannot send SMS (billing, opt-in, or permissions).");
  }
  const optId = toE164.replace(/\W/g, "_");
  const optSnap = await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsOptOuts")
    .doc(optId)
    .get();
  if (optSnap.exists) {
    throw new Error("Recipient opted out of SMS.");
  }
  const master = getMasterTwilioClient();
  const subSid = (tenant.twilioSubaccountSid || "").toString().trim();
  const client = subSid ? await getSubaccountClient(master, subSid) : master;
  const from = (tenant.smsPhoneNumber || "").toString().trim();
  if (!from) throw new Error("No SMS phone number on tenant.");
  const outboundCount = Number(tenant.smsOutboundCount || 0);
  if (outboundCount >= MAX_TENANT_OUTBOUND_SMS) {
    throw new Error("Outbound SMS limit reached (1,000 total).");
  }

  const msg = await client.messages.create({
    from,
    to: toE164,
    body: body.slice(0, 1600),
  });

  const logRef = getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .doc(msg.sid);
  await logRef.set({
    direction: "outbound",
    to: toE164,
    from,
    threadId: (meta && meta.threadId) || threadIdFromPhone(toE164),
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    body: body.slice(0, 500),
    status: msg.status,
    bookingRequestId: (meta && meta.bookingRequestId) || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await getDb().collection("tenants").doc(tenantId).set(
    {
      smsOutboundCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await upsertSmsThread(tenantId, (meta && meta.threadId) || threadIdFromPhone(toE164), {
    counterpartPhone: toE164,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    lastDirection: "outbound",
    lastMessageBody: body.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageStatus: (msg.status || "").toString(),
  });

  return msg;
}

async function recordInboundTenantSms(tenantId, inbound) {
  const from = (inbound && inbound.from) || "";
  const to = (inbound && inbound.to) || "";
  const body = ((inbound && inbound.body) || "").toString();
  const threadId = (inbound && inbound.threadId) || threadIdFromPhone(from);
  if (!tenantId || !from || !to) return;

  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .add({
      direction: "inbound",
      from,
      to,
      threadId,
      body: body.slice(0, 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  await upsertSmsThread(tenantId, threadId, {
    counterpartPhone: from,
    clientName: ((inbound && inbound.clientName) || "").toString().slice(0, 120),
    lastDirection: "inbound",
    lastMessageBody: body.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function suspendTenantSms(tenantId, reason) {
  await getDb().collection("tenants").doc(tenantId).set(
    {
      smsStatus: "suspended",
      smsSuspendedAt: admin.firestore.FieldValue.serverTimestamp(),
      smsSuspendReason: (reason || "").toString().slice(0, 200),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function syncSubscriptionStatusForTenant(tenantId, subscriptionStatus) {
  const status = (subscriptionStatus || "").toString().trim().toLowerCase();
  const tenantRef = getDb().collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) return;
  const tenant = tenantSnap.data();
  const ownerUid = tenant.ownerUid;
  const batch = getDb().batch();
  batch.set(
    tenantRef,
    {
      subscriptionStatus: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  if (ownerUid) {
    batch.set(
      getDb().collection("users").doc(ownerUid),
      { subscriptionStatus: status },
      { merge: true }
    );
  }
  await batch.commit();

  if (status !== "active" && tenant.smsStatus === "active") {
    await suspendTenantSms(tenantId, `subscription_${status}`);
  }
}

function extractCustomerPhone(booking) {
  const direct = booking.customerPhone;
  if (direct) {
    const n = toE164US(direct);
    if (n) return n;
  }
  const fr = booking.formResponses;
  if (fr && fr.phone) {
    const n = toE164US(fr.phone);
    if (n) return n;
  }
  return null;
}

module.exports = {
  twilioAccountSid,
  twilioAuthToken,
  toE164US,
  tenantHasPaidSubscription,
  tenantIsTrialing,
  tenantCanUseSms,
  resolveSubscriptionStatus,
  provisionTenantSms,
  sendTenantSms,
  recordInboundTenantSms,
  suspendTenantSms,
  syncSubscriptionStatusForTenant,
  extractCustomerPhone,
  inboundWebhookUrl,
  threadIdFromPhone,
  MAX_TENANT_OUTBOUND_SMS,
};
