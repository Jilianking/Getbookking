#!/usr/bin/env node
/**
 * Capture mobile hero screenshots for template picker thumbnails.
 * Usage (from Test/): node scripts/capture-template-previews.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "Test/Assets.xcassets");
const ORIGIN = process.env.TEMPLATE_PREVIEW_ORIGIN || "https://test-app-96812.web.app";

/** Slug on staging that uses each template family (see seed-demo-accounts.js). */
const CAPTURES = [
  { family: "classic", slug: "northline-tattoo", file: "template-preview-classic.png" },
  { family: "luxe", slug: "gilded-palm", file: "template-preview-luxe.png" },
  { family: "blade", slug: "iron-district-gym", file: "template-preview-blade.png" },
  { family: "stonecut", slug: "stone-cut-barbers", file: "template-preview-stonecut.png" },
  { family: "studio12", slug: "studio-amara", file: "template-preview-studio12.png" },
];

const VIEWPORT = { width: 390, height: 844 };
const CLIP_HEIGHT = 420;

function imagesetDir(assetName) {
  return path.join(OUT_DIR, `${assetName}.imageset`);
}

function writeImageset(assetName, filename) {
  const dir = imagesetDir(assetName);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(OUT_DIR, "_capture_staging", filename),
    path.join(dir, filename)
  );
  fs.writeFileSync(
    path.join(dir, "Contents.json"),
    JSON.stringify(
      {
        images: [{ filename, idiom: "universal", scale: "2x" }],
        info: { author: "xcode", version: 1 },
      },
      null,
      2
    ) + "\n"
  );
}

async function captureOne(page, { slug, file }) {
  const url = `${ORIGIN}/${slug}/home?bk_embed=1`;
  console.log(`Capturing ${slug} → ${file}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  const staging = path.join(OUT_DIR, "_capture_staging");
  fs.mkdirSync(staging, { recursive: true });
  const outPath = path.join(staging, file);
  await page.screenshot({
    path: outPath,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: CLIP_HEIGHT },
  });
  return outPath;
}

async function main() {
  const staging = path.join(OUT_DIR, "_capture_staging");
  fs.mkdirSync(staging, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(90000);

  for (const item of CAPTURES) {
    try {
      await captureOne(page, item);
    } catch (err) {
      console.error(`Failed ${item.slug}:`, err.message);
    }
  }
  await browser.close();

  const assetMap = {
    classic: "TemplatePreviewClassic",
    luxe: "TemplatePreviewLuxe",
    blade: "TemplatePreviewBlade",
    stonecut: "TemplatePreviewStonecut",
    studio12: "TemplatePreviewStudio12",
  };

  for (const item of CAPTURES) {
    const asset = assetMap[item.family];
    const src = path.join(staging, item.file);
    if (!fs.existsSync(src)) continue;
    writeImageset(asset, item.file);
    console.log(`Wrote ${asset}.imageset`);
  }

  fs.rmSync(staging, { recursive: true, force: true });
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
