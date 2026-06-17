#!/usr/bin/env node
/**
 * Upload Studio 12 section images (philosophy + book CTA).
 *
 * Usage:
 *   node scripts/upload-tenant-studio12-images.js --slug=studio-amara --philosophy=file.jpg --book-cta=file.jpg
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
    slug: "",
    tenantId: null,
    philosophy: "",
    bookCta: "",
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--philosophy=")) out.philosophy = arg.slice(13).trim();
    else if (arg.startsWith("--book-cta=")) out.bookCta = arg.slice(11).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function jpegBufferFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return fs.readFileSync(filePath);
  const { execSync } = require("child_process");
  const tmp = path.join(os.tmpdir(), `s12-upload-${Date.now()}.jpg`);
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
  return { width: 1200, height: 1500 };
}

function firebaseDownloadUrl(bucketName, objectPath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

async function uploadSectionImage(storage, tenantId, filePath) {
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

async function resolveTenantId(db, args) {
  if (args.tenantId) return args.tenantId;
  if (!args.slug) throw new Error("Provide --slug= or --tenantId=");
  const snap = await db
    .collection("tenants")
    .where("slug", "==", args.slug)
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`Tenant not found: ${args.slug}`);
  return snap.docs[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.philosophy && !args.bookCta)) {
    console.log(`
Upload Studio 12 philosophy and/or book CTA images.

  node scripts/upload-tenant-studio12-images.js --slug=studio-amara \\
    --philosophy=scripts/assets/studio-amara/04-nail-art.jpg \\
    --book-cta=scripts/assets/studio-amara/06-salon-manicure.jpg
`);
    process.exit(args.help ? 0 : 1);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);
  const tenantId = await resolveTenantId(db, args);
  const patch = { updatedAt: FieldValue.serverTimestamp() };

  if (args.philosophy) {
    if (!fs.existsSync(args.philosophy)) throw new Error(`File not found: ${args.philosophy}`);
    const dims = imageDimensions(args.philosophy);
    const url = await uploadSectionImage(storage, tenantId, args.philosophy);
    patch.studio12PhilosophyImageUrl = url;
    patch.studio12PhilosophyImagePixelWidth = dims.width;
    patch.studio12PhilosophyImagePixelHeight = dims.height;
    console.log(`Philosophy: ${path.basename(args.philosophy)} (${dims.width}×${dims.height})`);
    console.log(url);
  }

  if (args.bookCta) {
    if (!fs.existsSync(args.bookCta)) throw new Error(`File not found: ${args.bookCta}`);
    const dims = imageDimensions(args.bookCta);
    const url = await uploadSectionImage(storage, tenantId, args.bookCta);
    patch.studio12BookCtaImageUrl = url;
    patch.studio12BookCtaImagePixelWidth = dims.width;
    patch.studio12BookCtaImagePixelHeight = dims.height;
    console.log(`Book CTA: ${path.basename(args.bookCta)} (${dims.width}×${dims.height})`);
    console.log(url);
  }

  await db.collection("tenants").doc(tenantId).set(patch, { merge: true });
  console.log(`\nTenant: ${tenantId}${args.slug ? ` (${args.slug})` : ""}`);
  console.log(`View: https://${args.slug || tenantId}.getbookking.com/home`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
