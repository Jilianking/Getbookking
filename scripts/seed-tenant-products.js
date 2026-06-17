#!/usr/bin/env node
/**
 * Upload product images and seed tenants/{tenantId}/products.
 *
 * Usage:
 *   node scripts/seed-tenant-products.js --slug=gilded-palm --manifest=scripts/assets/gilded-palm/products.json
 *   node scripts/seed-tenant-products.js --slug=gilded-palm --manifest=... --replace
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
    tenantId: null,
    manifest: "",
    replace: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--manifest=")) out.manifest = arg.slice(11).trim();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg === "--replace") out.replace = true;
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
  const tmp = path.join(os.tmpdir(), `product-upload-${Date.now()}.jpg`);
  execSync(
    `sips -s format jpeg -s formatOptions 82 "${filePath}" --out "${tmp}"`,
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

async function uploadProductImage(storage, tenantId, filePath) {
  const objectName = `${crypto.randomUUID()}.jpg`;
  const objectPath = `tenants/${tenantId}/products/${objectName}`;
  const token = crypto.randomUUID();
  const jpeg = jpegBufferFromFile(filePath);
  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(objectPath);
  await file.save(jpeg, {
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
  if (args.help || !args.manifest) {
    console.log(`
Seed tenant shop products from a JSON manifest.

  node scripts/seed-tenant-products.js --slug=gilded-palm --manifest=scripts/assets/gilded-palm/products.json
  node scripts/seed-tenant-products.js --slug=gilded-palm --manifest=... --replace

Manifest format: array of { file, name, category, description, price, salePrice? }
  "file" is relative to the manifest directory unless absolute.
`);
    process.exit(args.help ? 0 : 1);
  }

  const manifestPath = path.resolve(args.manifest);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const products = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(products) || !products.length) {
    throw new Error("Manifest must be a non-empty JSON array");
  }

  const manifestDir = path.dirname(manifestPath);
  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);
  const tenantId = await resolveTenantId(db, args);

  const productsRef = db.collection("tenants").doc(tenantId).collection("products");

  if (args.replace) {
    const existing = await productsRef.get();
    const batch = db.batch();
    existing.docs.forEach((doc) => batch.delete(doc.ref));
    if (!existing.empty) await batch.commit();
    console.log(`Removed ${existing.size} existing product(s)`);
  }

  for (let i = 0; i < products.length; i++) {
    const item = products[i];
    const relFile = item.file;
    if (!relFile) throw new Error(`Product ${i + 1}: missing "file"`);
    const filePath = path.isAbsolute(relFile)
      ? relFile
      : path.join(manifestDir, relFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Product ${i + 1}: file not found: ${filePath}`);
    }

    console.log(`  [${i + 1}/${products.length}] ${item.name || relFile}`);
    const imageUrl = await uploadProductImage(storage, tenantId, filePath);

    const payload = {
      name: item.name || "Product",
      category: item.category || "",
      price: typeof item.price === "number" ? item.price : 0,
      imageUrl,
      isActive: item.isActive !== false,
      sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : i,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const desc = item.description ? String(item.description).trim() : "";
    if (desc) payload.description = desc;
    if (typeof item.salePrice === "number") payload.salePrice = item.salePrice;

    await productsRef.add(payload);
  }

  console.log(`\nTenant: ${tenantId}${args.slug ? ` (${args.slug})` : ""}`);
  console.log(`Products seeded: ${products.length}`);
  console.log(`Shop: https://${args.slug || tenantId}.getbookking.com/shop`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
