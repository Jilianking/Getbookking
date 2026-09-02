#!/usr/bin/env node
/**
 * Upload a team member portrait to Storage and set profilePhotoUrl on users/{uid}.
 *
 * Usage:
 *   node scripts/upload-team-member-photo.js --slug=stone-cut-barbers --email=demo-stone-cut-barbers@getbookking.com --file=scripts/assets/stone-cut-barbers/marcus-stone-profile.jpg
 *   node scripts/upload-team-member-photo.js --slug=stone-cut-barbers --member-slug=diego-cole --file=scripts/assets/stone-cut-barbers/10-clipper-fade.jpg
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Storage } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/storage"
));
const { Firestore, FieldValue } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));

const DEFAULT_PROJECT = "test-app-96812";
const BUCKET = "test-app-96812.firebasestorage.app";

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

async function createGoogleClients(projectId) {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error("Run: firebase login");
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
  const db = new Firestore({ projectId, authClient });
  const storage = new Storage({ projectId, authClient });
  return { db, storage };
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    slug: "",
    file: "",
    email: "",
    memberSlug: "",
    tenantId: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--file=")) out.file = arg.slice(7).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--member-slug="))
      out.memberSlug = arg.slice(14).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function jpegBufferFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return fs.readFileSync(filePath);
  }
  const { execSync } = require("child_process");
  const tmp = path.join(os.tmpdir(), `team-photo-upload-${Date.now()}.jpg`);
  execSync(
    `sips -s format jpeg -s formatOptions 84 "${filePath}" --out "${tmp}"`,
    { stdio: "ignore" }
  );
  const buf = fs.readFileSync(tmp);
  try {
    fs.unlinkSync(tmp);
  } catch (_) {}
  return buf;
}

function firebaseDownloadUrl(bucketName, objectPath, token) {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

async function resolveTenant(db, slug, tenantId) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, data: doc.data() };
  }
  if (!slug) throw new Error("Provide --slug= or --tenantId=");
  const snap = await db
    .collection("tenants")
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`Tenant not found: ${slug}`);
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() };
}

async function resolveMember(db, tenantId, email, memberSlug) {
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (email) {
    const hit = rows.find((r) => (r.email || "").toLowerCase() === email);
    if (!hit) throw new Error(`No user with email ${email} on tenant`);
    return hit;
  }
  if (memberSlug) {
    const hit = rows.find(
      (r) => (r.memberSlug || "").toLowerCase() === memberSlug
    );
    if (!hit) throw new Error(`No user with memberSlug ${memberSlug} on tenant`);
    return hit;
  }
  throw new Error("Provide --email= or --member-slug=");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(`
Upload team member profile photo.

  node scripts/upload-team-member-photo.js --slug=stone-cut-barbers --email=owner@example.com --file=/path/photo.jpg
  node scripts/upload-team-member-photo.js --slug=stone-cut-barbers --member-slug=diego-cole --file=/path/photo.jpg
`);
    process.exit(args.help ? 0 : 1);
  }

  if (!fs.existsSync(args.file)) {
    throw new Error(`File not found: ${args.file}`);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);
  const tenant = await resolveTenant(db, args.slug, args.tenantId);
  const member = await resolveMember(
    db,
    tenant.id,
    args.email,
    args.memberSlug
  );

  const objectPath = `tenants/${tenant.id}/team/${member.id}/profile.jpg`;
  const token = crypto.randomUUID();
  const jpeg = jpegBufferFromFile(args.file);

  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(objectPath);
  await file.save(jpeg, {
    metadata: {
      contentType: "image/jpeg",
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
    resumable: false,
  });

  const profilePhotoUrl = firebaseDownloadUrl(BUCKET, objectPath, token);
  await db.collection("users").doc(member.id).set(
    {
      profilePhotoUrl,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(`Tenant: ${tenant.data.slug || tenant.id} (${tenant.id})`);
  console.log(`Member: ${member.displayName || member.id} (${member.id})`);
  console.log(`Profile URL: ${profilePhotoUrl}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
