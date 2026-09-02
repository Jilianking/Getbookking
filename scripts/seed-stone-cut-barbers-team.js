#!/usr/bin/env node
/**
 * Studio plan + multi-barber roster + portraits for Stone Cut Barbers demo.
 *
 * Usage (from Test/):
 *   node scripts/seed-stone-cut-barbers-team.js
 *
 * Steps: re-seed tenant (studio), seed Diego + James, upload team photos.
 */

const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SLUG = "stone-cut-barbers";
const OWNER_EMAIL = "demo-stone-cut-barbers@getbookking.com";
const ASSETS = path.join(__dirname, "assets/stone-cut-barbers");

const PHOTOS = [
  {
    email: OWNER_EMAIL,
    file: path.join(ASSETS, "marcus-stone-profile.jpg"),
  },
  {
    memberSlug: "diego-cole",
    file: path.join(ASSETS, "10-clipper-fade.jpg"),
  },
  {
    memberSlug: "james-ortiz",
    file: path.join(ASSETS, "08-skin-fade.jpg"),
  },
];

function run(cmd) {
  console.log(`\n→ ${cmd}\n`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

function main() {
  run(`node scripts/seed-demo-accounts.js --only=${SLUG}`);
  run(`node scripts/seed-team-members.js --slug=${SLUG}`);
  for (const photo of PHOTOS) {
    const parts = [
      "node scripts/upload-team-member-photo.js",
      `--slug=${SLUG}`,
      `--file=${photo.file}`,
    ];
    if (photo.email) parts.push(`--email=${photo.email}`);
    if (photo.memberSlug) parts.push(`--member-slug=${photo.memberSlug}`);
    run(parts.join(" "));
  }
  console.log("\nDone. Team page: https://stone-cut-barbers.getbookking.com/team");
}

main();
