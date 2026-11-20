/**
 * Keeps the copies on bookings in step when the original changes.
 * Bookings store their own customerName / customerEmail / customerPhone, serviceName, and assignedMemberName,
 * so an edit to the client, service, or team member is copied onto that record's bookings here — whichever
 * screen (iPhone, website) made the edit. Calendar, booking details, Insights, and reminder texts then match.
 */
"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const BATCH_LIMIT = 400;

function db() {
  return admin.firestore();
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function last10(raw) {
  const d = str(raw).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/** The ways a phone number is stored on bookings: 6155001337, +16155001337, 16155001337, (615) 500-1337. */
function phoneForms(ten, raw) {
  if (!ten) return [];
  const forms = new Set([ten, "+1" + ten, "1" + ten, `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`]);
  if (str(raw)) forms.add(str(raw));
  return [...forms].slice(0, 10);
}

/** Runs the queries, de-dupes the bookings, and applies patch(data) → fields (or null) in batches. */
async function patchBookings(queries, patchFor) {
  const seen = new Map();
  for (const q of queries) {
    const snap = await q.get();
    snap.forEach((doc) => seen.set(doc.ref.path, doc));
  }
  let batch = db().batch();
  let pending = 0;
  let changed = 0;
  for (const doc of seen.values()) {
    const patch = patchFor(doc.data() || {});
    if (!patch || !Object.keys(patch).length) continue;
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    batch.update(doc.ref, patch);
    pending += 1;
    changed += 1;
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = db().batch();
      pending = 0;
    }
  }
  if (pending) await batch.commit();
  return changed;
}

function memberNames(u) {
  const composed = `${str(u.firstName)} ${str(u.lastName)}`.trim();
  return { composed, display: str(u.displayName) || str(u.name) };
}

function registerSyncCopies(exportsObj) {
  /** Client edited (name, email, phone) → their bookings. */
  exportsObj.onCustomerContactChanged = functions.firestore
    .document("tenants/{tenantId}/customers/{customerId}")
    .onUpdate(async (change, context) => {
      const before = change.before.data() || {};
      const after = change.after.data() || {};
      const name = str(after.name);
      const email = str(after.email).toLowerCase();
      const phone = str(after.phone);
      const nameChanged = name && name !== str(before.name);
      const emailChanged = email && email !== str(before.email).toLowerCase();
      const phoneChanged = phone && last10(phone) !== last10(before.phone);
      if (!nameChanged && !emailChanged && !phoneChanged) return null;

      const { tenantId, customerId } = context.params;
      const col = db().collection("tenants").doc(tenantId).collection("bookingRequests");
      const queries = [col.where("customerId", "==", customerId)];
      const oldEmail = str(before.email);
      if (oldEmail) queries.push(col.where("customerEmail", "in", [...new Set([oldEmail, oldEmail.toLowerCase()])]));
      // Old phone, plus the number the record was first filed under (its id is often those 10 digits).
      const tens = [...new Set([last10(before.phone), /^\d{10}$/.test(customerId) ? customerId : ""].filter(Boolean))];
      tens.forEach((ten) => queries.push(col.where("customerPhone", "in", phoneForms(ten, ten === last10(before.phone) ? before.phone : ""))));

      const changed = await patchBookings(queries, (d) => {
        const patch = {};
        if (nameChanged && str(d.customerName) !== name) patch.customerName = name;
        if (emailChanged && str(d.customerEmail).toLowerCase() !== email) patch.customerEmail = email;
        if (phoneChanged && last10(d.customerPhone) !== last10(phone)) patch.customerPhone = phone;
        if (!str(d.customerId)) patch.customerId = customerId;
        return patch;
      });
      if (changed) console.log("onCustomerContactChanged", tenantId, customerId, changed);
      return null;
    });

  /** Service renamed → the name on its bookings (calendar titles, reminder texts, Insights). */
  exportsObj.onServiceRenamed = functions.firestore
    .document("tenants/{tenantId}/services/{serviceId}")
    .onUpdate(async (change, context) => {
      const oldName = str((change.before.data() || {}).name);
      const newName = str((change.after.data() || {}).name);
      if (!newName || newName === oldName) return null;
      const { tenantId, serviceId } = context.params;
      const col = db().collection("tenants").doc(tenantId).collection("bookingRequests");
      const queries = [col.where("serviceId", "==", serviceId)];
      if (oldName) queries.push(col.where("serviceName", "==", oldName));
      const changed = await patchBookings(queries, (d) => {
        const sid = str(d.serviceId);
        // Same service id, or an older booking with the old name and no id.
        if (sid && sid !== serviceId) return null;
        if (!sid && str(d.serviceName) !== oldName) return null;
        return str(d.serviceName) !== newName ? { serviceName: newName } : null;
      });
      if (changed) console.log("onServiceRenamed", tenantId, serviceId, changed);
      return null;
    });

  /** Team member renamed → the "with" name on their bookings. */
  exportsObj.onMemberNameChanged = functions.firestore
    .document("users/{uid}")
    .onUpdate(async (change, context) => {
      const before = change.before.data() || {};
      const after = change.after.data() || {};
      const tenantId = str(after.tenantId);
      if (!tenantId) return null;
      const was = memberNames(before);
      const now = memberNames(after);
      if (was.composed === now.composed && was.display === now.display) return null;
      const col = db().collection("tenants").doc(tenantId).collection("bookingRequests");
      const changed = await patchBookings([col.where("assignedMemberUid", "==", context.params.uid)], (d) => {
        const current = str(d.assignedMemberName);
        // Replace only a name that came from this person's old name (either form the apps use).
        let next = "";
        if (current && current === was.composed && now.composed) next = now.composed;
        else if (current && current === was.display && now.display) next = now.display;
        else if (!current) next = now.composed || now.display;
        return next && next !== current ? { assignedMemberName: next } : null;
      });
      if (changed) console.log("onMemberNameChanged", tenantId, context.params.uid, changed);
      return null;
    });
}

module.exports = { registerSyncCopies, _test: { phoneForms, last10, memberNames } };
