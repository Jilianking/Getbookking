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
  buildSeedBookingRequestDoc,
  buildBarberSeedBookingRequestDoc,
  resolveTenantBySlug,
  writeSeedBookingRequests,
  writeBarberSeedBookingRequests,
};
