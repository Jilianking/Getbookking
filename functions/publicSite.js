/**
 * Public booking-site projection of a tenant.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const PUBLIC_SITES = "publicSites";


const PUBLIC_SITE_KEYS = [
  "slug",
  "displayName",
  "businessName",
  "logoUrl",
  "tagline",
  "smsEnabled",
  "smsStatus",
  "smsPhoneNumber",
  "showCharterContactCaptain",
  "backgroundColor",
  "cardSurfaceColor",
  "textColor",
  "primaryColor",
  "primaryColorHover",
  "formSchema",
  "showContactOnPage",
  "contactPhone",
  "contactEmail",
  "isActive",
  "industry",
  "industryCustomLabel",
  "heroImageUrl",
  "timeZone",
  "heroImagePixelWidth",
  "heroImagePixelHeight",
  "galleryImages",
  "galleryGridLayout",
  "galleryLayoutStyle",
  "aboutText",
  "reviews",
  "address",
  "contactAddress",
  "contactAddressSuite",
  "serviceArea",
  "businessHours",
  "businessHoursWeekly",
  "onlineBookableWeekly",
  "onlineSlotsConfigured",
  "onlineSlotStepMinutes",
  "onlineSlotPatterns",
  "blockedDates",
  "blockedTimeRanges",
  "showBusinessHoursOnPage",
  "instagramHandle",
  "mapEmbedLat",
  "mapEmbedLng",
  "mapCaptureImageUrl",
  "sidebarLinks",
  "sidebarBackgroundColor",
  "sidebarTextColor",
  "sidebarCloseIconColor",
  "sidebarIconColorHome",
  "sidebarIconColorBooking",
  "galleryCategories",
  "featuredWorkBackgroundColor",
  "featuredWorkTextColor",
  "bookingFormCardBackgroundColor",
  "galleryPageBackgroundColor",
  "galleryPageTextColor",
  "aboutSectionBackgroundColor",
  "aboutSectionTextColor",
  "headlineFont",
  "heroFont",
  "webThemeId",
  "webTextColors",
  "webTextFontSizes",
  "webSurfaceColors",
  "webButtonColors",
  "bookingFormStyleId",
  "bookingMode",
  "workflow",
  "guidedStepTitles",
  "guidedStepOrder",
  "luxeHeroTagline",
  "luxePromoHeadline",
  "bladeHeroTagline",
  "bladeHeroDescription",
  "heroTagline",
  "heroSubtitle",
  "studio12PhilosophyImageUrl",
  "studio12PhilosophyImagePixelWidth",
  "studio12PhilosophyImagePixelHeight",
  "studio12PhilosophyHeadline",
  "studio12PhilosophyHeadLine1",
  "studio12PhilosophyHeadLine2",
  "studio12PhilosophyHeadItalic",
  "studio12BookCtaHeadline",
  "studio12BookCtaLine1",
  "studio12BookCtaItalic",
  "studio12BookCtaBody",
  "studio12BookCtaImageUrl",
  "studio12BookCtaImagePixelWidth",
  "studio12BookCtaImagePixelHeight",
  "studio12ProcessSteps",
  "charterFaqs",
  "charterBoats",
  "studio12HeroEyebrow",
  "studio12HeroHeadline",
  "studio12HeroLine1",
  "studio12HeroLine2",
  "studio12ShowServicesSection",
  "studio12ShowProcessSection",
  "showGalleryPage",
  "showBookPage",
  "showAboutPage",
  "showChartersPage",
  "showHowItWorksPage",
  "showTeamPage",
  "showMeetTheTeamOnHome",
  "shopEnabled",
  "shopPickupEnabled",
  "shopShowPickupAddressOnCheckout",
  "shopShippingEnabled",
  "shopShipFrom",
  "shopDefaultParcel",
  "subscriptionPlan",
  "classicFeaturedWorkEyebrow",
  "classicFeaturedWorkHeading",
  "classicFeaturedWorkSub",
  "classicFeaturedWorkEmpty",
  "classicServicesEyebrow",
  "classicServicesHeading",
  "classicServicesExpandableCard",
  "classicAboutEyebrow",
  "classicAboutHeading",
  "classicAboutImageUrl",
  "classicAboutImagePixelWidth",
  "classicAboutImagePixelHeight",
  "luxeFeaturedWorkEyebrow",
  "luxeFeaturedWorkHeading",
  "luxeShowFeaturedWorkStrip",
  "luxeHomeServicesEyebrow",
  "luxeHomeServicesHeading",
  "luxeShowHomeServicesSection",
  "luxeHomeServicesExpandableCard",
  "webCopyOverrides",
  "featuredWorkImages",
];

function db() {
  return admin.firestore();
}

function normalizeSlug(raw) {
  return (raw || "").toString().trim().toLowerCase();
}

function buildPublicSitePayload(tenantId, data) {
  const src = data && typeof data === "object" ? data : {};
  const out = {
    tenantId: String(tenantId),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  for (const key of PUBLIC_SITE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    if (src[key] === undefined) continue;
    out[key] = src[key];
  }
  const tz =
    src.timeZone ||
    (src.availability && src.availability.timeZone) ||
    "";
  if (tz) out.timeZone = String(tz);
  const slug = normalizeSlug(src.slug);
  if (slug) out.slug = slug;
  return out;
}

async function deletePublicSiteIfOwned(firestore, slug, tenantId) {
  const id = normalizeSlug(slug);
  if (!id) return;
  const ref = firestore.collection(PUBLIC_SITES).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  if ((snap.data().tenantId || "").toString() !== String(tenantId)) return;
  await ref.delete();
}

async function syncPublicSiteForTenant(firestore, tenantId, data) {
  const slug = normalizeSlug(data && data.slug);
  if (!slug) return { ok: false, reason: "missing-slug" };
  const payload = buildPublicSitePayload(tenantId, data);
  await firestore.collection(PUBLIC_SITES).doc(slug).set(payload, { merge: true });
  return { ok: true, slug };
}

async function handleTenantPublicSiteWrite(change, tenantId) {
  const firestore = db();
  const before = change.before.exists ? change.before.data() || {} : null;
  const after = change.after.exists ? change.after.data() || {} : null;

  if (!after) {
    await deletePublicSiteIfOwned(firestore, before && before.slug, tenantId);
    return null;
  }

  const prevSlug = normalizeSlug(before && before.slug);
  const nextSlug = normalizeSlug(after.slug);
  if (prevSlug && prevSlug !== nextSlug) {
    await deletePublicSiteIfOwned(firestore, prevSlug, tenantId);
  }
  if (!nextSlug) return null;
  await syncPublicSiteForTenant(firestore, tenantId, after);
  return null;
}

async function backfillAllPublicSites(firestore) {
  const snap = await firestore.collection("tenants").get();
  let written = 0;
  let skipped = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const result = await syncPublicSiteForTenant(firestore, doc.id, data);
    if (result.ok) written += 1;
    else skipped += 1;
  }
  return { tenants: snap.size, written, skipped };
}

function registerPublicSiteFunctions(exportsObj, opts) {
  const assertPlatformAdmin = opts && opts.assertPlatformAdmin;

  exportsObj.onTenantPublicSiteSync = functions.firestore
    .document("tenants/{tenantId}")
    .onWrite((change, context) =>
      handleTenantPublicSiteWrite(change, context.params.tenantId)
    );

  exportsObj.syncMyPublicSite = functions.https.onCall(async (_data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
    }
    const userSnap = await db().collection("users").doc(context.auth.uid).get();
    const tenantId = userSnap.exists
      ? String((userSnap.data() || {}).tenantId || "").trim()
      : "";
    if (!tenantId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No business linked to this account."
      );
    }
    const tenantSnap = await db().collection("tenants").doc(tenantId).get();
    if (!tenantSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Business not found.");
    }
    const result = await syncPublicSiteForTenant(db(), tenantId, tenantSnap.data() || {});
    if (!result.ok) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        result.reason || "Could not publish the public site."
      );
    }
    return { ok: true, slug: result.slug };
  });

  if (typeof assertPlatformAdmin === "function") {
    exportsObj.backfillPublicSites = functions
      .runWith({ timeoutSeconds: 540, memory: "512MB" })
      .https.onCall(async (_data, context) => {
        assertPlatformAdmin(context);
        return backfillAllPublicSites(db());
      });
  }
}

module.exports = {
  PUBLIC_SITE_KEYS,
  buildPublicSitePayload,
  syncPublicSiteForTenant,
  backfillAllPublicSites,
  handleTenantPublicSiteWrite,
  registerPublicSiteFunctions,
};
