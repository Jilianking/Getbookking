#!/usr/bin/env node
/**
 * Upload Stonecut about-section image (sets featuredWorkImages[0]).
 *
 * Usage:
 *   node scripts/upload-tenant-stonecut-about.js --slug=stone-cut-barbers --file=scripts/assets/stone-cut-barbers/about.jpg
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
  if (!refresh) throw new Error("Run: firebase login");
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
  return {
    db: new Firestore({ projectId, authClient }),
    storage: new Storage({ projectId, authClient }),
  };
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    slug: "stone-cut-barbers",
    tenantId: null,
    file: path.join(__dirname, "assets/stone-cut-barbers/about.jpg"),
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--file=")) out.file = arg.slice(7).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function jpegBufferFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return fs.readFileSync(filePath);
  const { execSync } = require("child_process");
  const tmp = path.join(os.tmpdir(), `stonecut-about-${Date.now()}.jpg`);
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
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

async function uploadImage(storage, tenantId, filePath) {
  const id = crypto.randomUUID();
  const objectPath = `tenants/${tenantId}/gallery/${id}.jpg`;
  const token = crypto.randomUUID();
  await storage.bucket(BUCKET).file(objectPath).save(jpegBufferFromFile(filePath), {
    metadata: {
      contentType: "image/jpeg",
      metadata: { firebaseStorageDownloadTokens: token },
    },
    resumable: false,
  });
  return firebaseDownloadUrl(BUCKET, objectPath, token);
}

async function resolveTenant(db, args) {
  if (args.tenantId) {
    const doc = await db.collection("tenants").doc(args.tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${args.tenantId}`);
    return { id: doc.id, data: doc.data() || {} };
  }
  const snap = await db
    .collection("tenants")
    .where("slug", "==", args.slug)
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`Tenant not found: ${args.slug}`);
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() || {} };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Upload Stonecut about-section photo (featuredWorkImages slot 0).

  node scripts/upload-tenant-stonecut-about.js --slug=stone-cut-barbers --file=scripts/assets/stone-cut-barbers/about.jpg
`);
    process.exit(0);
  }

  const filePath = path.isAbsolute(args.file)
    ? args.file
    : path.join(__dirname, args.file.replace(/^\.\//, ""));
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);
  const tenant = await resolveTenant(db, args);

  console.log(`Uploading about photo for ${args.slug} (${tenant.id})…`);
  const url = await uploadImage(storage, tenant.id, filePath);

  const featured = Array.isArray(tenant.data.featuredWorkImages)
    ? tenant.data.featuredWorkImages.slice()
    : [];
  featured[0] = url;

  await db.collection("tenants").doc(tenant.id).set(
    {
      featuredWorkImages: featured,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(`\nAbout image URL:\n${url}`);
  console.log(`View: https://${args.slug}.getbookking.com/home#about`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
