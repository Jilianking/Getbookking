#!/usr/bin/env node
/**
 * Seed beta waitlist entries via the public submitBetaWaitlist callable
 * (same path as web/marketing/testflight.html).
 *
 * Usage (from Test/):
 *   node scripts/seed-beta-waitlist.js
 *   node scripts/seed-beta-waitlist.js --count=20
 *   node scripts/seed-beta-waitlist.js --prefix=beta-demo --count=5
 *   node scripts/seed-beta-waitlist.js --email=you@example.com
 *
 * No auth required — submitBetaWaitlist is a public callable.
 */

const DEFAULT_PROJECT = "test-app-96812";
const DEFAULT_REGION = "us-central1";
const DEFAULT_COUNT = 12;
const DEFAULT_PREFIX = "beta-seed";

const FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Sam",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Quinn",
  "Avery",
  "Drew",
  "Blake",
  "Cameron",
  "Jamie",
  "Reese",
  "Skyler",
];

const LAST_NAMES = [
  "Rivera",
  "Chen",
  "Patel",
  "Nguyen",
  "Brooks",
  "Hayes",
  "Foster",
  "Kim",
  "Morales",
  "Sullivan",
  "Diaz",
  "Wright",
  "Lopez",
  "Bennett",
  "Coleman",
];

const BUSINESSES = [
  { name: "Northline Barber", type: "barber", plan: "solo", teamSize: 1 },
  { name: "Luxe Hair Studio", type: "hair", plan: "studio", teamSize: 3 },
  { name: "Ink & Soul Tattoo", type: "tattoos", plan: "studio", teamSize: 4 },
  { name: "Polish Nail Bar", type: "nails", plan: "solo", teamSize: 1 },
  { name: "FitHouse Gym", type: "fitness", plan: "shop", teamSize: 8 },
  { name: "The Clip Joint", type: "barber", plan: "studio", teamSize: 2 },
  { name: "Glow Salon", type: "hair", plan: "shop", teamSize: 7 },
  { name: "Blackline Tattoo Co", type: "tattoos", plan: "shop", teamSize: 6 },
  { name: "Studio Nails", type: "nails", plan: "studio", teamSize: 5 },
  { name: "Peak Performance", type: "fitness", plan: "studio", teamSize: 3 },
  { name: "Main Street Cuts", type: "barber", plan: "solo", teamSize: 1 },
  { name: "Urban Wellness", type: "other", plan: "shop", teamSize: 9 },
];

function parseArgs(argv) {
  const out = {
    count: DEFAULT_COUNT,
    prefix: DEFAULT_PREFIX,
    project: DEFAULT_PROJECT,
    region: DEFAULT_REGION,
    emulator: false,
    email: null,
    firstName: null,
    lastName: null,
    plan: null,
    teamSize: null,
    businessName: null,
    businessType: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--count=")) {
      out.count = Math.min(100, Math.max(1, parseInt(arg.slice(8), 10) || DEFAULT_COUNT));
    } else if (arg.startsWith("--prefix=")) {
      out.prefix = arg.slice(9).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || DEFAULT_PREFIX;
    } else if (arg.startsWith("--email=")) {
      out.email = arg.slice(8).trim().toLowerCase();
    } else if (arg.startsWith("--first-name=")) {
      out.firstName = arg.slice(13).trim();
    } else if (arg.startsWith("--last-name=")) {
      out.lastName = arg.slice(12).trim();
    } else if (arg.startsWith("--plan=")) {
      out.plan = arg.slice(7).trim().toLowerCase();
    } else if (arg.startsWith("--team-size=")) {
      out.teamSize = parseInt(arg.slice(12), 10);
    } else if (arg.startsWith("--business-name=")) {
      out.businessName = arg.slice(16).trim();
    } else if (arg.startsWith("--business-type=")) {
      out.businessType = arg.slice(16).trim().toLowerCase();
    } else if (arg.startsWith("--project=")) {
      out.project = arg.slice(10).trim();
    } else if (arg.startsWith("--region=")) {
      out.region = arg.slice(9).trim();
    } else if (arg === "--emulator") {
      out.emulator = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }
  return out;
}

function callableUrl(project, region, name, emulator) {
  if (emulator) {
    return `http://127.0.0.1:5001/${project}/${region}/${name}`;
  }
  return `https://${region}-${project}.cloudfunctions.net/${name}`;
}

function buildSingleEntry(args) {
  const biz = BUSINESSES[0];
  return {
    firstName: args.firstName || "Jilian",
    lastName: args.lastName || "King",
    email: args.email,
    plan: args.plan || biz.plan,
    teamSize: Number.isFinite(args.teamSize) ? args.teamSize : biz.teamSize,
    businessName: args.businessName || biz.name,
    businessType: args.businessType || biz.type,
    website: "",
  };
}

function buildEntries(count, prefix) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const biz = BUSINESSES[i % BUSINESSES.length];
    entries.push({
      firstName: FIRST_NAMES[i % FIRST_NAMES.length],
      lastName: LAST_NAMES[i % LAST_NAMES.length],
      email: `${prefix}-${String(i + 1).padStart(3, "0")}@example.com`,
      plan: biz.plan,
      teamSize: biz.teamSize,
      businessName: biz.name,
      businessType: biz.type,
      website: "",
    });
  }
  return entries;
}

async function submitBetaWaitlist(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body?.error?.message ||
      body?.error?.status ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (body.error) {
    throw new Error(body.error.message || JSON.stringify(body.error));
  }
  return body.result || {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed betaWaitlist via submitBetaWaitlist (marketing testflight.html flow).

  node scripts/seed-beta-waitlist.js
  node scripts/seed-beta-waitlist.js --count=20
  node scripts/seed-beta-waitlist.js --prefix=beta-demo --count=5
  node scripts/seed-beta-waitlist.js --email=you@example.com
  node scripts/seed-beta-waitlist.js --emulator

Entries use emails like ${DEFAULT_PREFIX}-001@example.com, or pass --email for one custom entry.
No credentials required.
`);
    process.exit(0);
  }

  const url = callableUrl(args.project, args.region, "submitBetaWaitlist", args.emulator);
  const entries = args.email
    ? [buildSingleEntry(args)]
    : buildEntries(args.count, args.prefix);

  console.log(`Project: ${args.project}`);
  console.log(`Callable: ${url}`);
  console.log(`Submitting ${entries.length} beta waitlist entries...`);

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const result = await submitBetaWaitlist(url, entry);
      if (result.duplicate) {
        updated += 1;
        console.log(`  ~ ${entry.email} (updated existing)`);
      } else {
        created += 1;
        console.log(`  + ${entry.email} (${entry.plan}, ${entry.businessType})`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ! ${entry.email}: ${err.message || err}`);
    }
  }

  console.log(`Done. ${created} created, ${updated} updated, ${failed} failed.`);
  console.log("Open /admin/requests on your marketing site to review.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
