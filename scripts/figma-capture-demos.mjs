#!/usr/bin/env node
/**
 * Capture live demo tenant home pages into Figma (html-to-design).
 *
 * Usage:
 *   node scripts/figma-capture-demos.mjs
 *   FIGMA_CAPTURE_IDS='{"Classic":"uuid",...}' node scripts/figma-capture-demos.mjs
 *
 * Requires capture IDs from `generate_figma_design` MCP (one per page, same fileKey).
 */
import { chromium } from "playwright";

const BOOKING_HOST = "getbookking.com";
const VIEWPORT = { width: 1440, height: 900 };

const DEFAULT_CAPTURES = [
  { name: "Classic", slug: "northline-tattoo" },
  { name: "Blade", slug: "iron-district-gym" },
  { name: "Studio 12", slug: "studio-amara" },
  { name: "Stonecut", slug: "stone-cut-barbers" },
  { name: "Luxe", slug: "gilded-palm" },
];

const captureIdMap = process.env.FIGMA_CAPTURE_IDS
  ? JSON.parse(process.env.FIGMA_CAPTURE_IDS)
  : null;

function demoUrl(slug) {
  return `https://${slug}.${BOOKING_HOST}/home?bk_capture=1`;
}

async function waitForGalleryImages(page) {
  await page
    .waitForFunction(
      () => {
        const imgs = Array.from(
          document.querySelectorAll(
            "img[src*='firebasestorage'], .gallery-grid img, .gallery-alt img, .hero img, [class*='hero'] img"
          )
        );
        if (imgs.length === 0) return false;
        const loaded = imgs.filter(
          (img) => img.complete && img.naturalWidth > 0
        );
        return loaded.length >= Math.min(3, imgs.length);
      },
      { timeout: 45000 }
    )
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function captureOne(page, { name, slug, captureId }) {
  if (!captureId) {
    throw new Error(
      `Missing captureId for ${name}. Set FIGMA_CAPTURE_IDS or pass captureId.`
    );
  }

  const url = demoUrl(slug);
  const endpoint = `https://mcp.figma.com/mcp/capture/${captureId}/submit`;

  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["content-security-policy"];
    delete headers["content-security-policy-report-only"];
    await route.fulfill({ response, headers });
  });

  console.log(`[${name}] ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForGalleryImages(page);

  const scriptRes = await page.context().request.get(
    "https://mcp.figma.com/mcp/html-to-design/capture.js"
  );
  const scriptText = await scriptRes.text();
  await page.evaluate((s) => {
    const el = document.createElement("script");
    el.textContent = s;
    document.head.appendChild(el);
  }, scriptText);
  await page.waitForTimeout(600);

  const result = await page.evaluate(
    ({ captureId, endpoint }) =>
      window.figma.captureForDesign({
        captureId,
        endpoint,
        selector: "body",
      }),
    { captureId, endpoint }
  );

  console.log(`[${name}] submitted:`, JSON.stringify(result));
}

async function main() {
  const captures = DEFAULT_CAPTURES.map((c) => ({
    ...c,
    captureId: captureIdMap?.[c.name] || c.captureId,
  }));

  const missing = captures.filter((c) => !c.captureId);
  if (missing.length) {
    console.error(
      "Missing capture IDs for:",
      missing.map((c) => c.name).join(", ")
    );
    console.error(
      'Generate via Figma MCP `generate_figma_design`, then run:\n  FIGMA_CAPTURE_IDS=\'{"Classic":"...","Blade":"...",...}\' node scripts/figma-capture-demos.mjs'
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });

  for (const item of captures) {
    try {
      await captureOne(page, item);
      await page.waitForTimeout(3000);
    } catch (err) {
      console.error(`[${item.name}] failed:`, err.message);
    }
  }

  await browser.close();
  console.log("All captures triggered.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
