/**
 * Shop settings, logo, wallet domains, demo data.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  admin,
  Stripe,
  sms,
  ALLOWED_DEMO_APP_SLUGS,
  buildDemoAppSnapshot,
  stripeSecretKey,
  walletDomains,
  openaiApiKey,
  db,
  stripeClientFromSecret,
  getMemberAccessContext,
} = require("./core");

/**
 * Generates a logo asset with OpenAI gpt-image-1.
 * Params: { prompt: string, businessName?: string }
 * Returns { imageBase64: string, mimeType: string }
 */
exports.generateTenantLogoWithOpenAI = functions
  .runWith({ secrets: [openaiApiKey], timeoutSeconds: 120, memory: "512MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in");
    }
    const apiKey = openaiApiKey.value();
    if (!apiKey) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "OpenAI is not configured. Run: firebase functions:secrets:set OPENAI_API_KEY"
      );
    }
    const rawPrompt = (data?.prompt || "").toString().trim();
    if (rawPrompt.length < 3) {
      throw new functions.https.HttpsError("invalid-argument", "Describe your logo in at least a few words.");
    }
    if (rawPrompt.length > 2000) {
      throw new functions.https.HttpsError("invalid-argument", "Prompt is too long (max 2000 characters).");
    }
    const businessName = (data?.businessName || "").toString().trim();
    const fullPrompt = [
      businessName ? `Professional brand logo for "${businessName}".` : "Professional brand logo.",
      rawPrompt,
      "Flat vector style, simple recognizable mark, high contrast, readable at small sizes.",
      "No mockups, no photo backgrounds, single centered composition on a white background.",
    ].join(" ");

    const oaiResp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: fullPrompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
        response_format: "b64_json",
      }),
    });
    const oaiJson = await oaiResp.json();
    if (!oaiResp.ok) {
      const msg = (oaiJson.error && oaiJson.error.message) || oaiResp.statusText || "OpenAI request failed";
      console.error("OpenAI images error", oaiResp.status, msg);
      throw new functions.https.HttpsError(
        oaiResp.status === 429 ? "resource-exhausted" : "internal",
        msg
      );
    }
    const first = oaiJson.data && oaiJson.data[0] ? oaiJson.data[0] : null;
    const b64 = first && (first.b64_json || first.image_base64 || first.imageBase64);
    if (!b64) {
      console.error("OpenAI image payload missing base64", JSON.stringify(oaiJson).slice(0, 500));
      throw new functions.https.HttpsError("internal", "No base64 image data returned from OpenAI");
    }
    return { imageBase64: b64, mimeType: "image/png" };
  });

/**
 * Public read-only snapshot for iOS "Try demo" (salon / gym personas). No auth.
 * Params: { slug: "gilded-palm" | "iron-district-gym" }
 */
exports.getDemoAppSnapshot = functions.https.onCall(async (data) => {
  const slug = (data?.slug || "").toString().trim().toLowerCase();
  if (!ALLOWED_DEMO_APP_SLUGS.has(slug)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid demo slug"
    );
  }
  try {
    return await buildDemoAppSnapshot(db, slug);
  } catch (err) {
    const msg = (err && err.message) || "Demo unavailable";
    if (msg.includes("No tenant")) {
      throw new functions.https.HttpsError("not-found", msg);
    }
    throw new functions.https.HttpsError("internal", msg);
  }
});

/** Owner: SMS message presets (confirm / decline / quick replies). */
exports.updateTenantMessagingPresets = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  if (!ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can update messaging presets."
    );
  }
  const confirmed = (data && data.smsPresetConfirmed != null
    ? data.smsPresetConfirmed
    : ""
  )
    .toString()
    .trim()
    .slice(0, sms.SMS_PRESET_MAX_LEN);
  const declined = (data && data.smsPresetDeclined != null ? data.smsPresetDeclined : "")
    .toString()
    .trim()
    .slice(0, sms.SMS_PRESET_MAX_LEN);
  const quick = sms.normalizeSmsQuickPresets(data && data.smsQuickPresets);
  await db.collection("tenants").doc(ctx.tenantId).set(
    {
      smsPresetConfirmed: confirmed || sms.defaultSmsPresetConfirmed(),
      smsPresetDeclined: declined || sms.defaultSmsPresetDeclined(),
      smsQuickPresets: quick,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    ok: true,
    smsPresetConfirmed: confirmed || sms.defaultSmsPresetConfirmed(),
    smsPresetDeclined: declined || sms.defaultSmsPresetDeclined(),
    smsQuickPresets: quick,
  };
});

/**
 * Apple Pay / Google Pay: register the shop's booking address on its Stripe accounts when the
 * shop connects Stripe or changes its web address. The old address is switched off.
 */
exports.syncShopWalletDomains = functions
  .runWith({ secrets: [stripeSecretKey] })
  .firestore.document("tenants/{tenantId}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() || {} : {};
    const after = change.after.exists ? change.after.data() || {} : null;
    if (!after) return null;
    const beforeSlug = (before.slug || "").toString().trim().toLowerCase();
    const afterSlug = (after.slug || "").toString().trim().toLowerCase();
    const beforeAccount = (before.stripeAccountId || "").toString().trim();
    const afterAccount = (after.stripeAccountId || "").toString().trim();
    if (beforeSlug === afterSlug && beforeAccount === afterAccount) return null;
    const newHost = walletDomains.bookingHostForSlug(afterSlug);
    if (!newHost) return null;
    const stripe = stripeClientFromSecret();
    if (!stripe) return null;
    const tenantId = context.params.tenantId;
    const accounts = await walletDomains.stripeAccountsForShop(db, tenantId, after);
    if (!accounts.length) return null;
    const oldHost = walletDomains.bookingHostForSlug(beforeSlug);
    if (oldHost && oldHost !== newHost) {
      await walletDomains.setWalletDomain(stripe, accounts, oldHost, false);
    }
    const results = await walletDomains.setWalletDomain(stripe, accounts, newHost, true);
    console.log("syncShopWalletDomains", tenantId, newHost, results.join("; "));
    return null;
  });

/** Apple Pay / Google Pay: a team member who connects their own Stripe gets the shop's address registered. */
exports.syncMemberWalletDomain = functions
  .runWith({ secrets: [stripeSecretKey] })
  .firestore.document("users/{memberUid}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() || {} : {};
    const after = change.after.exists ? change.after.data() || {} : null;
    if (!after) return null;
    const account = (after.stripeAccountId || "").toString().trim();
    const tenantId = (after.tenantId || "").toString().trim();
    if (!account || !tenantId) return null;
    if (
      account === (before.stripeAccountId || "").toString().trim() &&
      tenantId === (before.tenantId || "").toString().trim()
    ) {
      return null;
    }
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    const host = walletDomains.bookingHostForSlug(tenantSnap.exists ? (tenantSnap.data() || {}).slug : "");
    if (!host) return null;
    const stripe = stripeClientFromSecret();
    if (!stripe) return null;
    const accounts = (await walletDomains.stripeAccountsForShop(db, tenantId, {})).filter((id) => id === account);
    if (!accounts.length) return null;
    const results = await walletDomains.setWalletDomain(stripe, accounts, host, true);
    console.log("syncMemberWalletDomain", context.params.memberUid, host, results.join("; "));
    return null;
  });
