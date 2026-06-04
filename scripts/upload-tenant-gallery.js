#!/usr/bin/env node
/**
 * Upload local images to tenants/{tenantId}/gallery/*.jpg and set galleryImages.
 * Optionally mirrors the same URLs to featuredWorkImages (home strip).
 *
 * Usage:
 *   node scripts/upload-tenant-gallery.js --slug=coles-chair --files=a.png,b.png,c.png
 *   node scripts/upload-tenant-gallery.js --slug=coles-chair --file=one.png --file=two.png
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
    files: [],
    featured: true,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--files=")) {
      out.files.push(
        ...arg
          .slice(8)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (arg.startsWith("--file=")) out.files.push(arg.slice(7).trim());
    else if (arg === "--no-featured") out.featured = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function jpegBufferFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return fs.readFileSync(filePath);
  const { execSync } = require("child_process");
  const tmp = path.join(os.tmpdir(), `gallery-upload-${Date.now()}-${Math.random()}.jpg`);
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

async function uploadGalleryImage(storage, tenantId, filePath) {
  const id = crypto.randomUUID();
  const objectPath = `tenants/${tenantId}/gallery/${id}.jpg`;
  const token = crypto.randomUUID();
  const bucket = storage.bucket(BUCKET);
  await bucket.file(objectPath).save(jpegBufferFromFile(filePath), {
    metadata: {
      contentType: "image/jpeg",
      metadata: { firebaseStorageDownloadTokens: token },
    },
    resumable: false,
  });
  return firebaseDownloadUrl(BUCKET, objectPath, token);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.files.length) {
    console.log(`
Upload gallery images for a tenant (/gallery page).

  node scripts/upload-tenant-gallery.js --slug=coles-chair --files=a.png,b.png,c.png
  node scripts/upload-tenant-gallery.js --slug=coles-chair --file=a.png --file=b.png

  --no-featured   do not copy URLs to featuredWorkImages (home strip)
`);
    process.exit(args.help ? 0 : 1);
  }

  for (const f of args.files) {
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
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

  const urls = [];
  for (let i = 0; i < args.files.length; i++) {
    const url = await uploadGalleryImage(storage, tenantId, args.files[i]);
    urls.push(url);
    console.log(`  [${i + 1}/${args.files.length}] ${path.basename(args.files[i])}`);
  }

  const patch = {
    galleryImages: urls,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (args.featured) patch.featuredWorkImages = urls;

  await db.collection("tenants").doc(tenantId).set(patch, { merge: true });

  console.log(`\nTenant: ${tenantId}${args.slug ? ` (${args.slug})` : ""}`);
  console.log(`Gallery: ${urls.length} images`);
  if (args.featured) console.log("Home featured strip: same images");
  console.log(`View: https://${args.slug || "tenant"}.getbookking.com/gallery`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
