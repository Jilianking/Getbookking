#!/usr/bin/env node
/**
 * Collage panel PNGs for Blade & Luxe on marketing/templates.html.
 * All panels captured at the same viewport width so tiles scale consistently.
 *
 * Usage:
 *   node scripts/capture-template-collages.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../web/marketing/assets/template-previews");
const BOOKING_HOST = "getbookking.com";
const CAPTURE_WIDTH = 560;

const TEMPLATES = [
  {
    slug: "iron-district-gym",
    path: "home",
    waitSelector: ".blade-hero, #services .blade-service-card",
    minImages: 2,
    panels: [
      {
        file: "blade-panel-main.png",
        mode: "clipTo",
        selector: "#services",
        maxHeight: 680,
      },
      {
        file: "blade-panel-gallery.png",
        mode: "clipTop",
        selector: "#blade-gallery",
        maxHeight: 340,
      },
      {
        file: "blade-panel-book.png",
        mode: "clipTop",
        selector: "#blade-booking",
        maxHeight: 420,
      },
    ],
  },
  {
    slug: "gilded-palm",
    path: "home",
    waitSelector: ".luxe-hero, .luxe-service-card img",
    minImages: 2,
    panels: [
      {
        file: "luxe-panel-main.png",
        mode: "clipTo",
        selector: "#gallery, .luxe-services-section",
        maxHeight: 680,
      },
      {
        file: "luxe-panel-shop.png",
        path: "shop",
        waitSelector: ".luxe-shop-grid img, .luxe-product-card",
        minImages: 1,
        mode: "clipTop",
        selector: ".luxe-shop-page-shell",
        maxHeight: 460,
      },
      {
        file: "luxe-panel-footer.png",
        mode: "clipTop",
        selector: ".luxe-promo",
        maxHeight: 420,
        fallbackSelector: ".luxe-contact",
      },
    ],
  },
];

function pngSize(filePath) {
  try {
    const out = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}"`, { encoding: "utf8" });
    const w = out.match(/pixelWidth:\s*(\d+)/);
    const h = out.match(/pixelHeight:\s*(\d+)/);
    return { width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function forceReveal(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".blade-fade-up, .s12-fade").forEach((el) => {
      el.classList.add("blade-visible");
      el.style.opacity = "1";
      el.style.transform = "none";
    });
  });
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
  await forceReveal(page);
  await page.waitForTimeout(400);
}

async function waitForReady(page, { waitSelector, minImages }) {
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 60000 }).catch(() => {});
  }
  if (minImages > 0 && waitSelector) {
    await page
      .waitForFunction(
        (sel, min) => {
          const scoped = document.querySelectorAll(sel).length
            ? Array.from(document.querySelectorAll(`${sel} img`))
            : Array.from(document.querySelectorAll("img"));
          if (!scoped.length) return min === 0;
          const loaded = scoped.filter((img) => img.complete && img.naturalWidth > 0);
          return loaded.length >= Math.min(min, scoped.length);
        },
        waitSelector,
        minImages,
        { timeout: 60000 }
      )
      .catch(() => {});
  }
  await page.waitForTimeout(1500);
  await forceReveal(page);
}

async function loadPage(page, slug, pagePath, wait) {
  const url = `https://${slug}.${BOOKING_HOST}/${pagePath}?bk_capture=1`;
  await page.setViewportSize({ width: CAPTURE_WIDTH, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForReady(page, wait);
  await scrollRevealForCapture(page);
}

async function captureClipTo(page, selector, outPath, { includeHero = true, maxHeight } = {}) {
  await page.locator("#services, .luxe-services-section, #gallery").first().scrollIntoViewIfNeeded().catch(() => {});
  await forceReveal(page);
  await page.waitForTimeout(300);

  const clip = await page.evaluate(
    ({ sel, includeHero: withHero, maxH }) => {
      const pick = (s) => document.querySelector(s.trim());
      const el = sel.split(",").map(pick).find(Boolean);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const bottom = rect.bottom + window.scrollY;
      const hero = document.querySelector(".blade-hero, .luxe-hero");
      const top = withHero && hero ? 0 : rect.top + window.scrollY;
      let height = Math.max(360, Math.ceil(bottom - top));
      if (maxH) height = Math.min(height, maxH);
      return {
        x: 0,
        y: Math.max(0, Math.floor(top)),
        width: document.documentElement.clientWidth,
        height,
      };
    },
    { sel: selector, includeHero, maxH: maxHeight }
  );

  if (!clip) throw new Error(`No element for clip: ${selector}`);
  await page.screenshot({ path: outPath, clip, fullPage: true });
}

async function captureElement(page, selector, outPath) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.scrollIntoViewIfNeeded();
  await forceReveal(page);
  await page.waitForTimeout(400);
  await loc.screenshot({ path: outPath });
}

async function captureClipTop(page, selector, outPath, { maxHeight, fallbackSelector } = {}) {
  await forceReveal(page);
  const clip = await page.evaluate(
    ({ sel, maxH, fallback }) => {
      const el = document.querySelector(sel) || (fallback ? document.querySelector(fallback) : null);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const height = Math.min(maxH ?? Math.ceil(rect.height), Math.ceil(rect.height));
      return {
        x: 0,
        y: Math.max(0, Math.floor(top)),
        width: document.documentElement.clientWidth,
        height: Math.max(120, Math.ceil(height)),
      };
    },
    { sel: selector, maxH: maxHeight, fallback: fallbackSelector }
  );

  if (!clip) throw new Error(`No element for clipTop: ${selector}`);
  await page.screenshot({ path: outPath, clip, fullPage: true });
}

async function capturePanel(page, template, panel) {
  const outPath = path.join(OUT_DIR, panel.file);
  console.log(`  → ${panel.file} (${CAPTURE_WIDTH}px)`);

  if (panel.path && panel.path !== template.path) {
    await loadPage(page, template.slug, panel.path, panel);
  }

  if (panel.mode === "clipTo") {
    await captureClipTo(page, panel.selector, outPath, {
      includeHero: true,
      maxHeight: panel.maxHeight,
    });
  } else if (panel.mode === "clipTop") {
    await captureClipTop(page, panel.selector, outPath, panel);
  } else if (panel.mode === "element") {
    await captureElement(page, panel.selector, outPath);
  }

  const size = pngSize(outPath);
  console.log(`    saved ${size.width}x${size.height}`);
  return { file: panel.file, ...size };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  for (const template of TEMPLATES) {
    console.log(`Capturing ${template.slug}/${template.path}`);
    await loadPage(page, template.slug, template.path, template);

    for (const panel of template.panels) {
      try {
        results.push(await capturePanel(page, template, panel));
      } catch (err) {
        console.error(`  failed ${panel.file}:`, err.message);
      }
    }
  }

  await browser.close();

  const metaPath = path.join(OUT_DIR, "collage-panels.json");
  fs.writeFileSync(metaPath, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
