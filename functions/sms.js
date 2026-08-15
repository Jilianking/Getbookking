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
/** Per texting line (studio or personal): 1,000 inbound+outbound / calendar month UTC. */
const MAX_SMS_PER_LINE_PER_MONTH = 1000;
/** @deprecated alias — kept for existing imports */
const MAX_TENANT_SMS_PER_MONTH = MAX_SMS_PER_LINE_PER_MONTH;
const SMS_MONTHLY_LIMIT_MESSAGE =
  "Monthly SMS limit reached for this texting number (1,000 messages including sent and received). Resets next calendar month (UTC).";

function currentSmsUsagePeriodUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Usage snapshot for a document that stores smsUsageCount / smsUsagePeriod. */
function smsMonthlyUsageFromDoc(docData) {
  const period = currentSmsUsagePeriodUtc();
  const storedPeriod = (docData && docData.smsUsagePeriod) || "";
  if (storedPeriod === period) {
    const count = Number(docData.smsUsageCount || 0);
    return {
      period,
      count,
      limit: MAX_SMS_PER_LINE_PER_MONTH,
      remaining: Math.max(0, MAX_SMS_PER_LINE_PER_MONTH - count),
    };
  }
  return {
    period,
    count: 0,
    limit: MAX_SMS_PER_LINE_PER_MONTH,
    remaining: MAX_SMS_PER_LINE_PER_MONTH,
  };
}

/** Studio line monthly usage (tenant fields). */
function smsMonthlyUsageForTenant(tenant) {
  return smsMonthlyUsageFromDoc(tenant);
}

/** Personal line monthly usage (user fields). */
function smsMonthlyUsageForMember(memberData) {
  return smsMonthlyUsageFromDoc(memberData);
}

/**
 * Reserve one message against the line's monthly cap (atomic).
 * @param {string} tenantId
 * @param {{ memberUid?: string|null }} [opts] — if memberUid set, count against personal line; else studio.
 */
async function consumeSmsMonthlySlot(tenantId, opts) {
  const memberUid = (opts && opts.memberUid) || "";
  const period = currentSmsUsagePeriodUtc();
  const isPersonal = !!(memberUid && String(memberUid).trim());
  const ref = isPersonal
    ? getDb().collection("users").doc(String(memberUid).trim())
    : getDb().collection("tenants").doc(tenantId);

  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    let count = 0;
    if ((data.smsUsagePeriod || "").toString() === period) {
      count = Number(data.smsUsageCount || 0);
    }
    if (count >= MAX_SMS_PER_LINE_PER_MONTH) {
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

const PAID_FEATURE_UPGRADE_MESSAGE =
  "Your free trial includes the website builder. Start your paid Get Bookking plan to unlock client texting and payments.";

/**
 * TESTING ONLY — when true, payments / SMS / Connect paid-feature gates do not
 * require an active paid subscription (no charge required).
 * UI copy can still show “start subscription” / free trial.
 * Set false and redeploy before real billing enforcement.
 */
const BYPASS_SUBSCRIPTION_PAYMENT_GATE = true;

function isSubscriptionPaymentGateBypassed() {
  return BYPASS_SUBSCRIPTION_PAYMENT_GATE === true;
}

/** Paid subscription: charged (active). Free trial (trialing) does not qualify (unless testing bypass). */
function tenantHasPaidSubscription(tenant, userData) {
  return !paidSubscriptionBlockReason(tenant, userData);
}

/** Billing-only block reason (provisioning / enable texting). */
function paidSubscriptionBlockReason(tenant, userData) {
  if (isSubscriptionPaymentGateBypassed()) {
    return null;
  }
  const hasStripe = !!((tenant && tenant.stripeCustomerId) || "").toString().trim();
  if (!hasStripe) {
    return PAID_FEATURE_UPGRADE_MESSAGE;
  }
  const status = resolveSubscriptionStatus(tenant, userData);
  if (status === "trialing") {
    return PAID_FEATURE_UPGRADE_MESSAGE;
  }
  if (status !== "active") {
    return PAID_FEATURE_UPGRADE_MESSAGE;
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

/**
 * Conversation id scoped to the Twilio number that was texted.
 * Studio (tenant) keeps legacy client-phone ids for backward compatibility.
 * Personal lines: l{lineDigits}_c{clientDigits} so owner/studio inbox stays separate.
 */
function lineScopedThreadId({ linePhone, clientPhone, lineScope, memberUid }) {
  const client = threadIdFromPhone(clientPhone);
  if (!client) return "";
  const scope = (lineScope || "tenant").toString();
  if (scope === "member" || (memberUid || "").toString().trim()) {
    const line = threadIdFromPhone(linePhone);
    const lineDigits = (line || "").replace(/\D/g, "");
    const clientDigits = (client || "").replace(/\D/g, "");
    if (lineDigits && clientDigits) {
      return `l${lineDigits}_c${clientDigits}`;
    }
  }
  return client;
}

function isLineScopedThreadId(threadId) {
  return /^l\d+_c\d+$/.test((threadId || "").toString().trim());
}

function clientPhoneFromThreadId(threadId) {
  const tid = (threadId || "").toString().trim();
  if (isLineScopedThreadId(tid)) {
    const clientDigits = tid.split("_c")[1] || "";
    return toE164US(clientDigits) || "";
  }
  return threadIdFromPhone(tid);
}

function isStudioSmsThread(threadData) {
  if (!threadData || typeof threadData !== "object") return true;
  const scope = (threadData.smsLineScope || "").toString().trim().toLowerCase();
  if (scope === "member") return false;
  const assigned = (threadData.assignedMemberUid || "").toString().trim();
  if (assigned) return false;
  if (isLineScopedThreadId(threadData.threadId || "")) return false;
  return true;
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
 * Release a Twilio number SID (detach messaging service + delete resource). Best effort.
 */
async function releaseTwilioPhoneSid(phoneSid) {
  const sid = (phoneSid || "").toString().trim();
  if (!sid) return { released: false };
  try {
    const master = getMasterTwilioClient();
    const messagingServiceSid = getMasterMessagingServiceSid();
    await detachNumberFromMasterMessagingService(master, messagingServiceSid, sid);
    try {
      await master.incomingPhoneNumbers(sid).remove();
    } catch (e) {
      console.warn("releaseTwilioPhoneSid: remove incoming number", sid, e.message || e);
    }
    return { released: true };
  } catch (e) {
    console.warn("releaseTwilioPhoneSid: twilio release failed", e.message || e);
    return { released: false };
  }
}

/** True if SID still exists in Twilio. Transient errors return true (do not wipe). */
async function twilioIncomingNumberExists(phoneSid) {
  const sid = (phoneSid || "").toString().trim();
  if (!sid) return false;
  try {
    await getMasterTwilioClient().incomingPhoneNumbers(sid).fetch();
    return true;
  } catch (e) {
    const status = e.status || e.statusCode || e.code;
    const msg = String(e.message || e).toLowerCase();
    if (
      status === 404 ||
      msg.includes("not found") ||
      msg.includes("404") ||
      msg.includes("was not found")
    ) {
      return false;
    }
    console.warn("twilioIncomingNumberExists transient", sid, e.message || e);
    return true;
  }
}

/**
 * Clear Firestore SMS lines whose Twilio SIDs no longer exist (orphans).
 * Returns updated tenant snapshot fields and how many lines were cleared.
 */
async function reconcileStaleSmsLinesInFirestore(tenantId, tenant, userDocs) {
  let cleared = 0;
  let tenantOut = tenant || {};
  const studioSid = (tenantOut.smsPhoneNumberSid || "").toString().trim();
  const studioPhone = (tenantOut.smsPhoneNumber || "").toString().trim();
  if (studioSid || studioPhone) {
    const ok = studioSid ? await twilioIncomingNumberExists(studioSid) : false;
    if (!ok) {
      await getDb()
        .collection("tenants")
        .doc(tenantId)
        .set(tenantSmsClearedFields(), { merge: true });
      tenantOut = {
        ...tenantOut,
        smsPhoneNumber: "",
        smsPhoneNumberSid: "",
        smsStatus: "off",
        smsEnabled: false,
      };
      cleared += 1;
      console.log("reconcileStaleSmsLines: cleared studio", tenantId, studioSid || studioPhone);
    }
  }

  for (const doc of userDocs || []) {
    const d = typeof doc.data === "function" ? doc.data() || {} : {};
    const sid = (d.smsPhoneNumberSid || "").toString().trim();
    const phone = (d.smsPhoneNumber || "").toString().trim();
    if (!sid && !phone) continue;
    if (!sid) continue; // phone-only rows: cannot verify without SID
    const ok = await twilioIncomingNumberExists(sid);
    if (!ok) {
      await doc.ref.set(personalSmsClearedFields(), { merge: true });
      cleared += 1;
      console.log("reconcileStaleSmsLines: cleared member", doc.id, sid);
    }
  }

  return { tenant: tenantOut, cleared };
}

/**
 * Release a team member's personal Twilio number (best effort). Caller clears Firestore SMS fields.
 */
async function releaseMemberSms(memberData) {
  return releaseTwilioPhoneSid(memberData && memberData.smsPhoneNumberSid);
}

/**
 * Release the tenant (studio) Twilio number (best effort). Caller clears Firestore fields.
 */
async function releaseTenantSms(tenant) {
  return releaseTwilioPhoneSid(tenant && tenant.smsPhoneNumberSid);
}

/** Firestore fields to clear after releasing a personal SMS line. */
function personalSmsClearedFields() {
  return {
    smsPhoneNumber: admin.firestore.FieldValue.delete(),
    smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
    smsStatus: "off",
    smsEnabled: false,
    smsEnabledAt: admin.firestore.FieldValue.delete(),
    smsProvisionError: admin.firestore.FieldValue.delete(),
    smsSuspendedAt: admin.firestore.FieldValue.delete(),
    smsSuspendReason: admin.firestore.FieldValue.delete(),
    smsLineRequestPending: admin.firestore.FieldValue.delete(),
    smsLineRequestedAt: admin.firestore.FieldValue.delete(),
    smsLineRequestConsentAccepted: admin.firestore.FieldValue.delete(),
    smsLineIsPaidExtra: admin.firestore.FieldValue.delete(),
    smsPaidLinePurchaseAuthorizationId: admin.firestore.FieldValue.delete(),
    smsPaidLinePurchaseInvoiceId: admin.firestore.FieldValue.delete(),
    smsPaidLinePurchaseAuthorizedAt: admin.firestore.FieldValue.delete(),
    smsPaidLinePurchaseExpiresAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/** Firestore fields to clear after releasing the studio line. */
function tenantSmsClearedFields() {
  return {
    smsPhoneNumber: admin.firestore.FieldValue.delete(),
    smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
    smsStatus: "off",
    smsEnabled: false,
    smsEnabledAt: admin.firestore.FieldValue.delete(),
    smsProvisionError: admin.firestore.FieldValue.delete(),
    smsSuspendedAt: admin.firestore.FieldValue.delete(),
    smsSuspendReason: admin.firestore.FieldValue.delete(),
    smsLineIsPaidExtra: admin.firestore.FieldValue.delete(),
    smsLastSoloReplacementInvoiceId: admin.firestore.FieldValue.delete(),
    smsLastSoloReplacementAt: admin.firestore.FieldValue.delete(),
    smsSoloReplacementAuthorizationId: admin.firestore.FieldValue.delete(),
    smsSoloReplacementAuthorizationInvoiceId: admin.firestore.FieldValue.delete(),
    smsSoloReplacementAuthorizationState: admin.firestore.FieldValue.delete(),
    smsSoloReplacementAuthorizationExpiresAt: admin.firestore.FieldValue.delete(),
    smsSoloReplacementInFlightAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
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
async function provisionTenantSms(tenantId, tenant, opts) {
  const master = getMasterTwilioClient();
  const messagingServiceSid = getMasterMessagingServiceSid();
  const areaCode = pickAreaCode(tenant);
  const webhook = inboundWebhookUrl();

  let numberResource = await ensureMasterIncomingNumber(master, tenant, webhook);
  let boughtNew = false;
  if (!numberResource) {
    numberResource = await buyMasterLocalNumber(master, areaCode);
    boughtNew = true;
    if (webhook) {
      await master.incomingPhoneNumbers(numberResource.sid).update({
        smsUrl: webhook,
        smsMethod: "POST",
      });
    }
  }

  await attachNumberToMasterMessagingService(master, messagingServiceSid, numberResource.sid);

  const e164 = numberResource.phoneNumber;
  const patch = {
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
  };
  if (boughtNew) {
    patch.smsLifetimeNumbersBought = admin.firestore.FieldValue.increment(1);
  }
  if (opts && opts.isPaidExtra === true) {
    patch.smsLineIsPaidExtra = true;
  } else if (opts && opts.isPaidExtra === false) {
    patch.smsLineIsPaidExtra = false;
  }
  await getDb().collection("tenants").doc(tenantId).set(patch, { merge: true });

  return { phoneNumber: e164, messagingServiceSid, boughtNew };
}

function memberPayoutMode(memberData) {
  const raw = memberData && memberData.memberSettings;
  const d = raw && typeof raw === "object" ? raw : {};
  const mode = (d.payoutMode || "independent").toString().trim().toLowerCase();
  if (mode === "shop_split" || mode === "studio_payroll") return "shop_split";
  return "independent";
}

/** Personal Stripe / SMS: any non-legacy-blocked mode (everyone uses own Connect now). */
function memberUsesOwnConnect(memberData) {
  const mode = memberPayoutMode(memberData);
  return mode === "independent" || mode === "shop_split";
}

function tenantStudioSmsActive(tenant) {
  return (
    tenant &&
    tenant.smsEnabled === true &&
    (tenant.smsStatus || "").toString() === "active" &&
    !!(tenant.smsPhoneNumber || "").toString().trim()
  );
}

/** `active` or `pending` occupies a line slot (counts toward free + paid capacity). */
function countsAsOccupiedSmsLine(smsStatus) {
  const s = (smsStatus || "off").toString().trim().toLowerCase();
  return s === "active" || s === "pending";
}

/**
 * True when this record holds (or is setting up) a Twilio inventory slot.
 * Includes phone/SID leftovers so UI and billing never under-count vs Twilio.
 */
function occupiesSmsLineSlot(record) {
  if (!record || typeof record !== "object") return false;
  if (countsAsOccupiedSmsLine(record.smsStatus)) return true;
  const phone = (record.smsPhoneNumber || "").toString().trim();
  const sid = (record.smsPhoneNumberSid || "").toString().trim();
  return !!(phone || sid);
}

/** True when this occupied line was acquired as a paid Extra SMS seat. */
function isPaidSmsLineExtra(record) {
  return !!(record && record.smsLineIsPaidExtra === true);
}

/**
 * Count occupied lines tagged as paid extras (studio + personal except owner).
 */
function countPaidSmsLinesFromDocs(tenant, userDocs) {
  let n = 0;
  if (occupiesSmsLineSlot(tenant) && isPaidSmsLineExtra(tenant)) n += 1;
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  for (const doc of userDocs || []) {
    if (ownerUid && doc.id === ownerUid) continue;
    const d = typeof doc.data === "function" ? doc.data() || {} : doc || {};
    if (occupiesSmsLineSlot(d) && isPaidSmsLineExtra(d)) n += 1;
  }
  return n;
}

async function countPaidSmsLines(tenantId, tenant) {
  const snap = await getDb().collection("users").where("tenantId", "==", tenantId).get();
  return countPaidSmsLinesFromDocs(tenant, snap.docs);
}

/**
 * Canonical SMS line free allotments: Solo/Charter 1 · Studio/Shop 2.
 * Plan slug should already be normalized (solo|studio|shop|charter).
 */
function freeIncludedSmsLinesForPlan(planNorm) {
  const p = (planNorm || "solo").toString().trim().toLowerCase();
  if (p === "studio" || p === "shop") return 2;
  return 1;
}

/**
 * Lifetime free Twilio numbers per account: Solo 1 · Studio/Shop 2.
 * Same as free included — no separate visible counter; used to gate refresh.
 */
function lifetimeFreeSmsNumbersForPlan(planNorm) {
  return freeIncludedSmsLinesForPlan(planNorm);
}

function smsLifetimeNumbersBought(tenant) {
  const n = Number(tenant && tenant.smsLifetimeNumbersBought);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Effective lifetime buys. Backfills from current occupied lines so accounts
 * that already have numbers don't get unlimited free refreshes.
 */
function resolveLifetimeNumbersBought(tenant, occupiedCount) {
  const stored = smsLifetimeNumbersBought(tenant);
  const occupied = Math.max(0, Math.floor(Number(occupiedCount) || 0));
  return Math.max(stored, occupied);
}

function smsRefreshNeedsPurchase(tenant, planNorm, occupiedCount) {
  const free = lifetimeFreeSmsNumbersForPlan(planNorm);
  const lifetime = resolveLifetimeNumbersBought(tenant, occupiedCount);
  return lifetime >= free;
}

/** Hard caps match seat limits: Solo/Charter 1 · Studio 5 · Shop 10. */
function maxSmsLinesForPlan(planNorm) {
  const p = (planNorm || "solo").toString().trim().toLowerCase();
  if (p === "solo" || p === "charter") return 1;
  if (p === "studio") return 5;
  if (p === "shop") return 10;
  return 1;
}

function smsExtraPaidQuantity(tenant) {
  const n = Number(tenant && tenant.smsExtraLineQuantity);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function smsLineCapacity(tenant, planNorm) {
  const free = freeIncludedSmsLinesForPlan(planNorm);
  const max = maxSmsLinesForPlan(planNorm);
  const paid = smsExtraPaidQuantity(tenant);
  return Math.min(max, free + paid);
}

/**
 * Studio line (tenant) + personal member lines (users except owner).
 * `userDocs` may be Firestore QueryDocumentSnapshots (or { id, data() }).
 * Counts status + any leftover Twilio phone/SID so free slots cannot be
 * overstated when a failed/orphaned line still holds inventory.
 */
function countOccupiedSmsLinesFromDocs(tenant, userDocs) {
  let n = 0;
  if (occupiesSmsLineSlot(tenant)) n += 1;
  const ownerUid = ((tenant && tenant.ownerUid) || "").toString().trim();
  const docs = userDocs || [];
  for (const doc of docs) {
    if (ownerUid && doc.id === ownerUid) continue;
    const d = typeof doc.data === "function" ? doc.data() || {} : doc || {};
    if (occupiesSmsLineSlot(d)) n += 1;
  }
  return n;
}

async function countOccupiedSmsLines(tenantId, tenant) {
  const snap = await getDb().collection("users").where("tenantId", "==", tenantId).get();
  return countOccupiedSmsLinesFromDocs(tenant, snap.docs);
}

/**
 * Snapshot for API / UI.
 *
 * Concurrent free seats: Solo 1 · Studio/Shop 2.
 * Lifetime free gets: same counts — after lifetime free are used, the next
 * new number costs $12 even if a free concurrent seat was freed by a delete.
 */
function buildSmsLineSummary(tenant, planNorm, lineCount) {
  const plan = (planNorm || "solo").toString().trim().toLowerCase() || "solo";
  const freeIncluded = freeIncludedSmsLinesForPlan(plan);
  const maxLines = maxSmsLinesForPlan(plan);
  const paidExtras = smsExtraPaidQuantity(tenant);
  const capacity = smsLineCapacity(tenant, plan);
  const used = Math.max(0, Number(lineCount) || 0);
  const lifetime = resolveLifetimeNumbersBought(tenant, used);
  const freeRemaining = Math.max(0, freeIncluded - used);
  const overage = Math.max(0, used - freeIncluded);
  const paidNeededForNextLine = Math.max(0, used + 1 - freeIncluded);
  const unusedPaidCapacity = Math.max(0, paidExtras - overage);
  const slotsRemaining = Math.max(0, capacity - used);
  const atMax = used >= maxLines;
  // Free only while under concurrent free AND lifetime free allotment remains.
  const nextIsFree = !atMax && used < freeIncluded && lifetime < freeIncluded;
  const needsPurchaseForNext = !atMax && !nextIsFree;
  const canAddWithoutPurchase = nextIsFree;
  const canProvisionNext = canAddWithoutPurchase;
  const nextUsesPaidCapacity = false;
  // Studio/Shop: recurring Extra SMS seats. Solo/Charter: one-time $12 replacement only (max 1).
  const canPurchaseExtra = plan !== "solo" && plan !== "charter" && !atMax;
  const canPurchaseSoloReplacement =
    (plan === "solo" || plan === "charter") && needsPurchaseForNext;
  return {
    plan,
    freeIncluded,
    maxLines,
    paidExtras,
    capacity,
    used,
    lifetimeNumbersBought: lifetime,
    freeRemaining,
    overage,
    paidNeededForNextLine,
    unusedPaidCapacity,
    slotsRemaining,
    atMax,
    nextIsFree,
    nextUsesPaidCapacity,
    needsPurchaseForNext,
    canAddWithoutPurchase,
    canProvisionNext,
    canPurchaseExtra,
    canPurchaseSoloReplacement,
    extraMonthlyPriceCents: 1200,
    extraMonthlyPriceLabel: "$12/mo",
    extraOneTimeReplacementCents: 1200,
    extraOneTimeReplacementLabel: "$12",
  };
}

/** Paid extras that should be on the sub = currently active paid-tagged lines. */
function smsExtraNeededForUsage(planNorm, lineCount) {
  const free = freeIncludedSmsLinesForPlan(planNorm);
  const used = Math.max(0, Number(lineCount) || 0);
  return Math.max(0, used - free);
}

/**
 * Block provisioning a brand-new line when over free allotment without paid capacity.
 * Returns null if allowed, else a human-readable error.
 */
function newSmsLineBlockReason(tenant, planNorm, lineCount) {
  const summary = buildSmsLineSummary(tenant, planNorm, lineCount);
  if (summary.atMax) {
    if (summary.plan === "solo" || summary.plan === "charter") {
      return summary.plan === "charter"
        ? "Charter includes 1 texting number."
        : "Solo includes 1 texting number.";
    }
    return (
      `Your ${summary.plan} plan allows up to ${summary.maxLines} texting numbers. ` +
      "Remove a line or upgrade your plan for more seats."
    );
  }
  if (!summary.canProvisionNext) {
    if (summary.plan === "solo" || summary.plan === "charter") {
      return (
        "You've used your included texting number. " +
        "Getting another costs a $12 fee (not monthly)."
      );
    }
    return (
      "You've used your included texting numbers. " +
      "Add another number for $12/mo under Account → Plan & billing on getbookking.com."
    );
  }
  return null;
}

async function getSmsLineSummaryForTenant(tenantId, tenant, planNorm) {
  const used = await countOccupiedSmsLines(tenantId, tenant);
  return buildSmsLineSummary(tenant, planNorm, used);
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
  if (!memberUsesOwnConnect(memberData)) {
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
async function provisionMemberSms(tenantId, tenant, memberUid, memberData, opts) {
  const studioBlock = tenantSmsMustBeActiveForMemberLine(tenant);
  if (studioBlock) {
    throw new Error(studioBlock);
  }
  if (!memberUsesOwnConnect(memberData)) {
    throw new Error("Personal texting lines are for independent team members.");
  }
  const master = getMasterTwilioClient();
  const messagingServiceSid = getMasterMessagingServiceSid();
  const areaCode = pickAreaCode(tenant);
  const webhook = inboundWebhookUrl();

  let numberResource = await ensureMemberIncomingNumber(master, memberData, webhook);
  let boughtNew = false;
  if (!numberResource) {
    numberResource = await buyMasterLocalNumber(master, areaCode);
    boughtNew = true;
    if (webhook) {
      await master.incomingPhoneNumbers(numberResource.sid).update({
        smsUrl: webhook,
        smsMethod: "POST",
      });
    }
  }

  await attachNumberToMasterMessagingService(master, messagingServiceSid, numberResource.sid);

  const e164 = numberResource.phoneNumber;
  const memberPatch = {
    smsPhoneNumber: e164,
    smsPhoneNumberSid: numberResource.sid,
    smsStatus: "active",
    smsEnabled: true,
    smsEnabledAt: admin.firestore.FieldValue.serverTimestamp(),
    smsProvisionError: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (opts && opts.isPaidExtra === true) {
    memberPatch.smsLineIsPaidExtra = true;
  } else {
    memberPatch.smsLineIsPaidExtra = false;
  }
  await getDb().collection("users").doc(memberUid).set(memberPatch, { merge: true });
  if (boughtNew) {
    await getDb().collection("tenants").doc(tenantId).set(
      {
        smsLifetimeNumbersBought: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return { phoneNumber: e164, messagingServiceSid, boughtNew };
}

function resolveOutboundSmsRoute({
  tenant,
  senderUid,
  senderUserData,
  isOwner,
  accessRole,
  managerPermissions,
  threadData,
}) {
  const threadScope = ((threadData && threadData.smsLineScope) || "")
    .toString()
    .trim()
    .toLowerCase();
  const threadMemberUid = ((threadData && threadData.assignedMemberUid) || "")
    .toString()
    .trim();
  // Replies stay on the line that owns the thread (number that was texted).
  if (threadScope === "member" || threadMemberUid) {
    if (
      memberUsesOwnConnect(senderUserData) &&
      senderUserData &&
      senderUserData.smsStatus === "active" &&
      (senderUserData.smsPhoneNumber || "").toString().trim() &&
      senderUid === threadMemberUid
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
  if (isOwner || accessRole === "manager") {
    return {
      lineType: "tenant",
      from: (tenant.smsPhoneNumber || "").toString().trim(),
      phoneSid: (tenant.smsPhoneNumberSid || "").toString().trim(),
      memberUid: null,
    };
  }
  if (
    memberUsesOwnConnect(senderUserData) &&
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
    memberUsesOwnConnect(senderUserData) &&
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
    threadData: meta && meta.threadData,
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
  if (!(await phoneHasSmsConsent(tenantId, toE164))) {
    throw new Error(
      "Recipient has not opted into appointment-related text messages."
    );
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

  await consumeSmsMonthlySlot(tenantId, {
    memberUid: route.lineType === "member" ? route.memberUid : null,
  });
  const messagingServiceSid = getMasterMessagingServiceSid();
  const mediaUrls = normalizeOutboundMediaUrls(meta && meta.mediaUrls);
  const createOpts = {
    to: toE164,
    messagingServiceSid,
    from: route.from,
  };
  const trimmedBody = (body || "").toString();
  if (trimmedBody) {
    createOpts.body = trimmedBody.slice(0, 1600);
  } else if (mediaUrls.length) {
    createOpts.body = "";
  } else {
    createOpts.body = "";
  }
  if (mediaUrls.length) {
    createOpts.mediaUrl = mediaUrls;
  }
  const msg = await master.messages.create(createOpts);

  const threadId =
    (meta && meta.threadId) ||
    lineScopedThreadId({
      linePhone: route.from,
      clientPhone: toE164,
      lineScope: route.lineType,
      memberUid: route.memberUid,
    });
  const logRef = getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .doc(msg.sid);
  const paymentMeta = paymentFieldsFromMeta(meta);
  const threadPreview = ((meta && meta.threadPreview) || "").toString().trim();
  const previewBody =
    threadPreview ||
    trimmedBody ||
    (mediaUrls.length ? "Photo" : "");
  const logPayload = {
    direction: "outbound",
    to: toE164,
    from: route.from,
    threadId,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    body: trimmedBody.slice(0, 500),
    status: msg.status,
    bookingRequestId: (meta && meta.bookingRequestId) || null,
    assignedMemberUid: route.memberUid || null,
    smsLineScope: route.lineType === "member" ? "member" : "tenant",
    ...paymentMeta,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (mediaUrls.length) {
    logPayload.mediaUrls = mediaUrls;
  }
  await logRef.set(logPayload);

  await upsertSmsThread(tenantId, threadId, {
    counterpartPhone: toE164,
    linePhone: route.from,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    lastDirection: "outbound",
    lastMessageBody: previewBody.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageStatus: (msg.status || "").toString(),
    assignedMemberUid: route.memberUid || null,
    smsLineScope: route.lineType === "member" ? "member" : "tenant",
  });

  return { msg, threadId, from: route.from, lineType: route.lineType };
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

/** Only allow Firebase Storage HTTPS URLs for outbound MMS. */
function normalizeOutboundMediaUrls(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list.slice(0, 5)) {
    const s = (item || "").toString().trim();
    if (!s || s.length > 2000) continue;
    if (!/^https:\/\//i.test(s)) continue;
    if (
      !/firebasestorage\.googleapis\.com/i.test(s) &&
      !/storage\.googleapis\.com/i.test(s)
    ) {
      continue;
    }
    out.push(s);
  }
  return out;
}

function extensionForContentType(contentType) {
  const ct = (contentType || "").toString().toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  return "jpg";
}

/**
 * Download Twilio inbound media and store under tenants/{id}/smsMedia for lasting URLs.
 */
async function persistInboundTwilioMedia(tenantId, params) {
  const numMedia = Number((params && params.NumMedia) || 0);
  if (!tenantId || !Number.isFinite(numMedia) || numMedia <= 0) return [];
  const accountSid = (twilioAccountSid.value() || "").toString().trim();
  const authToken = (twilioAuthToken.value() || "").toString().trim();
  if (!accountSid || !authToken) return [];

  const bucket = admin.storage().bucket();
  const authHeader =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const out = [];
  const limit = Math.min(Math.floor(numMedia), 5);
  for (let i = 0; i < limit; i += 1) {
    const mediaUrl = ((params && params[`MediaUrl${i}`]) || "").toString().trim();
    const contentType = ((params && params[`MediaContentType${i}`]) || "image/jpeg")
      .toString()
      .trim()
      .toLowerCase();
    if (!mediaUrl) continue;
    if (!contentType.startsWith("image/")) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(mediaUrl, {
        headers: { Authorization: authHeader },
        redirect: "follow",
      });
      if (!res.ok) {
        console.warn("persistInboundTwilioMedia fetch", res.status, mediaUrl);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 5 * 1024 * 1024) continue;
      const ext = extensionForContentType(contentType);
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const path = `tenants/${tenantId}/smsMedia/${Date.now()}_${i}.${ext}`;
      const file = bucket.file(path);
      // eslint-disable-next-line no-await-in-loop
      await file.save(buf, {
        resumable: false,
        metadata: {
          contentType: contentType.startsWith("image/") ? contentType : "image/jpeg",
          metadata: {
            firebaseStorageDownloadTokens: token,
          },
        },
      });
      const encoded = encodeURIComponent(path);
      out.push(
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`
      );
    } catch (e) {
      console.warn("persistInboundTwilioMedia", e && e.message ? e.message : e);
    }
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
  if (!(await phoneHasSmsConsent(tenantId, toE164))) {
    throw new Error(
      "Recipient has not opted into appointment-related text messages."
    );
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
  await consumeSmsMonthlySlot(tenantId, { memberUid: null });

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
    assignedMemberUid: null,
    smsLineScope: "tenant",
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
    linePhone: from,
    clientName: ((meta && meta.clientName) || "").toString().slice(0, 120),
    lastDirection: "outbound",
    lastMessageBody: body.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageStatus: (msg.status || "").toString(),
    assignedMemberUid: null,
    smsLineScope: "tenant",
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
  const assignedMemberUid = (inbound && inbound.assignedMemberUid) || null;
  const smsLineScope = (inbound && inbound.smsLineScope) || "tenant";
  const mediaUrls = Array.isArray(inbound && inbound.mediaUrls)
    ? inbound.mediaUrls
        .map((u) => (u || "").toString().trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const threadId =
    (inbound && inbound.threadId) ||
    lineScopedThreadId({
      linePhone: to,
      clientPhone: from,
      lineScope: smsLineScope,
      memberUid: assignedMemberUid,
    });
  if (!tenantId || !from || !to) return false;
  if (!body && !mediaUrls.length) return false;

  try {
    await consumeSmsMonthlySlot(tenantId, {
      memberUid: smsLineScope === "member" ? assignedMemberUid : null,
    });
  } catch (e) {
    if (String(e.message || e).includes("Monthly SMS limit")) {
      console.warn("recordInboundTenantSms: monthly cap", tenantId);
      return false;
    }
    throw e;
  }

  const previewBody = body || (mediaUrls.length ? "Photo" : "");
  const logPayload = {
    direction: "inbound",
    from,
    to,
    threadId,
    body: body.slice(0, 500),
    assignedMemberUid,
    smsLineScope,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (mediaUrls.length) {
    logPayload.mediaUrls = mediaUrls;
  }
  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .add(logPayload);
  await upsertSmsThread(tenantId, threadId, {
    counterpartPhone: from,
    linePhone: to,
    clientName: ((inbound && inbound.clientName) || "").toString().slice(0, 120),
    lastDirection: "inbound",
    lastMessageBody: previewBody.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    assignedMemberUid,
    smsLineScope,
  });

  // Fire-and-forget APNs/FCM so Twilio webhook stays fast.
  notifyInboundClientSms(tenantId, {
    threadId,
    counterpartPhone: from,
    bodyPreview: previewBody,
    clientName: ((inbound && inbound.clientName) || "").toString(),
    assignedMemberUid,
    smsLineScope,
  }).catch((e) => {
    console.warn(
      "notifyInboundClientSms",
      tenantId,
      e && e.message ? e.message : e
    );
  });

  return true;
}

/**
 * Push inbound client texts to the right team devices (studio inbox vs personal line).
 * Banner layout matches Messages: name on the first line, message text below.
 */
async function notifyInboundClientSms(tenantId, opts) {
  const threadId = ((opts && opts.threadId) || "").toString().trim();
  const counterpartPhone = ((opts && opts.counterpartPhone) || "").toString().trim();
  const bodyPreview = ((opts && opts.bodyPreview) || "").toString().trim();
  const assignedMemberUid = ((opts && opts.assignedMemberUid) || "").toString().trim();
  const smsLineScope = ((opts && opts.smsLineScope) || "tenant").toString().trim();
  if (!tenantId || !threadId) return;

  let displayName = ((opts && opts.clientName) || "").toString().trim();

  // Prefer the thread's stored name (kept in sync when a client is saved).
  if (!displayName) {
    try {
      const threadSnap = await getDb()
        .collection("tenants")
        .doc(tenantId)
        .collection("smsThreads")
        .doc(threadId)
        .get();
      if (threadSnap.exists) {
        displayName = ((threadSnap.data() || {}).clientName || "").toString().trim();
      }
    } catch (_) {
      /* optional */
    }
  }

  if (!displayName || looksLikePhoneLabel(displayName)) {
    const last10 = phoneLast10(counterpartPhone);
    if (last10) {
      try {
        const custSnap = await getDb()
          .collection("tenants")
          .doc(tenantId)
          .collection("customers")
          .doc(last10)
          .get();
        if (custSnap.exists) {
          const customerName = ((custSnap.data() || {}).name || "").toString().trim();
          if (customerName) displayName = customerName;
        }
      } catch (_) {
        /* optional */
      }
    }
  }

  if (!displayName || looksLikePhoneLabel(displayName)) {
    displayName = formatPhoneForPush(counterpartPhone) || "New message";
  }

  // iMessage-style: title = name, body = message (renders as name↵text).
  const alertTitle = displayName.slice(0, 100);
  const alertBody = (bodyPreview || "Photo").slice(0, 200);

  let recipientUids = [];
  if (smsLineScope === "member" && assignedMemberUid) {
    recipientUids = [assignedMemberUid];
  } else {
    const tenantSnap = await getDb().collection("tenants").doc(tenantId).get();
    const ownerUid = ((tenantSnap.data() || {}).ownerUid || "").toString().trim();
    const usersSnap = await getDb()
      .collection("users")
      .where("tenantId", "==", tenantId)
      .get();
    for (const userDoc of usersSnap.docs) {
      const d = userDoc.data() || {};
      const role = ((d.accessRole || d.role || "") + "").toString().toLowerCase();
      if (userDoc.id === ownerUid || role === "owner" || role === "manager") {
        recipientUids.push(userDoc.id);
      }
    }
    if (ownerUid && !recipientUids.includes(ownerUid)) {
      recipientUids.push(ownerUid);
    }
  }
  recipientUids = [...new Set(recipientUids.filter(Boolean))];
  if (!recipientUids.length) return;

  const tokens = [];
  for (const uid of recipientUids) {
    // eslint-disable-next-line no-await-in-loop
    const tokSnap = await getDb()
      .collection("users")
      .doc(uid)
      .collection("deviceTokens")
      .get();
    tokSnap.forEach((t) => {
      const token = (t.data() || {}).token;
      if (token && typeof token === "string") tokens.push(token);
    });
  }
  const unique = [...new Set(tokens)];
  if (!unique.length) return;

  const chunkSize = 500;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    try {
      // eslint-disable-next-line no-await-in-loop
      await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: alertTitle,
          body: alertBody,
        },
        data: {
          type: "sms_message",
          tenantId: String(tenantId),
          threadId: String(threadId),
        },
        apns: {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: {
                title: alertTitle,
                body: alertBody,
              },
              sound: "default",
            },
          },
        },
      });
    } catch (e) {
      console.error("notifyInboundClientSms FCM error", e);
    }
  }
}

function looksLikePhoneLabel(raw) {
  const digits = (raw || "").toString().replace(/\D/g, "");
  return digits.length >= 10;
}

function formatPhoneForPush(phone) {
  const last10 = phoneLast10(phone);
  if (last10.length === 10) {
    return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`;
  }
  return (phone || "").toString().trim();
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

function phoneLast10(phone) {
  const digits = (phone || "").toString().replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return "";
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlMessage(body) {
  return `<Response><Message>${escapeXml(body)}</Message></Response>`;
}

function isInboundConsentAffirmation(bodyUpper) {
  const b = (bodyUpper || "").toString().trim().toUpperCase();
  return b === "YES" || b === "Y" || b === "START";
}

function inboundConsentPromptBody(businessName) {
  const biz = (businessName || "us").toString().trim() || "us";
  return (
    `Thanks for texting ${biz}. Reply YES to get appointment updates by text. ` +
    `Msg & data rates may apply. Reply STOP to opt out.`
  );
}

/** After STOP: prompt on next inbound so they can re-confirm consent. */
function inboundResubscribePromptBody(businessName) {
  const biz = (businessName || "us").toString().trim() || "us";
  return (
    `You're unsubscribed from ${biz} appointment texts. ` +
    `Reply YES or START to opt back in. Msg & data rates may apply. Reply STOP to opt out.`
  );
}

function inboundConsentConfirmedBody() {
  return "You're opted in to appointment-related texts. Reply STOP to opt out.";
}

/** Allow a fresh consent / re-subscribe prompt after STOP. */
async function clearSmsConsentPromptSent(tenantId, phone, opts) {
  const linePhone = opts && opts.linePhone;
  const lineScope = (opts && opts.lineScope) || "tenant";
  const memberUid = (opts && opts.memberUid) || null;
  const threadId = lineScopedThreadId({
    linePhone: linePhone || "",
    clientPhone: phone,
    lineScope,
    memberUid,
  });
  // Also clear legacy phone-only thread gate.
  const legacyId = threadIdFromPhone(phone);
  const ids = [threadId, legacyId].filter(Boolean);
  await Promise.all(
    ids.map((id) =>
      getDb()
        .collection("tenants")
        .doc(tenantId)
        .collection("smsThreads")
        .doc(id)
        .set(
          {
            smsConsentPromptSentAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
        .catch(() => {})
    )
  );
}

async function isPhoneOptedOut(tenantId, phone) {
  const e164 = toE164US(phone) || (phone || "").toString().trim();
  if (!tenantId || !e164) return false;
  const optId = e164.replace(/\W/g, "_");
  const snap = await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsOptOuts")
    .doc(optId)
    .get();
  return snap.exists;
}

async function clearPhoneOptOut(tenantId, phone) {
  const e164 = toE164US(phone) || (phone || "").toString().trim();
  if (!tenantId || !e164) return;
  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsOptOuts")
    .doc(e164.replace(/\W/g, "_"))
    .delete()
    .catch(() => {});
}

/**
 * True only when the customer record contains an affirmative opt-in and
 * server-recorded evidence of when and how consent was obtained.
 */
async function phoneHasSmsConsent(tenantId, phone) {
  const last10 = phoneLast10(phone);
  if (!tenantId || !last10) return false;

  const customerSnap = await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("customers")
    .doc(last10)
    .get();
  if (!customerSnap.exists) return false;
  const customer = customerSnap.data() || {};
  return customer.smsOptedIn === true
    && !!customer.smsConsentAt
    && ["web_booking", "inbound_sms"].includes(
      (customer.smsConsentSource || "").toString()
    );
}

async function grantInboundSmsConsent(tenantId, phone) {
  const last10 = phoneLast10(phone);
  const e164 = toE164US(phone) || (phone || "").toString().trim();
  if (!tenantId || !last10 || !e164) return false;

  await clearPhoneOptOut(tenantId, e164);

  const ref = getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("customers")
    .doc(last10);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() || {} : {};
  const keepWebSource = (existing.smsConsentSource || "").toString() === "web_booking";

  await ref.set(
    {
      name: (existing.name || "Customer").toString().slice(0, 120),
      email: (existing.email || "").toString(),
      phone: e164,
      smsOptedIn: true,
      smsConsentAt: admin.firestore.FieldValue.serverTimestamp(),
      smsConsentSource: keepWebSource ? "web_booking" : "inbound_sms",
      source: existing.source || "inbound_sms",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
    },
    { merge: true }
  );
  return true;
}

/**
 * Log a system TwiML outbound (consent prompt / confirmation) into smsLog + thread.
 * Consumes one monthly slot. Returns false if cap reached.
 */
async function recordSystemOutboundSms(tenantId, { from, to, body, threadId, assignedMemberUid, smsLineScope }) {
  if (!tenantId || !from || !to || !body) return false;
  try {
    await consumeSmsMonthlySlot(tenantId, {
      memberUid: smsLineScope === "member" ? assignedMemberUid : null,
    });
  } catch (e) {
    if (String(e.message || e).includes("Monthly SMS limit")) {
      console.warn("recordSystemOutboundSms: monthly cap", tenantId);
      return false;
    }
    throw e;
  }

  const tid = threadId || threadIdFromPhone(to);
  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsLog")
    .add({
      direction: "outbound",
      from,
      to,
      threadId: tid,
      body: body.slice(0, 500),
      status: "sent",
      systemKind: "inbound_consent",
      assignedMemberUid: assignedMemberUid || null,
      smsLineScope: smsLineScope || "tenant",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  await upsertSmsThread(tenantId, tid, {
    counterpartPhone: to,
    linePhone: from,
    lastDirection: "outbound",
    lastMessageBody: body.slice(0, 500),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageStatus: "sent",
    assignedMemberUid: assignedMemberUid || null,
    smsLineScope: smsLineScope || "tenant",
  });
  return true;
}

/**
 * If the sender has no SMS consent yet (or previously opted out), send a
 * one-time YES/START opt-in prompt. Returns TwiML or null.
 * After STOP, clearSmsConsentPromptSent resets the gate so the next inbound
 * can get a fresh re-subscribe prompt.
 */
async function maybeSendInboundConsentPrompt(tenantId, {
  from,
  to,
  businessName,
  assignedMemberUid,
  smsLineScope,
}) {
  if (!tenantId || !from || !to) return null;
  const optedOut = await isPhoneOptedOut(tenantId, from);
  if (!optedOut && (await phoneHasSmsConsent(tenantId, from))) return null;

  const threadId = lineScopedThreadId({
    linePhone: to,
    clientPhone: from,
    lineScope: smsLineScope || "tenant",
    memberUid: assignedMemberUid,
  });
  const threadRef = getDb()
    .collection("tenants")
    .doc(tenantId)
    .collection("smsThreads")
    .doc(threadId);
  const threadSnap = await threadRef.get();
  const threadData = threadSnap.exists ? threadSnap.data() || {} : {};
  if (threadData.smsConsentPromptSentAt) return null;
  // Legacy gate: don't re-prompt if old phone-only thread already prompted.
  const legacyId = threadIdFromPhone(from);
  if (legacyId && legacyId !== threadId) {
    const legacySnap = await getDb()
      .collection("tenants")
      .doc(tenantId)
      .collection("smsThreads")
      .doc(legacyId)
      .get();
    if (legacySnap.exists && legacySnap.data().smsConsentPromptSentAt) {
      return null;
    }
  }

  const prompt = optedOut
    ? inboundResubscribePromptBody(businessName)
    : inboundConsentPromptBody(businessName);
  const logged = await recordSystemOutboundSms(tenantId, {
    from: to,
    to: from,
    body: prompt,
    threadId,
    assignedMemberUid,
    smsLineScope,
  });
  if (!logged) return null;

  await threadRef.set(
    {
      threadId,
      counterpartPhone: from,
      linePhone: to,
      smsConsentPromptSentAt: admin.firestore.FieldValue.serverTimestamp(),
      assignedMemberUid: assignedMemberUid || null,
      smsLineScope: smsLineScope || "tenant",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return twimlMessage(prompt);
}

module.exports = {
  twilioAccountSid,
  twilioAuthToken,
  masterTwilioMessagingServiceSid,
  toE164US,
  isSubscriptionPaymentGateBypassed,
  tenantHasPaidSubscription,
  tenantIsTrialing,
  tenantCanUseSms,
  paidSubscriptionBlockReason,
  smsEligibilityBlockReason,
  resolveSubscriptionStatus,
  provisionTenantSms,
  provisionMemberSms,
  releaseMemberSms,
  releaseTenantSms,
  releaseTwilioPhoneSid,
  twilioIncomingNumberExists,
  reconcileStaleSmsLinesInFirestore,
  personalSmsClearedFields,
  tenantSmsClearedFields,
  sendTenantSms,
  sendOutboundClientSms,
  recordInboundTenantSms,
  persistInboundTwilioMedia,
  normalizeOutboundMediaUrls,
  notifyInboundClientSms,
  grantInboundSmsConsent,
  maybeSendInboundConsentPrompt,
  isInboundConsentAffirmation,
  inboundConsentPromptBody,
  inboundResubscribePromptBody,
  inboundConsentConfirmedBody,
  clearSmsConsentPromptSent,
  recordSystemOutboundSms,
  twimlMessage,
  phoneHasSmsConsent,
  clearPhoneOptOut,
  memberPersonalSmsBlockReason,
  memberPayoutMode,
  memberUsesOwnConnect,
  tenantStudioSmsActive,
  countsAsOccupiedSmsLine,
  occupiesSmsLineSlot,
  isPaidSmsLineExtra,
  countPaidSmsLinesFromDocs,
  countPaidSmsLines,
  freeIncludedSmsLinesForPlan,
  lifetimeFreeSmsNumbersForPlan,
  smsLifetimeNumbersBought,
  resolveLifetimeNumbersBought,
  smsRefreshNeedsPurchase,
  maxSmsLinesForPlan,
  smsExtraPaidQuantity,
  smsLineCapacity,
  countOccupiedSmsLines,
  countOccupiedSmsLinesFromDocs,
  buildSmsLineSummary,
  smsExtraNeededForUsage,
  newSmsLineBlockReason,
  getSmsLineSummaryForTenant,
  resolveOutboundSmsRoute,
  canSendClientSms,
  suspendTenantSms,
  syncSubscriptionStatusForTenant,
  extractCustomerPhone,
  inboundWebhookUrl,
  threadIdFromPhone,
  lineScopedThreadId,
  isLineScopedThreadId,
  clientPhoneFromThreadId,
  isStudioSmsThread,
  MAX_TENANT_SMS_PER_MONTH,
  MAX_SMS_PER_LINE_PER_MONTH,
  SMS_MONTHLY_LIMIT_MESSAGE,
  smsMonthlyUsageForTenant,
  smsMonthlyUsageForMember,
  smsMonthlyUsageFromDoc,
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
  PAID_FEATURE_UPGRADE_MESSAGE,
};
