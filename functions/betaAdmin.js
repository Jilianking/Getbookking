/**
 * Beta program admin + tester onboarding (marketing admin portal).
 *
 * Env (functions/.env or Firebase params):
 *   BETA_ADMIN_UIDS — comma-separated Firebase Auth uids allowed to use admin portal
 *   RESEND_API_KEY — optional; when set, approval/decline emails are sent via Resend
 *   BETA_EMAIL_FROM — outbound From for approve/decline (e.g. "Get Bookking <beta@getbookking.com>")
 *   BETA_SUPPORT_EMAIL — optional override for Reply-To; defaults to beta contact email (support@getbookking.com)
 *   MARKETING_ORIGIN — e.g. https://getbookking.com
 */

const DEFAULT_SUPPORT_EMAIL = "support@getbookking.com";
const DEFAULT_TESTFLIGHT_PUBLIC_JOIN_URL =
  "https://testflight.apple.com/join/GD8AUjpS";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

const BETA_ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BETA_SIGNUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BUSINESS_TYPE_LABELS = {
  barber: "Barber shop",
  hair: "Hair salon",
  tattoos: "Tattoo studio",
  nails: "Nail salon",
  fitness: "Fitness / gym",
  other: "Other",
};

const DEFAULT_BETA_SETTINGS = {
  signupsCloseLabel: "Jul 24",
  studioSlotCap: 20,
  shopSlotCap: 10,
  testflightPublicJoinUrl: DEFAULT_TESTFLIGHT_PUBLIC_JOIN_URL,
  contactEmail: DEFAULT_SUPPORT_EMAIL,
  approvalEmailSubject: "You're in — welcome to the Get Bookking beta",
  approvalEmailIntro:
    "Good news — you've been approved for the Get Bookking iOS beta.\n\nFollow these steps to get started:",
  approvalEmailPortalNote:
    "Send feedback anytime through TestFlight (shake your iPhone or tap Send Beta Feedback in the app), or reply to this email.",
  approvalEmailClosing: "Welcome aboard,",
  declineEmailSubject: "Get Bookking beta — update on your request",
  declineEmailBody:
    "Thank you for applying to the Get Bookking iOS beta — we really appreciate you taking the time.\n\nThis round filled up quickly and spots were limited, so we weren't able to include everyone. We've kept you on the waitlist: if a spot opens up, or when we expand the beta, you'll be one of the first to hear.\n\nYou don't need to do anything — we'll email you the moment there's room.\n\nThanks again for wanting to be part of this early. It means a lot.",
};

function db() {
  return admin.firestore();
}

function marketingOrigin() {
  return (
    (process.env.MARKETING_ORIGIN || "https://getbookking.com")
      .toString()
      .trim()
      .replace(/\/+$/, "") || "https://getbookking.com"
  );
}

function adminOrigin() {
  const explicit = (process.env.ADMIN_ORIGIN || "").toString().trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const m = marketingOrigin();
  if (/getbookking\.com$/i.test(m.replace(/^https?:\/\//, ""))) {
    return "https://admin.getbookking.com";
  }
  return m;
}

function betaOrigin() {
  const explicit = (process.env.BETA_ORIGIN || "").toString().trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const m = marketingOrigin();
  if (/getbookking\.com$/i.test(m.replace(/^https?:\/\//, ""))) {
    return "https://beta.getbookking.com";
  }
  return m;
}

function parseAdminUids() {
  return (process.env.BETA_ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertPlatformAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign in to continue."
    );
  }
  const uid = context.auth.uid;
  if (context.auth.token.platformAdmin === true) return uid;
  const allowed = parseAdminUids();
  if (allowed.length && allowed.includes(uid)) return uid;
  throw new functions.https.HttpsError(
    "permission-denied",
    "You do not have access to the beta admin portal."
  );
}

function assertBetaTester(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign in to continue."
    );
  }
  if (context.auth.token.betaTester === true) return context.auth.uid;
  throw new functions.https.HttpsError(
    "permission-denied",
    "Beta portal access is not enabled for this account."
  );
}

async function assertActiveBetaTester(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign in to continue."
    );
  }
  const uid = context.auth.uid;
  const memberSnap = await db().collection("betaMembers").doc(uid).get();
  if (memberSnap.exists) {
    const status = (memberSnap.data()?.status || "").toString();
    if (status === "active") return uid;
    if (status === "invited") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Complete signup using the link in your approval email."
      );
    }
  }
  if (context.auth.token.betaTester === true) return uid;
  throw new functions.https.HttpsError(
    "permission-denied",
    "Beta portal access is not enabled for this account."
  );
}

function escapeEmailHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToEmailParagraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeEmailHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function businessTypeLabel(raw, customLabel) {
  const custom = (customLabel || "").toString().trim();
  const key = (raw || "").toString().trim().toLowerCase();
  if (key === "other" && custom) return custom;
  return BUSINESS_TYPE_LABELS[key] || key || "Business";
}

function generateTempPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

function normalizeBugAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 5)
    .map((item) => {
      const path = (item?.path || "").toString().trim();
      const url = (item?.url || "").toString().trim();
      const name = (item?.name || "attachment").toString().trim().slice(0, 200);
      const contentType = (item?.contentType || "").toString().trim().slice(0, 120);
      const size = Math.max(0, parseInt(item?.size, 10) || 0);
      if (!path.startsWith("betaBugAttachments/")) return null;
      if (!url.includes("firebasestorage.googleapis.com")) return null;
      return { path, url, name, contentType, size };
    })
    .filter(Boolean);
}

function onboardingToken() {
  return crypto.randomBytes(32).toString("hex");
}

function signupInviteToken() {
  return crypto.randomBytes(32).toString("hex");
}

function mapWaitlistBusinessTypeToSignupIndustry(businessType, businessTypeCustom) {
  const key = (businessType || "").toString().trim().toLowerCase();
  const custom = (businessTypeCustom || "").toString().trim();
  if (key === "charters") {
    return { industry: "charters", industryCustomLabel: "" };
  }
  if (key === "fitness") {
    return { industry: "custom", industryCustomLabel: custom || "Fitness / gym" };
  }
  if (key === "other") {
    return { industry: "custom", industryCustomLabel: custom || "Other" };
  }
  const signupIndustries = new Set(["barber", "hair", "tattoos", "nails"]);
  if (signupIndustries.has(key)) {
    return { industry: key, industryCustomLabel: "" };
  }
  return { industry: "custom", industryCustomLabel: custom || businessTypeLabel(key, custom) };
}

async function readBetaSignupInviteToken(token) {
  const trimmed = (token || "").toString().trim();
  if (!trimmed) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid invite link."
    );
  }
  const snap = await db().collection("betaSignupInviteTokens").doc(trimmed).get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
  }
  const tok = snap.data() || {};
  const now = admin.firestore.Timestamp.now();
  if (tok.usedAt) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite link was already used."
    );
  }
  if (tok.expiresAt && tok.expiresAt.toMillis() < now.toMillis()) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite link has expired."
    );
  }
  return { id: snap.id, ...tok };
}

async function loadWaitlistInviteEntry(waitlistId) {
  const snap = await db().collection("betaWaitlist").doc(waitlistId).get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Beta request not found.");
  }
  return { id: snap.id, ...(snap.data() || {}) };
}

function buildBetaSignupInviteUrl(token, plan) {
  const params = new URLSearchParams();
  params.set("beta", "1");
  if (plan) params.set("plan", plan);
  params.set("t", token);
  return `${marketingOrigin()}/signup?${params.toString()}`;
}

async function loadBetaSettings() {
  const snap = await db().collection("platformSettings").doc("beta").get();
  return normalizeBetaSettings(snap.exists ? snap.data() : {});
}

function normalizeBetaSettings(raw) {
  const settings = { ...DEFAULT_BETA_SETTINGS, ...(raw || {}) };
  const contact = (settings.contactEmail || "").toString().trim().toLowerCase();
  if (!contact || contact === "beta@getbookking.com") {
    settings.contactEmail = DEFAULT_SUPPORT_EMAIL;
  }
  if (!(settings.testflightPublicJoinUrl || "").toString().trim()) {
    settings.testflightPublicJoinUrl = DEFAULT_TESTFLIGHT_PUBLIC_JOIN_URL;
  }
  return settings;
}

function resolveTestflightPublicJoinUrl(settings, override) {
  const url = (
    override ||
    settings?.testflightPublicJoinUrl ||
    DEFAULT_TESTFLIGHT_PUBLIC_JOIN_URL ||
    ""
  )
    .toString()
    .trim();
  return url;
}

function resolveSupportEmail(settings) {
  const fromEnv = (process.env.BETA_SUPPORT_EMAIL || "").trim();
  if (fromEnv) return fromEnv;
  const fromSettings = (settings?.contactEmail || "").trim();
  if (fromSettings) return fromSettings;
  return DEFAULT_SUPPORT_EMAIL;
}

function resolveBetaEmailFrom() {
  return (
    (process.env.BETA_EMAIL_FROM || "").trim() ||
    "Get Bookking <beta@getbookking.com>"
  );
}

function isResendConfigured() {
  return !!(process.env.RESEND_API_KEY || "").trim();
}

function getBetaEmailConfig(settings) {
  return {
    resendConfigured: isResendConfigured(),
    from: resolveBetaEmailFrom(),
    supportEmail: resolveSupportEmail(settings || DEFAULT_BETA_SETTINGS),
  };
}

async function sendBetaEmail({ to, subject, html, replyTo }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping email to", to);
    return { skipped: true };
  }
  const from = resolveBetaEmailFrom();
  const payload = { from, to, subject, html };
  const reply = (replyTo || DEFAULT_SUPPORT_EMAIL).trim();
  if (reply) {
    payload.reply_to = reply;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Resend error", res.status, body);
    throw new functions.https.HttpsError(
      "internal",
      "Could not send email. Try again or check email configuration."
    );
  }
  return { ok: true };
}

function formatWaitlistRow(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    firstName: d.firstName || "",
    lastName: d.lastName || "",
    email: d.email || "",
    plan: d.plan || "solo",
    teamSize: d.teamSize || 1,
    businessName: d.businessName || "",
    businessType: d.businessType || "",
    businessTypeCustom: d.businessTypeCustom || "",
    businessTypeLabel: businessTypeLabel(d.businessType, d.businessTypeCustom),
    status: d.status || "pending",
    source: d.source || "",
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
    approvedAt: d.approvedAt || null,
    inviteSentAt: d.inviteSentAt || null,
    declinedAt: d.declinedAt || null,
    authUid: d.authUid || null,
  };
}

async function countWaitlistByPlanAndStatus(plan, statuses) {
  const snap = await db()
    .collection("betaWaitlist")
    .where("plan", "==", plan)
    .where("status", "in", statuses)
    .get();
  return snap.size;
}

async function countCollectionStatus(collection, statusField, statusValue) {
  const snap = await db()
    .collection(collection)
    .where(statusField, "==", statusValue)
    .get();
  return snap.size;
}

function buildDeclineEmailHtml({ firstName, body }) {
  return (
    `<p>Hi ${escapeEmailHtml(firstName || "there")},</p>` +
    textToEmailParagraphs(body) +
    `<p>Get Bookking</p>`
  );
}

function buildApprovalEmailHtml({
  firstName,
  email,
  signupUrl,
  testflightUrl,
  settings,
}) {
  const cfg = normalizeBetaSettings(settings || {});
  const intro = textToEmailParagraphs(cfg.approvalEmailIntro);
  const afterNote = textToEmailParagraphs(cfg.approvalEmailPortalNote);
  const closing = textToEmailParagraphs(cfg.approvalEmailClosing);
  const signupStep = signupUrl
    ? `<p style="margin:12px 0 0"><a href="${escapeEmailHtml(signupUrl)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Create your account</a></p>` +
      `<p style="margin:8px 0 0">Use the same email you applied with: <strong>${escapeEmailHtml(email)}</strong></p>`
    : `<p style="margin:8px 0 0">Finish signup at ${escapeEmailHtml(marketingOrigin())}/signup using <strong>${escapeEmailHtml(email)}</strong>.</p>`;
  const testflightStep = testflightUrl
    ? `<p style="margin:8px 0 0"><a href="${escapeEmailHtml(testflightUrl)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Join TestFlight</a></p>` +
      `<p style="margin:8px 0 0"><a href="${escapeEmailHtml(testflightUrl)}">${escapeEmailHtml(testflightUrl)}</a></p>`
    : `<p style="margin:8px 0 0">Use the TestFlight invite from Apple when it arrives.</p>`;
  const stepsBlock =
    `<ol style="margin:20px 0;padding-left:22px;line-height:1.55">` +
    `<li style="margin-bottom:18px"><strong>Create your account</strong>${signupStep}</li>` +
    `<li style="margin-bottom:18px"><strong>Install the app on TestFlight</strong>${testflightStep}</li>` +
    `<li style="margin-bottom:0"><strong>Sign in to the app</strong>` +
    `<p style="margin:8px 0 0">Open Get Bookking and sign in with the same email and password you just created.</p></li>` +
    `</ol>`;

  return (
    `<p>Hi ${escapeEmailHtml(firstName || "there")},</p>` +
    intro +
    stepsBlock +
    afterNote +
    closing +
    `<p>Get Bookking</p>`
  );
}

async function approveWaitlistEntry(waitlistId, adminUid, options = {}) {
  const waitlistRef = db().collection("betaWaitlist").doc(waitlistId);
  const waitlistSnap = await waitlistRef.get();
  if (!waitlistSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Request not found.");
  }
  const entry = waitlistSnap.data();
  const status = (entry.status || "pending").toString();
  if (status === "declined") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This request was declined."
    );
  }
  if (status === "invite_sent" || status === "active" || status === "approved") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "An invite was already sent for this request."
    );
  }

  const settings = await loadBetaSettings();
  const email = (entry.email || "").toString().trim().toLowerCase();
  const plan = (entry.plan || "solo").toString();

  const token = signupInviteToken();
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(
    now.toMillis() + BETA_SIGNUP_INVITE_TTL_MS
  );
  await db().collection("betaSignupInviteTokens").doc(token).set({
    waitlistId,
    email,
    plan,
    createdAt: now,
    expiresAt,
    usedAt: null,
    authUid: null,
  });

  const signupUrl = buildBetaSignupInviteUrl(token, plan);
  const testflightUrl = resolveTestflightPublicJoinUrl(
    settings,
    options.testflightUrl
  );

  const supportEmail = resolveSupportEmail(settings);

  const emailResult = await sendBetaEmail({
    to: email,
    subject:
      (settings.approvalEmailSubject || DEFAULT_BETA_SETTINGS.approvalEmailSubject)
        .toString()
        .trim() || DEFAULT_BETA_SETTINGS.approvalEmailSubject,
    replyTo: supportEmail,
    html: buildApprovalEmailHtml({
      firstName: entry.firstName,
      email,
      signupUrl,
      testflightUrl,
      settings,
    }),
  });

  await waitlistRef.set(
    {
      status: "invite_sent",
      inviteToken: token,
      approvedAt: now,
      inviteSentAt: now,
      approvedByUid: adminUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    ok: true,
    signupUrl,
    emailSent: !emailResult.skipped,
    emailSkipped: !!emailResult.skipped,
  };
}

function registerBetaAdminFunctions(functionsModule) {
  const fns = functionsModule;

  fns.assertBetaPlatformAdmin = functions.https.onCall(async (data, context) => {
    const uid = assertPlatformAdmin(context);
    return { ok: true, uid };
  });

  fns.getBetaAdminDashboard = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const settings = await loadBetaSettings();

    const pendingSnap = await db()
      .collection("betaWaitlist")
      .where("status", "==", "pending")
      .get();
    const activeMembersSnap = await db()
      .collection("betaMembers")
      .where("status", "==", "active")
      .get();
    const studioUsed = await countWaitlistByPlanAndStatus("studio", [
      "invite_sent",
      "active",
      "approved",
    ]);
    const shopUsed = await countWaitlistByPlanAndStatus("shop", [
      "invite_sent",
      "active",
      "approved",
    ]);
    const openBugsSnap = await db()
      .collection("betaBugReports")
      .where("status", "in", ["open", "triaged"])
      .get();
    const openBugsCount = openBugsSnap.size;

    const recentBugsSnap = await db()
      .collection("betaBugReports")
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();

    const reportsSnap = await db()
      .collection("betaReports")
      .orderBy("publishedAt", "desc")
      .limit(5)
      .get();

    return {
      settings,
      emailConfig: getBetaEmailConfig(settings),
      stats: {
        pending: pendingSnap.size,
        activeTesters: activeMembersSnap.size,
        studioUsed,
        studioCap: settings.studioSlotCap || 20,
        shopUsed,
        shopCap: settings.shopSlotCap || 10,
        openBugs: openBugsCount,
      },
      recentBugs: recentBugsSnap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          title: d.title || "",
          severity: d.severity || "medium",
          status: d.status || "open",
          reporterName: d.reporterName || "",
          iosVersion: d.iosVersion || "",
          createdAt: d.createdAt || null,
        };
      }),
      recentReports: reportsSnap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          weekLabel: d.weekLabel || "",
          title: d.title || "",
          submissionCount: d.submissionCount || 0,
          publishedAt: d.publishedAt || null,
          insight: d.insight || "",
        };
      }),
    };
  });

  fns.listBetaWaitlist = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const plan = (data?.plan || "").toString().trim().toLowerCase();
    const status = (data?.status || "").toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 100, 1), 500);

    let query = db().collection("betaWaitlist").orderBy("createdAt", "desc");
    if (plan && plan !== "all") {
      query = query.where("plan", "==", plan);
    }
    if (status && status !== "all") {
      query = query.where("status", "==", status);
    }
    const snap = await query.limit(limit).get();
    return { items: snap.docs.map(formatWaitlistRow) };
  });

  fns.approveBetaRequest = functions.https.onCall(async (data, context) => {
    const adminUid = assertPlatformAdmin(context);
    const waitlistId = (data?.waitlistId || "").toString().trim();
    if (!waitlistId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing request id."
      );
    }
    return approveWaitlistEntry(waitlistId, adminUid, {
      testflightUrl: data?.testflightUrl,
    });
  });

  fns.declineBetaRequest = functions.https.onCall(async (data, context) => {
    const adminUid = assertPlatformAdmin(context);
    const waitlistId = (data?.waitlistId || "").toString().trim();
    if (!waitlistId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing request id."
      );
    }
    const waitlistRef = db().collection("betaWaitlist").doc(waitlistId);
    const waitlistSnap = await waitlistRef.get();
    if (!waitlistSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Request not found.");
    }
    const entry = waitlistSnap.data();
    const status = (entry.status || "pending").toString();
    if (status === "invite_sent" || status === "active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This request was already approved."
      );
    }

    const settings = await loadBetaSettings();
    const body = (data?.reason || settings.declineEmailBody || "")
      .toString()
      .trim();
    const now = admin.firestore.Timestamp.now();

    await waitlistRef.set(
      {
        status: "declined",
        declinedAt: now,
        declinedByUid: adminUid,
        declineReason: body,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const email = (entry.email || "").toString().trim();
    if (email) {
      const supportEmail = resolveSupportEmail(settings);
      const emailResult = await sendBetaEmail({
        to: email,
        subject: settings.declineEmailSubject,
        replyTo: supportEmail,
        html: buildDeclineEmailHtml({
          firstName: entry.firstName,
          body,
        }),
      });
      return { ok: true, emailSent: !emailResult.skipped, emailSkipped: !!emailResult.skipped };
    }

    return { ok: true, emailSent: false, emailSkipped: true };
  });

  fns.reopenBetaWaitlistRequest = functions.https.onCall(async (data, context) => {
    const adminUid = assertPlatformAdmin(context);
    const waitlistId = (data?.waitlistId || "").toString().trim();
    if (!waitlistId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing request id."
      );
    }
    const waitlistRef = db().collection("betaWaitlist").doc(waitlistId);
    const waitlistSnap = await waitlistRef.get();
    if (!waitlistSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Request not found.");
    }
    const entry = waitlistSnap.data();
    const status = (entry.status || "pending").toString();
    if (status === "pending") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This request is already pending."
      );
    }
    if (status === "active") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This tester already completed onboarding. Contact them directly instead of reopening."
      );
    }

    const del = admin.firestore.FieldValue.delete();
    await waitlistRef.set(
      {
        status: "pending",
        approvedAt: del,
        inviteSentAt: del,
        inviteToken: del,
        approvedByUid: del,
        declinedAt: del,
        declinedByUid: del,
        declineReason: del,
        reopenAt: admin.firestore.FieldValue.serverTimestamp(),
        reopenedByUid: adminUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { ok: true };
  });

  fns.getBetaEmailStatus = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const settings = await loadBetaSettings();
    return getBetaEmailConfig(settings);
  });

  fns.inviteBetaTesterManual = functions.https.onCall(async (data, context) => {
    const adminUid = assertPlatformAdmin(context);
    const firstName = (data?.firstName || "").toString().trim();
    const lastName = (data?.lastName || "").toString().trim();
    const email = (data?.email || "").toString().trim().toLowerCase();
    const plan = (data?.plan || "solo").toString().trim().toLowerCase();
    const teamSize = parseInt(data?.teamSize, 10) || 1;
    const businessName = (data?.businessName || "Beta tester")
      .toString()
      .trim();
    const businessType = (data?.businessType || "other").toString().trim();

    if (!firstName || !lastName || !email) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "First name, last name, and email are required."
      );
    }

    const ref = await db().collection("betaWaitlist").add({
      firstName,
      lastName,
      email,
      plan,
      teamSize,
      businessName,
      businessType,
      source: "admin-invite",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdByUid: adminUid,
    });

    return approveWaitlistEntry(ref.id, adminUid, {
      testflightUrl: data?.testflightUrl,
    });
  });

  fns.updateBetaPlatformSettings = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const patch = {};
    const allowed = [
      "signupsCloseLabel",
      "studioSlotCap",
      "shopSlotCap",
      "testflightPublicJoinUrl",
      "contactEmail",
      "approvalEmailSubject",
      "approvalEmailIntro",
      "approvalEmailPortalNote",
      "approvalEmailClosing",
      "declineEmailSubject",
      "declineEmailBody",
      "weeklyInsight",
    ];
    allowed.forEach((key) => {
      if (data && Object.prototype.hasOwnProperty.call(data, key)) {
        patch[key] = data[key];
      }
    });
    [
      "approvalEmailSubject",
      "approvalEmailIntro",
      "approvalEmailPortalNote",
      "approvalEmailClosing",
      "declineEmailSubject",
      "declineEmailBody",
    ].forEach((key) => {
      if (patch[key] != null) {
        patch[key] = patch[key].toString().trim().slice(0, 4000);
      }
    });
    if (patch.studioSlotCap != null) {
      patch.studioSlotCap = Math.max(1, parseInt(patch.studioSlotCap, 10) || 20);
    }
    if (patch.shopSlotCap != null) {
      patch.shopSlotCap = Math.max(1, parseInt(patch.shopSlotCap, 10) || 10);
    }
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db().collection("platformSettings").doc("beta").set(patch, { merge: true });
    const settings = await loadBetaSettings();
    return { ok: true, settings };
  });

  fns.getBetaPlatformSettings = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const settings = await loadBetaSettings();
    return { settings };
  });

  fns.listBetaBugReports = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 100, 1), 500);
    const snap = await db()
      .collection("betaBugReports")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return {
      items: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    };
  });

  fns.updateBetaBugReport = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const id = (data?.id || "").toString().trim();
    const status = (data?.status || "").toString().trim();
    if (!id || !status) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Bug id and status are required."
      );
    }
    await db().collection("betaBugReports").doc(id).set(
      {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { ok: true };
  });

  fns.listBetaReports = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const limit = Math.min(Math.max(parseInt(data?.limit, 10) || 50, 1), 200);
    const snap = await db()
      .collection("betaReports")
      .orderBy("publishedAt", "desc")
      .limit(limit)
      .get();
    return {
      items: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    };
  });

  fns.publishBetaWeeklyReport = functions.https.onCall(async (data, context) => {
    const adminUid = assertPlatformAdmin(context);
    const weekLabel = (data?.weekLabel || "").toString().trim();
    const title = (data?.title || "").toString().trim();
    const body = (data?.body || "").toString().trim();
    const insight = (data?.insight || "").toString().trim();
    if (!weekLabel || !title || !body) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Week label, title, and body are required."
      );
    }
    const now = admin.firestore.Timestamp.now();
    const ref = await db().collection("betaReports").add({
      weekLabel,
      title,
      body,
      insight,
      submissionCount: parseInt(data?.submissionCount, 10) || 0,
      publishedAt: now,
      publishedByUid: adminUid,
      createdAt: now,
    });
    return { ok: true, id: ref.id };
  });

  fns.validateBetaSignupInvite = functions.https.onCall(async (data) => {
    const token = (data?.token || "").toString().trim();
    try {
      const tok = await readBetaSignupInviteToken(token);
      const entry = await loadWaitlistInviteEntry(tok.waitlistId);
      const mapped = mapWaitlistBusinessTypeToSignupIndustry(
        entry.businessType,
        entry.businessTypeCustom
      );
      return {
        email: tok.email || entry.email || "",
        plan: tok.plan || entry.plan || "solo",
        firstName: entry.firstName || "",
        lastName: entry.lastName || "",
        businessName: entry.businessName || "",
        businessType: entry.businessType || "",
        businessTypeCustom: entry.businessTypeCustom || "",
        teamSize: entry.teamSize || 1,
        industry: mapped.industry,
        industryCustomLabel: mapped.industryCustomLabel,
        waitlistId: tok.waitlistId || entry.id || "",
      };
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError("internal", "Could not validate invite link.");
    }
  });

  fns.validateBetaOnboardingToken = functions.https.onCall(async (data) => {
    const token = (data?.token || "").toString().trim();
    if (!token) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Invalid invite link."
      );
    }
    const snap = await db().collection("betaOnboardingTokens").doc(token).get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
    }
    const tok = snap.data();
    const now = admin.firestore.Timestamp.now();
    if (tok.usedAt) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This invite link was already used."
      );
    }
    if (tok.expiresAt && tok.expiresAt.toMillis() < now.toMillis()) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This invite link has expired."
      );
    }
    return {
      email: tok.email || "",
      waitlistId: tok.waitlistId || "",
    };
  });

  fns.completeBetaOnboarding = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Sign in with your temporary password first."
      );
    }
    const token = (data?.token || "").toString().trim();
    const newPassword = (data?.newPassword || "").toString();
    if (!token || newPassword.length < 6) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Choose a password with at least 6 characters."
      );
    }
    if (context.auth.uid !== (await db().collection("betaOnboardingTokens").doc(token).get()).data()?.authUid) {
      // allow if email matches token
    }

    const tokenRef = db().collection("betaOnboardingTokens").doc(token);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Invalid invite link.");
    }
    const tok = tokenSnap.data();
    if (tok.authUid !== context.auth.uid) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "This invite is for a different account."
      );
    }
    if (tok.usedAt) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This invite was already used."
      );
    }

    await admin.auth().updateUser(context.auth.uid, { password: newPassword });
    const existingClaims =
      (await admin.auth().getUser(context.auth.uid)).customClaims || {};
    await admin.auth().setCustomUserClaims(context.auth.uid, {
      ...existingClaims,
      betaTester: true,
    });

    const now = admin.firestore.Timestamp.now();
    await tokenRef.set({ usedAt: now }, { merge: true });
    await db().collection("betaMembers").doc(context.auth.uid).set(
      {
        status: "active",
        onboardedAt: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (tok.waitlistId) {
      await db().collection("betaWaitlist").doc(tok.waitlistId).set(
        {
          status: "active",
          activatedAt: now,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { ok: true };
  });

  fns.getBetaTesterPortal = functions.https.onCall(async (data, context) => {
    await assertActiveBetaTester(context);
    const settings = await loadBetaSettings();
    const reportsSnap = await db()
      .collection("betaReports")
      .orderBy("publishedAt", "desc")
      .limit(20)
      .get();
    const memberSnap = await db().collection("betaMembers").doc(context.auth.uid).get();
    return {
      settings: {
        contactEmail: settings.contactEmail,
        testflightPublicJoinUrl: settings.testflightPublicJoinUrl,
      },
      member: memberSnap.exists ? memberSnap.data() : null,
      reports: reportsSnap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          weekLabel: d.weekLabel,
          title: d.title,
          body: d.body,
          insight: d.insight,
          publishedAt: d.publishedAt,
        };
      }),
    };
  });

  fns.submitBetaBugReport = functions.https.onCall(async (data, context) => {
    await assertActiveBetaTester(context);
    const title = (data?.title || "").toString().trim();
    const stepsToReproduce = (data?.stepsToReproduce || "").toString().trim();
    const description = (data?.description || stepsToReproduce || "")
      .toString()
      .trim();
    const screen = (data?.screen || "").toString().trim();
    const iosVersion = (data?.iosVersion || "").toString().trim();
    const appVersion = (data?.appVersion || "").toString().trim();
    const deviceModel = (data?.deviceModel || "").toString().trim();
    const buildNumber = (data?.buildNumber || "").toString().trim();
    const notes = (data?.notes || "").toString().trim().slice(0, 2000);
    const severity = (data?.severity || "medium").toString().trim().toLowerCase();
    const frequency = (data?.frequency || "").toString().trim().toLowerCase();
    if (!title || !description) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Title and steps to reproduce are required."
      );
    }
    if (!screen) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Select where in the app the bug happened."
      );
    }
    const memberSnap = await db().collection("betaMembers").doc(context.auth.uid).get();
    const member = memberSnap.exists ? memberSnap.data() : {};
    const reporterName =
      `${member.firstName || ""} ${member.lastName || ""}`.trim() ||
      context.auth.token.email ||
      "Beta tester";
    const attachments = normalizeBugAttachments(data?.attachments);
    const ref = await db().collection("betaBugReports").add({
      title,
      description,
      stepsToReproduce,
      screen,
      notes,
      iosVersion,
      appVersion,
      deviceModel,
      buildNumber,
      severity: ["low", "medium", "high"].includes(severity) ? severity : "medium",
      frequency: ["always", "sometimes", "once"].includes(frequency)
        ? frequency
        : "sometimes",
      attachments,
      status: "open",
      reporterUid: context.auth.uid,
      reporterName,
      reporterEmail: member.email || context.auth.token.email || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, id: ref.id };
  });

  fns.provisionBetaTestUser = functions.https.onCall(async (data, context) => {
    assertPlatformAdmin(context);
    const email = (data?.email || "").toString().trim().toLowerCase();
    const password = (data?.password || "").toString();
    const firstName = (data?.firstName || "Beta").toString().trim();
    const lastName = (data?.lastName || "Tester").toString().trim();
    if (!email || password.length < 6) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Email and password (min 6 chars) are required."
      );
    }
    let authUid;
    try {
      const existing = await admin.auth().getUserByEmail(email);
      authUid = existing.uid;
      await admin.auth().updateUser(authUid, { password });
    } catch (err) {
      if (err.code !== "auth/user-not-found") throw err;
      const created = await admin.auth().createUser({
        email,
        password,
        displayName: `${firstName} ${lastName}`.trim(),
        emailVerified: false,
      });
      authUid = created.uid;
    }
    const existingClaims =
      (await admin.auth().getUser(authUid)).customClaims || {};
    await admin.auth().setCustomUserClaims(authUid, {
      ...existingClaims,
      betaTester: true,
    });
    await db().collection("betaMembers").doc(authUid).set(
      {
        email,
        firstName,
        lastName,
        plan: "solo",
        teamSize: 1,
        businessName: "Beta tester",
        businessType: "other",
        status: "active",
        source: "admin-provision",
        onboardedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { ok: true, email, authUid, loginUrl: `${betaOrigin()}/beta/login` };
  });
}

async function assertBetaSignupInviteForCheckout(token, email) {
  const tok = await readBetaSignupInviteToken(token);
  const inviteEmail = (tok.email || "").toString().trim().toLowerCase();
  const signupEmail = (email || "").toString().trim().toLowerCase();
  if (!inviteEmail || inviteEmail !== signupEmail) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Sign up with the same email address that received the beta approval."
    );
  }
  return tok;
}

async function activateBetaTesterFromSignup({ uid, email, betaInviteToken }) {
  const token = (betaInviteToken || "").toString().trim();
  if (!token || !uid) {
    return { activated: false };
  }

  const tok = await readBetaSignupInviteToken(token);
  const inviteEmail = (tok.email || "").toString().trim().toLowerCase();
  const signupEmail = (email || "").toString().trim().toLowerCase();
  if (!inviteEmail || inviteEmail !== signupEmail) {
    console.warn("activateBetaTesterFromSignup email mismatch", inviteEmail, signupEmail);
    return { activated: false };
  }

  const entry = await loadWaitlistInviteEntry(tok.waitlistId);
  const now = admin.firestore.Timestamp.now();
  const existingClaims =
    (await admin.auth().getUser(uid)).customClaims || {};
  await admin.auth().setCustomUserClaims(uid, {
    ...existingClaims,
    betaTester: true,
  });

  await db().collection("betaMembers").doc(uid).set(
    {
      email: inviteEmail,
      firstName: entry.firstName || "",
      lastName: entry.lastName || "",
      plan: tok.plan || entry.plan || "solo",
      teamSize: entry.teamSize || 1,
      businessName: entry.businessName || "",
      businessType: entry.businessType || "",
      businessTypeCustom: entry.businessTypeCustom || "",
      waitlistId: tok.waitlistId || entry.id || "",
      status: "active",
      invitedAt: entry.inviteSentAt || entry.approvedAt || now,
      onboardedAt: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db().collection("betaSignupInviteTokens").doc(token).set(
    {
      usedAt: now,
      authUid: uid,
    },
    { merge: true }
  );

  if (tok.waitlistId) {
    await db().collection("betaWaitlist").doc(tok.waitlistId).set(
      {
        status: "active",
        authUid: uid,
        activatedAt: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return { activated: true };
}

module.exports = {
  registerBetaAdminFunctions,
  assertPlatformAdmin,
  assertBetaSignupInviteForCheckout,
  activateBetaTesterFromSignup,
};
