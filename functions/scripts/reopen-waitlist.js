/**
 * One-off: reopen a beta waitlist entry by email.
 * Usage: node scripts/reopen-waitlist.js jilianking@getbookking.com
 */
const admin = require("firebase-admin");

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/reopen-waitlist.js <email>");
  process.exit(1);
}

admin.initializeApp({ projectId: "test-app-96812" });
const db = admin.firestore();
const del = admin.firestore.FieldValue.delete();

async function main() {
  const snap = await db
    .collection("betaWaitlist")
    .where("email", "==", email)
    .limit(5)
    .get();

  if (snap.empty) {
    console.error("No waitlist entry found for", email);
    process.exit(1);
  }

  for (const doc of snap.docs) {
    const status = (doc.data().status || "pending").toString();
    if (status === "pending") {
      console.log(doc.id, "already pending");
      continue;
    }
    await doc.ref.set(
      {
        status: "pending",
        approvedAt: del,
        inviteSentAt: del,
        approvedByUid: del,
        declinedAt: del,
        declinedByUid: del,
        declineReason: del,
        reopenAt: admin.firestore.FieldValue.serverTimestamp(),
        reopenedByUid: "script",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log("Reopened", doc.id, "was", status);
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
