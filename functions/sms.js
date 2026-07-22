/**
 * Twilio client texting (master account + shared 10DLC messaging service, opt-in, paid subscription only).
 */

const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { defineSecret, defineString } = require("firebase-functions/params");

const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
/** Approved 10DLC messaging service (MG…). Set in functions/.env.<projectId> or Firebase params. */
const masterTwilioMessagingServiceSid = defineString("MASTER_TWILIO_MESSAGING_SERVICE_SID", {
  default: "",
  description: "Twilio Messaging Service SID for the approved US A2P 10DLC campaign",
});
const MAX_TENANT_SMS_PER_MONTH = 1000;
const SMS_MONTHLY_LIMIT_MESSAGE =
  "Monthly SMS limit reached (1,000 messages including sent and received). Resets next calendar month (UTC).";

function currentSmsUsagePeriodUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Inbound + outbound messages counted toward the monthly cap. */
function smsMonthlyUsageForTenant(tenant) {
  const period = currentSmsUsagePeriodUtc();
  const storedPeriod = (tenant && tenant.smsUsagePeriod) || "";
  if (storedPeriod === period) {
    return {
      period,
      count: Number(tenant.smsUsageCount || 0),
      limit: MAX_TENANT_SMS_PER_MONTH,
      remaining: Math.max(0, MAX_TENANT_SMS_PER_MONTH - Number(tenant.smsUsageCount || 0)),
    };
  }
  return {
    period,
    count: 0,
    limit: MAX_TENANT_SMS_PER_MONTH,
    remaining: MAX_TENANT_SMS_PER_MONTH,
  };
}

/**
 * Reserve one message against the tenant monthly cap (atomic). Throws if at limit.
 */
async function consumeSmsMonthlySlot(tenantId) {
  const period = currentSmsUsagePeriodUtc();
  const ref = getDb().collection("tenants").doc(tenantId);
  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    let count = 0;
    if ((data.smsUsagePeriod || "").toString() === period) {
      count = Number(data.smsUsageCount || 0);
    }
    if (count >= MAX_TENANT_SMS_PER_MONTH) {
      throw new Error(SMS_MONTHLY_LIMIT_MESSAGE);
    }
    tx.set(
      ref,
      {
        smsUsagePeriod: period,
        smsUsageCount: count + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

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
  return !paidSubscriptionBlockReason(tenant, userData);
}

/** Billing-only block reason (provisioning / enable texting). */
function paidSubscriptionBlockReason(tenant, userData) {
  const hasStripe = !!((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!hasStripe) {
    return (
      "Billing is not linked to Stripe. Finish sign-up at getbookking.com/signup.html " +
      "(complete checkout), or sync billing from Team → Notifications."
    );
  }
  const status = resolveSubscriptionStatus(tenant, userData);
  if (status === "trialing") {
    return (
      "Client texting starts after your paid subscription begins (not during the free trial). " +
      "Use Start subscription today in Team → Notifications."
    );
  }
  if (status !== "active") {
    return `Subscription status is "${status || "unknown"}". Update billing in account settings.`;
  }
  return null;
}

function tenantIsTrialing(tenant, userData) {
  const hasStripe = !!((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!hasStripe) return false;
  return resolveSubscriptionStatus(tenant, userData) === "trialing";
}

function tenantCanUseSms(tenant, userData, managerPermissions) {
  return !smsEligibilityBlockReason(tenant, userData, managerPermissions);
}

/** Human-readable reason when SMS is blocked; null when sending is allowed. */
function smsEligibilityBlockReason(tenant, userData, managerPermissions) {
  const billingBlock = paidSubscriptionBlockReason(tenant, userData);
  if (billingBlock) return billingBlock;
  if (tenant.smsEnabled !== true) {
    return "Enable client texting under Team → Notifications.";
  }
  const smsStatus = (tenant.smsStatus || "off").toString();
  if (smsStatus === "pending") {
    return "Your texting number is still being set up. Try again in a minute.";
  }
  if (smsStatus === "failed") {
    const err = (tenant.smsProvisionError || "").toString().trim();
    return err || "Texting setup failed. Try again under Team → Notifications.";
  }
  if (smsStatus !== "active") {
    return "Enable client texting under Team → Notifications.";
  }
  if (!(tenant.smsPhoneNumber || "").toString().trim()) {
    return "No client texting number on file. Enable client texting under Team → Notifications.";
  }
  const perms = managerPermissions || {};
  if (perms.sendClientNotifications === false) {
    return "Manager policy has client texting notifications turned off.";
  }
  return null;
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

function getMasterMessagingServiceSid() {
  const sid = (masterTwilioMessagingServiceSid.value() || "").toString().trim();
  if (!sid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Twilio messaging service is not configured. Set MASTER_TWILIO_MESSAGING_SERVICE_SID " +
        "(MG… for your approved 10DLC campaign) in Secret Manager or functions/.env.<projectId>."
    );
  }
  return sid;
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

async function attachNumberToMasterMessagingService(master, messagingServiceSid, phoneNumberSid) {
  try {
    await master.messaging.v1
      .services(messagingServiceSid)
      .phoneNumbers.create({ phoneNumberSid });
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes("already")) {
      console.warn("messaging service phone attach", msg);
      throw e;
    }
  }
}

async function detachNumberFromMasterMessagingService(master, messagingServiceSid, phoneNumberSid) {
  if (!messagingServiceSid || !phoneNumberSid) return;
  try {
    await master.messaging.v1
      .services(messagingServiceSid)
      .phoneNumbers(phoneNumberSid)
      .remove();
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes("not found") && !msg.includes("404")) {
      console.warn("detachNumberFromMasterMessagingService", msg);
    }
  }
}

/**
 * Release a team member's personal Twilio number (best effort). Caller clears Firestore SMS fields.
 */
async function releaseMemberSms(memberData) {
  const phoneSid = (memberData.smsPhoneNumberSid || "").toString().trim();
  if (!phoneSid) return { released: false };
  try {
    const master = getMasterTwilioClient();
    const messagingServiceSid = getMasterMessagingServiceSid();
    await detachNumberFromMasterMessagingService(master, messagingServiceSid, phoneSid);
    try {
      await master.incomingPhoneNumbers(phoneSid).remove();
    } catch (e) {
      console.warn("releaseMemberSms: remove incoming number", phoneSid, e.message || e);
    }
    return { released: true };
  } catch (e) {
    console.warn("releaseMemberSms: twilio release failed", e.message || e);
    return { released: false };
  }
}

async function ensureMasterIncomingNumber(master, tenant, webhook) {
  const hadSubaccount = !!(tenant.twilioSubaccountSid || "").toString().trim();
  if (hadSubaccount) {
    return null;
  }
  const existingSid = (tenant.smsPhoneNumberSid || "").toString().trim();
  if (existingSid) {
    try {
      const resource = await master.incomingPhoneNumbers(existingSid).fetch();
      if (webhook) {
        await master.incomingPhoneNumbers(existingSid).update({
          smsUrl: webhook,
          smsMethod: "POST",
        });
      }
      return resource;
    } catch (e) {
      console.warn(
        "ensureMasterIncomingNumber: existing sid not on master, buying new",
        existingSid,
        e.message || e
      );
    }
  }
  return null;
}

async function buyMasterLocalNumber(master, areaCode) {
  let available = await master.availablePhoneNumbers("US").local.list({
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
    available = fallback;
  }
  const picked = available[0].phoneNumber;
  const createOpts = { phoneNumber: picked };
  const webhook = inboundWebhookUrl();
  if (webhook) {
    createOpts.smsUrl = webhook;
    createOpts.smsMethod = "POST";
  }
  return master.incomingPhoneNumbers.create(createOpts);
}

/**
 * Provision a local SMS number on the master account and add it to the shared 10DLC messaging service.
 */
async function provisionTenantSms(tenantId, tenant) {
  const master = getMasterTwilioClient();
  const messagingServiceSid = getMasterMessagingServiceSid();
  const areaCode = pickAreaCode(tenant);
  const webhook = inboundWebhookUrl();

  let numberResource = await ensureMasterIncomingNumber(master, tenant, webhook);
  if (!numberResource) {
    numberResource = await buyMasterLocalNumber(master, areaCode);
    if (webhook) {
      await master.incomingPhoneNumbers(numberResource.sid).update({
        smsUrl: webhook,
        smsMethod: "POST",
      });
    }
  }

  await attachNumberToMasterMessagingService(master, messagingServiceSid, numberResource.sid);

  const e164 = numberResource.phoneNumber;
  await getDb().collection("tenants").doc(tenantId).set(
    {
      twilioMessagingServiceSid: messagingServiceSid,
      twilioSubaccountSid: admin.firestore.FieldValue.delete(),
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

  return { phoneNumber: e164, messagingServiceSid };
}

function memberPayoutMode(memberData) {
  const raw = memberData && memberData.memberSettings;
  const d = raw && typeof raw === "object" ? raw : {};
  const mode = (d.payoutMode || "independent").toString().trim().toLowerCase();
  return mode === "studio_payroll" ? "studio_payroll" : "independent";
}

function tenantStudioSmsActive(tenant) {
  return (
    tenant &&
    tenant.smsEnabled === true &&
    (tenant.smsStatus || "").toString() === "active" &&
    !!(tenant.smsPhoneNumber || "").toString().trim()
  );
}

/** Studio must have texting on before members can provision personal lines. */
function tenantSmsMustBeActiveForMemberLine(tenant) {
  if (!tenantStudioSmsActive(tenant)) {
    return (
      "Your studio must enable client texting before you can set up a personal line."
    );
  }
  return null;
}

function memberPersonalSmsBlockReason(tenant, ownerUserData, memberData) {
  const billingBlock = paidSubscriptionBlockReason(tenant, ownerUserData);
  if (billingBlock) return billingBlock;
  const studioBlock = tenantSmsMustBeActiveForMemberLine(tenant);
  if (studioBlock) return studioBlock;
  if (memberPayoutMode(memberData) !== "independent") {
    return "Personal texting lines are for independent team members.";
  }
  if (memberData.smsEnabled !== true) {
    return "Enable your personal texting line under Team.";
  }
  const smsStatus = (memberData.smsStatus || "off").toString();
  if (smsStatus === "pending") {
    return "Your texting number is still being set up. Try again in a minute.";
  }
  if (smsStatus === "failed") {
    const err = (memberData.smsProvisionError || "").toString().trim();
    return err || "Personal texting setup failed. Try again under Team.";
  }
  if (smsStatus !== "active") {
    return "Set up your personal texting line under Team.";
  }
  if (!(memberData.smsPhoneNumber || "").toString().trim()) {
    return "No personal texting number on file. Set up your line under Team.";
  }
  return null;
}

async function ensureMemberIncomingNumber(master, memberData, webhook) {
  const existingSid = (memberData.smsPhoneNumberSid || "").toString().trim();
  if (!existingSid) return null;
  try {
    const resource = await master.incomingPhoneNumbers(existingSid).fetch();
    if (webhook) {
      await master.incomingPhoneNumbers(existingSid).update({
        smsUrl: webhook,
        smsMethod: "POST",
      });
    }
    return resource;
  } catch (e) {
    console.warn(
      "ensureMemberIncomingNumber: existing sid not on master, buying new",
      existingSid,
      e.message || e
    );
    return null;
  }
}

/**
 * Provision a personal SMS number for an independent team member.
 */
async function provisionMemberSms(tenantId, tenant, memberUid, memberData) {
  const studioBlock = tenantSmsMustBeActiveForMemberLine(tenant);
  if (studioBlock) {
    throw new Error(studioBlock);
  }
  if (memberPayoutMode(memberData) !== "independent") {
    throw new Error("Personal texting lines are for independent team members.");
  }
  const master = getMasterTwilioClient();
  const messagingServiceSid = getMasterMessagingServiceSid();
  const areaCode = pickAreaCode(tenant);
  const webhook = inboundWebhookUrl();

  let numberResource = await ensureMemberIncomingNumber(master, memberData, webhook);
  if (!numberResource) {
    numberResource = await buyMasterLocalNumber(master, areaCode);
    if (webhook) {
      await master.incomingPhoneNumbers(numberResource.sid).update({
        smsUrl: webhook,
        smsMethod: "POST",
      });
    }
  }

  await attachNumberToMasterMessagingService(master, messagingServiceSid, numberResource.sid);

  const e164 = numberResource.phoneNumber;
  await getDb().collection("users").doc(memberUid).set(
    {
      smsPhoneNumber: e164,
      smsPhoneNumberSid: numberResource.sid,
      smsStatus: "active",
      smsEnabled: true,
      smsEnabledAt: admin.firestore.FieldValue.serverTimestamp(),
      smsProvisionError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { phoneNumber: e164, messagingServiceSid };
}

function resolveOutboundSmsRoute({
  tenant,
  senderUid,
  senderUserData,
  isOwner,
  accessRole,
  managerPermissions,
}) {
  if (isOwner || accessRole === "manager") {
    return {
      lineType: "tenant",
      from: (tenant.smsPhoneNumber || "").toString().trim(),
      phoneSid: (tenant.smsPhoneNumberSid || "").toString().trim(),
      memberUid: null,
    };
  }
  if (
    memberPayoutMode(senderUserData) === "independent" &&
    senderUserData &&
    senderUserData.smsStatus === "active" &&
    (senderUserData.smsPhoneNumber || "").toString().trim()
  ) {
    return {
      lineType: "member",
      from: (senderUserData.smsPhoneNumber || "").toString().trim(),
      phoneSid: (senderUserData.smsPhoneNumberSid || "").toString().trim(),
      memberUid: senderUid,
    };
  }
  return null;
}

function canSendClientSms({
  isOwner,
  accessRole,
  managerPermissions,
  senderUserData,
}) {
  if (isOwner) return true;
  if (accessRole === "manager" && managerPermissions.sendClientNotifications !== false) {
    return true;
  }
  if (
    memberPayoutMode(senderUserData) === "independent" &&
    senderUserData &&
    senderUserData.smsStatus === "active" &&
    (senderUserData.smsPhoneNumber || "").toString().trim()
  ) {
    return true;
  }
  return false;
}

async function sendOutboundClientSms({
  tenantId,
  tenant,
  toE164,
  body,
  meta,
  ownerUserData,
  senderUid,
  senderUserData,
  isOwner,
  accessRole,
  managerPermissions,
}) {
  const route = resolveOutboundSmsRoute({
    tenant,
    senderUid,
    senderUserData,
    isOwner,
    accessRole,
    managerPermissions,
  });
  if (!route || !route.from) {
    throw new Error("You do not have permission to send client texts.");
  }
  if (route.lineType === "tenant") {
    const blockReason = smsEligibilityBlockReason(
      tenant,
      ownerUserData,
      managerPermissions
    );
    if (blockReason) throw new Error(blockReason);
  } else {
    const blockReason = memberPersonalSmsBlockReason(
      tenant,
      ownerUserData,
      senderUserData
    );
    if (blockReason) throw new Error(blockReason);
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
  const phoneSid = route.phoneSid;
  if (phoneSid) {
    try {
      await master.incomingPhoneNumbers(phoneSid).fetch();
    } catch (e) {
      throw new Error(
        "Your texting number must be refreshed for delivery. Try again in Team settings."
      );
    }
  }

  await consumeSmsMonthlySlot(tenantId);
  const messagingServiceSid = getMasterMessagingServiceSid();
  const msg = await master.messages.create({
    to: toE164,
    body: body.slice(0, 1600),
    messagingServiceSid,
    from: route.from,
  });

  const threadId = (meta && meta.threadId) || threadIdFromPhone(toE164);
  const logRef = getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .doc(msg.sid);
  const paymentMeta = paymentFieldsFromMeta(meta);
  const threadPreview = ((meta && meta.threadPreview) || "").toString().trim();
  await logRef.set({
    direction: "outbound",
    to: toE164,
    from: route.from,
    threadId,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    body: body.slice(0, 500),
    status: msg.status,
    bookingRequestId: (meta && meta.bookingRequestId) || null,
    assignedMemberUid: route.memberUid || null,
    smsLineScope: route.lineType,
    ...paymentMeta,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await upsertSmsThread(tenantId, threadId, {
    counterpartPhone: toE164,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    lastDirection: "outbound",
    lastMessageBody: (threadPreview || body).slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageStatus: (msg.status || "").toString(),
    assignedMemberUid: route.memberUid || null,
    smsLineScope: route.lineType,
  });

  return msg;
}

/** Optional structured payment fields for in-app message bubbles. */
function paymentFieldsFromMeta(meta) {
  const out = {};
  const kind = ((meta && meta.paymentKind) || "").toString().trim().toLowerCase();
  if (kind === "deposit" || kind === "payment") {
    out.paymentKind = kind;
  }
  const cents = Number(meta && meta.amountCents);
  if (Number.isFinite(cents) && cents > 0) {
    out.amountCents = Math.round(cents);
  }
  const url = ((meta && meta.paymentUrl) || "").toString().trim();
  if (url) {
    out.paymentUrl = url.slice(0, 500);
  }
  return out;
}

async function sendTenantSms(tenantId, tenant, toE164, body, meta, ownerUserData) {
  const blockReason = smsEligibilityBlockReason(
    tenant,
    ownerUserData,
    tenant.managerPermissions
  );
  if (blockReason) {
    throw new Error(blockReason);
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
  const from = (tenant.smsPhoneNumber || "").toString().trim();
  if (!from) throw new Error("No SMS phone number on tenant.");
  const phoneSid = (tenant.smsPhoneNumberSid || "").toString().trim();
  if (phoneSid) {
    try {
      await master.incomingPhoneNumbers(phoneSid).fetch();
    } catch (e) {
      throw new Error(
        "Your texting number must be refreshed for delivery. " +
          "In Team → Notifications, tap Refresh texting number, then try again."
      );
    }
  } else if ((tenant.twilioSubaccountSid || "").toString().trim()) {
    throw new Error(
      "Your texting number must be refreshed for delivery. " +
        "In Team → Notifications, tap Refresh texting number, then try again."
    );
  }
  await consumeSmsMonthlySlot(tenantId);

  const messagingServiceSid = getMasterMessagingServiceSid();
  const msg = await master.messages.create({
    to: toE164,
    body: body.slice(0, 1600),
    messagingServiceSid,
    from,
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
      twilioMessagingServiceSid: messagingServiceSid,
      twilioSubaccountSid: admin.firestore.FieldValue.delete(),
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

/**
 * Log inbound client SMS and count toward monthly usage. Returns false if monthly cap reached.
 */
async function recordInboundTenantSms(tenantId, inbound) {
  const from = (inbound && inbound.from) || "";
  const to = (inbound && inbound.to) || "";
  const body = ((inbound && inbound.body) || "").toString();
  const threadId = (inbound && inbound.threadId) || threadIdFromPhone(from);
  const assignedMemberUid = (inbound && inbound.assignedMemberUid) || null;
  const smsLineScope = (inbound && inbound.smsLineScope) || "tenant";
  if (!tenantId || !from || !to) return false;

  try {
    await consumeSmsMonthlySlot(tenantId);
  } catch (e) {
    if (String(e.message || e).includes("Monthly SMS limit")) {
      console.warn("recordInboundTenantSms: monthly cap", tenantId);
      return false;
    }
    throw e;
  }

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
      assignedMemberUid,
      smsLineScope,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  await upsertSmsThread(tenantId, threadId, {
    counterpartPhone: from,
    clientName: ((inbound && inbound.clientName) || "").toString().slice(0, 120),
    lastDirection: "inbound",
    lastMessageBody: body.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    assignedMemberUid,
    smsLineScope,
  });
  return true;
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

async function syncSubscriptionStatusForTenant(tenantId, subscriptionStatus, billingPatch) {
  const status = (subscriptionStatus || "").toString().trim().toLowerCase();
  const extra = billingPatch && typeof billingPatch === "object" ? billingPatch : {};
  const tenantRef = getDb().collection("tenants").doc(tenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) return;
  const tenant = tenantSnap.data();
  const ownerUid = tenant.ownerUid;
  const tenantFields = {
    subscriptionStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (extra.stripeCustomerId) tenantFields.stripeCustomerId = extra.stripeCustomerId;
  if (extra.stripeSubscriptionId) tenantFields.stripeSubscriptionId = extra.stripeSubscriptionId;
  if (extra.subscriptionPlan) tenantFields.subscriptionPlan = extra.subscriptionPlan;
  const batch = getDb().batch();
  batch.set(tenantRef, tenantFields, { merge: true });
  if (ownerUid) {
    const userFields = { subscriptionStatus: status };
    if (extra.subscriptionPlan) userFields.subscriptionPlan = extra.subscriptionPlan;
    batch.set(getDb().collection("users").doc(ownerUid), userFields, { merge: true });
  }
  await batch.commit();

  if (status !== "active" && tenant.smsStatus === "active") {
    await suspendTenantSms(tenantId, `subscription_${status}`);
  }
}

const SMS_PRESET_MAX_LEN = 500;
const SMS_QUICK_REPLY_MAX = 12;
const SMS_QUICK_REPLY_ITEM_MAX = 300;

function defaultSmsPresetConfirmed() {
  return "{business}: Your appointment request for {service} is confirmed. Reply STOP to opt out.";
}

function defaultSmsPresetDeclined() {
  return "{business}: We're unable to take this request at this time. Reply STOP to opt out.";
}

function defaultSmsQuickPresets() {
  return [
    "Thanks for reaching out! We'll get back to you shortly.",
    "See you at your appointment!",
    "Can you share your preferred date and time?",
  ];
}

function normalizeSmsQuickPresets(raw) {
  if (!Array.isArray(raw)) return defaultSmsQuickPresets();
  const out = [];
  for (const item of raw) {
    const s = (item || "").toString().trim();
    if (!s) continue;
    out.push(s.slice(0, SMS_QUICK_REPLY_ITEM_MAX));
    if (out.length >= SMS_QUICK_REPLY_MAX) break;
  }
  return out.length ? out : defaultSmsQuickPresets();
}

function tenantSmsPresets(tenant) {
  const businessDefault = defaultSmsPresetConfirmed();
  const confirmed = ((tenant && tenant.smsPresetConfirmed) || businessDefault).toString().trim();
  const declined = ((tenant && tenant.smsPresetDeclined) || defaultSmsPresetDeclined())
    .toString()
    .trim();
  return {
    smsPresetConfirmed: confirmed.slice(0, SMS_PRESET_MAX_LEN) || defaultSmsPresetConfirmed(),
    smsPresetDeclined: declined.slice(0, SMS_PRESET_MAX_LEN) || defaultSmsPresetDeclined(),
    smsQuickPresets: normalizeSmsQuickPresets(tenant && tenant.smsQuickPresets),
  };
}

/** Replace {business}, {businessName}, {service}, {serviceName} in preset templates. */
function renderSmsPreset(template, ctx) {
  const business = ((ctx && ctx.business) || "Your provider").toString().trim().slice(0, 120);
  const service = ((ctx && ctx.service) || "").toString().trim().slice(0, 120);
  let body = (template || "").toString();
  body = body.replace(/\{businessName\}/gi, business);
  body = body.replace(/\{business\}/gi, business);
  body = body.replace(/\{serviceName\}/gi, service);
  body = body.replace(/\{service\}/gi, service);
  if (!service) {
    body = body.replace(/\s+for\s+(?=[.,!?]|$)/gi, " ");
    body = body.replace(/\s+for\s*$/gi, "");
  }
  body = body.replace(/\s{2,}/g, " ").trim();
  return body.slice(0, 1600);
}

function bookingStatusSmsBody(tenant, status, booking) {
  const presets = tenantSmsPresets(tenant);
  const business = ((tenant && (tenant.businessName || tenant.displayName)) || "Your provider")
    .toString()
    .trim();
  const service = ((booking && booking.serviceName) || "").toString().trim();
  const ctx = { business, service };
  if (status === "confirmed") {
    return renderSmsPreset(presets.smsPresetConfirmed, ctx);
  }
  if (status === "declined") {
    return renderSmsPreset(presets.smsPresetDeclined, ctx);
  }
  return null;
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
  masterTwilioMessagingServiceSid,
  toE164US,
  tenantHasPaidSubscription,
  tenantIsTrialing,
  tenantCanUseSms,
  paidSubscriptionBlockReason,
  smsEligibilityBlockReason,
  resolveSubscriptionStatus,
  provisionTenantSms,
  provisionMemberSms,
  releaseMemberSms,
  sendTenantSms,
  sendOutboundClientSms,
  recordInboundTenantSms,
  memberPersonalSmsBlockReason,
  memberPayoutMode,
  tenantStudioSmsActive,
  resolveOutboundSmsRoute,
  canSendClientSms,
  suspendTenantSms,
  syncSubscriptionStatusForTenant,
  extractCustomerPhone,
  inboundWebhookUrl,
  threadIdFromPhone,
  MAX_TENANT_SMS_PER_MONTH,
  SMS_MONTHLY_LIMIT_MESSAGE,
  smsMonthlyUsageForTenant,
  currentSmsUsagePeriodUtc,
  defaultSmsPresetConfirmed,
  defaultSmsPresetDeclined,
  defaultSmsQuickPresets,
  tenantSmsPresets,
  normalizeSmsQuickPresets,
  renderSmsPreset,
  bookingStatusSmsBody,
  SMS_PRESET_MAX_LEN,
  SMS_QUICK_REPLY_MAX,
};
