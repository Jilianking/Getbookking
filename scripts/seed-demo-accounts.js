#!/usr/bin/env node
/**
 * Seed four public marketing demo tenants (solo).
 * Creates Auth owners + Firestore tenants + services.
 *
 * Usage (from Test/):
 *   node scripts/seed-demo-accounts.js
 *   node scripts/seed-demo-accounts.js --only=coles-chair
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
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
const DEFAULT_PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD || "BookkingDemo2026!";

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

async function createGoogleClients(projectId) {
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
  const db = new Firestore({ projectId, authClient });
  const accessToken = await auth.getAccessToken();
  return { db, accessToken };
}

async function lookupAuthUserByEmail(projectId, accessToken, email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: [email] }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user =
    data && data.users && data.users.find((u) => u.email === email);
  return user ? { uid: user.localId, email: user.email } : null;
}

async function createOrUpdateAuthUser(projectId, accessToken, { email, password, displayName }) {
  const existing = await lookupAuthUserByEmail(projectId, accessToken, email);
  if (existing) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localId: existing.uid,
          password,
          displayName,
          emailVerified: true,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Auth update failed for ${email}: ${res.status} ${err}`);
    }
    return { uid: existing.uid, created: false };
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        displayName,
        emailVerified: true,
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Auth create failed for ${email}: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return { uid: body.localId, created: true };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Unsplash — crop params for consistent hero/gallery aspect. */
function u(photoId, w, h) {
  var base = "https://images.unsplash.com/photo-" + photoId;
  return (
    base +
    "?auto=format&fit=crop&w=" +
    (w || 1200) +
    (h ? "&h=" + h : "") +
    "&q=85"
  );
}

/** Full color fields for web (matches WebColorPalettes.firestoreUpdates). */
function paletteTokens(t) {
  return {
    backgroundColor: t.bg,
    cardSurfaceColor: t.card,
    textColor: t.text,
    primaryColor: t.accent,
    primaryColorHover: t.accentHover,
    featuredWorkBackgroundColor: t.featuredBg,
    featuredWorkTextColor: t.featuredText,
    bookingFormCardBackgroundColor: t.bookCard,
    galleryPageBackgroundColor: t.featuredBg,
    galleryPageTextColor: t.featuredText,
    aboutSectionBackgroundColor: t.aboutBg,
    aboutSectionTextColor: t.aboutText,
  };
}

const PALETTES = {
  "blade:copper-ledger": paletteTokens({
    bg: "#18120C",
    card: "#261E14",
    text: "#F5EDE4",
    accent: "#D4A050",
    accentHover: "#E8B868",
    featuredBg: "#18120C",
    featuredText: "#F5EDE4",
    bookCard: "#261E14",
    aboutBg: "#261E14",
    aboutText: "#F5EDE4",
  }),
  "studio12:rose-quartz": paletteTokens({
    bg: "#FAF6F7",
    card: "#E8D6DA",
    text: "#3C2E32",
    accent: "#B88490",
    accentHover: "#9A6C78",
    featuredBg: "#FAF6F7",
    featuredText: "#3C2E32",
    bookCard: "#FFFDF9",
    aboutBg: "#3C2E32",
    aboutText: "#FAF6F7",
  }),
  "stonecut:berry-noir": paletteTokens({
    bg: "#0E080C",
    card: "#1A1016",
    text: "#EAE0E6",
    accent: "#A86888",
    accentHover: "#BE80A0",
    featuredBg: "#0E080C",
    featuredText: "#EAE0E6",
    bookCard: "#1A1016",
    aboutBg: "#1A1016",
    aboutText: "#EAE0E6",
  }),
  "luxe:terracotta-clay": paletteTokens({
    bg: "#F9F4EE",
    card: "#E4D0BE",
    text: "#3E2C20",
    accent: "#CC7850",
    accentHover: "#A86040",
    featuredBg: "#F9F4EE",
    featuredText: "#3E2C20",
    bookCard: "#F9F4EE",
    aboutBg: "#3E2C20",
    aboutText: "#F9F4EE",
  }),
};

const DEMO_ACCOUNTS = [
  {
    slug: "coles-chair",
    email: "demo-coles-chair@getbookking.com",
    firstName: "Marcus",
    lastName: "Cole",
    business: "Cole's Chair",
    industry: "barber",
    webThemeId: "blade-v1",
    webColorPaletteId: "copper-ledger",
    paletteKey: "blade:copper-ledger",
    subscriptionPlan: "solo",
    tagline: "Sharp lines. Clean chair.",
    serviceCity: "Austin",
    serviceStateAbbr: "TX",
    businessHours: "Tue–Sat 9am–7pm · Walk-ins until 2pm",
    bladeHeroTagline: "Est. 2016 · Downtown Austin",
    bladeHeroDescription:
      "Precision fades, beard sculpts, and full grooming in a calm, focused chair.",
    instagramHandle: "coleschair",
    /* hero + gallery: custom uploads — not overwritten on seed */
    services: [
      { name: "Skin fade", description: "Clean fade with sharp detailing.", durationMinutes: 45, price: 42 },
      { name: "Beard sculpt", description: "Defined shape and clean finish.", durationMinutes: 20, price: 28 },
      { name: "Line-up", description: "Crisp edges and a polished finish.", durationMinutes: 20, price: 22 },
      { name: "The Full Cole", description: "Haircut, beard, and full grooming.", durationMinutes: 75, price: 65 },
    ],
  },
  {
    slug: "studio-amara",
    email: "demo-studio-amara@getbookking.com",
    firstName: "Amara",
    lastName: "Okonkwo",
    business: "Studio Amara",
    industry: "hair",
    webThemeId: "studio-12-v1",
    subscriptionPlan: "solo",
    tagline: "Color that respects your hair.",
    serviceCity: "Charleston",
    serviceStateAbbr: "SC",
    businessHours: "Wed–Sat 10am–6pm · By appointment",
    studio12HeroEyebrow: "Hair · Color · Treatments",
    studio12HeroHeadline: "Color that respects your hair.",
    studio12PhilosophyHeadline: "Consult-first color in a calm studio.",
    studio12BookCtaHeadline: "Ready for your consultation?",
    studio12BookCtaBody:
      "Tell us your goals — we'll match you with the right service and time.",
    instagramHandle: "studioamara",
    webColorPaletteId: "rose-quartz",
    paletteKey: "studio12:rose-quartz",
    /* hero + gallery: custom uploads — not overwritten on seed */
    services: [
      { name: "Signature cut", description: "Custom cut designed for your look.", durationMinutes: 60, price: 85 },
      { name: "Gloss & blowout", description: "Smooth finish with volume and shine.", durationMinutes: 45, price: 72 },
      { name: "Single process color", description: "Rich, balanced, long-lasting color.", durationMinutes: 90, price: 145 },
      { name: "Balayage", description: "Hand-painted dimension and softness.", durationMinutes: 180, price: 220 },
    ],
  },
  {
    slug: "northline-tattoo",
    email: "demo-northline@getbookking.com",
    firstName: "Sage",
    lastName: "Morales",
    business: "Northline Tattoo",
    industry: "tattoos",
    webThemeId: "stonecut-v1",
    subscriptionPlan: "solo",
    tagline: "Permanent, on purpose.",
    serviceCity: "Portland",
    serviceStateAbbr: "OR",
    businessHours: "By appointment · Tue–Sat",
    instagramHandle: "northlinetattoo",
    webColorPaletteId: "berry-noir",
    paletteKey: "stonecut:berry-noir",
    heroImageUrl: u("1611500641799-7c87404d47d0", 1200, 1500),
    featuredWorkImages: [
      u("1590246292337-6329e383436a", 900, 1100),
      u("1598210987933-0e7d8f7b2b0e", 900, 1100),
      u("1578662996442-48f60103fc96", 900, 1100),
    ],
    galleryImages: [
      u("1611500641799-7c87404d47d0", 800, 1000),
      u("1590246292337-6329e383436a", 800, 1000),
      u("1551218808-94e45611d4d0", 800, 1000),
      u("1578662996442-48f60103fc96", 800, 1000),
    ],
    services: [
      { name: "Consultation", description: "Discuss your idea and design direction.", durationMinutes: 30, price: 0 },
      { name: "Small piece", description: "Minimal or fine line work.", durationMinutes: 60, price: 200 },
      { name: "Medium piece", description: "Detailed design with balanced coverage.", durationMinutes: 120, price: 450 },
      { name: "Full session", description: "Large-scale or ongoing work.", durationMinutes: 240, price: 900 },
    ],
  },
  {
    slug: "gilded-palm",
    email: "demo-gilded-palm@getbookking.com",
    firstName: "Lina",
    lastName: "Vasquez",
    business: "Gilded Palm",
    industry: "nails",
    webThemeId: "luxe-v1",
    subscriptionPlan: "solo",
    tagline: "Quiet luxury for your hands.",
    serviceCity: "Coral Gables",
    serviceStateAbbr: "FL",
    businessHours: "Mon–Sat 10am–7pm",
    luxeHeroTagline: "Nails · Gel · Art",
    instagramHandle: "gildedpalm",
    webColorPaletteId: "terracotta-clay",
    paletteKey: "luxe:terracotta-clay",
    heroImageUrl: u("1604654894610-6dd4e01d13f3", 1200, 1500),
    featuredWorkImages: [
      u("1632345031435-4c42d6e2a88f", 900, 1100),
      u("1519014816941-bf64fb0e2b8e", 900, 1100),
      u("1522335783442-4271ecc10a7f", 900, 1100),
    ],
    galleryImages: [
      u("1604654894610-6dd4e01d13f3", 800, 1000),
      u("1632345031435-4c42d6e2a88f", 800, 1000),
      u("1519014816941-bf64fb0e2b8e", 800, 1000),
      u("1522335783442-4271ecc10a7f", 800, 1000),
    ],
    services: [
      { name: "Classic manicure", description: "Clean shaping with a polished finish.", durationMinutes: 45, price: 38 },
      { name: "Gel manicure", description: "Long-lasting color with high shine.", durationMinutes: 60, price: 58 },
      { name: "Gel extensions", description: "Structured length with a refined shape.", durationMinutes: 90, price: 78 },
      { name: "Nail art add-on", description: "Micro-art and detail per set.", durationMinutes: 30, price: 18 },
    ],
  },
];

function serviceArea(city, stateAbbr) {
  return stateAbbr ? `${city}, ${stateAbbr}` : city;
}

function parseArgs(argv) {
  const out = { project: DEFAULT_PROJECT, password: DEFAULT_PASSWORD, only: null };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--password=")) out.password = arg.slice(11);
    else if (arg.startsWith("--only=")) out.only = arg.slice(7).trim().toLowerCase();
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function findTenantBySlug(db, slug) {
  const snap = await db
    .collection("tenants")
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() };
}

async function upsertServices(db, tenantId, services) {
  const existing = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("services")
    .get();
  const bySlug = new Map();
  for (const doc of existing.docs) {
    const s = doc.data().slug || slugify(doc.data().name || "");
    bySlug.set(s, doc.id);
  }

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const slug = slugify(svc.name);
    const payload = {
      name: svc.name,
      slug,
      description: svc.description || "",
      durationMinutes: svc.durationMinutes,
      price: svc.price,
      sortOrder: i,
      isActive: true,
      updatedAt: FieldValue.serverTimestamp(),
    };
    const existingId = bySlug.get(slug);
    if (existingId) {
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("services")
        .doc(existingId)
        .set(payload, { merge: true });
    } else {
      payload.createdAt = FieldValue.serverTimestamp();
      await db
        .collection("tenants")
        .doc(tenantId)
        .collection("services")
        .doc()
        .set(payload);
    }
  }
}

async function seedOne(db, projectId, accessToken, demo, password) {
  const displayName = `${demo.firstName} ${demo.lastName}`;
  const area = serviceArea(demo.serviceCity, demo.serviceStateAbbr);

  const auth = await createOrUpdateAuthUser(projectId, accessToken, {
    email: demo.email,
    password,
    displayName,
  });

  let tenant = await findTenantBySlug(db, demo.slug);
  let tenantId;

  const tenantPatch = {
    slug: demo.slug,
    displayName: demo.business,
    businessName: demo.business,
    industry: demo.industry,
    ownerUid: auth.uid,
    subscriptionPlan: demo.subscriptionPlan,
    subscriptionStatus: "active",
    isActive: true,
    isDemoAccount: true,
    bookingModeDefault: "request",
    requireApprovalForSlotBookings: true,
    maxBookingWindowDays: 30,
    bufferMinutes: 15,
    webThemeId: demo.webThemeId,
    webColorPaletteId: demo.webColorPaletteId || "",
    tagline: demo.tagline,
    serviceArea: area,
    serviceCity: demo.serviceCity,
    serviceStateAbbr: demo.serviceStateAbbr,
    businessHours: demo.businessHours || "",
    instagramHandle: demo.instagramHandle || "",
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (demo.bladeHeroTagline) tenantPatch.bladeHeroTagline = demo.bladeHeroTagline;
  if (demo.bladeHeroDescription) tenantPatch.bladeHeroDescription = demo.bladeHeroDescription;
  if (demo.luxeHeroTagline) tenantPatch.luxeHeroTagline = demo.luxeHeroTagline;
  if (demo.studio12HeroEyebrow) tenantPatch.studio12HeroEyebrow = demo.studio12HeroEyebrow;
  if (demo.studio12HeroHeadline) tenantPatch.studio12HeroHeadline = demo.studio12HeroHeadline;
  if (demo.studio12PhilosophyHeadline)
    tenantPatch.studio12PhilosophyHeadline = demo.studio12PhilosophyHeadline;
  if (demo.studio12BookCtaHeadline)
    tenantPatch.studio12BookCtaHeadline = demo.studio12BookCtaHeadline;
  if (demo.studio12BookCtaBody) tenantPatch.studio12BookCtaBody = demo.studio12BookCtaBody;
  if (demo.heroImageUrl) tenantPatch.heroImageUrl = demo.heroImageUrl;
  if (demo.featuredWorkImages && demo.featuredWorkImages.length) {
    tenantPatch.featuredWorkImages = demo.featuredWorkImages;
  }
  if (demo.galleryImages && demo.galleryImages.length) {
    tenantPatch.galleryImages = demo.galleryImages;
  }
  if (demo.paletteKey && PALETTES[demo.paletteKey]) {
    Object.assign(tenantPatch, PALETTES[demo.paletteKey]);
  }

  if (tenant) {
    tenantId = tenant.id;
    await db.collection("tenants").doc(tenantId).set(tenantPatch, { merge: true });
    console.log(`Updated tenant ${demo.slug} (${tenantId})`);
  } else {
    tenantPatch.createdAt = FieldValue.serverTimestamp();
    const ref = await db.collection("tenants").add(tenantPatch);
    tenantId = ref.id;
    console.log(`Created tenant ${demo.slug} (${tenantId})`);
  }

  const userPatch = {
    tenantId,
    tenantSlug: demo.slug,
    role: "owner",
    accessRole: "owner",
    email: demo.email,
    firstName: demo.firstName,
    lastName: demo.lastName,
    name: displayName,
    displayName,
    business: demo.business,
    industry: demo.industry,
    subscriptionPlan: demo.subscriptionPlan,
    subscriptionStatus: "active",
    profilePhotoUrl: "",
    availability: {
      timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
      daysOpen: [1, 2, 3, 4, 5, 6],
      timeZone: "America/New_York",
    },
    workflow: {
      confirmationType: "request_approve",
      responseTimeHours: 24,
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
  const userDoc = await db.collection("users").doc(auth.uid).get();
  if (!userDoc.exists) userPatch.createdAt = FieldValue.serverTimestamp();
  await db.collection("users").doc(auth.uid).set(userPatch, { merge: true });

  await upsertServices(db, tenantId, demo.services);

  return {
    slug: demo.slug,
    tenantId,
    email: demo.email,
    authCreated: auth.created,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed four marketing demo tenants (Auth owner + Firestore + services).

  node scripts/seed-demo-accounts.js
  node scripts/seed-demo-accounts.js --only=coles-chair

Password: DEMO_ACCOUNT_PASSWORD env or --password=
`);
    process.exit(0);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const { db, accessToken } = await createGoogleClients(projectId);

  let demos = DEMO_ACCOUNTS;
  if (args.only) {
    demos = demos.filter((d) => d.slug === args.only);
    if (!demos.length) throw new Error(`Unknown slug: ${args.only}`);
  }

  console.log(`Project: ${projectId}\n`);
  const results = [];
  for (const demo of demos) {
    const r = await seedOne(db, projectId, accessToken, demo, args.password);
    results.push(r);
  }

  console.log("\n--- Demo accounts ---\n");
  for (const r of results) {
    console.log(`${r.slug}`);
    console.log(`  Site:  https://${r.slug}.getbookking.com`);
    console.log(`  Alt:   https://test-app-96812.web.app/${r.slug}`);
    console.log(`  Owner: ${r.email}`);
    console.log(`  Pass:  ${args.password}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
