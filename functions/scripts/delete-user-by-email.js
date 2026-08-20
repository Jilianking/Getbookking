/**
 * One-off: fully remove a user by email (Auth + Firestore + tenant if owner).
 * Usage: node scripts/delete-user-by-email.js noabpope52@gmail.com
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { Firestore } = require("@google-cloud/firestore");

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/delete-user-by-email.js <email>");
  process.exit(1);
}

const PROJECT_ID = "test-app-96812";
const TENANT_SUBCOLLECTIONS = [
  "services",
  "products",
  "customers",
  "bookingRequests",
  "smsThreads",
  "smsLog",
  "smsOptOuts",
];

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

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

async function createClients() {
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
  const db = new Firestore({ projectId: PROJECT_ID, authClient });
  const accessToken = await auth.getAccessToken();
  return { db, accessToken };
}

async function lookupAuthUserByEmail(accessToken, emailAddr) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: [emailAddr] }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user =
    data && data.users && data.users.find((u) => u.email === emailAddr);
  return user ? { uid: user.localId, email: user.email } : null;
}

async function deleteAuthUser(accessToken, uid) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:delete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localId: uid }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth delete failed: ${res.status} ${err}`);
  }
}

async function deleteQueryInBatches(db, query, batchSize = 300) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

async function deleteCollectionRef(db, collectionRef) {
  await deleteQueryInBatches(db, collectionRef);
}

async function deleteTenantInvites(db, tenantId) {
  const snap = await db.collection("tenantInvites").where("tenantId", "==", tenantId).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

async function deleteTenantData(db, tenantId) {
  const tenantRef = db.collection("tenants").doc(tenantId);
  for (const sub of TENANT_SUBCOLLECTIONS) {
    await deleteCollectionRef(db, tenantRef.collection(sub));
  }
  await deleteTenantInvites(db, tenantId);
  await tenantRef.delete();
}

async function deleteUserFirestore(db, uid) {
  await deleteCollectionRef(
    db,
    db.collection("users").doc(uid).collection("deviceTokens")
  );
  await db.collection("pendingProviderSignups").doc(uid).delete().catch(() => null);
  await db.collection("users").doc(uid).delete().catch(() => null);
}

async function deleteBetaWaitlist(db, emailAddr) {
  const snap = await db.collection("betaWaitlist").where("email", "==", emailAddr).get();
  for (const doc of snap.docs) {
    await doc.ref.delete();
    console.log("Deleted betaWaitlist", doc.id);
  }
}

async function main() {
  const { db, accessToken } = await createClients();
  let uid = null;
  let userData = {};

  const authUser = await lookupAuthUserByEmail(accessToken, email);
  if (authUser) {
    uid = authUser.uid;
    console.log("Found Auth user", uid, authUser.email);
  } else {
    console.log("No Auth user for", email);
  }

  if (!uid) {
    const userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    if (!userSnap.empty) {
      uid = userSnap.docs[0].id;
      userData = userSnap.docs[0].data() || {};
      console.log("Found Firestore user (no Auth)", uid);
    }
  } else {
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) userData = userSnap.data() || {};
  }

  const tenantId = (userData.tenantId || "").toString().trim();
  if (tenantId) {
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    const tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};
    const isOwner = !uid || tenant.ownerUid === uid;
    if (isOwner && tenantSnap.exists) {
      console.log("Deleting tenant", tenantId, "slug:", tenant.slug || "(none)");
      await deleteTenantData(db, tenantId);
    } else if (tenantSnap.exists) {
      console.log("User is not owner; skipping tenant delete for", tenantId);
    }
  }

  if (uid) {
    console.log("Deleting Firestore user docs for", uid);
    await deleteUserFirestore(db, uid);
    if (authUser) {
      await deleteAuthUser(accessToken, uid);
      console.log("Deleted Auth user", uid);
    }
  }

  await deleteBetaWaitlist(db, email);

  if (!uid) {
    const pendingSnap = await db.collection("pendingProviderSignups").get();
    for (const doc of pendingSnap.docs) {
      const data = doc.data() || {};
      if ((data.email || "").toString().toLowerCase() === email) {
        await doc.ref.delete();
        console.log("Deleted pendingProviderSignups", doc.id);
      }
    }
  }

  console.log("Done. Email", email, "is cleared for re-signup.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
