#!/usr/bin/env node
/**
 * Upload a local image to tenants/{tenantId}/hero.jpg and set heroImageUrl on the tenant.
 *
 * Usage:
 *   node scripts/upload-tenant-hero.js --slug=coles-chair --file=/path/to/image.png
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
  const out = { project: DEFAULT_PROJECT, slug: "", file: "", tenantId: null };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--file=")) out.file = arg.slice(7).trim();
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
  const tmp = path.join(os.tmpdir(), `hero-upload-${Date.now()}.jpg`);
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

function imageDimensions(filePath) {
  try {
    const { execSync } = require("child_process");
    const out = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}"`, {
      encoding: "utf8",
    });
    const w = out.match(/pixelWidth: (\d+)/);
    const h = out.match(/pixelHeight: (\d+)/);
    if (w && h) return { width: parseInt(w[1], 10), height: parseInt(h[1], 10) };
  } catch (_) {}
  return { width: 1024, height: 1024 };
}

function firebaseDownloadUrl(bucketName, objectPath, token) {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(`
Upload hero image for a tenant.

  node scripts/upload-tenant-hero.js --slug=coles-chair --file=/path/to/photo.png
`);
    process.exit(args.help ? 0 : 1);
  }

  if (!fs.existsSync(args.file)) {
    throw new Error(`File not found: ${args.file}`);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);

  let tenantId = args.tenantId;
  if (!tenantId) {
    if (!args.slug) throw new Error("Provide --slug= or --tenantId=");
    const snap = await db
      .collection("tenants")
      .where("slug", "==", args.slug)
      .limit(1)
      .get();
    if (snap.empty) throw new Error(`Tenant not found: ${args.slug}`);
    tenantId = snap.docs[0].id;
  }

  const objectPath = `tenants/${tenantId}/hero.jpg`;
  const token = crypto.randomUUID();
  const jpeg = jpegBufferFromFile(args.file);
  const dims = imageDimensions(args.file);

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

  const heroImageUrl = firebaseDownloadUrl(BUCKET, objectPath, token);
  await db.collection("tenants").doc(tenantId).set(
    {
      heroImageUrl,
      heroImagePixelWidth: dims.width,
      heroImagePixelHeight: dims.height,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(`Tenant: ${tenantId}${args.slug ? ` (${args.slug})` : ""}`);
  console.log(`Hero URL: ${heroImageUrl}`);
  console.log(`Size: ${dims.width}×${dims.height}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
