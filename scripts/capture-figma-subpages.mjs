#!/usr/bin/env node
/**
 * Desktop screenshots of template subpages for Figma (shop, booking, etc.).
 * Uses ?bk_capture=1 — hides nav drawer, keeps full page content.
 *
 * Usage:
 *   node scripts/capture-figma-subpages.mjs
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
  {
    slug: "gilded-palm",
    path: "shop",
    file: "luxe-shop-desktop.png",
    waitSelector: ".luxe-product-card img, .luxe-shop-grid img",
    minImages: 1,
  },
  {
    slug: "iron-district-gym",
    path: "book",
    file: "blade-book-desktop.png",
    waitSelector: "#book-form, .booking-form, .booking-guided",
    minImages: 0,
  },
];

function pngHeight(filePath) {
  try {
    const out = execSync(`sips -g pixelHeight "${filePath}"`, { encoding: "utf8" });
    const m = out.match(/pixelHeight:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

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

async function waitForReady(page, { waitSelector, minImages }) {
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 60000 }).catch(() => {});
  }
  if (minImages > 0) {
    await page
      .waitForFunction(
        (sel, min) => {
          const imgs = Array.from(document.querySelectorAll(sel));
          if (!imgs.length) return false;
          const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0);
          return loaded.length >= Math.min(min, imgs.length);
        },
        waitSelector,
        minImages,
        { timeout: 60000 }
      )
      .catch(() => {});
  }
  await page.waitForTimeout(2000);
}

async function captureOne(page, { slug, path: pagePath, file, ...wait }) {
  const url = `https://${slug}.${BOOKING_HOST}/${pagePath}?bk_capture=1`;
  console.log(`Capturing ${slug}/${pagePath} → ${file}`);
  await page.setViewportSize(VIEWPORT);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForReady(page, wait);
  await scrollRevealForCapture(page);
  const outPath = path.join(OUT_DIR, file);
  await page.screenshot({ path: outPath, fullPage: true });
  const h = pngHeight(outPath);
  console.log(`  saved ${WIDTH}x${h}`);
  return { file, width: WIDTH, height: h, slug, path: pagePath };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const results = [];

  for (const item of CAPTURES) {
    try {
      results.push(await captureOne(page, item));
    } catch (err) {
      console.error(`Failed ${item.slug}/${item.path}:`, err.message);
    }
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
