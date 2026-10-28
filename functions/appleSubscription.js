/**
 * App Store subscription record.
 * The signed transaction is the only source of plan, trial, and expiry.
 * Client-supplied product ids and dates are ignored.
 *
 * App Store Server Notifications V2:
 *   https://us-central1-test-app-96812.cloudfunctions.net/appStoreServerNotification
 * Set that URL in App Store Connect → App Information → App Store Server Notifications,
 * Version 2, for both Production and Sandbox.
 *
 * Local StoreKit configuration files are signed as the Xcode environment, which Apple
 * does not sign. Those receipts are rejected unless APPLE_ACCEPT_XCODE_RECEIPTS=true.
 * Leave that unset on the deployed functions. Sandbox and App Review receipts verify.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");
const {
  SignedDataVerifier,
  Environment,
  OfferType,
  Status,
  NotificationTypeV2,
} = require("@apple/app-store-server-library");

const BUNDLE_ID = "com.jilianking.getbooking";
const APP_APPLE_ID = 6785088401;

const APPLE_SUBSCRIPTION_PRODUCTS = {
  "com.jilianking.getbooking.solo": "solo",
  "com.jilianking.getbooking.studio": "studio",
  "com.jilianking.getbooking.shop": "shop",
  "com.jilianking.getbooking.charter": "charter",
  "com.jilianking.getbooking.solo.now": "solo",
  "com.jilianking.getbooking.studio.now": "studio",
  "com.jilianking.getbooking.shop.now": "shop",
  "com.jilianking.getbooking.charter.now": "charter",
};

/** One-time App Store purchase that pays for an extra or replacement texting number. */
const SMS_EXTRA_PRODUCT_ID = "com.jilianking.getbooking.sms.extra";
const SMS_EXTRA_PURCHASES = "appleSmsExtraPurchases";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function db() {
  return admin.firestore();
}

function loadRootCertificates() {
  const dir = path.join(__dirname, "certs");
  return ["AppleRootCA-G3.cer", "AppleRootCA-G2.cer"].map((name) =>
    fs.readFileSync(path.join(dir, name))
  );
}

let verifiers;

function signedDataVerifiers() {
  if (verifiers) return verifiers;
  const roots = loadRootCertificates();
  verifiers = [
    new SignedDataVerifier(roots, true, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID),
    new SignedDataVerifier(roots, true, Environment.SANDBOX, BUNDLE_ID),
  ];
  if (process.env.APPLE_ACCEPT_XCODE_RECEIPTS === "true") {
    verifiers.push(new SignedDataVerifier(roots, false, Environment.XCODE, BUNDLE_ID));
  }
  return verifiers;
}

async function verifyWith(method, signed) {
  const payload = (signed || "").toString().trim();
  if (!payload) {
    throw new Error("Missing App Store signature.");
  }
  let lastError;
  for (const verifier of signedDataVerifiers()) {
    try {
      return await verifier[method](payload);
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError && lastError.message ? lastError.message : "verification failed";
  throw new Error(message);
}

function verifySignedTransaction(signedTransaction) {
  return verifyWith("verifyAndDecodeTransaction", signedTransaction);
}

function verifySignedNotification(signedPayload) {
  return verifyWith("verifyAndDecodeNotification", signedPayload);
}

function planForProduct(productId) {
  return APPLE_SUBSCRIPTION_PRODUCTS[(productId || "").toString().trim()] || "";
}

function normalizeAccountToken(value) {
  const token = (value || "").toString().trim().toLowerCase();
  return UUID_RE.test(token) ? token : "";
}

/**
 * active / trialing stay usable. past_due and canceled do not.
 * Grace period stays active. Billing retry does not.
 */
function subscriptionStatusFromApple(transaction, appleStatus) {
  const statusNum = Number(appleStatus);
  if (transaction && transaction.revocationDate) return "canceled";
  if (statusNum === Status.REVOKED || statusNum === Status.EXPIRED) return "canceled";
  if (statusNum === Status.BILLING_RETRY) return "past_due";
  const expires = Number(transaction && transaction.expiresDate) || 0;
  if (expires && expires < Date.now() && statusNum !== Status.BILLING_GRACE_PERIOD) {
    return "canceled";
  }
  if (Number(transaction && transaction.offerType) === OfferType.INTRODUCTORY_OFFER) {
    return "trialing";
  }
  return "active";
}

async function findTenantForTransaction(transaction) {
  const originalId = (transaction.originalTransactionId || "").toString().trim();
  if (originalId) {
    const byOriginal = await db()
      .collection("tenants")
      .where("appleOriginalTransactionId", "==", originalId)
      .limit(1)
      .get();
    if (!byOriginal.empty) return byOriginal.docs[0];
  }
  const token = normalizeAccountToken(transaction.appAccountToken);
  if (token) {
    const byToken = await db()
      .collection("tenants")
      .where("appleAppAccountToken", "==", token)
      .limit(1)
      .get();
    if (!byToken.empty) return byToken.docs[0];
    // The token is saved on the owner's profile before the purchase and only copied to the
    // business once the app's sync call lands. If that call was lost, find the business
    // through the owner so Apple's notification can still record the purchase.
    const byOwner = await db()
      .collection("users")
      .where("appleAppAccountToken", "==", token)
      .limit(1)
      .get();
    if (!byOwner.empty) {
      const ownerUid = byOwner.docs[0].id;
      const tenantId = ((byOwner.docs[0].data() || {}).tenantId || "").toString().trim();
      if (tenantId) {
        const tenantDoc = await db().collection("tenants").doc(tenantId).get();
        if (tenantDoc.exists && (tenantDoc.data() || {}).ownerUid === ownerUid) return tenantDoc;
      }
    }
  }
  return null;
}

/**
 * Writes the verified entitlement onto the tenant.
 * An older signedDate than the one already stored is ignored.
 */
async function applyVerifiedTransaction(tenantId, transaction, signedDate, appleStatus) {
  const plan = planForProduct(transaction.productId);
  if (!plan) {
    const error = new Error("Unknown App Store plan.");
    error.code = "unknown-plan";
    throw error;
  }
  const signedMs = Number(signedDate) || Number(transaction.signedDate) || 0;
  const ref = db().collection("tenants").doc(tenantId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error("Business not found.");
    }
    const current = snap.data() || {};
    const previousMs = Number(current.appleSignedDateMs) || 0;
    if (signedMs && previousMs && signedMs < previousMs) {
      return {
        applied: false,
        subscriptionPlan: current.subscriptionPlan || plan,
        subscriptionStatus: current.subscriptionStatus || "",
      };
    }
    const subscriptionStatus = subscriptionStatusFromApple(transaction, appleStatus);
    // Billing moved to a paid website subscription: an Apple lapse must not lock the business.
    if (
      (current.billingSource || "").toString() === "stripe" &&
      (current.subscriptionStatus || "").toString() === "active" &&
      subscriptionStatus !== "active"
    ) {
      return {
        applied: false,
        subscriptionPlan: current.subscriptionPlan || plan,
        subscriptionStatus: current.subscriptionStatus || "",
      };
    }
    const token = normalizeAccountToken(transaction.appAccountToken);
    const patch = {
      subscriptionPlan: plan,
      subscriptionStatus,
      billingSource: "apple",
      appleOriginalTransactionId: (transaction.originalTransactionId || "").toString(),
      appleProductId: (transaction.productId || "").toString(),
      appleSignedDateMs: signedMs || previousMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (token) patch.appleAppAccountToken = token;
    const expires = Number(transaction.expiresDate) || 0;
    if (expires > 0) {
      patch.appleExpiresAt = admin.firestore.Timestamp.fromMillis(expires);
    }
    tx.set(ref, patch, { merge: true });
    return { applied: true, subscriptionPlan: plan, subscriptionStatus };
  });
}

async function prepareAccountToken(uid) {
  const ref = db().collection("users").doc(uid);
  const snap = await ref.get();
  const existing = normalizeAccountToken(snap.exists && snap.data().appleAppAccountToken);
  if (existing) return existing;
  const token = crypto.randomUUID();
  await ref.set(
    {
      appleAppAccountToken: token,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return token;
}

/**
 * Verifies an App Store texting-number purchase and reserves it for one use.
 * The receipt must be Apple-signed, for the texting-number product, bought by this login,
 * and not already spent. Asking again for the same use returns the same reservation.
 * `purpose` is "member_number" or "tenant_number".
 * Throws an Error whose `code` is "unverified", "wrong-account", "refunded", or "already-used".
 */
async function claimSmsExtraPurchase({ uid, tenantId, signedTransaction, purpose, memberUid }) {
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  let transaction;
  try {
    transaction = await verifySignedTransaction(signedTransaction);
  } catch (error) {
    throw fail("unverified", "The App Store could not verify this purchase.");
  }
  if ((transaction.productId || "").toString() !== SMS_EXTRA_PRODUCT_ID) {
    throw fail("unverified", "This App Store purchase is not for a texting number.");
  }
  if (transaction.revocationDate) {
    throw fail("refunded", "This App Store purchase was refunded.");
  }
  const userSnap = await db().collection("users").doc(uid).get();
  const expectedToken = normalizeAccountToken(userSnap.exists && userSnap.data().appleAppAccountToken);
  const receiptToken = normalizeAccountToken(transaction.appAccountToken);
  if (!expectedToken || receiptToken !== expectedToken) {
    throw fail("wrong-account", "This App Store purchase does not match this account.");
  }
  const transactionId = (transaction.transactionId || "").toString().trim();
  if (!transactionId) {
    throw fail("unverified", "The App Store could not verify this purchase.");
  }
  const target = (memberUid || "").toString();
  const ref = db().collection(SMS_EXTRA_PURCHASES).doc(transactionId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const claim = snap.data() || {};
      const sameUse =
        claim.uid === uid &&
        claim.tenantId === tenantId &&
        claim.purpose === purpose &&
        (claim.memberUid || "") === target &&
        !claim.consumedAt;
      if (!sameUse) {
        throw fail("already-used", "This App Store purchase was already used for a texting number.");
      }
      return { transactionId, alreadyClaimed: true };
    }
    tx.set(ref, {
      transactionId,
      uid,
      tenantId,
      purpose,
      memberUid: target,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { transactionId, alreadyClaimed: false };
  });
}

/** True while a reserved texting-number purchase is still unspent for this business and use. */
async function smsExtraPurchaseIsUnspent(transactionId, tenantId, purpose) {
  const id = (transactionId || "").toString().trim();
  if (!id) return false;
  const snap = await db().collection(SMS_EXTRA_PURCHASES).doc(id).get();
  if (!snap.exists) return false;
  const claim = snap.data() || {};
  return claim.tenantId === tenantId && claim.purpose === purpose && !claim.consumedAt;
}

/** Marks the purchase spent once Twilio has provisioned the number it paid for. */
async function consumeSmsExtraPurchase(transactionId) {
  const id = (transactionId || "").toString().trim();
  if (!id) return;
  await db().collection(SMS_EXTRA_PURCHASES).doc(id).set(
    { consumedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

function preservedAccountToken(existingUser) {
  if (!existingUser || !existingUser.exists) return "";
  return normalizeAccountToken(existingUser.data().appleAppAccountToken);
}

module.exports = {
  APPLE_SUBSCRIPTION_PRODUCTS,
  NotificationTypeV2,
  verifySignedTransaction,
  verifySignedNotification,
  planForProduct,
  normalizeAccountToken,
  subscriptionStatusFromApple,
  findTenantForTransaction,
  applyVerifiedTransaction,
  prepareAccountToken,
  preservedAccountToken,
  claimSmsExtraPurchase,
  smsExtraPurchaseIsUnspent,
  consumeSmsExtraPurchase,
};
