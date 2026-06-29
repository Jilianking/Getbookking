/**
 * Marketing demo activity: customers, bookings, SMS, showcase payments (60-day window).
 * Used by scripts/seed-demo-activity.js
 */

const { DEMO_SHOWCASE_STRIPE_ACCOUNT_ID } = require("./demoShowcasePayments");

const DEMO_SEED_SOURCE = "demo-seed";
const DEFAULT_HISTORY_DAYS = 60;

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function atHour(base, hour, minute = 0) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function formatPreferredTime(date) {
  const hour = date.getHours();
  const min = date.getMinutes();
  const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${h12}:${min === 0 ? "00" : String(min).padStart(2, "0")} ${suffix}`;
}

/** Matches functions/index.js customerDocIdForTenant */
function customerDocIdForTenant(email, phone) {
  const digits = (phone || "").toString().replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  const normalizedEmail = (email || "").toString().trim().toLowerCase();
  if (normalizedEmail) {
    return normalizedEmail
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120);
  }
  return `customer_${Date.now()}`;
}

async function resolveTenantBySlug(db, slug) {
  const snap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (snap.empty) throw new Error(`No tenant with slug "${slug}"`);
  const doc = snap.docs[0];
  return { id: doc.id, slug: (doc.data().slug || "").toString(), data: doc.data() };
}

async function loadTenantSeedContext(db, tenantId) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  const tenant = tenantSnap.exists ? tenantSnap.data() : {};
  const ownerUid = (tenant.ownerUid || "").toString();
  let ownerDisplayName = "Owner";
  let ownerEmail = "";
  if (ownerUid) {
    const ownerSnap = await db.collection("users").doc(ownerUid).get();
    if (ownerSnap.exists) {
      const u = ownerSnap.data();
      ownerEmail = (u.email || "").toString();
      const fn = (u.firstName || "").toString().trim();
      const ln = (u.lastName || "").toString().trim();
      const combined = `${fn} ${ln}`.trim();
      ownerDisplayName =
        combined ||
        (u.displayName || "").toString().trim() ||
        (u.name || "").toString().trim() ||
        (tenant.displayName || "").toString().trim() ||
        "Owner";
    }
  }

  const servicesSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("services")
    .get();
  const servicesByName = {};
  for (const doc of servicesSnap.docs) {
    const d = doc.data();
    const name = (d.name || "").toString().trim();
    if (!name) continue;
    const rawPrice = d.price;
    const price =
      typeof rawPrice === "number" && rawPrice >= 0
        ? rawPrice
        : typeof rawPrice === "string" && parseFloat(rawPrice) >= 0
          ? parseFloat(rawPrice)
          : null;
    servicesByName[name] = { id: doc.id, name, price };
  }
  return { ownerUid, ownerDisplayName, ownerEmail, servicesByName, tenant };
}

function resolveService(serviceName, servicesByName) {
  const direct = servicesByName[serviceName];
  if (direct) return { serviceId: direct.id, serviceName: direct.name, price: direct.price };
  const lower = serviceName.toLowerCase();
  for (const [name, meta] of Object.entries(servicesByName)) {
    if (name.toLowerCase() === lower) {
      return { serviceId: meta.id, serviceName: name, price: meta.price };
    }
  }
  return { serviceId: null, serviceName, price: null };
}

/** Per-slug marketing rosters (names, local phones, industry copy). */
const DEMO_ACTIVITY_BY_SLUG = {
  "northline-tattoo": {
    businessLine: "+15035550100",
    paymentPreset: { availableBalanceCents: 184250, pendingBalanceCents: 32000 },
    customers: [
      {
        name: "Elena Vasquez",
        email: "elena.v.mtz@gmail.com",
        phone: "+15032847193",
        notes: "Prefers afternoon sessions. Reference photos on phone.",
        vip: true,
        bookings: [
          { service: "Consultation", status: "completed", dayOffset: -48, price: 0 },
          { service: "Medium piece", status: "confirmed", dayOffset: 4, price: 450 },
          { service: "Touch-up", status: "NEW", dayOffset: 8, price: 200 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -12, body: "Hey! Sending reference pics for the forearm piece" },
          { dir: "outbound", dayOffset: -12, body: "Got them — Thu at 2pm still works?" },
          { dir: "inbound", dayOffset: -11, body: "Perfect, see you then!" },
        ],
      },
      {
        name: "James Whitmore",
        email: "j.whitmore@icloud.com",
        phone: "+19713882041",
        bookings: [
          { service: "Small piece", status: "completed", dayOffset: -35, price: 200 },
          { service: "Small piece", status: "confirmed", dayOffset: -6, price: 200 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -8, body: "Quick question on deposit for the small piece" },
          { dir: "outbound", dayOffset: -8, body: "Deposit is $50 — I'll send a link after we confirm the date" },
        ],
      },
      {
        name: "Sofia Chen",
        email: "sofiachen.art@gmail.com",
        phone: "+15035551204",
        bookings: [
          { service: "Consultation", status: "completed", dayOffset: -22, price: 0 },
          { service: "Full session", status: "confirmed", dayOffset: 11, price: 900 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -3, body: "Touch-up healing great — ready to schedule the big session" },
          { dir: "outbound", dayOffset: -3, body: "Love to hear it. I have the 11th open — want that?" },
        ],
      },
      {
        name: "Marcus Reed",
        email: "marcus.reed.pdx@gmail.com",
        phone: "+15032849017",
        bookings: [
          { service: "Full session", status: "completed", dayOffset: -41, price: 900 },
          { service: "Medium piece", status: "completed", dayOffset: -18, price: 450 },
        ],
        sms: [
          { dir: "outbound", dayOffset: -40, body: "Aftercare sheet is in your email — reach out if anything feels off" },
          { dir: "inbound", dayOffset: -39, body: "Thanks Sage, healing clean so far" },
        ],
      },
      {
        name: "Tyler Nguyen",
        email: "tyler.nguyen@gmail.com",
        phone: "+19714023856",
        bookings: [
          { service: "Consultation", status: "NEW", dayOffset: 2, price: 0 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "First tattoo — nervous but excited. Any availability next week?" },
        ],
      },
      {
        name: "Avery Torres",
        email: "avery.torres@outlook.com",
        phone: "+15032845502",
        bookings: [
          { service: "Touch-up", status: "confirmed", dayOffset: -5, price: 200 },
          { service: "Small piece", status: "NEW", dayOffset: 6, price: 200 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -5, body: "Running 10 min late for touch-up" },
          { dir: "outbound", dayOffset: -5, body: "No worries — see you soon" },
        ],
      },
      {
        name: "Blake Brooks",
        email: "blake.brooks@gmail.com",
        phone: "+15035557891",
        bookings: [
          { service: "Medium piece", status: "completed", dayOffset: -55, price: 450 },
          { service: "Custom piece", status: "confirmed", dayOffset: -14, price: 450 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -14, body: "Can we push custom piece to afternoon?" },
          { dir: "outbound", dayOffset: -14, body: "2:30 works — I'll move it" },
        ],
      },
      {
        name: "Phoenix Wilson",
        email: "phoenix.wilson@gmail.com",
        phone: "+19713889912",
        bookings: [
          { service: "Small piece", status: "completed", dayOffset: -28, price: 200 },
          { service: "Touch-up", status: "declined", dayOffset: -10, price: 200 },
        ],
        sms: [],
      },
      {
        name: "Sage Brown",
        email: "sage.brown.pdx@gmail.com",
        phone: "+15032846188",
        bookings: [
          { service: "Consultation", status: "completed", dayOffset: -52, price: 0 },
          { service: "Full session", status: "confirmed", dayOffset: 15, price: 900 },
        ],
        sms: [
          { dir: "outbound", dayOffset: -2, body: "Reminder: full session is in two weeks — hydrate well the day before" },
        ],
      },
      {
        name: "Jordan Lee",
        email: "jordan.lee@gmail.com",
        phone: "+15035553421",
        bookings: [
          { service: "Medium piece", status: "NEW", dayOffset: 3, price: 450 },
        ],
        sms: [
          { dir: "inbound", dayOffset: 0, body: "Submitted a request — inner bicep, blackwork" },
        ],
      },
      {
        name: "Riley Park",
        email: "riley.park@gmail.com",
        phone: "+19714021109",
        bookings: [
          { service: "Small piece", status: "completed", dayOffset: -19, price: 200 },
        ],
        sms: [],
      },
      {
        name: "Morgan Ellis",
        email: "morgan.ellis@gmail.com",
        phone: "+15032847765",
        bookings: [
          { service: "Consultation", status: "confirmed", dayOffset: 7, price: 0 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -4, body: "Looking for a consult for a rib piece — is that something you do?" },
          { dir: "outbound", dayOffset: -4, body: "Yes — book a consult and we'll map placement + sizing" },
        ],
      },
    ],
  },
  "stone-cut-barbers": {
    businessLine: "+16155550100",
    paymentPreset: { availableBalanceCents: 74200, pendingBalanceCents: 9600 },
    customers: [
      {
        name: "Andre Washington",
        email: "andre.washington@gmail.com",
        phone: "+16155550142",
        bookings: [
          { service: "Signature fade", status: "completed", dayOffset: -32, price: 48 },
          { service: "Signature fade", status: "confirmed", dayOffset: 3, price: 48 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -2, body: "Can I get a mid fade Saturday morning?" },
          { dir: "outbound", dayOffset: -2, body: "9:30am is open — want me to book it?" },
        ],
      },
      {
        name: "Chris Delaney",
        email: "chris.delaney@icloud.com",
        phone: "+16155550218",
        bookings: [
          { service: "Beard sculpt & lineup", status: "completed", dayOffset: -21, price: 32 },
          { service: "The Full Stone Cut", status: "confirmed", dayOffset: 6, price: 82 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -6, body: "Add beard sculpt to my next cut?" },
          { dir: "outbound", dayOffset: -6, body: "Done — upgraded to Full Stone Cut" },
        ],
      },
      {
        name: "Jordan Miles",
        email: "jordan.miles@gmail.com",
        phone: "+16155550301",
        bookings: [
          { service: "Signature fade", status: "NEW", dayOffset: 1, price: 48 },
        ],
        sms: [
          { dir: "inbound", dayOffset: 0, body: "Running 10 min late today" },
          { dir: "outbound", dayOffset: 0, body: "All good — we'll start when you get here" },
        ],
      },
      {
        name: "Kevin Ortiz",
        email: "kevin.ortiz@gmail.com",
        phone: "+16155550477",
        bookings: [
          { service: "Kids cut (12 & under)", status: "completed", dayOffset: -45, price: 28 },
          { service: "Buzz cut & shape", status: "confirmed", dayOffset: -4, price: 35 },
        ],
        sms: [],
      },
      {
        name: "Dylan Howard",
        email: "dylan.howard@gmail.com",
        phone: "+16155550563",
        bookings: [
          { service: "Hot towel shave", status: "completed", dayOffset: -38, price: 45 },
        ],
        sms: [
          { dir: "outbound", dayOffset: -37, body: "Thanks for coming in — same time in 4 weeks?" },
        ],
      },
      {
        name: "Nathan Price",
        email: "nathan.price@gmail.com",
        phone: "+16155550644",
        bookings: [
          { service: "Signature fade", status: "completed", dayOffset: -14, price: 48 },
          { service: "Signature fade", status: "NEW", dayOffset: 5, price: 48 },
        ],
        sms: [],
      },
      {
        name: "Brandon Hughes",
        email: "brandon.hughes@gmail.com",
        phone: "+16155550722",
        bookings: [
          { service: "The Full Stone Cut", status: "confirmed", dayOffset: 9, price: 82 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -3, body: "First time at Stone Cut — parking ok on 8th?" },
          { dir: "outbound", dayOffset: -3, body: "Street parking on 8th — first hour free with validation" },
        ],
      },
      {
        name: "Sean West",
        email: "sean.west@gmail.com",
        phone: "+16155550811",
        bookings: [
          { service: "Beard sculpt & lineup", status: "cancelled", dayOffset: -8, price: 32 },
        ],
        sms: [],
      },
      {
        name: "Marcus Cole",
        email: "marcus.cole@gmail.com",
        phone: "+16155550902",
        bookings: [
          { service: "Signature fade", status: "completed", dayOffset: -52, price: 48 },
          { service: "Signature fade", status: "completed", dayOffset: -25, price: 48 },
        ],
        sms: [],
      },
      {
        name: "Tyler Banks",
        email: "tyler.banks@gmail.com",
        phone: "+16155550988",
        bookings: [
          { service: "Buzz cut & shape", status: "NEW", dayOffset: 2, price: 35 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "Walk-in ok tomorrow or appointment only?" },
        ],
      },
    ],
  },
  "studio-amara": {
    businessLine: "+18435550100",
    paymentPreset: { availableBalanceCents: 58600, pendingBalanceCents: 11200 },
    customers: [
      {
        name: "Mia Thompson",
        email: "mia.thompson@gmail.com",
        phone: "+18435550188",
        bookings: [
          { service: "Gel extensions", status: "completed", dayOffset: -36, price: 78 },
          { service: "Gel manicure", status: "confirmed", dayOffset: 5, price: 58 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -4, body: "Do you have gel extensions open this Friday?" },
          { dir: "outbound", dayOffset: -4, body: "Friday 11am just opened — want it?" },
        ],
      },
      {
        name: "Lauren Price",
        email: "lauren.price@icloud.com",
        phone: "+18435550234",
        bookings: [
          { service: "Classic manicure", status: "completed", dayOffset: -22, price: 38 },
          { service: "Nail art add-on", status: "confirmed", dayOffset: -3, price: 18 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -5, body: "Sending nail art inspo pics!" },
        ],
      },
      {
        name: "Hannah Brooks",
        email: "hannah.brooks@gmail.com",
        phone: "+18435550392",
        bookings: [
          { service: "Gel manicure", status: "NEW", dayOffset: 4, price: 58 },
        ],
        sms: [
          { dir: "inbound", dayOffset: 0, body: "Submitted booking — soft almond shape if possible" },
        ],
      },
      {
        name: "Emma Walsh",
        email: "emma.walsh@gmail.com",
        phone: "+18435550456",
        bookings: [
          { service: "Gel extensions", status: "completed", dayOffset: -48, price: 78 },
        ],
        sms: [],
      },
      {
        name: "Olivia Grant",
        email: "olivia.grant@gmail.com",
        phone: "+18435550517",
        bookings: [
          { service: "Classic manicure", status: "confirmed", dayOffset: 8, price: 38 },
        ],
        sms: [
          { dir: "outbound", dayOffset: -2, body: "Reminder: classic mani Thursday at 4pm" },
        ],
      },
      {
        name: "Sophia Reed",
        email: "sophia.reed@gmail.com",
        phone: "+18435550603",
        bookings: [
          { service: "Gel manicure", status: "completed", dayOffset: -15, price: 58 },
          { service: "Nail art add-on", status: "completed", dayOffset: -15, price: 18 },
        ],
        sms: [],
      },
      {
        name: "Ava Collins",
        email: "ava.collins@gmail.com",
        phone: "+18435550688",
        bookings: [
          { service: "Gel extensions", status: "confirmed", dayOffset: 12, price: 78 },
        ],
        sms: [],
      },
      {
        name: "Chloe Martin",
        email: "chloe.martin@gmail.com",
        phone: "+18435550774",
        bookings: [
          { service: "Classic manicure", status: "NEW", dayOffset: 1, price: 38 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "Any Saturday slots for a classic set?" },
        ],
      },
      {
        name: "Grace Turner",
        email: "grace.turner@gmail.com",
        phone: "+18435550855",
        bookings: [
          { service: "Gel manicure", status: "completed", dayOffset: -55, price: 58 },
        ],
        sms: [],
      },
      {
        name: "Lily Foster",
        email: "lily.foster@gmail.com",
        phone: "+18435550941",
        bookings: [
          { service: "Gel extensions", status: "declined", dayOffset: -9, price: 78 },
        ],
        sms: [],
      },
    ],
  },
  "gilded-palm": {
    businessLine: "+13055550100",
    paymentPreset: { availableBalanceCents: 128400, pendingBalanceCents: 24500 },
    customers: [
      {
        name: "Isabella Romero",
        email: "isabella.romero@gmail.com",
        phone: "+13055550167",
        bookings: [
          { service: "Balayage", status: "completed", dayOffset: -42, price: 240 },
          { service: "Gloss & blowout", status: "confirmed", dayOffset: 7, price: 72 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -7, body: "Balayage consult — can we talk tone before my appointment?" },
          { dir: "outbound", dayOffset: -7, body: "Absolutely — send a few inspo pics and we'll plan" },
        ],
      },
      {
        name: "Camille Laurent",
        email: "camille.laurent@icloud.com",
        phone: "+13055550291",
        bookings: [
          { service: "Signature cut & style", status: "completed", dayOffset: -28, price: 95 },
        ],
        sms: [],
      },
      {
        name: "Natalie Brooks",
        email: "natalie.brooks@gmail.com",
        phone: "+13055550403",
        bookings: [
          { service: "Single-process color", status: "confirmed", dayOffset: 4, price: 145 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -2, body: "Running 15 behind — still ok?" },
          { dir: "outbound", dayOffset: -2, body: "Yes, take your time" },
        ],
      },
      {
        name: "Valentina Cruz",
        email: "valentina.cruz@gmail.com",
        phone: "+13055550488",
        bookings: [
          { service: "Signature cut & style", status: "NEW", dayOffset: 3, price: 95 },
        ],
        sms: [
          { dir: "inbound", dayOffset: 0, body: "New client — looking for a consult + cut" },
        ],
      },
      {
        name: "Elena Vasquez",
        email: "elena.v.miami@gmail.com",
        phone: "+13055550572",
        bookings: [
          { service: "Gloss & blowout", status: "completed", dayOffset: -18, price: 72 },
          { service: "Gloss & blowout", status: "completed", dayOffset: -5, price: 72 },
        ],
        sms: [],
      },
      {
        name: "Julia Hart",
        email: "julia.hart@gmail.com",
        phone: "+13055550661",
        bookings: [
          { service: "Balayage", status: "confirmed", dayOffset: 14, price: 240 },
        ],
        sms: [],
      },
      {
        name: "Amanda Pierce",
        email: "amanda.pierce@gmail.com",
        phone: "+13055550748",
        bookings: [
          { service: "Single-process color", status: "completed", dayOffset: -50, price: 145 },
        ],
        sms: [],
      },
      {
        name: "Rachel Stone",
        email: "rachel.stone@gmail.com",
        phone: "+13055550829",
        bookings: [
          { service: "Signature cut & style", status: "completed", dayOffset: -33, price: 95 },
        ],
        sms: [],
      },
      {
        name: "Diana Moss",
        email: "diana.moss@gmail.com",
        phone: "+13055550914",
        bookings: [
          { service: "Gloss & blowout", status: "NEW", dayOffset: 6, price: 72 },
        ],
        sms: [],
      },
      {
        name: "Laura Kim",
        email: "laura.kim@gmail.com",
        phone: "+13055550996",
        bookings: [
          { service: "Single-process color", status: "cancelled", dayOffset: -11, price: 145 },
        ],
        sms: [],
      },
    ],
  },
  "iron-district-gym": {
    businessLine: "+13035550100",
    paymentPreset: { availableBalanceCents: 91800, pendingBalanceCents: 15400 },
    customers: [
      {
        name: "Chris Mullen",
        email: "chris.mullen@gmail.com",
        phone: "+13035550112",
        bookings: [
          { service: "Strength assessment", status: "completed", dayOffset: -44, price: 0 },
          { service: "Personal training with Jordan", status: "confirmed", dayOffset: 2, price: 85 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -10, body: "Signed up for strength assessment — what should I bring?" },
          { dir: "outbound", dayOffset: -10, body: "Athletic shoes + water. We'll screen movement and set baselines" },
        ],
      },
      {
        name: "Sam Torres",
        email: "sam.torres@gmail.com",
        phone: "+13035550245",
        bookings: [
          { service: "Personal training with Jordan", status: "completed", dayOffset: -30, price: 85 },
          { service: "Personal training with Jordan", status: "confirmed", dayOffset: -3, price: 85 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -4, body: "Can we move Thursday session to 6am?" },
          { dir: "outbound", dayOffset: -4, body: "6am works — see you then" },
        ],
      },
      {
        name: "Alex Rivera",
        email: "alex.rivera@gmail.com",
        phone: "+13035550378",
        bookings: [
          { service: "Intro session", status: "NEW", dayOffset: 5, price: 65 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "Interested in barbell basics — total beginner" },
        ],
      },
      {
        name: "Jordan Hayes",
        email: "jordan.hayes@gmail.com",
        phone: "+13035550462",
        bookings: [
          { service: "Coach-led class", status: "completed", dayOffset: -20, price: 28 },
          { service: "Coach-led class", status: "completed", dayOffset: -6, price: 28 },
        ],
        sms: [],
      },
      {
        name: "Taylor Brooks",
        email: "taylor.brooks@gmail.com",
        phone: "+13035550551",
        bookings: [
          { service: "Personal training with Jordan", status: "completed", dayOffset: -52, price: 85 },
        ],
        sms: [],
      },
      {
        name: "Morgan Lee",
        email: "morgan.lee@gmail.com",
        phone: "+13035550638",
        bookings: [
          { service: "Nutrition check-in", status: "confirmed", dayOffset: 9, price: 45 },
        ],
        sms: [
          { dir: "outbound", dayOffset: -3, body: "Nutrition check-in — log meals for 3 days before we meet" },
        ],
      },
      {
        name: "Casey Dunn",
        email: "casey.dunn@gmail.com",
        phone: "+13035550724",
        bookings: [
          { service: "Open gym + coach check-in", status: "completed", dayOffset: -15, price: 18 },
        ],
        sms: [],
      },
      {
        name: "Riley Shaw",
        email: "riley.shaw@gmail.com",
        phone: "+13035550807",
        bookings: [
          { service: "Intro session", status: "completed", dayOffset: -38, price: 65 },
          { service: "Personal training with Jordan", status: "NEW", dayOffset: 1, price: 85 },
        ],
        sms: [],
      },
      {
        name: "Drew Coleman",
        email: "drew.coleman@gmail.com",
        phone: "+13035550892",
        bookings: [
          { service: "Coach-led class", status: "confirmed", dayOffset: 4, price: 28 },
        ],
        sms: [],
      },
      {
        name: "Jamie Ortiz",
        email: "jamie.ortiz@gmail.com",
        phone: "+13035550976",
        bookings: [
          { service: "Personal training with Jordan", status: "declined", dayOffset: -12, price: 85 },
        ],
        sms: [],
      },
    ],
  },
};

/**
 * Target net revenue ($) per chart week, Wk 1 → Wk 8. Wk 8 must exceed Wk 7 for
 * positive week-over-week; ascending curve supports positive month-over-month.
 */
const SHOWCASE_WEEKLY_NET_DOLLARS = {
  "northline-tattoo": [820, 940, 880, 1020, 960, 1100, 1050, 1280],
  "stone-cut-barbers": [220, 255, 240, 280, 265, 300, 275, 340],
  "studio-amara": [180, 210, 195, 225, 215, 245, 230, 285],
  "gilded-palm": [420, 480, 450, 520, 495, 560, 530, 640],
  "iron-district-gym": [280, 320, 300, 350, 335, 380, 355, 430],
};

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekRangeForWeeksAgo(now, weeksAgo) {
  const weekStart = startOfWeek(now);
  weekStart.setDate(weekStart.getDate() - weeksAgo * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  return { weekStart, weekEnd };
}

function grossFromNetCents(netCents) {
  let gross = Math.max(netCents + 30, Math.round((netCents + 30) / (1 - 0.029)));
  for (let i = 0; i < 40; i++) {
    const fee = estimateStripeFeeCents(gross);
    const net = gross - fee;
    if (net === netCents) return gross;
    gross += net < netCents ? 1 : -1;
  }
  return gross;
}

/**
 * Deterministic 8-week revenue for dashboard chart (positive WoW / MoM).
 * Replaces booking-scattered charges in demoShowcase.payments.
 */
function buildShowcaseWeeklyTransactions(slug, now, Timestamp) {
  const weekly = SHOWCASE_WEEKLY_NET_DOLLARS[slug];
  if (!weekly || weekly.length !== 8) return [];

  const charges = [];
  for (let index = 0; index < 8; index++) {
    const weeksAgo = 7 - index;
    let when;
    if (weeksAgo === 0) {
      // Anchor current-week revenue to today so charts stay positive after re-seed.
      when = new Date(now);
      when.setHours(11, 30, 0, 0);
      if (when > now) {
        when.setDate(when.getDate() - 1);
        when.setHours(11, 30, 0, 0);
      }
    } else {
      const { weekStart } = weekRangeForWeeksAgo(now, weeksAgo);
      when = new Date(weekStart);
      when.setDate(weekStart.getDate() + 3);
      when.setHours(11, 30, 0, 0);
    }

    const netCents = Math.round(weekly[index] * 100);
    const amountCents = grossFromNetCents(netCents);
    const fee = estimateStripeFeeCents(amountCents);
    const weekNum = index + 1;

    charges.push({
      id: `demo_tx_wk${weekNum}`,
      type: "charge",
      amountCents,
      fee,
      netCents: amountCents - fee,
      customerName: "Showcase",
      description: `Week ${weekNum} revenue`,
      createdAt: Timestamp.fromDate(when),
      created: Math.floor(when.getTime() / 1000),
      sourceId: `ch_demo_wk${weekNum}`,
      reportingCategory: "charge",
    });
  }

  charges.sort((a, b) => b.created - a.created);
  return charges;
}

function cloneCustomersForSeed(customers) {
  return customers.map((c) => ({
    ...c,
    bookings: [...(c.bookings || [])],
    sms: c.sms ? [...c.sms] : undefined,
  }));
}

function estimateStripeFeeCents(amountCents) {
  return Math.round(amountCents * 0.029 + 30);
}

function buildPaymentTransactions(customers, servicesByName, now, Timestamp) {
  const charges = [];
  let idx = 0;
  for (const person of customers) {
    for (const b of person.bookings || []) {
      if (b.status !== "completed") continue;
      const resolved = resolveService(b.service, servicesByName);
      const amountCents = Math.round(
        (b.price != null ? b.price : resolved.price != null ? resolved.price : 0) * 100
      );
      if (amountCents <= 0) continue;
      const dayOffset = b.dayOffset;
      const when = atHour(addDays(now, dayOffset), 10 + (idx % 6), (idx % 2) * 30);
      const fee = estimateStripeFeeCents(amountCents);
      const net = amountCents - fee;
      idx += 1;
      charges.push({
        id: `demo_tx_${String(idx).padStart(3, "0")}`,
        type: "charge",
        amountCents,
        fee,
        netCents: net,
        customerName: person.name,
        description: `${resolved.serviceName} — ${person.name}`,
        createdAt: Timestamp.fromDate(when),
        created: Math.floor(when.getTime() / 1000),
        sourceId: `ch_demo_${String(idx).padStart(3, "0")}`,
        reportingCategory: "charge",
      });
    }
  }
  charges.sort((a, b) => b.created - a.created);
  return charges;
}

async function deleteDemoSeedDocs(db, tenantId) {
  const collections = [
    { path: "bookingRequests", field: "source", value: DEMO_SEED_SOURCE },
    { path: "customers", field: "source", value: DEMO_SEED_SOURCE },
    { path: "smsLog", field: "source", value: DEMO_SEED_SOURCE },
    { path: "smsThreads", field: "source", value: DEMO_SEED_SOURCE },
  ];

  for (const { path, field, value } of collections) {
    const col = db.collection("tenants").doc(tenantId).collection(path);
    const snap = await col.where(field, "==", value).get();
    if (snap.empty) continue;
    let batch = db.batch();
    let ops = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  }
}

async function seedDemoActivity(db, tenantId, slug, Timestamp, opts = {}) {
  const config = DEMO_ACTIVITY_BY_SLUG[slug];
  if (!config) throw new Error(`No demo activity config for slug "${slug}"`);

  const now = opts.now ? new Date(opts.now) : new Date();
  if (opts.replace !== false) {
    await deleteDemoSeedDocs(db, tenantId);
  }

  const ctx = await loadTenantSeedContext(db, tenantId);
  const customers = cloneCustomersForSeed(config.customers);
  let batch = db.batch();
  let ops = 0;

  const commitIfNeeded = async () => {
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (let i = 0; i < customers.length; i++) {
    const person = customers[i];
    const customerId = customerDocIdForTenant(person.email, person.phone);
    const customerCreated = addDays(now, -(DEFAULT_HISTORY_DAYS - 3 - (i % 15)));

    batch.set(
      db.collection("tenants").doc(tenantId).collection("customers").doc(customerId),
      {
        name: person.name,
        email: person.email.toLowerCase(),
        phone: person.phone,
        source: DEMO_SEED_SOURCE,
        totalAppointments: (person.bookings || []).filter((b) =>
          ["completed", "confirmed"].includes(b.status)
        ).length,
        vip: !!person.vip,
        notes: person.notes || "",
        createdAt: Timestamp.fromDate(customerCreated),
        updatedAt: Timestamp.fromDate(now),
        lastContact: Timestamp.fromDate(addDays(now, -(i % 14))),
        smsOptedIn: true,
        smsConsentSource: "web_booking",
        smsConsentAt: Timestamp.fromDate(addDays(now, -(30 + i))),
      },
      { merge: true }
    );
    ops += 1;

    for (let b = 0; b < (person.bookings || []).length; b++) {
      const spec = person.bookings[b];
      const start = atHour(addDays(now, spec.dayOffset), 9 + ((i + b) % 8), ((i + b) % 2) * 30);
      const createdAt = addDays(start, -(2 + (b % 4)));
      const resolved = resolveService(spec.service, ctx.servicesByName);
      const bookingRef = db
        .collection("tenants")
        .doc(tenantId)
        .collection("bookingRequests")
        .doc();

      const booking = {
        status: spec.status === "NEW" ? "NEW" : spec.status,
        source: DEMO_SEED_SOURCE,
        tenantId,
        customerId,
        customerName: person.name,
        customerEmail: person.email.toLowerCase(),
        customerPhone: person.phone,
        serviceName: resolved.serviceName,
        preferredTime: formatPreferredTime(start),
        preferredDays: ["Tuesday", "Thursday", "Saturday"].slice(0, 1 + (i % 3)),
        notes: `Demo booking — ${resolved.serviceName}`,
        assignedMemberName: ctx.ownerDisplayName,
        assignedMemberEmail: ctx.ownerEmail || undefined,
        createdAt: Timestamp.fromDate(createdAt),
        requestedStartTime: Timestamp.fromDate(start),
      };
      if (ctx.ownerUid) booking.assignedMemberUid = ctx.ownerUid;
      if (resolved.serviceId) booking.serviceId = resolved.serviceId;
      if (spec.status === "NEW") {
        /* unread inbox */
      } else if (["confirmed", "completed"].includes(spec.status)) {
        booking.smsConsentAccepted = true;
      }

      batch.set(bookingRef, booking);
      ops += 1;
      await commitIfNeeded();
    }

    const threadId = person.phone;
    const messages = person.sms || [];
    if (messages.length) {
      let lastMsg = null;
      for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const msgAt = addDays(now, msg.dayOffset);
        msgAt.setHours(9 + m, 15 * (m % 4), 0, 0);
        const logRef = db.collection("tenants").doc(tenantId).collection("smsLog").doc();
        const isOut = msg.dir === "outbound";
        batch.set(logRef, {
          direction: isOut ? "outbound" : "inbound",
          from: isOut ? config.businessLine : person.phone,
          to: isOut ? person.phone : config.businessLine,
          threadId,
          clientName: person.name,
          body: msg.body.slice(0, 500),
          createdAt: Timestamp.fromDate(msgAt),
          source: DEMO_SEED_SOURCE,
        });
        ops += 1;
        lastMsg = { body: msg.body, at: msgAt, dir: msg.dir };
        await commitIfNeeded();
      }

      if (lastMsg) {
        const threadRef = db.collection("tenants").doc(tenantId).collection("smsThreads").doc(threadId);
        batch.set(
          threadRef,
          {
            threadId,
            counterpartPhone: person.phone,
            clientName: person.name,
            lastMessageBody: lastMsg.body.slice(0, 500),
            lastMessageAt: Timestamp.fromDate(lastMsg.at),
            lastDirection: lastMsg.dir === "outbound" ? "outbound" : "inbound",
            source: DEMO_SEED_SOURCE,
            updatedAt: Timestamp.fromDate(now),
          },
          { merge: true }
        );
        ops += 1;
        await commitIfNeeded();
      }
    }

    await commitIfNeeded();
  }

  if (ops > 0) await batch.commit();

  const transactions = buildShowcaseWeeklyTransactions(slug, now, Timestamp);
  const preset = config.paymentPreset || {};
  const payments = {
    availableBalanceCents: preset.availableBalanceCents ?? 0,
    pendingBalanceCents: preset.pendingBalanceCents ?? 0,
    transactions,
  };

  await db.collection("tenants").doc(tenantId).set(
    {
      stripeAccountId: DEMO_SHOWCASE_STRIPE_ACCOUNT_ID,
      demoShowcase: {
        version: 1,
        seededAt: Timestamp.fromDate(now),
        payments,
      },
      updatedAt: Timestamp.fromDate(now),
    },
    { merge: true }
  );

  const threadCount = customers.filter((c) => (c.sms || []).length).length;
  const bookingCount = customers.reduce((n, c) => n + (c.bookings || []).length, 0);

  return {
    tenantId,
    slug,
    customers: customers.length,
    bookings: bookingCount,
    smsThreads: threadCount,
    paymentTransactions: transactions.length,
  };
}

module.exports = {
  DEMO_SEED_SOURCE,
  DEMO_ACTIVITY_BY_SLUG,
  DEMO_SHOWCASE_STRIPE_ACCOUNT_ID,
  resolveTenantBySlug,
  deleteDemoSeedDocs,
  seedDemoActivity,
};
