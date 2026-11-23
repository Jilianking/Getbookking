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
          { dir: "inbound", dayOffset: -9, body: "Hey Jordan, can I book a training session this week?" },
          { dir: "outbound", dayOffset: -9, body: "Yeah — I’ve got Tue 6pm or Thu 7am. Either work?" },
          { dir: "inbound", dayOffset: -9, body: "Thursday 7am is perfect" },
          { dir: "outbound", dayOffset: -8, body: "Locked in. See you Thu at 7" },
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
          { dir: "inbound", dayOffset: -5, body: "Something came up — can we reschedule Thursday?" },
          { dir: "outbound", dayOffset: -5, body: "No problem. Friday 6am or Saturday 9?" },
          { dir: "inbound", dayOffset: -4, body: "Friday 6am works" },
          { dir: "outbound", dayOffset: -4, body: "Moved you to Fri 6am. See you then" },
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
          { dir: "inbound", dayOffset: -2, body: "Hi, I’m looking to schedule an intro session. Any openings next week?" },
          { dir: "outbound", dayOffset: -2, body: "I’ve got Mon 5:30pm or Wed 12. Want one of those?" },
          { dir: "inbound", dayOffset: -1, body: "Wednesday at noon please" },
          { dir: "outbound", dayOffset: -1, body: "Booked. I’ll confirm once I review your request" },
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
        sms: [
          { dir: "inbound", dayOffset: -7, body: "Can I switch Saturday’s class to Sunday morning?" },
          { dir: "outbound", dayOffset: -7, body: "Sunday 9am has a spot — want me to move you?" },
          { dir: "inbound", dayOffset: -6, body: "Yes please" },
          { dir: "outbound", dayOffset: -6, body: "Done — you’re on Sunday at 9" },
        ],
      },
      {
        name: "Taylor Brooks",
        email: "taylor.brooks@gmail.com",
        phone: "+13035550551",
        bookings: [
          { service: "Personal training with Jordan", status: "completed", dayOffset: -52, price: 85 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -3, body: "Hey, ready to get back on a weekly schedule. What times do you have?" },
          { dir: "outbound", dayOffset: -3, body: "Tue/Thu mornings or Mon/Wed evenings. Preference?" },
          { dir: "inbound", dayOffset: -2, body: "Tue and Thu mornings work best" },
          { dir: "outbound", dayOffset: -2, body: "Cool — send a booking request for Tue 7am and we’ll lock it" },
        ],
      },
      {
        name: "Morgan Lee",
        email: "morgan.lee@gmail.com",
        phone: "+13035550638",
        bookings: [
          { service: "Nutrition check-in", status: "confirmed", dayOffset: 9, price: 45 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -4, body: "Can we push my nutrition check-in to next week?" },
          { dir: "outbound", dayOffset: -4, body: "Sure — next Tue 4pm or Wed 11?" },
          { dir: "inbound", dayOffset: -3, body: "Tuesday 4 works" },
          { dir: "outbound", dayOffset: -3, body: "Rescheduled to Tue 4pm" },
        ],
      },
      {
        name: "Casey Dunn",
        email: "casey.dunn@gmail.com",
        phone: "+13035550724",
        bookings: [
          { service: "Open gym + coach check-in", status: "completed", dayOffset: -15, price: 18 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "Any chance I can grab a coach check-in tomorrow afternoon?" },
          { dir: "outbound", dayOffset: -1, body: "2:30 or 4:00 open. Which one?" },
          { dir: "inbound", dayOffset: 0, body: "2:30 please" },
          { dir: "outbound", dayOffset: 0, body: "You’re set for 2:30" },
        ],
      },
      {
        name: "Riley Shaw",
        email: "riley.shaw@gmail.com",
        phone: "+13035550807",
        bookings: [
          { service: "Intro session", status: "completed", dayOffset: -38, price: 65 },
          { service: "Personal training with Jordan", status: "NEW", dayOffset: 1, price: 85 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -2, body: "Want to schedule a PT session — do you have anything this weekend?" },
          { dir: "outbound", dayOffset: -2, body: "Sat 10am or Sun 8am. Either good?" },
          { dir: "inbound", dayOffset: -1, body: "Saturday 10" },
          { dir: "outbound", dayOffset: -1, body: "Got it — request is in, I’ll confirm shortly" },
        ],
      },
      {
        name: "Drew Coleman",
        email: "drew.coleman@gmail.com",
        phone: "+13035550892",
        bookings: [
          { service: "Coach-led class", status: "confirmed", dayOffset: 4, price: 28 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -3, body: "Running late today — can we move my class to later this week?" },
          { dir: "outbound", dayOffset: -3, body: "Totally. Thu 6pm still open if that helps" },
          { dir: "inbound", dayOffset: -2, body: "Yes, Thursday works" },
          { dir: "outbound", dayOffset: -2, body: "Moved you to Thu 6pm" },
        ],
      },
      {
        name: "Jamie Ortiz",
        email: "jamie.ortiz@gmail.com",
        phone: "+13035550976",
        bookings: [
          { service: "Personal training with Jordan", status: "declined", dayOffset: -12, price: 85 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -12, body: "Hey, can I schedule something for next Monday evening?" },
          { dir: "outbound", dayOffset: -12, body: "I’m full Mon — Tue 6:30pm or Wed 7?" },
          { dir: "inbound", dayOffset: -11, body: "Actually need to hold off for now, sorry" },
          { dir: "outbound", dayOffset: -11, body: "No worries — text me when you’re ready and we’ll find a time" },
        ],
      },
    ],
  },
  "harbor-charters": {
    businessLine: "+13055550110",
    paymentPreset: { availableBalanceCents: 246800, pendingBalanceCents: 41200 },
    customers: [
      {
        name: "Danielle Ruiz",
        email: "danielle.ruiz.kw@gmail.com",
        phone: "+13055551102",
        notes: "Loves the yellowtail bite. Prefers sunrise departures from Garrison Bight.",
        vip: true,
        bookings: [
          { service: "Half-Day Reef Charter", status: "completed", dayOffset: -41, price: 450, pay: [["card", "deposit", 100], ["tap", "balance", 350]] },
          { service: "Half-Day Reef Charter", status: "confirmed", dayOffset: 5, price: 450, pay: [["card", "deposit", 100]] },
        ],
        sms: [
          { dir: "inbound", dayOffset: -6, body: "We still meeting at Garrison Bight at 6:30?" },
          { dir: "outbound", dayOffset: -6, body: "Yep — Sea Ya Later, slip side of the bight. Sunscreen and a cooler for the catch." },
          { dir: "inbound", dayOffset: -5, body: "Y’all got the yellowtail bite this week?" },
          { dir: "outbound", dayOffset: -5, body: "It’s been on. Patch reefs have been lighting up after the first chum." },
        ],
      },
      {
        name: "Chris Pell",
        email: "chris.pell@gmail.com",
        phone: "+13055551148",
        bookings: [
          { service: "Bachelor / Bachelorette Boat Day", status: "completed", dayOffset: -22, price: 1400, pay: [["card", "deposit", 300], ["link", "balance", 1100]] },
          { service: "Key West Sandbar Day", status: "confirmed", dayOffset: 9, price: 680, pay: [["card", "deposit", 150], ["cash", "balance", 200]] },
        ],
        sms: [
          { dir: "inbound", dayOffset: -8, body: "Wedding crew wants another sandbar day — Bluetooth and cooler ok?" },
          { dir: "outbound", dayOffset: -8, body: "That’s the whole point. BYOB, no glass. Conch Crusher holds 8." },
        ],
      },
      {
        name: "Sam Torres",
        email: "sam.torres.fl@gmail.com",
        phone: "+13055551207",
        bookings: [
          { service: "Family Flats & Harbor Trip", status: "completed", dayOffset: -18, price: 500, pay: [["card", "deposit", 100]] },
          { service: "Half-Day Reef Charter", status: "confirmed", dayOffset: 0, price: 450, pay: [["card", "deposit", 100]] },
          { service: "Family Flats & Harbor Trip", status: "pending_deposit", dayOffset: 3, price: 500, depositRequest: 100 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -2, body: "Kids ok on the flats trip? They’re 7 and 10." },
          { dir: "outbound", dayOffset: -2, body: "Perfect ages. Life jackets on board, we work the harbor close to the bight." },
        ],
      },
      {
        name: "Jamie Ortiz",
        email: "jamie.ortiz.kw@gmail.com",
        phone: "+13055551284",
        bookings: [
          { service: "Full-Day Offshore Charter", status: "completed", dayOffset: -33, price: 950, pay: [["tap", "payment", 950]] },
          { service: "Full-Day Offshore Charter", status: "confirmed", dayOffset: 12, price: 950, pay: [["link", "payment", 950]] },
        ],
        sms: [
          { dir: "inbound", dayOffset: -4, body: "Bringing a cooler for mahi — that cool?" },
          { dir: "outbound", dayOffset: -4, body: "Bring a big one. We’ll filet at the dock when we hit Garrison Bight." },
        ],
      },
      {
        name: "Elena Vasquez",
        email: "elena.v.keys@gmail.com",
        phone: "+13055551351",
        bookings: [
          { service: "Mallory Square Sunset Cruise", status: "completed", dayOffset: -9, price: 250, pay: [["tap", "payment", 250]] },
          { service: "Mallory Square Sunset Cruise", status: "confirmed", dayOffset: 2, price: 250, pay: [["card", "deposit", 50]] },
        ],
        sms: [
          { dir: "inbound", dayOffset: -1, body: "Sunset still going out if it’s breezy?" },
          {
            dir: "outbound",
            dayOffset: -1,
            body: "If we can leave Palm Key Marina safely, we’re on. I’ll text if we need to move it.",
          },
          {
            dir: "inbound",
            dayOffset: 0,
            body: "Looks like storms tomorrow — can we reschedule the sunset cruise?",
          },
          {
            dir: "outbound",
            dayOffset: 0,
            body: "Yeah, better safe. Want Saturday same time, or Sunday?",
          },
          { dir: "inbound", dayOffset: 0, body: "Saturday works for us" },
          {
            dir: "outbound",
            dayOffset: 0,
            body: "Locked in for Saturday — same time at the Palm Key Marina dock. I’ll text if anything shifts.",
          },
        ],
      },
      {
        name: "Marcus Hale",
        email: "marcus.hale@gmail.com",
        phone: "+13055551419",
        bookings: [
          { service: "Night Yellowtail Bite", status: "completed", dayOffset: -14, price: 480 },
          { service: "Night Yellowtail Bite", status: "confirmed", dayOffset: 6, price: 480 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -3, body: "What time do we meet for the night bite?" },
          { dir: "outbound", dayOffset: -3, body: "7:30 at Garrison Bight. Bring a light jacket — it cools off on the run." },
        ],
      },
      {
        name: "Priya Shah",
        email: "priya.shah.fl@gmail.com",
        phone: "+13055551486",
        bookings: [
          { service: "Key West Sandbar Day", status: "completed", dayOffset: -27, price: 680 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -7, body: "Snorkel gear on the boat or should we pack ours?" },
          { dir: "outbound", dayOffset: -7, body: "We have masks on board. Pack sunscreen — Keys sun is no joke." },
        ],
      },
      {
        name: "Tyler Brooks",
        email: "tyler.brooks.kw@gmail.com",
        phone: "+13055551553",
        bookings: [
          { service: "Half-Day Reef Charter", status: "NEW", dayOffset: 1, price: 450 },
        ],
        sms: [
          { dir: "inbound", dayOffset: 0, body: "First time in Key West — reef trip for 4 tomorrow morning?" },
          { dir: "outbound", dayOffset: 0, body: "Sea Ya Later is open at 7. Gear and FL licenses are included." },
        ],
      },
      {
        name: "Lauren Kim",
        email: "lauren.kim.fl@gmail.com",
        phone: "+13055551620",
        bookings: [
          { service: "Full-Day Offshore Charter", status: "completed", dayOffset: -48, price: 950 },
        ],
        sms: [],
      },
      {
        name: "Jordan Hale",
        email: "jordan.hale.kw@gmail.com",
        phone: "+13055551755",
        bookings: [
          { service: "Half-Day Reef Charter", status: "NEW", dayOffset: 4, price: 450 },
        ],
        sms: [
          {
            dir: "inbound",
            dayOffset: 0,
            body: "Hey — can we book a half-day reef trip for 4 next week?",
          },
          {
            dir: "outbound",
            dayOffset: 0,
            body: "We’ve got Thursday or Friday morning open. Which works better?",
          },
          { dir: "inbound", dayOffset: 0, body: "Thursday morning is perfect" },
          {
            dir: "outbound",
            dayOffset: 0,
            body: "Great — I’ll send a deposit link to confirm the spot. Once that’s paid, you’re locked in.",
          },
        ],
      },
      {
        name: "Drew Coleman",
        email: "drew.coleman.kw@gmail.com",
        phone: "+13055551688",
        bookings: [
          { service: "Bachelor / Bachelorette Boat Day", status: "cancelled", dayOffset: -11, price: 1400 },
        ],
        sms: [
          { dir: "inbound", dayOffset: -11, body: "Have to push the boat day — storm coming through?" },
          { dir: "outbound", dayOffset: -11, body: "Yeah, Keys are kicking up. I’ll refund and you can rebook a calmer day." },
        ],
      },
    ],
    // About two years of trips so Insights has a full chart and a "last year" line to compare with.
    history: {
      seed: 13,
      pastDays: 740,
      futureDays: 30,
      perDay: 0.7,
      growthFrom: 0.72,
      onlineShare: 0.7,
      areaCode: "305",
      clients: 72,
      // Key West: busy late winter and spring, steady summer, slow in September and October.
      season: [1.1, 1.25, 1.4, 1.3, 1.1, 1.05, 1.15, 0.85, 0.55, 0.7, 0.85, 1.0],
      weekday: [1.3, 0.8, 0.8, 0.85, 0.95, 1.15, 1.5],
      services: [
        { name: "Half-Day Reef Charter", price: 450, minutes: 240, weight: 30, times: [[7, 0], [12, 30]] },
        { name: "Full-Day Offshore Charter", price: 950, minutes: 480, weight: 13, times: [[6, 30]] },
        { name: "Key West Sandbar Day", price: 680, minutes: 360, weight: 16, times: [[10, 0]] },
        { name: "Mallory Square Sunset Cruise", price: 250, minutes: 120, weight: 17, times: [[17, 30]] },
        { name: "Night Yellowtail Bite", price: 480, minutes: 240, weight: 8, times: [[19, 0]] },
        { name: "Family Flats & Harbor Trip", price: 500, minutes: 240, weight: 10, times: [[8, 30], [13, 0]] },
        { name: "Bachelor / Bachelorette Boat Day", price: 1400, minutes: 480, weight: 6, times: [[10, 30]] },
      ],
      firstNames: [
        "Avery", "Brooke", "Caleb", "Dana", "Ethan", "Faith", "Grant", "Hannah", "Isaac", "Jenna",
        "Kyle", "Leah", "Mason", "Nora", "Owen", "Paige", "Quinn", "Reid", "Sophie", "Trent",
        "Uma", "Vince", "Whitney", "Xavier", "Yara", "Zach", "Carly", "Derek", "Megan", "Nolan",
      ],
      lastNames: [
        "Adler", "Barrett", "Cortez", "Dalton", "Ellis", "Fowler", "Garner", "Hayes", "Irwin", "Jensen",
        "Keller", "Lowry", "Mercer", "Nash", "Osborne", "Pruitt", "Quill", "Rowe", "Sutton", "Tate",
        "Underwood", "Vance", "Whitlock", "Yates", "Zeller", "Archer", "Bishop", "Crane", "Doyle", "Emery",
      ],
    },
    // Shown as connected in Settings; no real Instagram account behind it, so replies won't send.
    instagram: {
      username: "harborcharterskw",
      igUserId: "demo-harbor-charters-ig",
      // [direction, minutes ago, text]
      threads: [
        {
          handle: "tara.on.the.water",
          messages: [
            ["inbound", 26, "Hi! Do you have room for 6 this Saturday morning? Looking at the half-day reef trip."],
            ["outbound", 21, "We do. Saturday at 7am is open on Sea Ya Later. Want me to send the booking link?"],
            ["inbound", 14, "Yes please"],
            ["outbound", 11, "Here you go. A $90 deposit holds the spot, and the rest is due at the dock."],
          ],
        },
        {
          handle: "mattandkels",
          messages: [
            ["inbound", 135, "How much for a sandbar day for a bachelorette group of 8?"],
            ["outbound", 120, "Sandbar Day is $680 for up to 8. The Bachelorette Boat Day is $1,400 for 8 hours with music and a lunch stop. Which sounds more like your crew?"],
            ["inbound", 96, "The boat day for sure. Is June 14 open?"],
          ],
        },
        {
          handle: "keysfamilytravels",
          messages: [
            ["inbound", 1250, "Can we bring our dog on the sunset cruise? He is very calm."],
            ["outbound", 1230, "Well-behaved dogs are welcome on the sunset cruise. Bring water for him, there is shade on board."],
            ["inbound", 1215, "Amazing, booking now"],
          ],
        },
        {
          handle: "offshore_dave",
          messages: [
            ["inbound", 4400, "Mahi still running?"],
            ["outbound", 4380, "They have been on the weedlines about 20 miles out. The full day is your best shot."],
            ["inbound", 4300, "Booked the full day for the 12th. See you then"],
            ["outbound", 4290, "See you at Garrison Bight at 6:30."],
          ],
        },
        {
          handle: "jenn.travels.fl",
          messages: [
            ["inbound", 8700, "Is the 8am trip still on with this wind?"],
            ["outbound", 8650, "We are moving it to the afternoon when it lays down. Same price, I will text you the new time."],
            ["inbound", 8600, "Perfect, thank you"],
          ],
        },
        {
          handle: "brookeandben",
          messages: [
            ["inbound", 13100, "Do you do proposals on the sunset cruise?"],
            ["outbound", 13000, "We have done a bunch. Tell me the date and we will make sure the ring gets on and off the boat safely."],
          ],
        },
      ],
    },
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
  "harbor-charters": [980, 1120, 1040, 1280, 1180, 1420, 1340, 1680],
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

/* ── Screenshot extras: a long booking history (Insights) and Instagram DMs ── */

// Booked online through the shop's site: Insights counts a source containing "web" with no createdByUid.
const DEMO_SEED_WEB_SOURCE = "demo-seed-web";
const DAY_MS = 24 * 60 * 60 * 1000;

function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rng, list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of list) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return list[list.length - 1];
}

/** Made-up clients (555 numbers, example.com emails). The first dozen are regulars. */
function historyClients(spec) {
  const firsts = spec.firstNames;
  const lasts = spec.lastNames;
  const out = [];
  for (let i = 0; i < spec.clients; i++) {
    const first = firsts[i % firsts.length];
    const last = lasts[(i + Math.floor(i / firsts.length) * 7) % lasts.length];
    out.push({
      name: `${first} ${last}`,
      email: `${first}.${last}${i}@example.com`.toLowerCase(),
      phone: `+1${spec.areaCode}555${String(2000 + i).padStart(4, "0")}`,
      weight: i < 12 ? 6 : i < 30 ? 2 : 1,
    });
  }
  return out;
}

/** One row per trip from pastDays ago to futureDays ahead, shaped by season, weekday, and growth. */
function buildHistoryRows(spec, now) {
  const rng = seededRandom(spec.seed);
  const clients = historyClients(spec);
  const rows = [];
  for (let day = -spec.pastDays; day <= spec.futureDays; day++) {
    const date = addDays(now, day);
    const progress = Math.min(1, (day + spec.pastDays) / spec.pastDays);
    const growth = spec.growthFrom + (1 - spec.growthFrom) * progress;
    let expected = spec.perDay * spec.season[date.getMonth()] * spec.weekday[date.getDay()] * growth;
    // Further out, fewer trips are booked yet.
    if (day > 0) expected *= day <= 14 ? 0.9 : 0.6;
    let count = Math.floor(expected);
    if (rng() < expected - count) count += 1;
    const used = new Set();
    for (let k = 0; k < count; k++) {
      const svc = pickWeighted(rng, spec.services);
      const time = svc.times[Math.floor(rng() * svc.times.length)];
      const key = `${svc.name}@${time[0]}:${time[1]}`;
      if (used.has(key)) continue;
      used.add(key);
      const start = atHour(date, time[0], time[1]);
      const past = start < now;
      const r = rng();
      let status = "confirmed";
      let noShow = false;
      if (past) {
        if (r < 0.05) status = "cancelled";
        else if (r < 0.085) noShow = true;
        else status = "completed";
      } else if (day <= 7 && r < 0.06) status = "NEW";
      else if (r < 0.14) status = "pending_deposit";
      rows.push({
        client: pickWeighted(rng, clients),
        svc,
        start,
        status,
        noShow,
        online: rng() < spec.onlineShare,
        leadDays: 2 + Math.floor(Math.pow(rng(), 2) * 45),
        payRoll: rng(),
        kindRoll: rng(),
      });
    }
  }
  return { clients, rows };
}

/** Payments for a history trip: deposit (or paid in full) up front, balance at the dock. */
function historyPayments(row, priceDollars, createdAt) {
  const deposit = Math.max(50, Math.round((priceDollars * 0.2) / 10) * 10);
  const pays = [];
  if (["cancelled", "NEW", "pending_deposit"].includes(row.status)) return { pays, deposit };
  const upfront = row.online ? "card" : "link";
  if (row.payRoll < 0.18 && !row.noShow) {
    pays.push([upfront, "payment", priceDollars, createdAt]);
    return { pays, deposit };
  }
  pays.push([upfront, "deposit", deposit, createdAt]);
  if (row.status === "completed") {
    const k = row.kindRoll;
    const kind = k < 0.45 ? "tap" : k < 0.7 ? "link" : k < 0.85 ? "cash" : "card";
    pays.push([kind, "balance", priceDollars - deposit, row.start]);
  }
  return { pays, deposit };
}

function paymentEntry(kind, role, cents, at, now, Timestamp) {
  return {
    kind,
    role,
    cents,
    grossCents: kind === "cash" ? cents : Math.round(cents * 1.039 + 30),
    at: Timestamp.fromDate(at > now ? now : at),
  };
}

/**
 * Weekly revenue rows for the demo payment shim, from what the seeded trips actually took in.
 * Ids start with txn_ so Insights pages back through all of them (it pages on Stripe-style ids).
 */
function buildWeeklyTransactionsFromEntries(entries, now, weeks, Timestamp) {
  const thisWeek = startOfWeek(now);
  const sums = new Array(weeks).fill(0);
  for (const e of entries) {
    if (e.at > now) continue;
    const back = Math.round((thisWeek - startOfWeek(e.at)) / (7 * DAY_MS));
    const idx = weeks - 1 - back;
    if (idx >= 0 && idx < weeks) sums[idx] += e.cents;
  }
  // This week is only partway done: keep it a little ahead of last week so the Home chart reads up.
  if (weeks > 1) sums[weeks - 1] = Math.max(sums[weeks - 1], Math.round(sums[weeks - 2] * 1.08));
  const charges = [];
  for (let index = 0; index < weeks; index++) {
    const amountCents = sums[index];
    if (amountCents <= 0) continue;
    const weeksAgo = weeks - 1 - index;
    let when;
    if (weeksAgo === 0) {
      when = atHour(now, 11, 30);
      if (when > now) when = atHour(addDays(now, -1), 11, 30);
    } else {
      const { weekStart } = weekRangeForWeeksAgo(now, weeksAgo);
      when = atHour(addDays(weekStart, 3), 11, 30);
    }
    const fee = estimateStripeFeeCents(amountCents);
    const n = String(index + 1).padStart(3, "0");
    charges.push({
      id: `txn_demo_wk${n}`,
      type: "charge",
      amountCents,
      fee,
      netCents: amountCents - fee,
      customerName: "Charters",
      description: "Charter trips",
      createdAt: Timestamp.fromDate(when),
      created: Math.floor(when.getTime() / 1000),
      sourceId: `ch_demo_wk${n}`,
      reportingCategory: "charge",
    });
  }
  charges.sort((a, b) => b.created - a.created);
  return charges;
}

async function deleteDemoSeedDocs(db, tenantId) {
  const collections = [
    { path: "bookingRequests", field: "source", value: DEMO_SEED_SOURCE },
    { path: "bookingRequests", field: "source", value: DEMO_SEED_WEB_SOURCE },
    { path: "bookingRequests", field: "demoSeed", value: true },
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
  // Bookings go in as source "seed" so the new-booking alerts and client texts skip them,
  // then get their real label in a second pass (that update doesn't trigger anything).
  const relabel = [];
  // Money taken, for the weekly revenue rows (history shops only).
  const revenueEntries = [];

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
        source: "seed",
        demoSeed: true,
        tenantId,
        customerId,
        customerName: person.name,
        customerEmail: person.email.toLowerCase(),
        customerPhone: person.phone,
        serviceName: resolved.serviceName,
        notes: `Demo booking — ${resolved.serviceName}`,
        assignedMemberName: ctx.ownerDisplayName,
        assignedMemberEmail: ctx.ownerEmail || undefined,
        createdAt: Timestamp.fromDate(createdAt),
        requestedStartTime: Timestamp.fromDate(start),
      };
      if (ctx.ownerUid) booking.assignedMemberUid = ctx.ownerUid;
      if (resolved.serviceId) booking.serviceId = resolved.serviceId;
      // Booking balances (see functions/balances.js): price, payments, deposit waiting.
      if (Array.isArray(spec.pay) || spec.depositRequest) {
        if (spec.price > 0) booking.priceCents = Math.round(spec.price * 100);
        const payments = {};
        (spec.pay || []).forEach((p, k) => {
          const cents = Math.round(p[2] * 100);
          const at = addDays(start, p[1] === "deposit" ? -(3 + (b % 4)) : 0);
          payments[`demo_${b}_${k}`] = {
            kind: p[0], role: p[1], cents,
            grossCents: p[0] === "cash" ? cents : Math.round(cents * 1.039 + 30),
            at: Timestamp.fromDate(at > now ? now : at),
          };
          revenueEntries.push({ cents, at: at > now ? now : at });
        });
        if (Object.keys(payments).length) booking.payments = payments;
        if (spec.depositRequest) booking.depositRequestCents = Math.round(spec.depositRequest * 100);
        if (spec.status === "pending_deposit") booking.smsConsentAccepted = true;
      }
      // Demo clients have real-looking emails: the balance reminder must never go out for demo rows.
      booking.balanceReminderSentAt = Timestamp.fromDate(now);
      if (spec.status === "NEW") {
        /* unread inbox */
      } else if (["confirmed", "completed"].includes(spec.status)) {
        booking.smsConsentAccepted = true;
      }

      batch.set(bookingRef, booking);
      relabel.push({ ref: bookingRef, source: DEMO_SEED_SOURCE });
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

  let historyCount = 0;
  if (config.history) {
    const spec = config.history;
    const { rows } = buildHistoryRows(spec, now);
    const perClient = new Map();
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n];
      const resolved = resolveService(row.svc.name, ctx.servicesByName);
      const priceDollars = resolved.price > 0 ? resolved.price : row.svc.price;
      let createdAt = addDays(row.start, -row.leadDays);
      if (createdAt > now) createdAt = new Date(now.getTime() - 60 * 60 * 1000);
      const customerId = customerDocIdForTenant(row.client.email, row.client.phone);
      const { pays, deposit } = historyPayments(row, priceDollars, createdAt);
      const payments = {};
      pays.forEach((p, k) => {
        const cents = Math.round(p[2] * 100);
        payments[`h${n}_${k}`] = paymentEntry(p[0], p[1], cents, p[3], now, Timestamp);
        revenueEntries.push({ cents, at: p[3] > now ? now : p[3] });
      });
      const booking = {
        status: row.status,
        source: "seed",
        demoSeed: true,
        tenantId,
        customerId,
        customerName: row.client.name,
        customerEmail: row.client.email,
        customerPhone: row.client.phone,
        serviceName: resolved.serviceName,
        durationMinutes: row.svc.minutes,
        notes: "",
        assignedMemberName: ctx.ownerDisplayName,
        createdAt: Timestamp.fromDate(createdAt),
        requestedStartTime: Timestamp.fromDate(row.start),
        // A no-show keeps the deposit and owes nothing more.
        priceCents: Math.round((row.noShow ? deposit : priceDollars) * 100),
        skipConfirmationSms: true,
        smsConsentAccepted: true,
        balanceReminderSentAt: Timestamp.fromDate(now),
      };
      if (ctx.ownerEmail) booking.assignedMemberEmail = ctx.ownerEmail;
      if (ctx.ownerUid) booking.assignedMemberUid = ctx.ownerUid;
      if (resolved.serviceId) booking.serviceId = resolved.serviceId;
      if (Object.keys(payments).length) booking.payments = payments;
      if (row.status === "pending_deposit") booking.depositRequestCents = deposit * 100;
      if (row.noShow) booking.noShowAt = Timestamp.fromDate(atHour(row.start, row.start.getHours() + 1));
      if (!row.online && ctx.ownerUid) booking.createdByUid = ctx.ownerUid;

      const ref = db.collection("tenants").doc(tenantId).collection("bookingRequests").doc();
      batch.set(ref, booking);
      relabel.push({ ref, source: row.online ? DEMO_SEED_WEB_SOURCE : DEMO_SEED_SOURCE });
      ops += 1;
      await commitIfNeeded();

      const c = perClient.get(customerId) || { client: row.client, first: createdAt, last: row.start, visits: 0 };
      if (createdAt < c.first) c.first = createdAt;
      if (row.start > c.last && row.start <= now) c.last = row.start;
      if (["completed", "confirmed"].includes(row.status) && !row.noShow) c.visits += 1;
      perClient.set(customerId, c);
    }
    historyCount = rows.length;

    for (const [customerId, c] of perClient) {
      batch.set(
        db.collection("tenants").doc(tenantId).collection("customers").doc(customerId),
        {
          name: c.client.name,
          email: c.client.email,
          phone: c.client.phone,
          source: DEMO_SEED_SOURCE,
          totalAppointments: c.visits,
          vip: false,
          notes: "",
          createdAt: Timestamp.fromDate(c.first),
          updatedAt: Timestamp.fromDate(now),
          lastContact: Timestamp.fromDate(c.last),
          smsOptedIn: true,
          smsConsentSource: "web_booking",
          smsConsentAt: Timestamp.fromDate(c.first),
        },
        { merge: true }
      );
      ops += 1;
      await commitIfNeeded();
    }
  }

  let igThreadCount = 0;
  if (config.instagram) {
    const ig = config.instagram;
    for (let t = 0; t < ig.threads.length; t++) {
      const thread = ig.threads[t];
      const scopedId = `demo-ig-${t + 1}`;
      const threadId = `ig:${ig.igUserId}:${scopedId}`;
      const handle = `@${thread.handle}`;
      let last = null;
      let lastInbound = null;
      for (const [dir, minutesAgo, body] of thread.messages) {
        const at = new Date(now.getTime() - minutesAgo * 60 * 1000);
        const isOut = dir === "outbound";
        batch.set(db.collection("tenants").doc(tenantId).collection("smsLog").doc(), {
          channel: "instagram",
          direction: isOut ? "outbound" : "inbound",
          from: isOut ? ig.igUserId : scopedId,
          to: isOut ? scopedId : ig.igUserId,
          threadId,
          body,
          clientName: handle,
          igScopedUserId: scopedId,
          igUsername: thread.handle,
          assignedMemberUid: "",
          smsLineScope: "tenant",
          createdAt: Timestamp.fromDate(at),
          source: DEMO_SEED_SOURCE,
        });
        ops += 1;
        last = { dir, at, body };
        if (!isOut) lastInbound = at;
        await commitIfNeeded();
      }
      if (!last) continue;
      const threadDoc = {
        threadId,
        channel: "instagram",
        igScopedUserId: scopedId,
        igUsername: thread.handle,
        clientName: handle,
        lastDirection: last.dir === "outbound" ? "outbound" : "inbound",
        lastMessageBody: last.body.slice(0, 500),
        lastMessageAt: Timestamp.fromDate(last.at),
        assignedMemberUid: "",
        smsLineScope: "tenant",
        source: DEMO_SEED_SOURCE,
        updatedAt: Timestamp.fromDate(now),
      };
      // Instagram allows replies for 24 hours after the client's last message.
      if (lastInbound) threadDoc.igWindowExpiresAt = Timestamp.fromDate(new Date(lastInbound.getTime() + DAY_MS));
      batch.set(db.collection("tenants").doc(tenantId).collection("smsThreads").doc(threadId), threadDoc);
      ops += 1;
      igThreadCount += 1;
      await commitIfNeeded();
    }
  }

  if (ops > 0) await batch.commit();

  // Second pass: the bookings' real source labels.
  for (let i = 0; i < relabel.length; i += 400) {
    const b2 = db.batch();
    relabel.slice(i, i + 400).forEach((r) => b2.update(r.ref, { source: r.source }));
    await b2.commit();
  }

  const transactions = config.history
    ? buildWeeklyTransactionsFromEntries(revenueEntries, now, Math.ceil(config.history.pastDays / 7) + 1, Timestamp)
    : buildShowcaseWeeklyTransactions(slug, now, Timestamp);
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
      ...(config.instagram
        ? {
            igStatus: "connected",
            igUserId: config.instagram.igUserId,
            igUsername: config.instagram.username,
            igConnectedAt: Timestamp.fromDate(now),
            igProvisionError: "",
          }
        : {}),
      updatedAt: Timestamp.fromDate(now),
    },
    { merge: true }
  );

  const threadCount = customers.filter((c) => (c.sms || []).length).length;
  const bookingCount = customers.reduce((n, c) => n + (c.bookings || []).length, 0) + historyCount;

  return {
    tenantId,
    slug,
    customers: customers.length,
    bookings: bookingCount,
    smsThreads: threadCount,
    instagramThreads: igThreadCount,
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
