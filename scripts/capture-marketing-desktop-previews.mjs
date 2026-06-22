#!/usr/bin/env node
/**
 * Full desktop home-page screenshots for marketing / Figma.
 * Uses ?bk_capture=1 (hides nav drawer, keeps footer + all home sections).
 * fullPage screenshot at fixed viewport avoids flex min-height empty bands.
 *
 * Usage:
 *   node scripts/capture-marketing-desktop-previews.mjs
 *   node scripts/capture-marketing-desktop-previews.mjs --only=stone-cut-barbers,gilded-palm
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../web/marketing/assets/template-previews");
const BOOKING_HOST = "getbookking.com";
const WIDTH = 1440;
const VIEWPORT = { width: WIDTH, height: 900 };

const CAPTURES = [
  { name: "classic", slug: "northline-tattoo", file: "classic-desktop.png" },
  { name: "blade", slug: "iron-district-gym", file: "blade-desktop.png" },
  { name: "studio12", slug: "studio-amara", file: "studio12-desktop.png" },
  { name: "stonecut", slug: "stone-cut-barbers", file: "stonecut-desktop.png" },
  { name: "luxe", slug: "gilded-palm", file: "luxe-desktop.png" },
];

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlySlugs = onlyArg
  ? onlyArg
      .split("=")[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

/** Scroll full page so IntersectionObserver reveals fade-up sections before screenshot. */
async function scrollRevealForCapture(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const max = document.documentElement.scrollHeight;
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

async function waitForPageReady(page, minImages = 3) {
  await page
    .waitForFunction(
      (min) => {
        const imgs = Array.from(
          document.querySelectorAll(
            "img[src*='firebasestorage'], .gallery-grid img, .gallery-alt img, [class*='hero'] img, .s12-hero img"
          )
        );
        if (!imgs.length) return false;
        const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0);
        return loaded.length >= Math.min(min, imgs.length);
      },
      minImages,
      { timeout: 60000 }
    )
    .catch(() => {});
  await page.waitForTimeout(2000);
  await page
    .waitForFunction(
      () => {
        const mapImg = document.querySelector(".s12-map-embed img");
        if (!mapImg) return true;
        return mapImg.complete && mapImg.naturalWidth > 0;
      },
      { timeout: 30000 }
    )
    .catch(() => {});
}

function pngHeight(filePath) {
  try {
    const out = execSync(`sips -g pixelHeight "${filePath}"`, { encoding: "utf8" });
    const m = out.match(/pixelHeight:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function captureOne(page, { slug, file }) {
  const url = `https://${slug}.${BOOKING_HOST}/home?bk_capture=1`;
  console.log(`Capturing ${slug} → ${file}`);
  await page.setViewportSize(VIEWPORT);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  const minImages = slug === "studio-amara" ? 2 : 3;
  await waitForPageReady(page, minImages);
  await scrollRevealForCapture(page);
  const outPath = path.join(OUT_DIR, file);
  // fullPage at fixed viewport avoids flex min-height empty bands from tall viewports
  await page.screenshot({ path: outPath, fullPage: true });
  const h = pngHeight(outPath);
  console.log(`  saved ${WIDTH}x${h}`);
  return { file, width: WIDTH, height: h };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const items = onlySlugs
    ? CAPTURES.filter((c) => onlySlugs.includes(c.slug) || onlySlugs.includes(c.name))
    : CAPTURES;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const meta = [];

  let existing = [];
  const dimPath = path.join(OUT_DIR, "dimensions.json");
  if (fs.existsSync(dimPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(dimPath, "utf8"));
    } catch (_) {}
  }

  for (const item of items) {
    try {
      const result = await captureOne(page, item);
      const idx = existing.findIndex((e) => e.file === item.file);
      if (idx >= 0) existing[idx] = result;
      else existing.push(result);
      meta.push(result);
    } catch (err) {
      console.error(`Failed ${item.slug}:`, err.message);
    }
  }

  await browser.close();

  if (onlySlugs) {
    for (const cap of CAPTURES) {
      if (!items.find((i) => i.file === cap.file)) {
        const kept = existing.find((e) => e.file === cap.file);
        if (kept) meta.push(kept);
      }
    }
    const merged = CAPTURES.map(
      (c) => meta.find((m) => m.file === c.file) || existing.find((e) => e.file === c.file)
    ).filter(Boolean);
    fs.writeFileSync(dimPath, JSON.stringify(merged, null, 2) + "\n");
  } else {
    fs.writeFileSync(dimPath, JSON.stringify(meta, null, 2) + "\n");
  }

  console.log(`Wrote previews to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
