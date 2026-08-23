/**
 * One-off: delete all beta waitlist / member / bug / report docs.
 * Usage: node scripts/clear-beta-waitlist.js
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { Firestore } = require("@google-cloud/firestore");

const PROJECT_ID = "test-app-96812";

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

const COLLECTIONS = [
  "betaWaitlist",
  "betaMembers",
  "betaBugReports",
  "betaReports",
  "betaOnboardingTokens",
  "betaSignupInviteTokens",
];

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json"
  );
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return cfg && cfg.tokens && cfg.tokens.refresh_token;
}

async function getDb() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new Firestore({ projectId: PROJECT_ID });
  }
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error(
      "No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
  const auth = new GoogleAuth({
    credentials: {
      type: "authorized_user",
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      refresh_token: refresh,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const authClient = await auth.getClient();
  return new Firestore({ projectId: PROJECT_ID, authClient });
}

async function deleteCollection(db, name) {
  const snap = await db.collection(name).get();
  if (snap.empty) {
    console.log(`${name}: 0 docs`);
    return 0;
  }
  let deleted = 0;
  const batchSize = 400;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + batchSize);
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
  }
  console.log(`${name}: deleted ${deleted}`);
  return deleted;
}

async function main() {
  const db = await getDb();
  for (const name of COLLECTIONS) {
    await deleteCollection(db, name);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
