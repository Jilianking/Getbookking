/**
 * Account deletion, ownership transfer, password reset.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  admin,
  Stripe,
  sms,
  stripeSecretKey,
  db,
  assertTenantOwnerUid,
  countUsersForTenant,
  parseLifecycleConfirmPhrase,
  countOtherTeamMembers,
  cancelTenantStripeSubscription,
  releaseTenantTextingNumbers,
  deleteTenantData,
  deleteUserFirestoreAndAuth,
  assessMemberStripeDeletionBlock,
  passwordResetMarketingOrigin,
  parsePasswordResetOobLink,
} = require("./core");

/** Read-only: whether Delete account is allowed and if transfer is required first. */
exports.getAccountDeletionEligibility = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    return {
      ok: true,
      hasProfile: false,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const userData = userSnap.data() || {};
  const tenantId = (userData.tenantId || "").toString().trim();
  if (!tenantId) {
    return {
      ok: true,
      hasProfile: true,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    return {
      ok: true,
      hasProfile: true,
      isOwner: false,
      teamMemberCount: 0,
      otherTeamMemberCount: 0,
      requiresTransfer: false,
      canDelete: true,
      businessName: "",
    };
  }
  const tenant = tenantSnap.data() || {};
  const isOwner = tenant.ownerUid === uid;
  const teamMemberCount = await countUsersForTenant(tenantId);
  const otherTeamMemberCount = await countOtherTeamMembers(tenantId, uid);
  const requiresTransfer = isOwner && otherTeamMemberCount > 0;
  const businessName = (
    tenant.displayName ||
    tenant.businessName ||
    userData.business ||
    ""
  ).toString();
  const stripeAssessment = await assessMemberStripeDeletionBlock(userData);
  return {
    ok: true,
    hasProfile: true,
    isOwner,
    teamMemberCount,
    otherTeamMemberCount,
    requiresTransfer,
    requiresShutdownConfirm: requiresTransfer,
    canDelete: !stripeAssessment.stripeBalanceBlocksDeletion,
    businessName,
    hasStripeConnectAccount: stripeAssessment.hasStripeConnectAccount,
    stripeBalanceBlocksDeletion: stripeAssessment.stripeBalanceBlocksDeletion,
    stripeBalanceBlockMessage: stripeAssessment.stripeBalanceBlockMessage,
  };
});

/** Owner-only: transfer business ownership to an existing team member. */
exports.transferTenantOwnership = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    parseLifecycleConfirmPhrase(data, "TRANSFER");
    const uid = context.auth.uid;
    const newOwnerUid = ((data && data.newOwnerUid) || "").toString().trim();
    if (!newOwnerUid) {
      throw new functions.https.HttpsError("invalid-argument", "newOwnerUid is required.");
    }
    if (newOwnerUid === uid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Choose a different team member."
      );
    }
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError("not-found", "User profile not found.");
    }
    const tenantId = userDoc.data().tenantId;
    if (!tenantId) {
      throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
    }
    const tenant = await assertTenantOwnerUid(uid, tenantId);
    const newOwnerRef = db.collection("users").doc(newOwnerUid);
    const newOwnerSnap = await newOwnerRef.get();
    if (!newOwnerSnap.exists || newOwnerSnap.data().tenantId !== tenantId) {
      throw new functions.https.HttpsError("not-found", "Team member not found.");
    }
    const batch = db.batch();
    batch.set(
      db.collection("tenants").doc(tenantId),
      {
        ownerUid: newOwnerUid,
        ownerId: newOwnerUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(
      newOwnerRef,
      {
        role: "owner",
        accessRole: "owner",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(
      db.collection("users").doc(uid),
      {
        role: "manager",
        accessRole: "manager",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();

    const newOwnerEmail = (newOwnerSnap.data().email || "").toString().trim();
    const stripeCustomerId = (tenant.stripeCustomerId || "").toString().trim();
    if (stripeCustomerId && newOwnerEmail) {
      const secretKey = stripeSecretKey.value();
      if (secretKey) {
        try {
          const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
          await stripe.customers.update(stripeCustomerId, { email: newOwnerEmail });
        } catch (err) {
          console.warn("transferTenantOwnership stripe customer email", err.message || err);
        }
      }
    }

    return {
      ok: true,
      tenantId,
      newOwnerUid,
      billingUpdateRecommended: Boolean(stripeCustomerId),
    };
  });

/** Delete the signed-in user's account. Owners with team may shut down the business (SHUTDOWN) or transfer first. */
exports.deleteMyAccount = functions
  .runWith({ secrets: [stripeSecretKey, sms.twilioAccountSid, sms.twilioAuthToken] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    parseLifecycleConfirmPhrase(data, "DELETE");
    const uid = context.auth.uid;
    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};
    const tenantId = (userData.tenantId || "").toString().trim();

    const stripeAssessment = await assessMemberStripeDeletionBlock(userData);
    if (stripeAssessment.stripeBalanceBlocksDeletion) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        stripeAssessment.stripeBalanceBlockMessage ||
          "Withdraw your Stripe payout balance in Payments before deleting your account."
      );
    }

    if (!tenantId) {
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: false };
    }

    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) {
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: false };
    }

    const tenant = tenantSnap.data() || {};
    const isOwner = tenant.ownerUid === uid;
    const otherMembers = await countOtherTeamMembers(tenantId, uid);

    if (isOwner && otherMembers > 0) {
      const shutdownPhrase = ((data && data.shutdownConfirmPhrase) || "")
        .toString()
        .trim()
        .toUpperCase();
      if (shutdownPhrase !== "SHUTDOWN") {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Type SHUTDOWN to confirm shutting down the business for your team."
        );
      }
      await cancelTenantStripeSubscription(tenant);
      await releaseTenantTextingNumbers(tenantId, tenant);
      await deleteTenantData(tenantId);
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: true, shutDownBusiness: true };
    }

    if (isOwner) {
      await cancelTenantStripeSubscription(tenant);
      await releaseTenantTextingNumbers(tenantId, tenant);
      await deleteTenantData(tenantId);
      await deleteUserFirestoreAndAuth(uid);
      return { ok: true, deletedTenant: true };
    }

    // A teammate leaving: their personal number goes back to Twilio with them.
    if ((userData.smsPhoneNumberSid || "").toString().trim()) {
      try {
        await sms.releaseMemberSms(userData);
      } catch (e) {
        console.warn("deleteMyAccount release member number", uid, e.message || e);
      }
    }
    await deleteUserFirestoreAndAuth(uid);
    return { ok: true, deletedTenant: false, leftTenant: true };
  });

/**
 * Sends a branded password reset email via Resend, pointing to the custom
 * reset-password handler instead of Firebase's default action page.
 * Public callable — no auth required (user is logged out).
 * Params: { email }
 */
exports.sendPasswordResetLink = functions.https.onCall(async (data) => {
  const email = ((data && data.email) ? data.email : "").toString().trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new functions.https.HttpsError("invalid-argument", "A valid email address is required.");
  }

  const origin = passwordResetMarketingOrigin();
  const paths = { resetPath: "/reset-password", loginPath: "/login.html" };
  const loginUrl = origin + paths.loginPath;

  let resetLink;
  try {
    resetLink = await admin.auth().generatePasswordResetLink(email, { url: loginUrl });
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return { ok: true };
    }
    console.error("generatePasswordResetLink error", err);
    throw new functions.https.HttpsError("internal", "Could not generate reset link.");
  }

  let oobCode;
  try {
    oobCode = parsePasswordResetOobLink(resetLink);
  } catch (err) {
    console.error("Failed to parse reset link", resetLink, err);
    throw new functions.https.HttpsError("internal", "Could not parse reset link.");
  }

  if (!oobCode) {
    console.error("Reset link missing oobCode", resetLink);
    throw new functions.https.HttpsError("internal", "Reset link missing required parameters.");
  }

  const customResetUrl =
    origin +
    paths.resetPath +
    "?mode=resetPassword" +
    "&oobCode=" + encodeURIComponent(oobCode) +
    "&continueUrl=" + encodeURIComponent(loginUrl);

  const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set; skipping password reset email to", email);
    return { ok: true };
  }

  const from = (
    process.env.PASSWORD_RESET_EMAIL_FROM || "Get Bookking <noreply@getbookking.com>"
  ).trim();
  const replyTo = (process.env.SUPPORT_EMAIL || "support@getbookking.com").trim();

  const html = [
    "<p>Hello,</p>",
    "<p>Follow this link to reset your Get Bookking password for your <strong>" + email + "</strong> account.</p>",
    "<p><a href=\"" + customResetUrl + "\">Reset password</a></p>",
    "<p>If you didn't ask to reset your password, you can ignore this email.</p>",
    "<p>Thanks,<br>Your Get Bookking team</p>",
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + resendApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: email, subject: "Reset your Get Bookking password", html, reply_to: replyTo }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Resend error sending password reset", res.status, body);
    throw new functions.https.HttpsError("internal", "Could not send reset email. Please try again.");
  }

  return { ok: true };
});
