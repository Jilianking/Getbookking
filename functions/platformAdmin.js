/**
 * Platform admin check for maintenance callables (e.g. rebuilding public sites).
 *
 * Env: BETA_ADMIN_UIDS — comma-separated Firebase Auth uids allowed to run them. The name is
 * left over from the retired beta admin portal; it is kept so existing config keeps working.
 */

const functions = require("firebase-functions");

function parseAdminUids() {
  return (process.env.BETA_ADMIN_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertPlatformAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in to continue.");
  }
  const uid = context.auth.uid;
  if (context.auth.token.platformAdmin === true) return uid;
  const allowed = parseAdminUids();
  if (allowed.length && allowed.includes(uid)) return uid;
  throw new functions.https.HttpsError("permission-denied", "You do not have access.");
}

module.exports = { assertPlatformAdmin };
