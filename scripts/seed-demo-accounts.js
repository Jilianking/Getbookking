#!/usr/bin/env node
/**
 * Seed marketing demo tenants (solo).
 * Creates Auth owners + Firestore tenants + services.
 *
 * Usage (from Test/):
 *   node scripts/seed-demo-accounts.js
 *   node scripts/seed-demo-accounts.js --only=iron-district-gym
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
const { Firestore, FieldValue, Timestamp } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const { formSchemaForIndustry } = require(path.join(
  __dirname,
  "../functions/signupPayloads.js"
));
const { seedDemoActivity } = require(path.join(
  __dirname,
  "../functions/demoSeedActivityLib.js"
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

/** Weekly schedule helper for demo tenants (minutes from midnight). */
function openDayMinutes(openMin, closeMin) {
  return { closed: false, ranges: [{ openMin, closeMin }] };
}

function weekSameHours(openMin, closeMin) {
  const day = openDayMinutes(openMin, closeMin);
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
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
  "blade:original": paletteTokens({
    bg: "#0A0A08",
    card: "#141410",
    text: "#F5F0E8",
    accent: "#C9A84C",
    accentHover: "#E5C97A",
    featuredBg: "#0A0A08",
    featuredText: "#F5F0E8",
    bookCard: "#141410",
    aboutBg: "#141410",
    aboutText: "#F5F0E8",
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
  "stonecut:barber-chocolate": paletteTokens({
    bg: "#3D2E26",
    card: "#1E1612",
    text: "#F5EDE4",
    accent: "#C0221A",
    accentHover: "#D42A20",
    featuredBg: "#3D2E26",
    featuredText: "#F5EDE4",
    bookCard: "#1A1410",
    aboutBg: "#0E0D0A",
    aboutText: "#A09888",
  }),
  "stonecut:original": paletteTokens({
    bg: "#060604",
    card: "#0E0D0A",
    text: "#E8E0D0",
    accent: "#C0221A",
    accentHover: "#D42A20",
    featuredBg: "#060604",
    featuredText: "#E8E0D0",
    bookCard: "#0E0D0A",
    aboutBg: "#0E0D0A",
    aboutText: "#E8E0D0",
  }),
  "classic:warm-coral": paletteTokens({
    bg: "#FFF9F7",
    card: "#F5E0DA",
    text: "#3A2824",
    accent: "#E07A62",
    accentHover: "#C4624E",
    featuredBg: "#FFF9F7",
    featuredText: "#3A2824",
    bookCard: "#FFFFFF",
    aboutBg: "#3A2824",
    aboutText: "#FFF9F7",
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
    slug: "northline-tattoo",
    email: "demo-northline@getbookking.com",
    firstName: "Sage",
    lastName: "Morales",
    business: "Northline Tattoo",
    displayName: "Northline",
    industry: "tattoos",
    webThemeId: "tattoo-studio-v1",
    webColorPaletteId: "custom",
    paletteKey: "classic:warm-coral",
    subscriptionPlan: "solo",
    tagline: "Permanent, on purpose.",
    serviceCity: "Portland",
    serviceStateAbbr: "OR",
    businessHours: "By appointment · Tue–Sat",
    aboutText:
      "Northline Tattoo is a custom studio built around collaboration, clean execution, and work that ages well. Every piece starts with your idea — we refine design, placement, and pacing together before ink ever touches skin.",
    instagramHandle: "northlinetattoo",
    /* hero + gallery: scripts/assets/northline-tattoo/ — upload via upload-tenant-hero.js + upload-tenant-gallery.js */
    services: [
      { name: "Consultation", description: "Discuss your idea, placement, and design direction.", durationMinutes: 30, price: 0 },
      { name: "Small piece", description: "Minimal or fine line work with balanced coverage.", durationMinutes: 60, price: 200 },
      { name: "Medium piece", description: "Detailed design with thoughtful placement and shading.", durationMinutes: 120, price: 450 },
      { name: "Full session", description: "Large-scale or ongoing work in a focused session.", durationMinutes: 240, price: 900 },
    ],
  },
  {
    slug: "studio-amara",
    email: "demo-studio-amara@getbookking.com",
    firstName: "Amara",
    lastName: "Okonkwo",
    business: "Studio Amara",
    displayName: "Amara",
    industry: "nails",
    webThemeId: "studio-12-v1",
    subscriptionPlan: "solo",
    tagline: "",
    aboutText: "Clean, polished, and done right.",
    serviceCity: "Charleston",
    serviceStateAbbr: "SC",
    address: "75 Wentworth Street\nCharleston, SC 29401",
    mapEmbedLat: 32.7795,
    mapEmbedLng: -79.931,
    mapCaptureImageUrl: "/assets/demo-maps/studio-amara-location.png",
    businessHours: "Mon–Fri 10am–9pm · Sat–Sun 11am–7pm",
    businessHoursWeekly: {
      mon: openDayMinutes(600, 1260),
      tue: openDayMinutes(600, 1260),
      wed: openDayMinutes(600, 1260),
      thu: openDayMinutes(600, 1260),
      fri: openDayMinutes(600, 1260),
      sat: openDayMinutes(660, 1140),
      sun: openDayMinutes(660, 1140),
    },
    studio12HeroEyebrow: "Color · Care · Finish",
    studio12HeroHeadline: "Nails that elevate",
    heroTagline: "every day.",
    studio12PhilosophyHeadline: "Polish is more than color. · It's the details.",
    studio12BookCtaHeadline: "Ready for your · next set?",
    studio12BookCtaBody:
      "Book online in minutes. We'll confirm your slot and follow up with everything you need.",
    instagramHandle: "studioamara",
    webColorPaletteId: "rose-quartz",
    paletteKey: "studio12:rose-quartz",
    /* hero + gallery: scripts/assets/studio-amara/ — upload via upload-tenant-hero.js + upload-tenant-gallery.js */
    /* philosophy + book CTA: upload-tenant-studio12-images.js */
    services: [
      {
        name: "Classic manicure",
        description: "Clean shaping with a polished, natural finish.",
        durationMinutes: 45,
        price: 38,
      },
      {
        name: "Gel manicure",
        description: "Long-lasting color with a high-shine, chip-resistant finish.",
        durationMinutes: 60,
        price: 58,
      },
      {
        name: "Gel extensions",
        description: "Structured length and shape with a refined, salon-perfect look.",
        durationMinutes: 90,
        price: 78,
      },
      {
        name: "Nail art add-on",
        description: "Micro-art, French tips, or detail work per set.",
        durationMinutes: 30,
        price: 18,
      },
    ],
  },
  {
    slug: "stone-cut-barbers",
    email: "demo-stone-cut-barbers@getbookking.com",
    firstName: "Marcus",
    lastName: "Stone",
    business: "Stone Cut Barbers",
    displayName: "Stone Cut",
    industry: "barber",
    webThemeId: "stonecut-v1",
    subscriptionPlan: "solo",
    tagline: "Sharp lines. Warm welcome.",
    serviceCity: "Nashville",
    serviceStateAbbr: "TN",
    businessHours: "Tue–Sat 9am–7pm · Walk-ins welcome until 2pm",
    aboutText:
      "Stone Cut Barbers opened with one simple idea: every client deserves a sharp cut and a warm chair. We take our time — one appointment at a time, full attention, no rush. From skin fades to hot-towel shaves, every service is built around precision, calm, and craft.",
    instagramHandle: "stonecutbarbers",
    webColorPaletteId: "custom",
    paletteKey: "stonecut:barber-chocolate",
    /* hero + gallery: scripts/assets/stone-cut-barbers/ — upload via upload-tenant-hero.js + upload-tenant-gallery.js */
    services: [
      {
        name: "Signature fade",
        description: "Hand-finished skin fade with razor-defined edges and custom texture on top.",
        durationMinutes: 45,
        price: 48,
      },
      {
        name: "Beard sculpt & lineup",
        description: "Shape, line, and finish with straight-razor detailing along cheeks and jaw.",
        durationMinutes: 25,
        price: 32,
      },
      {
        name: "Hot towel shave",
        description: "Traditional straight-razor shave with steamed towels and a post-shave ritual.",
        durationMinutes: 40,
        price: 45,
      },
      {
        name: "The Full Stone Cut",
        description: "Haircut, beard sculpt, hot towel, and scalp treatment — the complete experience.",
        durationMinutes: 75,
        price: 82,
      },
      {
        name: "Kids cut (12 & under)",
        description: "Clean, age-appropriate cuts in a calm chair — parents welcome.",
        durationMinutes: 30,
        price: 28,
      },
      {
        name: "Buzz cut & shape",
        description: "Even clipper work with crisp edges and a quick neck cleanup.",
        durationMinutes: 25,
        price: 35,
      },
    ],
  },
  {
    slug: "gilded-palm",
    email: "demo-gilded-palm@getbookking.com",
    firstName: "Lina",
    lastName: "Vasquez",
    business: "Maison Lumière",
    displayName: "Lumière",
    industry: "hair",
    webThemeId: "luxe-v1",
    subscriptionPlan: "solo",
    tagline: "Elevated hair, tailored to you.",
    serviceCity: "Coral Gables",
    serviceStateAbbr: "FL",
    businessHours: "Mon–Sat 10am–7pm · By appointment",
    luxeHeroTagline: "Hair · Color · Styling",
    luxeShowHomeServicesSection: true,
    shopEnabled: true,
    aboutText:
      "Maison Lumière is a consult-first salon for cuts, color, and styling that feel effortless. We work one client at a time in a calm, light-filled space — precision where it matters, softness where you want it.",
    instagramHandle: "maisonlumiere",
    webColorPaletteId: "custom",
    paletteKey: "luxe:terracotta-clay",
    /* hero + gallery: scripts/assets/gilded-palm/ — upload via upload-tenant-hero.js + upload-tenant-gallery.js */
    /* shop products: scripts/assets/gilded-palm/products.json — seed via seed-tenant-products.js */
    services: [
      {
        name: "Signature cut & style",
        description:
          "Custom cut shaped for your face, hair, and lifestyle — finished with a polished blowout.",
        durationMinutes: 75,
        price: 95,
      },
      {
        name: "Gloss & blowout",
        description: "Smooth, voluminous finish with mirror-like shine.",
        durationMinutes: 45,
        price: 72,
      },
      {
        name: "Single-process color",
        description: "Rich, balanced color with a healthy, luminous finish.",
        durationMinutes: 90,
        price: 145,
      },
      {
        name: "Balayage",
        description: "Hand-painted dimension for soft, sun-kissed movement.",
        durationMinutes: 180,
        price: 240,
      },
    ],
  },
  {
    slug: "iron-district-gym",
    email: "demo-iron-district@getbookking.com",
    firstName: "Jordan",
    lastName: "Reyes",
    business: "Iron District Gym",
    displayName: "Jordan Reyes",
    industry: "custom",
    industryCustomLabel: "Personal trainer",
    webThemeId: "blade-v1",
    webColorPaletteId: "original",
    paletteKey: "blade:original",
    subscriptionPlan: "solo",
    tagline: "Strength coaching for real life.",
    serviceCity: "Denver",
    serviceStateAbbr: "CO",
    businessHours: "Mon–Fri 5am–9pm · Sat 7am–2pm",
    bladeHeroTagline: "Strength. Form. Results.",
    bladeHeroDescription:
      "One-on-one coaching for beginners and experienced lifters — form-first programming, honest feedback, and room to grow at Iron District Gym.",
    aboutText:
      "I'm Jordan Reyes, head coach at Iron District Gym in Denver. I work with beginners learning barbell basics and experienced lifters chasing their next PR. Every session is form-first, progressive, and built around your schedule — not a one-size-fits-all program.\n\nI train in person at Iron District: a no-frills space for people who show up. Book a free strength assessment to get started, or jump into a personal training session when you're ready.",
    reviews: [
      {
        quote: "Jordan fixed my deadlift form in one session. Finally training without back pain.",
        name: "Chris M.",
        service: "Personal training",
      },
      {
        quote: "Clear programming, no fluff. Best coach I've worked with in Denver.",
        name: "Sam T.",
        service: "Strength assessment",
      },
      {
        quote: "The gym is focused and professional. Jordan meets you where you are.",
        name: "Alex R.",
        service: "Coach-led class",
      },
    ],
    instagramHandle: "jordanreyes.coach",
    /* hero + gallery: scripts/assets/iron-district-gym/ — upload via upload-tenant-hero.js + upload-tenant-gallery.js */
    services: [
      {
        name: "Personal training with Jordan",
        description: "One-on-one coaching tailored to your goals, form, and schedule.",
        durationMinutes: 60,
        price: 85,
      },
      {
        name: "Strength assessment",
        description: "Movement screen, baseline lifts, and a clear plan you can follow.",
        durationMinutes: 45,
        price: 0,
      },
      {
        name: "Coach-led class",
        description: "Small-group strength or conditioning — Jordan on the floor, all levels welcome.",
        durationMinutes: 60,
        price: 28,
      },
      {
        name: "Open gym + coach check-in",
        description: "Solo training time at Iron District with Jordan available for form checks.",
        durationMinutes: 60,
        price: 18,
      },
      {
        name: "Nutrition check-in",
        description: "Macro targets, meal timing, and habits that support your training — no fad diets.",
        durationMinutes: 30,
        price: 45,
      },
      {
        name: "Intro session",
        description: "First visit at Iron District: goals, movement basics, and what training here looks like.",
        durationMinutes: 60,
        price: 65,
      },
    ],
  },
];

/** Industry booking fields; demos can override with `formSchema` on the demo object. */
function demoFormSchema(demo) {
  if (demo.formSchema && demo.formSchema.length) return demo.formSchema;
  const base = formSchemaForIndustry(demo.industry);
  if (demo.slug === "studio-amara") {
    return base.concat([
      {
        key: "preferredDays",
        label: "Preferred days",
        type: "text",
        required: false,
      },
      {
        key: "preferredTime",
        label: "Preferred time of day",
        type: "select",
        required: false,
        options: ["Morning", "Afternoon", "Night", "Flexible"],
        placeholder: "Select preferred time",
      },
    ]);
  }
  return base;
}

function serviceArea(city, stateAbbr) {
  return stateAbbr ? `${city}, ${stateAbbr}` : city;
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    password: DEFAULT_PASSWORD,
    only: null,
    withActivity: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--password=")) out.password = arg.slice(11);
    else if (arg.startsWith("--only=")) out.only = arg.slice(7).trim().toLowerCase();
    else if (arg === "--with-activity") out.withActivity = true;
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

  const activeSlugs = new Set();
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const slug = slugify(svc.name);
    activeSlugs.add(slug);
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

  for (const doc of existing.docs) {
    const s = doc.data().slug || slugify(doc.data().name || "");
    if (!activeSlugs.has(s) && doc.data().isActive !== false) {
      await doc.ref.set(
        { isActive: false, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
  }
}

async function seedOne(db, projectId, accessToken, demo, password, opts = {}) {
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
    displayName: demo.displayName || demo.business,
    businessName: demo.business,
    industry: demo.industry,
    ...(demo.industryCustomLabel
      ? { industryCustomLabel: demo.industryCustomLabel }
      : {}),
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
    formSchema: demoFormSchema(demo),
    bookingFormStyleId: demo.bookingFormStyleId || "standard",
    tagline: demo.tagline,
    serviceArea: area,
    serviceCity: demo.serviceCity,
    serviceStateAbbr: demo.serviceStateAbbr,
    businessHours: demo.businessHours || "",
    instagramHandle: demo.instagramHandle || "",
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (demo.businessHoursWeekly) tenantPatch.businessHoursWeekly = demo.businessHoursWeekly;

  if (demo.bladeHeroTagline) tenantPatch.bladeHeroTagline = demo.bladeHeroTagline;
  if (demo.bladeHeroDescription) tenantPatch.bladeHeroDescription = demo.bladeHeroDescription;
  if (demo.address) tenantPatch.address = demo.address;
  if (typeof demo.mapEmbedLat === "number") tenantPatch.mapEmbedLat = demo.mapEmbedLat;
  if (typeof demo.mapEmbedLng === "number") tenantPatch.mapEmbedLng = demo.mapEmbedLng;
  if (demo.mapCaptureImageUrl) tenantPatch.mapCaptureImageUrl = demo.mapCaptureImageUrl;
  if (demo.aboutText) tenantPatch.aboutText = demo.aboutText;
  if (demo.reviews && demo.reviews.length) tenantPatch.reviews = demo.reviews;
  if (demo.luxeHeroTagline) tenantPatch.luxeHeroTagline = demo.luxeHeroTagline;
  if (demo.heroTagline) tenantPatch.heroTagline = demo.heroTagline;
  if (demo.luxeShowHomeServicesSection === true) {
    tenantPatch.luxeShowHomeServicesSection = true;
  }
  if (demo.shopEnabled === true) {
    tenantPatch.shopEnabled = true;
  }
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

  if (opts.withActivity) {
    const activity = await seedDemoActivity(db, tenantId, demo.slug, Timestamp, {
      replace: true,
    });
    console.log(
      `  Activity: ${activity.customers} clients, ${activity.bookings} bookings, ${activity.smsThreads} SMS threads, ${activity.paymentTransactions} payments`
    );
  }

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
Seed marketing demo tenants (Auth owner + Firestore + services).

  node scripts/seed-demo-accounts.js
  node scripts/seed-demo-accounts.js --only=iron-district-gym
  node scripts/seed-demo-accounts.js --with-activity   # also seed bookings, SMS, payments

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
    const r = await seedOne(db, projectId, accessToken, demo, args.password, {
      withActivity: args.withActivity,
    });
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
