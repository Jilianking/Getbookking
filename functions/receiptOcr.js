const functions = require("firebase-functions");

const MAX_BASE64_BYTES = 7 * 1024 * 1024; // ~5MB image after base64 overhead
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Extracts amount/date/vendor from a receipt photo using OpenAI vision.
 * Runs before the expense is saved (the user may retake/cancel the photo), so it
 * takes raw base64 image data rather than a Storage path — no orphaned uploads
 * for rejected photos.
 * Params: { imageBase64: string, mimeType: string }
 * Returns: { amountCents: number|null, date: string|null, vendor: string|null, confidence: "high"|"low" }
 */
function registerReceiptOcrFunctions(exportsObj, { openaiApiKey }) {
  exportsObj.extractReceiptData = functions
    .runWith({ secrets: [openaiApiKey], timeoutSeconds: 60, memory: "256MB" })
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

      const imageBase64 = (data?.imageBase64 || "").toString();
      const mimeType = (data?.mimeType || "image/jpeg").toString();
      if (!imageBase64) {
        throw new functions.https.HttpsError("invalid-argument", "imageBase64 is required.");
      }
      if (imageBase64.length > MAX_BASE64_BYTES) {
        throw new functions.https.HttpsError("invalid-argument", "Image is too large.");
      }
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new functions.https.HttpsError("invalid-argument", "Unsupported image type.");
      }

      const dataUrl = `data:${mimeType};base64,${imageBase64}`;
      const oaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Read this business receipt photo. Return a JSON object with exactly these keys: " +
                    'amountCents (integer, the total charged, in cents, or null if unreadable), ' +
                    'date (ISO 8601 date string YYYY-MM-DD, or null if unreadable), ' +
                    'vendor (merchant/business name as a short string, or null if unreadable), ' +
                    'confidence ("high" or "low", your confidence in the extracted values). ' +
                    "Only return the JSON object, no other text.",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });

      const oaiJson = await oaiResp.json();
      if (!oaiResp.ok) {
        const msg = (oaiJson.error && oaiJson.error.message) || oaiResp.statusText || "OpenAI request failed";
        console.error("OpenAI receipt OCR error", oaiResp.status, msg);
        throw new functions.https.HttpsError(
          oaiResp.status === 429 ? "resource-exhausted" : "internal",
          msg
        );
      }

      const content = oaiJson.choices?.[0]?.message?.content;
      let parsed;
      try {
        parsed = JSON.parse(content || "{}");
      } catch (err) {
        console.error("OpenAI receipt OCR: unparseable response", content);
        return { amountCents: null, date: null, vendor: null, confidence: "low" };
      }

      const amountCents = Number.isFinite(Number(parsed.amountCents))
        ? Math.max(0, Math.min(Math.round(Number(parsed.amountCents)), 100_000_00))
        : null;
      const date =
        typeof parsed.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date.trim())
          ? parsed.date.trim()
          : null;
      const vendor =
        typeof parsed.vendor === "string" && parsed.vendor.trim() ? parsed.vendor.trim().slice(0, 200) : null;
      const confidence = parsed.confidence === "high" ? "high" : "low";

      // Temporary diagnostic — remove once the "auto-fill not populating" report is resolved.
      console.log("extractReceiptData result", JSON.stringify({ amountCents, date, vendor, confidence, rawModelContent: content }));

      return { amountCents, date, vendor, confidence };
    });
}

module.exports = { registerReceiptOcrFunctions };
