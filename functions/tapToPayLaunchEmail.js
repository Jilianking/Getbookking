/**
 * Apple Tap to Pay on iPhone partner launch email (req 6.1).
 * Uses Marketing Toolkit Email Launch copy structure + Get Bookking branding.
 * Sent via Resend (same credentials as beta / password-reset mail).
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const PARTNER_NAME = "Get Bookking";
const PARTNER_PRODUCT = "Get Bookking";
const DEFAULT_CTA_LABEL = "Open Get Bookking";
const DEFAULT_SUPPORT = "support@getbookking.com";

function marketingOrigin() {
  return (
    (process.env.MARKETING_ORIGIN || "https://getbookking.com")
      .toString()
      .trim()
      .replace(/\/+$/, "") || "https://getbookking.com"
  );
}

function assetUrl(path) {
  const origin = marketingOrigin();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

function resolveFrom() {
  return (
    (process.env.BETA_EMAIL_FROM || "").trim() ||
    "Get Bookking <beta@getbookking.com>"
  );
}

function resolveReplyTo() {
  return (process.env.BETA_SUPPORT_EMAIL || DEFAULT_SUPPORT).trim();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * HTML aligned to Apple TTPoiP Email Launch template (US-EN) with partner slots filled.
 */
function buildTapToPayLaunchEmailHtml({
  firstName = "",
  ctaUrl,
  ctaLabel = DEFAULT_CTA_LABEL,
} = {}) {
  const origin = marketingOrigin();
  // Hosted on getbookking.com marketing site (web/marketing → site root).
  const logoUrl = assetUrl("assets/brand/bookking-email-logo.png");
  const heroUrl = assetUrl("assets/brand/ttpoi-email-launch-hero.jpg");
  const buttonUrl = (ctaUrl || `${origin}`).toString().trim();
  const greet = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tap to Pay on iPhone is available with ${escapeHtml(PARTNER_PRODUCT)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;">
          <tr>
            <td style="padding-bottom:20px;">
              <img src="${escapeHtml(logoUrl)}" width="56" height="56" alt="${escapeHtml(PARTNER_NAME)}" style="display:block;border:0;border-radius:12px;" />
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:15px;line-height:1.4;color:#6e6e73;">${greet}</td>
          </tr>
          <tr>
            <td style="padding-bottom:12px;font-size:28px;line-height:1.2;font-weight:700;color:#1d1d1f;">
              Tap to Pay on iPhone
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:16px;font-size:18px;line-height:1.35;color:#6e6e73;">
              Accept contactless payments right on your iPhone.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:20px;font-size:15px;line-height:1.5;color:#1d1d1f;">
              Tap to Pay on iPhone is now available with ${escapeHtml(PARTNER_PRODUCT)}.
              You can accept all types of in-person, contactless payments — from physical debit and credit cards
              to Apple Pay and other digital wallets — right on your iPhone.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;">
              <a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:12px 28px;border:1.5px solid #1d1d1f;border-radius:980px;color:#1d1d1f;text-decoration:none;font-size:15px;font-weight:600;">
                ${escapeHtml(ctaLabel)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:32px;">
              <img src="${escapeHtml(heroUrl)}" width="560" alt="Tap to Pay on iPhone" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:12px;" />
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:17px;font-weight:600;color:#1d1d1f;">Expand where you do business.</td>
          </tr>
          <tr>
            <td style="padding-bottom:20px;font-size:14px;line-height:1.5;color:#6e6e73;">
              Reach more customers, accept payments on the go, and explore new setups, like line busting. All you need is your iPhone.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:17px;font-weight:600;color:#1d1d1f;">Streamline checkout with no additional hardware.</td>
          </tr>
          <tr>
            <td style="padding-bottom:20px;font-size:14px;line-height:1.5;color:#6e6e73;">
              Tap to Pay on iPhone is easy to set up and use. No card readers or terminals required.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:17px;font-weight:600;color:#1d1d1f;">Privacy and security built in.</td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;font-size:14px;line-height:1.5;color:#6e6e73;">
              Tap to Pay on iPhone uses the built-in security and privacy features of iPhone to help protect your business and customer data.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:12px;font-size:18px;font-weight:700;color:#1d1d1f;">Get started in a few steps.</td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:14px;line-height:1.5;color:#1d1d1f;">
              <strong>1.</strong> Download the ${escapeHtml(PARTNER_NAME)} app.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:8px;font-size:14px;line-height:1.5;color:#1d1d1f;">
              <strong>2.</strong> Complete sign-up information.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;font-size:14px;line-height:1.5;color:#1d1d1f;">
              <strong>3.</strong> Accept in-person, contactless payments — right on iPhone.
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:12px;">
              <a href="${escapeHtml(buttonUrl)}" style="display:inline-block;padding:12px 28px;border:1.5px solid #1d1d1f;border-radius:980px;color:#1d1d1f;text-decoration:none;font-size:15px;font-weight:600;">
                ${escapeHtml(ctaLabel)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;font-size:11px;line-height:1.45;color:#86868b;">
              Tap to Pay on iPhone requires a supported payment app and the latest version of iOS.
              To update to the latest version of iOS on your iPhone, go to Settings &gt; General &gt; Software Update.
              Some contactless cards may not be accepted. Transaction limits may apply.
              The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC.
              Tap to Pay on iPhone is not available in all markets.
              See <a href="https://developer.apple.com/tap-to-pay/regions" style="color:#86868b;">developer.apple.com/tap-to-pay/regions</a>.
              Terms apply.
            </td>
          </tr>
          <tr>
            <td style="padding-top:16px;font-size:12px;color:#86868b;">
              ${escapeHtml(PARTNER_NAME)} · <a href="${escapeHtml(origin)}" style="color:#86868b;">${escapeHtml(origin.replace(/^https?:\/\//, ""))}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping Tap to Pay launch email to", to);
    return { skipped: true };
  }
  const from = resolveFrom();
  const replyTo = resolveReplyTo();
  const payload = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;

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
    console.error("Resend Tap to Pay launch email error", res.status, body);
    throw new Error(`Resend failed: ${res.status}`);
  }
  return { ok: true };
}

/**
 * Send partner launch email once per user (idempotent via users.tapToPayLaunchEmailSentAt).
 */
async function sendTapToPayLaunchEmailOnce({
  uid,
  email,
  firstName = "",
  force = false,
} = {}) {
  const to = (email || "").toString().trim().toLowerCase();
  if (!to || !to.includes("@")) {
    return { skipped: true, reason: "no_email" };
  }

  const db = admin.firestore();
  const userRef = uid ? db.collection("users").doc(uid) : null;
  if (userRef && !force) {
    const snap = await userRef.get();
    if (snap.exists && snap.data().tapToPayLaunchEmailSentAt) {
      return { skipped: true, reason: "already_sent" };
    }
  }

  const html = buildTapToPayLaunchEmailHtml({
    firstName,
    ctaUrl: marketingOrigin(),
    ctaLabel: DEFAULT_CTA_LABEL,
  });
  const subject = `Tap to Pay on iPhone is now available with ${PARTNER_PRODUCT}`;

  const result = await sendViaResend({ to, subject, html });
  if (result.skipped) return result;

  if (userRef) {
    await userRef.set(
      {
        tapToPayLaunchEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  return { ok: true, to };
}

/**
 * Fire-and-forget after new merchant provision. Never throws to caller.
 */
function scheduleTapToPayLaunchEmailAfterSignup({ uid, email, firstName }) {
  Promise.resolve()
    .then(() =>
      sendTapToPayLaunchEmailOnce({
        uid,
        email,
        firstName,
        force: false,
      })
    )
    .then((r) => {
      if (r && r.ok) {
        console.log("Tap to Pay launch email sent", email);
      } else if (r && r.skipped) {
        console.log("Tap to Pay launch email skipped", email, r.reason || "");
      }
    })
    .catch((err) => {
      console.error("Tap to Pay launch email failed", email, err);
    });
}

function registerTapToPayLaunchEmailFunctions(exports) {
  /**
   * Owner/admin test or resend: { force?: boolean, email?: string }
   * Defaults to signed-in user's email.
   */
  exports.sendTapToPayLaunchEmail = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const uid = context.auth.uid;
    const force = !!(data && data.force);
    const db = admin.firestore();
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      throw new functions.https.HttpsError("failed-precondition", "No user profile.");
    }
    const user = userSnap.data() || {};
    const role = (user.role || "").toString();
    if (role !== "owner" && role !== "admin") {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only the account owner can send the Tap to Pay launch email."
      );
    }
    const email =
      ((data && data.email) || user.email || context.auth.token.email || "")
        .toString()
        .trim();
    const firstName = (user.firstName || "").toString().trim();
    try {
      const result = await sendTapToPayLaunchEmailOnce({
        uid,
        email,
        firstName,
        force,
      });
      return result;
    } catch (err) {
      console.error(err);
      throw new functions.https.HttpsError(
        "internal",
        "Could not send Tap to Pay launch email."
      );
    }
  });
}

module.exports = {
  buildTapToPayLaunchEmailHtml,
  sendTapToPayLaunchEmailOnce,
  scheduleTapToPayLaunchEmailAfterSignup,
  registerTapToPayLaunchEmailFunctions,
};
