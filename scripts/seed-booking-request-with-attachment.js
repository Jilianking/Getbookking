#!/usr/bin/env node
/**
 * Seed one booking request with a reference image attachment.
 *
 * Usage (from Test/):
 *   node scripts/seed-booking-request-with-attachment.js --email=daisybleu@gmail.com
 *   node scripts/seed-booking-request-with-attachment.js --slug=my-studio --file=/path/to/ref.jpg
 *
 * Auth: firebase login or GOOGLE_APPLICATION_CREDENTIALS
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
const { Firestore, Timestamp } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));

const {
  resolveTenantBySlug,
  resolveTenantByOwnerEmail,
} = require(path.join(__dirname, "../functions/seedBookingRequestsLib"));

const DEFAULT_PROJECT = "test-app-96812";
const BUCKET = "test-app-96812.firebasestorage.app";
const DEFAULT_IMAGE = path.join(
  __dirname,
  "assets/northline-tattoo/02-forearm-florals.jpg"
);

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

function parseArgs(argv) {
  const out = {
    slug: null,
    tenantId: null,
    email: "daisybleu@gmail.com",
    project: DEFAULT_PROJECT,
    file: DEFAULT_IMAGE,
  };
  for (const arg of argv) {
    if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--tenantId=")) out.tenantId = arg.slice(11).trim();
    else if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--file=")) out.file = arg.slice(7).trim();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function createGoogleClients(projectId) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const authClient = await auth.getClient();
    return {
      db: new Firestore({ projectId, authClient }),
      storage: new Storage({ projectId, authClient }),
    };
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
  return {
    db: new Firestore({ projectId, authClient }),
    storage: new Storage({ projectId, authClient }),
  };
}

async function resolveTenantId(db, { slug, tenantId, email }) {
  if (tenantId) {
    const doc = await db.collection("tenants").doc(tenantId).get();
    if (!doc.exists) throw new Error(`Tenant not found: ${tenantId}`);
    return { id: tenantId, slug: (doc.data().slug || "").toString() };
  }
  if (email) {
    return resolveTenantByOwnerEmail(db, email);
  }
  if (slug) {
    return resolveTenantBySlug(db, slug);
  }
  throw new Error("Provide --email=, --slug=, or --tenantId=");
}

function firebaseDownloadUrl(bucketName, objectPath, token) {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

async function uploadReferenceImage(storage, tenantId, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".png"
      ? "image/png"
      : ext === ".pdf"
        ? "application/pdf"
        : "image/jpeg";
  const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  const uploadId = crypto.randomUUID();
  const objectPath = `tenantRefImages/${tenantId}/${uploadId}/${safeName}`;
  const token = crypto.randomUUID();
  const bytes = fs.readFileSync(filePath);

  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(objectPath);
  await file.save(bytes, {
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
    resumable: false,
  });

  return firebaseDownloadUrl(BUCKET, objectPath, token);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed one booking request with a reference image attachment.

  node scripts/seed-booking-request-with-attachment.js --email=daisybleu@gmail.com
  node scripts/seed-booking-request-with-attachment.js --slug=my-studio --file=/path/to/ref.jpg
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, storage } = await createGoogleClients(projectId);
  const tenant = await resolveTenantId(db, args);

  console.log(`Project: ${projectId}`);
  console.log(`Tenant: ${tenant.slug || "(no slug)"} (${tenant.id})`);
  console.log(`Uploading reference image from ${args.file}...`);

  const attachmentUrl = await uploadReferenceImage(storage, tenant.id, args.file);

  const now = new Date();
  const start = new Date(now.getTime() + 3 * 86400000);
  start.setHours(14, 0, 0, 0);

  const doc = {
    status: "NEW",
    source: "seed",
    tenantId: tenant.id,
    customerName: "Alex Rivera",
    customerEmail: "alex.rivera.seed@example.com",
    customerPhone: "5555550101",
    serviceName: "Custom piece",
    preferredTime: "2:00 PM",
    notes: "Interested in fine line florals — see attached reference.",
    formResponses: {
      placement: "Forearm",
      tattooStyle: "Fine line",
      sizeEstimate: "Medium (4–8 in)",
      referenceImages: [attachmentUrl],
    },
    createdAt: Timestamp.fromDate(now),
    requestedStartTime: Timestamp.fromDate(start),
  };

  const ref = await db
    .collection("tenants")
    .doc(tenant.id)
    .collection("bookingRequests")
    .add(doc);

  console.log(`Done. Request id: ${ref.id}`);
  console.log(`Path: tenants/${tenant.id}/bookingRequests/${ref.id}`);
  console.log(`Attachment: ${attachmentUrl}`);
  console.log("Open the app → Requests → pull to refresh.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
