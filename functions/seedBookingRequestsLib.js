/**
 * Shared booking-request seed data for scripts/seed-booking-requests.js and
 * seedTenantBookingRequests callable.
 */

const TIME_SLOTS = ["9:00 AM", "10:30 AM", "12:00 PM", "2:00 PM", "3:30 PM", "5:00 PM"];
const SERVICES = [
  "Consultation",
  "Full session",
  "Touch-up",
  "Custom piece",
  "Half day",
  "Walk-in",
];
const FIRST = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Quinn",
  "Avery", "Blake", "Cameron", "Drew", "Emery", "Finley", "Harper", "Jesse",
];
const LAST = [
  "Lee", "Kim", "Patel", "Garcia", "Nguyen", "Smith", "Brown", "Martinez",
  "Wilson", "Anderson", "Thomas", "Jackson", "White", "Harris", "Clark", "Lewis",
];

const SEED_CONFIRM = "SEED_BOOKING_REQUESTS";
const MAX_SEED_COUNT = 500;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickStatus() {
  const r = Math.random();
  if (r < 0.55) return "NEW";
  if (r < 0.8) return "confirmed";
  if (r < 0.92) return "declined";
  return "cancelled";
}

function randomEmail(first, last, i) {
  const base = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
  return `${base}.${i}@example.com`;
}

function randomCreatedAt(daysBack) {
  const now = Date.now();
  const offset = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - offset);
}

function buildSeedBookingRequestDoc(tenantId, index, Timestamp) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const createdAt = randomCreatedAt(30);
  const doc = {
    status: pickStatus(),
    source: "seed",
    tenantId,
    customerName: `${first} ${last}`,
    customerEmail: randomEmail(first, last, index),
    customerPhone: `555${String(1000000 + (index % 9000000)).slice(0, 7)}`,
    serviceName: pick(SERVICES),
    preferredTime: pick(TIME_SLOTS),
    notes: `Seeded test request #${index + 1}`,
    createdAt: Timestamp.fromDate(createdAt),
  };
  if (Math.random() > 0.4) {
    doc.requestedStartTime = Timestamp.fromDate(
      new Date(createdAt.getTime() + 86400000 * (1 + (index % 14)))
    );
  }
  return doc;
}

async function resolveTenantBySlug(db, slug) {
  const snap = await db.collection("tenants").where("slug", "==", slug).limit(1).get();
  if (snap.empty) throw new Error(`No tenant with slug "${slug}"`);
  const doc = snap.docs[0];
  return { id: doc.id, slug: (doc.data().slug || "").toString() };
}

/** Matches functions/index.js customerDocIdForTenant (phone last 10, else email slug). */
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

/**
 * Resolve tenant for a business owner by users/{uid}.email or tenants.ownerUid.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} ownerEmail
 */
async function resolveTenantByOwnerEmail(db, ownerEmail) {
  const email = (ownerEmail || "").toString().trim().toLowerCase();
  if (!email) throw new Error("owner email is required");

  const userSnap = await db.collection("users").where("email", "==", email).limit(1).get();
  if (!userSnap.empty) {
    const userDoc = userSnap.docs[0];
    const uid = userDoc.id;
    const data = userDoc.data();
    const tenantId = (data.tenantId || "").toString().trim();
    if (tenantId) {
      const tenantDoc = await db.collection("tenants").doc(tenantId).get();
      if (tenantDoc.exists) {
        return {
          id: tenantId,
          slug: (tenantDoc.data().slug || "").toString(),
          ownerUid: uid,
        };
      }
    }
    const ownerSnap = await db
      .collection("tenants")
      .where("ownerUid", "==", uid)
      .limit(1)
      .get();
    if (!ownerSnap.empty) {
      const t = ownerSnap.docs[0];
      return { id: t.id, slug: (t.data().slug || "").toString(), ownerUid: uid };
    }
  }

  throw new Error(`No tenant found for owner email "${email}"`);
}

/** Fixed roster: repeat customers with past + upcoming bookings. */
const REPEAT_CUSTOMERS = [
  { name: "Marcus Brooks", email: "marcus.brooks@example.com", phone: "(555) 301-0001" },
  { name: "Tyler Hayes", email: "tyler.hayes@example.com", phone: "(555) 301-0002" },
  { name: "Noah Foster", email: "noah.foster@example.com", phone: "(555) 301-0003" },
  { name: "Ethan Reed", email: "ethan.reed@example.com", phone: "(555) 301-0004" },
  { name: "Liam Cole", email: "liam.cole@example.com", phone: "(555) 301-0005" },
  { name: "Mason Grant", email: "mason.grant@example.com", phone: "(555) 301-0006" },
  { name: "Lucas Pierce", email: "lucas.pierce@example.com", phone: "(555) 301-0007" },
  { name: "Owen Walsh", email: "owen.walsh@example.com", phone: "(555) 301-0008" },
  { name: "Caleb Bennett", email: "caleb.bennett@example.com", phone: "(555) 301-0009" },
  { name: "Ryan Russell", email: "ryan.russell@example.com", phone: "(555) 301-0010" },
];

/** Default catalog prices when tenant services exist but have no price (enables Total spent). */
const SEED_SERVICE_PRICES = {
  Consultation: 75,
  "Full session": 450,
  "Touch-up": 200,
  "Custom piece": 600,
  "Half day": 350,
  "Walk-in": 120,
};

const PREFERRED_DAYS_ROTATION = [
  ["Saturday", "Sunday"],
  ["Tuesday", "Thursday"],
  ["Friday"],
  ["Monday", "Wednesday"],
  ["Saturday"],
  ["Sunday", "Tuesday"],
  ["Thursday", "Friday"],
  ["Saturday", "Sunday"],
  ["Saturday", "Sunday"],
  ["Wednesday", "Friday"],
];

function addDays(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(10 + (days % 6), (days % 2) * 30, 0, 0);
  return d;
}

function formatPreferredTimeFromDate(start) {
  const hour = start.getHours();
  const min = start.getMinutes();
  const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${h12}:${min === 0 ? "00" : "30"} ${suffix}`;
}

/** Per-roster-index profile fake data for customer docs + booking hints. */
function profileSeedForIndex(index) {
  if (index === 8) {
    return {
      vip: true,
      birthday: "March 15",
      referralSource: "Instagram — @inkedfriends",
      notes:
        "Prefers afternoon sessions. Sensitive skin on inner forearm — use fragrance-free aftercare. Always books half-day blocks.",
      preferences: {
        preferredTime: "Afternoons (2–5 PM)",
        tattooStyles: ["Blackwork", "Neo-traditional"],
        tattooStyle: "Blackwork",
        allergies: ["Latex gloves", "Certain green pigments"],
      },
      profileExtras: [
        { id: "extra-pronouns", label: "Pronouns", value: "he/him" },
        {
          id: "extra-emergency",
          label: "Emergency contact",
          value: "Jordan Bennett — (555) 301-0199",
        },
        { id: "extra-parking", label: "Parking", value: "Street parking on Oak; validates 2hr" },
      ],
      preferredDays: ["Saturday", "Sunday"],
      smsOptedIn: true,
    };
  }

  const styleSets = [
    ["Traditional", "American classic"],
    ["Fine line", "Minimalist"],
    ["Japanese", "Irezumi"],
    ["Realism", "Portrait"],
    ["Geometric", "Dotwork"],
    ["Watercolor"],
    ["Blackwork"],
    ["Neo-traditional", "Illustrative"],
    ["Blackwork", "Neo-traditional"],
    ["Tribal", "Polynesian"],
  ];
  const allergySets = [
    ["Nickel jewelry"],
    ["Aloe-based aftercare"],
    [],
    ["Lidocaine"],
    ["Fragrance oils"],
    ["Latex gloves"],
    [],
    ["Certain red pigments"],
    ["Latex gloves", "Certain green pigments"],
    ["Coconut oil"],
  ];
  const birthdays = [
    "January 12",
    "April 3",
    "June 21",
    "August 9",
    "November 2",
    "February 28",
    "May 17",
    "September 5",
    "March 15",
    "December 1",
  ];
  const referrals = [
    "Walk-in",
    "Google Maps",
    "Friend referral — Marcus",
    "TikTok",
    "Yelp",
    "Repeat client board",
    "Instagram — @localink",
    "Facebook",
    "Instagram — @inkedfriends",
    "Shop flyer",
  ];
  const notes = [
    "Likes bold linework; books 3–4 hour blocks.",
    "Always asks for numbing check before long sessions.",
    "Brings reference photos on phone — prefers DM preview.",
    "Tips well; prefers morning slots when available.",
    "First tattoo was here — very loyal.",
    "Travels from out of town; needs parking reminder.",
    "Sensitive to noise — prefers quieter station.",
    "VIP regular; coordinate with front desk for beverages.",
    "Prefers afternoon sessions. Sensitive skin on inner forearm.",
    "Interested in sleeve continuation Q3.",
  ];
  const extras = [
    [{ id: "e1", label: "Pronouns", value: "they/them" }],
    [{ id: "e2", label: "Preferred language", value: "English" }],
    [
      { id: "e3", label: "ID verified", value: "Yes — 2025-11" },
      { id: "e4", label: "Deposit on file", value: "$100" },
    ],
    [{ id: "e5", label: "Artist preference", value: "Any senior artist" }],
    [],
    [{ id: "e6", label: "Parking", value: "Garage level P2" }],
    [{ id: "e7", label: "Accessibility", value: "Wheelchair access needed" }],
    [],
    [
      { id: "e8", label: "Pronouns", value: "he/him" },
      { id: "e9", label: "Emergency contact", value: "Jordan Bennett — (555) 301-0199" },
    ],
    [{ id: "e10", label: "Referral code", value: "INK10" }],
  ];

  const styles = styleSets[index % styleSets.length];
  const allergies = allergySets[index % allergySets.length];
  const preferredTimes = [
    "Mornings (9–12)",
    "Midday (12–2)",
    "Afternoons (2–5 PM)",
    "Evenings (5–7)",
    "Flexible",
  ];

  return {
    vip: index % 3 === 0,
    birthday: birthdays[index % birthdays.length],
    referralSource: referrals[index % referrals.length],
    notes: notes[index % notes.length],
    preferences: {
      preferredTime: preferredTimes[index % preferredTimes.length],
      tattooStyles: styles,
      tattooStyle: styles[0],
      ...(allergies.length ? { allergies } : {}),
    },
    profileExtras: extras[index % extras.length],
    preferredDays: PREFERRED_DAYS_ROTATION[index % PREFERRED_DAYS_ROTATION.length],
    smsOptedIn: index % 2 === 0,
  };
}

function buildEnrichedCustomerFields(person, index, Timestamp, now, customerCreated) {
  const seed = profileSeedForIndex(index);
  const consentAt = addDays(now, -(45 + index));
  const fields = {
    name: person.name,
    email: person.email.toLowerCase(),
    phone: person.phone,
    source: "seed",
    totalAppointments: 2 + (index % 2),
    vip: seed.vip,
    birthday: seed.birthday,
    referralSource: seed.referralSource,
    notes: seed.notes,
    preferences: seed.preferences,
    profileExtras: seed.profileExtras,
    createdAt: Timestamp.fromDate(customerCreated),
    updatedAt: Timestamp.fromDate(now),
    lastContact: Timestamp.fromDate(now),
  };
  if (seed.smsOptedIn) {
    fields.smsOptedIn = true;
    fields.smsConsentSource = "web_booking";
    fields.smsConsentAt = Timestamp.fromDate(consentAt);
  }
  return { fields, seed };
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
        (u.name || "").toString().trim() ||
        (u.business || "").toString().trim() ||
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
      typeof rawPrice === "number" && rawPrice > 0
        ? rawPrice
        : typeof rawPrice === "string" && parseFloat(rawPrice) > 0
          ? parseFloat(rawPrice)
          : null;
    servicesByName[name] = { id: doc.id, name, price };
  }
  return { ownerUid, ownerDisplayName, ownerEmail, servicesByName };
}

function defaultPriceForServiceName(name) {
  if (SEED_SERVICE_PRICES[name] != null) return SEED_SERVICE_PRICES[name];
  const lower = name.toLowerCase();
  for (const [key, price] of Object.entries(SEED_SERVICE_PRICES)) {
    if (key.toLowerCase() === lower) return price;
  }
  return null;
}

async function ensureSeedServicePrices(db, tenantId, servicesByName) {
  let updated = 0;
  let batch = db.batch();
  let ops = 0;
  for (const [name, meta] of Object.entries(servicesByName)) {
    const defaultPrice = defaultPriceForServiceName(name);
    if (defaultPrice == null || (meta.price != null && meta.price > 0)) continue;
    const ref = db.collection("tenants").doc(tenantId).collection("services").doc(meta.id);
    batch.set(ref, { price: defaultPrice }, { merge: true });
    meta.price = defaultPrice;
    ops++;
    updated++;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return updated;
}

function resolveServiceForBooking(serviceName, servicesByName) {
  const direct = servicesByName[serviceName];
  if (direct) return { serviceId: direct.id, serviceName: direct.name };
  const lower = serviceName.toLowerCase();
  for (const [name, meta] of Object.entries(servicesByName)) {
    if (name.toLowerCase() === lower) {
      return { serviceId: meta.id, serviceName: name };
    }
  }
  return { serviceId: null, serviceName };
}

function buildEnrichedBookingFields(spec, person, customerId, tenantId, index, b, ctx, seed) {
  const serviceName = SERVICES[(index + b) % SERVICES.length];
  const resolved = resolveServiceForBooking(serviceName, ctx.servicesByName);
  const preferredTime = formatPreferredTimeFromDate(spec.start);
  const booking = {
    status: spec.status,
    source: "seed",
    tenantId,
    customerId,
    customerName: person.name,
    customerEmail: person.email.toLowerCase(),
    customerPhone: person.phone,
    serviceName: resolved.serviceName,
    preferredTime,
    preferredDays: seed.preferredDays,
    notes: spec.notes,
    assignedMemberName: ctx.ownerDisplayName,
    assignedMemberEmail: ctx.ownerEmail || undefined,
  };
  if (ctx.ownerUid) booking.assignedMemberUid = ctx.ownerUid;
  if (resolved.serviceId) booking.serviceId = resolved.serviceId;
  if (seed.smsOptedIn && (spec.status === "confirmed" || spec.status === "completed")) {
    booking.smsConsentAccepted = true;
  }
  return booking;
}

/**
 * Seed customers + booking requests (repeat visits, some upcoming confirmed).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tenantId
 * @param {*} Timestamp — Firestore Timestamp class
 * @param {{ customerCount?: number, ensureServicePrices?: boolean }} opts
 */
async function writeRepeatCustomerSeedData(db, tenantId, Timestamp, opts = {}) {
  const roster = REPEAT_CUSTOMERS.slice(
    0,
    Math.min(REPEAT_CUSTOMERS.length, Math.max(1, opts.customerCount ?? REPEAT_CUSTOMERS.length))
  );
  const now = opts.now ? new Date(opts.now) : new Date();
  const ctx = await loadTenantSeedContext(db, tenantId);
  let pricesUpdated = 0;
  if (opts.ensureServicePrices !== false) {
    pricesUpdated = await ensureSeedServicePrices(db, tenantId, ctx.servicesByName);
  }

  let writtenCustomers = 0;
  let writtenBookings = 0;
  let batch = db.batch();
  let ops = 0;

  const commitIfNeeded = async () => {
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (let i = 0; i < roster.length; i++) {
    const person = roster[i];
    const customerId = customerDocIdForTenant(person.email, person.phone);
    const customerCreated = addDays(now, -(60 + i * 3));
    const { fields: customerFields, seed } = buildEnrichedCustomerFields(
      person,
      i,
      Timestamp,
      now,
      customerCreated
    );

    const customerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("customers")
      .doc(customerId);
    batch.set(customerRef, customerFields, { merge: true });
    ops++;
    writtenCustomers++;

    const bookings = [
      {
        status: "completed",
        start: addDays(now, -(21 + (i % 10))),
        notes: "Seeded past visit",
      },
      {
        status: "confirmed",
        start: addDays(now, -(7 + (i % 5))),
        notes: "Seeded recent visit",
      },
      {
        status: "confirmed",
        start: addDays(now, 2 + (i % 12)),
        notes: "Seeded upcoming appointment",
      },
    ];
    if (i % 4 === 0) {
      bookings.push({
        status: "NEW",
        start: addDays(now, 5 + (i % 7)),
        notes: "Seeded new request (inbox)",
      });
    }

    for (let b = 0; b < bookings.length; b++) {
      const spec = bookings[b];
      const createdAt = new Date(spec.start.getTime() - 86400000 * (2 + b));
      const bookingFields = buildEnrichedBookingFields(
        spec,
        person,
        customerId,
        tenantId,
        i,
        b,
        ctx,
        seed
      );

      const ref = db
        .collection("tenants")
        .doc(tenantId)
        .collection("bookingRequests")
        .doc();
      batch.set(ref, {
        ...bookingFields,
        createdAt: Timestamp.fromDate(createdAt),
        requestedStartTime: Timestamp.fromDate(spec.start),
      });
      ops++;
      writtenBookings++;
      await commitIfNeeded();
    }
    await commitIfNeeded();
  }

  if (ops > 0) await batch.commit();
  return {
    writtenCustomers,
    writtenBookings,
    tenantId,
    customers: roster.length,
    servicePricesUpdated: pricesUpdated,
  };
}

/**
 * Merge profile/preferences onto existing seed customers and patch their bookings.
 * Does not create new booking rows.
 */
async function enrichRepeatCustomerProfiles(db, tenantId, Timestamp, opts = {}) {
  const roster = REPEAT_CUSTOMERS.slice(
    0,
    Math.min(REPEAT_CUSTOMERS.length, Math.max(1, opts.customerCount ?? REPEAT_CUSTOMERS.length))
  );
  const now = opts.now ? new Date(opts.now) : new Date();
  const ctx = await loadTenantSeedContext(db, tenantId);
  let pricesUpdated = 0;
  if (opts.ensureServicePrices !== false) {
    pricesUpdated = await ensureSeedServicePrices(db, tenantId, ctx.servicesByName);
  }

  let enrichedCustomers = 0;
  let patchedBookings = 0;
  let batch = db.batch();
  let ops = 0;

  const commitIfNeeded = async () => {
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (let i = 0; i < roster.length; i++) {
    const person = roster[i];
    const customerId = customerDocIdForTenant(person.email, person.phone);
    const customerCreated = addDays(now, -(60 + i * 3));
    const { fields: customerFields } = buildEnrichedCustomerFields(
      person,
      i,
      Timestamp,
      now,
      customerCreated
    );

    const customerRef = db
      .collection("tenants")
      .doc(tenantId)
      .collection("customers")
      .doc(customerId);
    batch.set(customerRef, customerFields, { merge: true });
    ops++;
    enrichedCustomers++;
    await commitIfNeeded();

    const seed = profileSeedForIndex(i);
    const email = person.email.toLowerCase();
    const bookingSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .where("customerEmail", "==", email)
      .get();

    for (const doc of bookingSnap.docs) {
      const data = doc.data();
      const serviceName =
        (data.serviceName || SERVICES[i % SERVICES.length]).toString() || SERVICES[0];
      const resolved = resolveServiceForBooking(serviceName, ctx.servicesByName);
      const patch = {
        customerId,
        preferredDays: seed.preferredDays,
        assignedMemberName: ctx.ownerDisplayName,
        assignedMemberEmail: ctx.ownerEmail || undefined,
      };
      if (ctx.ownerUid) patch.assignedMemberUid = ctx.ownerUid;
      if (resolved.serviceId) patch.serviceId = resolved.serviceId;
      if (resolved.serviceName) patch.serviceName = resolved.serviceName;
      if (seed.smsOptedIn) patch.smsConsentAccepted = true;
      batch.set(doc.ref, patch, { merge: true });
      ops++;
      patchedBookings++;
      await commitIfNeeded();
    }
  }

  if (ops > 0) await batch.commit();
  return {
    enrichedCustomers,
    patchedBookings,
    tenantId,
    servicePricesUpdated: pricesUpdated,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tenantId
 * @param {number} count
 * @param {typeof import('firebase-admin')} admin
 */
async function writeSeedBookingRequests(db, tenantId, count, admin) {
  const { Timestamp } = admin.firestore;
  const capped = Math.min(MAX_SEED_COUNT, Math.max(1, count));
  let written = 0;
  let batch = db.batch();
  let ops = 0;

  for (let i = 0; i < capped; i++) {
    const ref = db
      .collection("tenants")
      .doc(tenantId)
      .collection("bookingRequests")
      .doc();
    batch.set(ref, buildSeedBookingRequestDoc(tenantId, i, Timestamp));
    ops++;
    written++;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { written, tenantId };
}

/** Barber shop services (matches BookingTemplate.barber). */
const BARBER_SERVICES = [
  "Skin fade",
  "Beard trim",
  "Lineup / edge-up",
  "Full service",
];

const BARBER_APPOINTMENT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

const BARBER_STAFF = [
  { name: "Marc Reyes", email: "marc.barber1@example.com" },
  { name: "Diego Cole", email: "diego.barber2@example.com" },
  { name: "James Ortiz", email: "james.barber3@example.com" },
];

const BARBER_CLIENT_FIRST = [
  "Marcus", "Tyler", "Noah", "Ethan", "Liam", "Mason", "Lucas", "Owen",
  "Caleb", "Ryan", "Dylan", "Nathan", "Brandon", "Kevin", "Chris", "Mike",
  "Andre", "Carlos", "Jordan", "Sean",
];

const BARBER_CLIENT_LAST = [
  "Brooks", "Hayes", "Foster", "Reed", "Cole", "Grant", "Pierce", "Walsh",
  "Bennett", "Russell", "Howard", "Murray", "Dixon", "Hughes", "Price", "West",
  "Banks", "Stone", "Cross", "Lane",
];

function barberPickStatus(slotIndex) {
  if (slotIndex % 7 === 0) return "declined";
  if (slotIndex % 5 === 0) return "cancelled";
  if (slotIndex % 3 === 0) return "NEW";
  return "confirmed";
}

function buildBarberSeedBookingRequestDoc(
  tenantId,
  { barber, slotIndex, globalIndex, appointmentDate, Timestamp }
) {
  const first = BARBER_CLIENT_FIRST[globalIndex % BARBER_CLIENT_FIRST.length];
  const last = BARBER_CLIENT_LAST[(globalIndex + slotIndex) % BARBER_CLIENT_LAST.length];
  const hour = BARBER_APPOINTMENT_HOURS[slotIndex % BARBER_APPOINTMENT_HOURS.length];
  const start = new Date(appointmentDate);
  start.setHours(hour, (slotIndex % 2) * 30, 0, 0);
  const createdAt = new Date(start.getTime() - 86400000 * (2 + (slotIndex % 5)));

  const serviceName = BARBER_SERVICES[slotIndex % BARBER_SERVICES.length];
  const preferredTime = `${hour > 12 ? hour - 12 : hour}:${start.getMinutes() === 0 ? "00" : "30"} ${hour >= 12 ? "PM" : "AM"}`;

  return {
    status: barberPickStatus(slotIndex),
    source: "seed",
    tenantId,
    customerName: `${first} ${last}`,
    customerEmail: `${first}.${last}.${globalIndex}@example.com`.toLowerCase(),
    customerPhone: `555${String(3010000 + globalIndex).slice(0, 7)}`,
    serviceName,
    preferredTime,
    notes: `Seeded appointment — barber: ${barber.name}`,
    assignedMemberName: barber.name,
    assignedMemberEmail: barber.email,
    formResponses: {
      fadeOrStyle: ["Low fade", "Mid fade", "High fade", "Taper", "Buzz / crew"][slotIndex % 5],
      facialHair: ["Beard trim", "Clean shave", "No facial hair service today"][slotIndex % 3],
    },
    createdAt: Timestamp.fromDate(createdAt),
    requestedStartTime: Timestamp.fromDate(start),
  };
}

/**
 * Spread `perBarber` appointments per barber between startDate and endDate (inclusive).
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tenantId
 * @param {{ fromDate: (d: Date) => unknown }} Timestamp — Firestore Timestamp class
 * @param {{ perBarber?: number, startDate?: Date, endDate?: Date }} opts
 */
async function writeBarberSeedBookingRequests(db, tenantId, Timestamp, opts = {}) {
  const perBarber = Math.min(50, Math.max(1, opts.perBarber ?? 10));
  const startDate = opts.startDate ?? new Date("2026-05-20T12:00:00");
  const endDate = opts.endDate ?? new Date("2026-06-30T12:00:00");
  const rangeMs = Math.max(0, endDate.getTime() - startDate.getTime());
  const rangeDays = Math.max(1, Math.floor(rangeMs / 86400000));

  let written = 0;
  let globalIndex = 0;
  let batch = db.batch();
  let ops = 0;

  for (const barber of BARBER_STAFF) {
    for (let slot = 0; slot < perBarber; slot++) {
      const dayOffset = Math.floor((slot * rangeDays) / perBarber);
      const appointmentDate = new Date(startDate);
      appointmentDate.setDate(appointmentDate.getDate() + dayOffset);

      const ref = db
        .collection("tenants")
        .doc(tenantId)
        .collection("bookingRequests")
        .doc();
      batch.set(
        ref,
        buildBarberSeedBookingRequestDoc(tenantId, {
          barber,
          slotIndex: slot,
          globalIndex,
          appointmentDate,
          Timestamp,
        })
      );
      ops++;
      written++;
      globalIndex++;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }
  if (ops > 0) await batch.commit();
  return { written, tenantId, perBarber, barbers: BARBER_STAFF.length };
}

module.exports = {
  SEED_CONFIRM,
  MAX_SEED_COUNT,
  BARBER_SERVICES,
  BARBER_STAFF,
  REPEAT_CUSTOMERS,
  buildSeedBookingRequestDoc,
  buildBarberSeedBookingRequestDoc,
  customerDocIdForTenant,
  resolveTenantBySlug,
  resolveTenantByOwnerEmail,
  writeSeedBookingRequests,
  writeBarberSeedBookingRequests,
  writeRepeatCustomerSeedData,
  enrichRepeatCustomerProfiles,
  profileSeedForIndex,
  buildEnrichedCustomerFields,
};
