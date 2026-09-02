#!/usr/bin/env node
/**
 * Screenshots for barbershop marketing: Stone Cut /team + member profile.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../web/marketing/assets/barber");
const HOST = "stone-cut-barbers.getbookking.com";

async function waitTeamImages(page, min = 3) {
  await page
    .waitForFunction(
      (m) => {
        const imgs = Array.from(
          document.querySelectorAll(".bk-team-roster-photo img, .bk-team-member-hero img")
        );
        if (!imgs.length) return false;
        const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0);
        return loaded.length >= Math.min(m, imgs.length);
      },
      min,
      { timeout: 60000 }
    )
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  const teamPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const teamUrl = `https://${HOST}/team`;
  console.log(`Team: ${teamUrl}`);
  await teamPage.goto(teamUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitTeamImages(teamPage, 3);
  const roster = teamPage.locator(".bk-team-roster-section").first();
  const teamOut = path.join(OUT_DIR, "stonecut-team-desktop.png");
  if (await roster.count()) {
    await roster.screenshot({ path: teamOut });
  } else {
    await teamPage.screenshot({ path: teamOut, fullPage: true });
  }
  console.log(`  saved ${teamOut}`);
  await teamPage.close();

  const mobilePage = await browser.newPage({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
  });
  const memberUrl = `https://${HOST}/team/james-ortiz`;
  console.log(`Member: ${memberUrl}`);
  await mobilePage.goto(memberUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitTeamImages(mobilePage, 1);
  const memberOut = path.join(OUT_DIR, "stonecut-member-mobile.png");
  await mobilePage.screenshot({ path: memberOut, fullPage: false });
  console.log(`  saved ${memberOut}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
