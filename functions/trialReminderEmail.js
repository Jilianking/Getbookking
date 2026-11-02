/**
 * Free trial ending reminder: emailed once, 3 days before a web sign-up's free trial ends and the
 * card on file is first charged (Terms §8). Sent via Resend from support@ so owners can reply.
 * Skipped for shops that started their plan early, cancelled, or have no card on file.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const REMIND_DAYS_BEFORE = 3;

function marketingOrigin() {
  return (process.env.MARKETING_ORIGIN || "https://getbookking.com").toString().trim().replace(/\/+$/, "") ||
    "https://getbookking.com";
}

function resolveFrom() {
  return (process.env.WELCOME_EMAIL_FROM || "").trim() || "Get Bookking <support@getbookking.com>";
}

function resolveReplyTo() {
  return (process.env.SUPPORT_EMAIL || "support@getbookking.com").trim();
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(cents) {
  return "$" + (Math.round(Number(cents) || 0) / 100).toFixed(2).replace(/\.00$/, "");
}

/** e.g. "Thursday, November 15" */
function longDay(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
  });
}

/** e.g. "November 15" */
function shortDay(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "America/New_York",
  });
}

function buildTrialReminderEmail({ firstName = "", planName = "Solo", priceCents = 3900, trialEndUnix, cardLast4 = "" }) {
  const origin = marketingOrigin();
  const logoUrl = `${origin}/assets/brand/bookking-email-logo.png?v=2`;
  const billingUrl = `${origin}/app/billing`;
  const price = money(priceCents);
  const endLong = longDay(trialEndUnix);
  const endShort = shortDay(trialEndUnix);
  const greet = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,";
  const cardText = cardLast4 ? `your card ending in <strong>${escapeHtml(cardLast4)}</strong>` : "your card on file";
  const subject = `Your Get Bookking free trial ends in ${REMIND_DAYS_BEFORE} days`;
  const p = (html, extra = "") =>
    `<tr><td style="padding-bottom:16px;font-size:15px;line-height:1.55;color:#1d1d1f;${extra}">${html}</td></tr>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;">
          <tr>
            <td style="padding-bottom:20px;">
              <img src="${escapeHtml(logoUrl)}" width="56" height="56" alt="Get Bookking" style="display:block;border:0;border-radius:12px;" />
            </td>
          </tr>
          ${p(greet, "color:#6e6e73;padding-bottom:8px;")}
          <tr><td style="padding-bottom:16px;font-size:26px;line-height:1.25;font-weight:700;color:#1d1d1f;">Your free trial ends in ${REMIND_DAYS_BEFORE} days</td></tr>
          ${p(`Your 14-day free trial of Get Bookking ends on <strong>${escapeHtml(endLong)}</strong>.`)}
          ${p(`On that day, your <strong>${escapeHtml(planName)}</strong> plan starts and we'll charge <strong>${escapeHtml(price)}</strong> to ${cardText}. After that, it's ${escapeHtml(price)} every month until you cancel.`)}
          <tr><td style="padding-bottom:8px;font-size:15px;font-weight:600;color:#1d1d1f;">When your plan starts, you unlock:</td></tr>
          <tr>
            <td style="padding-bottom:20px;font-size:15px;line-height:1.6;color:#1d1d1f;">
              &bull; Client texting with your own business number<br />
              &bull; Card payments, deposits, and Tap to Pay on iPhone
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;">
              <a href="${escapeHtml(billingUrl)}" style="display:inline-block;padding:12px 28px;border:1.5px solid #1d1d1f;border-radius:980px;color:#1d1d1f;text-decoration:none;font-size:15px;font-weight:600;">Manage your plan</a>
            </td>
          </tr>
          ${p("Want to start now instead? You can start your plan early from the same page and unlock texting and payments today.")}
          ${p(`Don't want to continue? Cancel before ${escapeHtml(endShort)} in Plan &amp; billing and you won't be charged.`)}
          ${p("Questions? Just reply to this email.")}
          ${p("The Get Bookking team", "padding-bottom:28px;")}
          <tr>
            <td style="padding-top:16px;border-top:1px solid #e5e5ea;font-size:12px;line-height:1.5;color:#86868b;">
              You're getting this because you started a free trial at getbookking.com.
              Get Bookking is operated by Software by King LLC.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping trial reminder to", to);
    return { ok: false, skipped: true, reason: "no_api_key" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: resolveFrom(), to, subject, html, reply_to: resolveReplyTo() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
  }
  return { ok: true };
}

const PLAN_NAMES = { solo: "Solo", studio: "Studio", shop: "Shop", charter: "Charter" };

/**
 * Daily: owners whose trial (with a card on file) ends within the next 3 days get one reminder.
 * Uses the live Stripe subscription, so a trial that was started early, cancelled, or changed is skipped.
 */
function registerTrialReminderFunctions(exportsObj, { stripeSecretKey, Stripe }) {
  exportsObj.sendTrialEndingReminders = functions
    .runWith({ secrets: [stripeSecretKey] })
    .pubsub.schedule("every 24 hours")
    .onRun(async () => {
      const db = admin.firestore();
      const secretKey = stripeSecretKey.value();
      if (!secretKey) {
        console.warn("sendTrialEndingReminders: Stripe not configured");
        return null;
      }
      const stripe = new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
      const snap = await db.collection("tenants").where("subscriptionStatus", "==", "trialing").get();
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = now + REMIND_DAYS_BEFORE * 86400;
      const outcome = { sent: 0, skipped: 0, failed: 0 };
      for (const doc of snap.docs) {
        const t = doc.data() || {};
        const subId = (t.stripeSubscriptionId || "").toString().trim();
        if (!subId || t.trialReminderSentAt) { outcome.skipped++; continue; }
        try {
          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ["default_payment_method", "items.data.price"],
          });
          const trialEnd = Number(sub.trial_end) || 0;
          // Only real trials ending in the next 3 days that will actually charge.
          if (sub.status !== "trialing" || !trialEnd || trialEnd <= now || trialEnd > windowEnd || sub.cancel_at_period_end) {
            outcome.skipped++;
            continue;
          }
          const pm = sub.default_payment_method && typeof sub.default_payment_method === "object" ? sub.default_payment_method : null;
          if (!pm) { outcome.skipped++; continue; }
          const ownerUid = (t.ownerUid || "").toString().trim();
          const owner = ownerUid ? (await db.collection("users").doc(ownerUid).get()).data() || {} : {};
          const to = (owner.email || "").toString().trim();
          if (!to) { outcome.skipped++; continue; }
          const item = sub.items && sub.items.data && sub.items.data[0];
          const priceCents = item && item.price && Number(item.price.unit_amount) || 0;
          const planKey = ((sub.metadata && sub.metadata.plan) || t.subscriptionPlan || "solo").toString().toLowerCase();
          const { subject, html } = buildTrialReminderEmail({
            firstName: (owner.firstName || "").toString().trim(),
            planName: PLAN_NAMES[planKey] || "Get Bookking",
            priceCents,
            trialEndUnix: trialEnd,
            cardLast4: (pm.card && pm.card.last4) || "",
          });
          const result = await sendViaResend({ to, subject, html });
          if (result.ok) {
            await doc.ref.set({ trialReminderSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            outcome.sent++;
          } else {
            outcome.skipped++;
          }
        } catch (e) {
          outcome.failed++;
          console.warn("sendTrialEndingReminders", doc.id, e.message || e);
        }
      }
      console.log("sendTrialEndingReminders", outcome);
      return null;
    });
}

module.exports = { registerTrialReminderFunctions, buildTrialReminderEmail };
