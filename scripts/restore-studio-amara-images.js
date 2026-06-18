#!/usr/bin/env node
/**
 * Restore Studio Amara demo nail photos when galleryImages was truncated but
 * featuredWorkImages still has the full home-strip set (6 images).
 *
 * Usage (from Test/):
 *   node scripts/restore-studio-amara-images.js
 *   node scripts/restore-studio-amara-images.js --slug=studio-amara
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, FieldValue } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));

const DEFAULT_PROJECT = "test-app-96812";
const DEFAULT_SLUG = "studio-amara";
const GALLERY_TARGET = 6;

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

async function createDb(projectId) {
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
  return new Firestore({ projectId, authClient: await auth.getClient() });
}

function parseArgs(argv) {
  const out = { project: DEFAULT_PROJECT, slug: DEFAULT_SLUG };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--slug=")) out.slug = arg.slice(7).trim().toLowerCase();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls || []) {
    const s = String(u || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Restore demo gallery images from featuredWorkImages when galleryImages is incomplete.

  node scripts/restore-studio-amara-images.js
  node scripts/restore-studio-amara-images.js --slug=studio-amara
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const db = await createDb(projectId);
  const snap = await db
    .collection("tenants")
    .where("slug", "==", args.slug)
    .limit(1)
    .get();
  if (snap.empty) throw new Error(`Tenant not found: ${args.slug}`);

  const ref = snap.docs[0].ref;
  const data = snap.docs[0].data() || {};
  const featured = uniqueUrls(data.featuredWorkImages);
  const gallery = uniqueUrls(data.galleryImages);
  const hero = String(data.heroImageUrl || "").trim();

  let source = featured.length >= GALLERY_TARGET ? featured : gallery;
  if (source.length < GALLERY_TARGET) {
    source = uniqueUrls([...featured, ...gallery, hero]);
  }
  const restoredGallery = source.slice(0, GALLERY_TARGET);

  if (restoredGallery.length < GALLERY_TARGET) {
    throw new Error(
      `Only found ${restoredGallery.length} image URL(s); need ${GALLERY_TARGET}. Upload via upload-tenant-gallery.js first.`
    );
  }

  const patch = {
    galleryImages: restoredGallery,
    featuredWorkImages: restoredGallery,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!data.studio12PhilosophyImageUrl && restoredGallery[2]) {
    patch.studio12PhilosophyImageUrl = restoredGallery[2];
  }
  if (!data.studio12BookCtaImageUrl && restoredGallery[4]) {
    patch.studio12BookCtaImageUrl = restoredGallery[4];
  }

  await ref.set(patch, { merge: true });

  console.log(`Restored ${args.slug} (${snap.docs[0].id})`);
  console.log(`  galleryImages: ${gallery.length} → ${restoredGallery.length}`);
  console.log(`  hero: ${hero ? "ok" : "missing"}`);
  console.log(`  philosophy: ${data.studio12PhilosophyImageUrl || patch.studio12PhilosophyImageUrl || "—"}`);
  console.log(`  book CTA: ${data.studio12BookCtaImageUrl || patch.studio12BookCtaImageUrl || "—"}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
