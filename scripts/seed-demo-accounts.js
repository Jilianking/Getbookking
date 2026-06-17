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
const { formSchemaForIndustry } = require(path.join(
  __dirname,
  "../functions/signupPayloads.js"
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
    slug: "coles-chair",
    email: "demo-coles-chair@getbookking.com",
    firstName: "Marcus",
    lastName: "Cole",
    business: "Cole's Chair",
    industry: "barber",
    webThemeId: "blade-v1",
    webColorPaletteId: "original",
    paletteKey: "blade:original",
    subscriptionPlan: "solo",
    tagline: "Sharp lines. Clean chair.",
    serviceCity: "Austin",
    serviceStateAbbr: "TX",
    businessHours: "Tue–Sat 9am–7pm · Walk-ins until 2pm",
    bladeHeroTagline: "Where every line is intentional",
    bladeHeroDescription:
      "A private grooming experience for men who care about the details. Precision fades, hot-towel shaves, and beard work — unhurried, by appointment.",
    aboutText:
      "Cole's Chair opened in 2016 with one belief: a great haircut should feel like a ritual, not a transaction. Our chair is unhurried — one client at a time, full attention, no walk-in chaos. From the first comb stroke to the final hot towel, every service is built around precision, calm, and craft.",
    reviews: [
      {
        quote: "Best fade I've had in Austin. Marcus doesn't rush — you feel it.",
        name: "James R.",
        service: "Signature fade",
      },
      {
        quote: "The hot-towel shave is unreal. Felt like a different person walking out.",
        name: "David M.",
        service: "Hot-towel shave",
      },
      {
        quote: "Finally a barbershop that treats grooming like an art.",
        name: "Andre T.",
        service: "The Full Cole",
      },
    ],
    instagramHandle: "coleschair",
    /* hero + gallery: uploaded via scripts/upload-tenant-hero.js + upload-tenant-gallery.js */
    services: [
      {
        name: "Signature fade",
        description: "Hand-finished skin fade with razor-defined edges and custom texture.",
        durationMinutes: 50,
        price: 48,
      },
      {
        name: "Beard sculpt",
        description: "Shape, line, and finish with straight-razor detailing.",
        durationMinutes: 25,
        price: 32,
      },
      {
        name: "Hot-towel shave",
        description: "Traditional straight-razor shave with steamed towels and post-shave ritual.",
        durationMinutes: 40,
        price: 45,
      },
      {
        name: "The Full Cole",
        description: "Haircut, beard sculpt, hot towel, and scalp treatment. The complete experience.",
        durationMinutes: 90,
        price: 85,
      },
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
    businessHours: "Wed–Sat 10am–6pm · By appointment",
    studio12HeroEyebrow: "Color · Care · Finish",
    studio12HeroHeadline: "Nails that elevate",
    heroTagline: "every day.",
    studio12PhilosophyHeadline: "Polish is more than color. · It's the details.",
    studio12BookCtaHeadline: "Ready for your · next set?",
    studio12BookCtaBody:
      "Book online in minutes. We'll confirm your slot and follow up with everything you need.",
    instagramHandle: "studioamara",
    webColorPaletteId: "custom",
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
    displayName: demo.displayName || demo.business,
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

  if (demo.bladeHeroTagline) tenantPatch.bladeHeroTagline = demo.bladeHeroTagline;
  if (demo.bladeHeroDescription) tenantPatch.bladeHeroDescription = demo.bladeHeroDescription;
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
