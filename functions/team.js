/**
 * Invites, members, roles, team payouts, public profiles.
 * Moved from index.js without changes; shared helpers come from core.js.
 */

const {
  functions,
  onCall,
  HttpsError,
  admin,
  crypto,
  Stripe,
  sms,
  stripeSecretKey,
  stripeSubscriptionPriceIds,
  db,
  normalizeSubscriptionPlan,
  isSingleOperatorPlan,
  maybeReduceSmsExtraAfterReleasingOccupiedLine,
  stripeClientFromSecret,
  TENANT_INVITE_TTL_MS,
  DEFAULT_MANAGER_PERMISSIONS,
  bookingRequiresApproval,
  managersApproveAppointments,
  resolveTenantWorkflow,
  getMemberAccessContext,
  DEFAULT_MANAGER_NOTIFICATIONS,
  parseAccessRole,
  parseInviteAccessRole,
  normalizeJobTitle,
  memberUsesOwnConnect,
  normalizeMemberSettings,
  defaultJobTitleForIndustry,
  assertTenantOwnerUid,
  normalizeProviderGalleryImages,
  normalizeMemberSlugInput,
  allocateMemberSlug,
  ensureUserMemberSlug,
  defaultMemberSettingsForInvite,
  serializePublicProvider,
  serializeTeamRosterMember,
  resolveTenantBySlug,
  serializeTeamMember,
  maxSeatsForPlanNormalized,
  countUsersForTenant,
  parseInviteToken,
  unassignMemberFromTenantRecords,
  messagingFieldsWithLineCount,
} = require("./core");

/** Public preview for join page (business name only). */
exports.getTenantInvitePreview = functions.https.onCall(async (data) => {
  const token = parseInviteToken(data);
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invite link.");
  }
  const snap = await db.collection("tenantInvites").doc(token).get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
  }
  const inv = snap.data();
  if (inv.usedAt) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite was already used."
    );
  }
  const exp = inv.expiresAt;
  if (exp && exp.toMillis && exp.toMillis() < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This invite has expired.");
  }
  const tenantSnap = await db.collection("tenants").doc(inv.tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const t = tenantSnap.data();
  const plan = normalizeSubscriptionPlan(t.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting team invites on its current plan."
    );
  }
  const businessName = t.displayName || t.businessName || "Business";
  const jobTitle = normalizeJobTitle(
    inv.jobTitle || defaultJobTitleForIndustry(t.industry || "custom")
  );
  return { businessName, jobTitle };
});

/** Owner-only: single-use invite; pass baseUrl for full join link. */
exports.createTenantInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const userData = userDoc.data();
  const tenantId = (data && data.tenantId) || userData.tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "No tenant linked to this account."
    );
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data();
  if (tenant.ownerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can create team invites."
    );
  }
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This plan is owner only. Upgrade to Studio or Shop to invite team members."
    );
  }
  const memberCount = await countUsersForTenant(tenantId);
  const maxSeats = maxSeatsForPlanNormalized(plan);
  if (memberCount >= maxSeats) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      plan === "studio"
        ? "Studio plan allows up to 5 team members."
        : "Team member limit reached for this plan."
    );
  }
  const inviteAccessRole = parseInviteAccessRole(data);
  const industry = (tenant.industry || "custom").toString();
  const jobTitleRaw = normalizeJobTitle((data && data.jobTitle) || "");
  const jobTitle = jobTitleRaw || defaultJobTitleForIndustry(industry);

  const token = crypto.randomBytes(32).toString("hex");
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(
    now.toMillis() + TENANT_INVITE_TTL_MS
  );
  await db.collection("tenantInvites").doc(token).set({
    tenantId,
    createdByUid: uid,
    createdAt: now,
    expiresAt,
    role: inviteAccessRole,
    accessRole: inviteAccessRole,
    jobTitle,
  });
  const baseUrl = ((data && data.baseUrl) || "")
    .toString()
    .trim()
    .replace(/\/+$/, "");
  const joinUrl = baseUrl ? `${baseUrl}/join?t=${encodeURIComponent(token)}` : null;
  return { token, joinUrl };
});

/** After Auth sign-in/up: attach user as staff and consume invite (transaction). */
exports.acceptTenantInvite = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const token = parseInviteToken(data);
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid invite link.");
  }
  const uid = context.auth.uid;
  const inviteRef = db.collection("tenantInvites").doc(token);
  const inviteSnap = await inviteRef.get();
  if (!inviteSnap.exists) {
    throw new functions.https.HttpsError("not-found", "This invite link is not valid.");
  }
  const inv = inviteSnap.data();
  if (inv.usedAt) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This invite was already used."
    );
  }
  const exp = inv.expiresAt;
  if (exp && exp.toMillis && exp.toMillis() < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This invite has expired.");
  }
  const tenantId = inv.tenantId;
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = tenantSnap.data();
  if (tenant.ownerUid === uid) {
    return { ok: true, tenantId, alreadyOwner: true };
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  if (userData.tenantId && userData.tenantId !== tenantId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This account already belongs to another business. Use a different account to accept this invite."
    );
  }
  const existingRole = parseAccessRole(userData.role || userData.accessRole);
  if (userData.tenantId === tenantId && existingRole !== "owner") {
    return { ok: true, tenantId, alreadyMember: true };
  }

  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is on an owner-only plan and cannot add team members."
    );
  }
  const memberCount = await countUsersForTenant(tenantId);
  const maxSeats = maxSeatsForPlanNormalized(plan);
  if (memberCount >= maxSeats) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      plan === "studio"
        ? "Studio plan allows up to 5 team members."
        : "Team member limit reached for this plan."
    );
  }

  const slug = tenant.slug || "";
  const tenantBusinessLabel = tenant.displayName || tenant.businessName || "";
  const industry = tenant.industry || "custom";
  const subscriptionPlan = plan;
  const email =
    (context.auth.token && context.auth.token.email) || userData.email || "";

  const rawJoinFirst = ((data && data.firstName) || "").toString().trim().slice(0, 80);
  const rawJoinLast = ((data && data.lastName) || "").toString().trim().slice(0, 80);
  const rawJoinPhone = ((data && data.phone) || "").toString().trim().slice(0, 40);
  const phoneDigits = rawJoinPhone.replace(/\D/g, "");
  if (!rawJoinFirst || !rawJoinLast || !rawJoinPhone) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "First name, last name, and phone are required."
    );
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Enter a valid phone number (at least 10 digits)."
    );
  }

  const firstName = rawJoinFirst;
  const lastName = rawJoinLast;
  const personName = `${rawJoinFirst} ${rawJoinLast}`.trim();
  const personDisplay = personName;

  const defaultAvailability = {
    timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
    daysOpen: [1, 2, 3, 4, 5],
    timeZone: "America/New_York",
  };
  const defaultWorkflow = {
    confirmationType: "request_approve",
    responseTimeHours: 24,
  };

  const inviteAccessRole = parseAccessRole(inv.accessRole || inv.role);
  const inviteJobTitle = normalizeJobTitle(
    inv.jobTitle || defaultJobTitleForIndustry(industry)
  );
  const memberSlug = await allocateMemberSlug(tenantId, firstName, lastName, uid);
  const isBookable = inviteAccessRole !== "manager";
  const inviteMemberSettings = defaultMemberSettingsForInvite(inviteAccessRole);

  await db.runTransaction(async (tx) => {
    const invFresh = await tx.get(inviteRef);
    if (!invFresh.exists) {
      throw new functions.https.HttpsError("not-found", "Invite not found.");
    }
    const inv2 = invFresh.data();
    if (inv2.usedAt) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This invite was already used."
      );
    }
    tx.update(inviteRef, {
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      usedByUid: uid,
    });
    const userPatch = {
      tenantId,
      tenantSlug: slug,
      role: inviteAccessRole,
      accessRole: inviteAccessRole,
      jobTitle: inviteAccessRole === "manager" ? "Manager" : inviteJobTitle,
      business: tenantBusinessLabel,
      industry,
      subscriptionPlan,
      subscriptionStatus: userData.subscriptionStatus || "active",
      email,
      firstName,
      lastName,
      displayName: personDisplay,
      name: personName,
      phone: rawJoinPhone,
      profilePhotoUrl: userData.profilePhotoUrl || "",
      memberSlug,
      isBookable,
      memberSettings: inviteMemberSettings,
      availability: userData.availability || defaultAvailability,
      workflow: userData.workflow || defaultWorkflow,
      createdAt: userData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    };
    tx.set(userRef, userPatch, { merge: true });
  });

  return { ok: true, tenantId };
});

/** Public: bookable providers for a studio/shop site (team cards + provider pages). */
exports.listPublicProviders = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required.");
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = resolved.data;
  const tenantId = resolved.id;
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    return { providers: [], subscriptionPlan: plan, tenantSlug };
  }
  if (tenant.isActive === false) {
    return { providers: [], subscriptionPlan: plan, tenantSlug };
  }
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const providers = [];
  for (const doc of snap.docs) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      const pub = serializePublicProvider(fresh, tenant);
      if (pub) providers.push(pub);
    } else {
      const pub = serializePublicProvider(doc, tenant);
      if (pub) providers.push(pub);
    }
  }
  providers.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  return { providers, subscriptionPlan: plan, tenantSlug };
});

/** Public: team roster cards for /team and home strip (visibility flags, not bookable-only). */
exports.listTeamRoster = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  if (!tenantSlug) {
    throw new functions.https.HttpsError("invalid-argument", "tenantSlug is required.");
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = resolved.data;
  const tenantId = resolved.id;
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    return { members: [], subscriptionPlan: plan, tenantSlug };
  }
  if (tenant.isActive === false) {
    return { members: [], subscriptionPlan: plan, tenantSlug };
  }
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const members = [];
  for (const doc of snap.docs) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      const row = serializeTeamRosterMember(fresh, tenant);
      if (row) members.push(row);
    } else {
      const row = serializeTeamRosterMember(doc, tenant);
      if (row) members.push(row);
    }
  }
  members.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  return { members, subscriptionPlan: plan, tenantSlug };
});

/** Public: one provider profile for /{studio}/{member} pages. */
exports.getPublicProvider = functions.https.onCall(async (data) => {
  const tenantSlug = (data?.tenantSlug || "").toString().trim().toLowerCase();
  const memberSlug = normalizeMemberSlugInput(data?.memberSlug);
  if (!tenantSlug || !memberSlug) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "tenantSlug and memberSlug are required."
    );
  }
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    throw new functions.https.HttpsError("not-found", "Business not found.");
  }
  const tenant = resolved.data;
  const tenantId = resolved.id;
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan)) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  if (tenant.isActive === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This business is not accepting bookings right now."
    );
  }
  const snap = await db
    .collection("users")
    .where("tenantId", "==", tenantId)
    .where("memberSlug", "==", memberSlug)
    .limit(1)
    .get();
  if (snap.empty) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  const doc = snap.docs[0];
  let provider = serializePublicProvider(doc, tenant);
  if (!provider) {
    const userData = doc.data();
    if (!normalizeMemberSlugInput(userData.memberSlug)) {
      await ensureUserMemberSlug(doc.id, userData, tenantId);
      const fresh = await doc.ref.get();
      provider = serializePublicProvider(fresh, tenant);
    }
  }
  if (!provider) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "This team member is not available for online booking."
    );
  }
  return {
    provider,
    tenant: {
      slug: tenant.slug || tenantSlug,
      displayName: tenant.displayName || tenant.businessName || "",
      businessName: tenant.businessName || "",
      subscriptionPlan: plan,
    },
  };
});

/** Member (or owner for a member): save portfolio image URLs for a provider page. */
exports.updateProviderGallery = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const targetUid = ((data && data.memberUid) || uid).toString().trim();
  const images = normalizeProviderGalleryImages(data && data.providerGalleryImages);
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const plan = normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan);
  if (isSingleOperatorPlan(plan) && targetUid !== ctx.tenant.ownerUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Member portfolios are for Studio and Shop teams."
    );
  }
  if (targetUid !== uid && !ctx.isOwner) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the business owner can edit another member's portfolio."
    );
  }
  if (targetUid !== uid) {
    await assertTenantOwnerUid(uid, ctx.tenantId);
  }
  const memberRef = db.collection("users").doc(targetUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== ctx.tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  if (targetUid === uid && !ctx.isOwner) {
    const selfSettings = normalizeMemberSettings(memberSnap.data().memberSettings);
    if (!selfSettings.canEditPortfolio) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Your studio owner has not enabled portfolio editing for your account."
      );
    }
  }
  await memberRef.set({ providerGalleryImages: images }, { merge: true });
  return { ok: true, providerGalleryImages: images };
});

/** Member: save own public bio when owner enabled self-edit in Design → Team. */
exports.updateMyPublicProfile = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  if (!ctx.tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const settings = normalizeMemberSettings(ctx.userData.memberSettings);
  if (!ctx.isOwner && !settings.canEditPublicBio) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Your studio owner has not enabled bio editing for your account."
    );
  }
  if (data && data.providerAboutText == null) {
    throw new functions.https.HttpsError("invalid-argument", "providerAboutText is required.");
  }
  const providerAboutText = (data.providerAboutText || "")
    .toString()
    .trim()
    .slice(0, 2000);
  await db.collection("users").doc(uid).set({ providerAboutText }, { merge: true });
  return { ok: true, providerAboutText };
});

/** Signed-in member: role, effective manager toggles, tenant booking workflow. */
exports.getMyTeamAccess = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const ctx = await getMemberAccessContext(context.auth.uid);
  const isOwner = ctx.isOwner || ctx.tenant.ownerUid === context.auth.uid;
  const memberSettings = normalizeMemberSettings(ctx.userData.memberSettings);
  const usesOwnPayments = !isOwner && memberUsesOwnConnect(memberSettings.payoutMode);
  const studioSmsActive = sms.tenantStudioSmsActive(ctx.tenant);
  const memberSmsStatus = (ctx.userData.smsStatus || "off").toString();
  const memberSmsPhone = (ctx.userData.smsPhoneNumber || "").toString().trim();
  const usesOwnSms =
    usesOwnPayments && memberSmsStatus === "active" && !!memberSmsPhone;
  const canSendClientSms = sms.canSendClientSms({
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    managerPermissions: ctx.managerPermissions,
    senderUserData: ctx.userData,
  });
  const memberWebsiteSettings = normalizeMemberSettings(ctx.userData.memberSettings);
  const canEditPortfolio = isOwner || memberWebsiteSettings.canEditPortfolio === true;
  const canEditPublicBio = isOwner || memberWebsiteSettings.canEditPublicBio === true;
  return {
    tenantId: ctx.tenantId,
    isOwner,
    accessRole: isOwner ? "owner" : ctx.accessRole,
    subscriptionPlan: normalizeSubscriptionPlan(ctx.tenant.subscriptionPlan),
    managerPermissions: ctx.managerPermissions,
    confirmationType: ctx.workflow.confirmationType,
    responseTimeHours: ctx.workflow.responseTimeHours,
    depositAmount: ctx.workflow.depositAmount ?? null,
    bookingRequiresApproval: ctx.bookingRequiresApproval,
    managersApproveAppointments: ctx.managersApproveAppointments,
    usesStudioBookingPolicy: ctx.usesStudioBookingPolicy === true,
    tenantConfirmationType: ctx.tenantWorkflow.confirmationType,
    payoutMode: isOwner ? null : memberSettings.payoutMode,
    usesOwnPayments,
    canTakePayments: isOwner || (usesOwnPayments && memberSettings.canTakePayments !== false),
    studioSmsActive,
    usesOwnSms,
    canSendClientSms,
    memberSmsStatus: isOwner ? null : memberSmsStatus,
    memberSmsPhoneNumber: isOwner ? null : memberSmsPhone,
    canEditPortfolio,
    canEditPublicBio,
  };
});

/** Tenant members: roster (+ owner-only policy fields for Team screen). */
exports.listTenantMembers = functions
  .runWith({
    secrets: [
      sms.twilioAccountSid,
      sms.twilioAuthToken,
      stripeSecretKey,
      stripeSubscriptionPriceIds,
    ],
  })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const ctx = await getMemberAccessContext(uid);
  const tenantId = ctx.tenantId;
  const tenant = ctx.tenant;
  const isOwner = ctx.isOwner;
  const snap = await db.collection("users").where("tenantId", "==", tenantId).get();
  const ownerSnap = tenant.ownerUid
    ? await db.collection("users").doc(tenant.ownerUid).get()
    : null;
  const ownerData =
    ownerSnap && ownerSnap.exists ? ownerSnap.data() : null;
  const members = snap.docs.map((doc) =>
    serializeTeamMember(doc, tenant.ownerUid, tenant, ownerData)
  );
  members.sort((a, b) => {
    const rank = { owner: 0, manager: 1, member: 2 };
    const ra = rank[a.accessRole] ?? 3;
    const rb = rank[b.accessRole] ?? 3;
    if (ra !== rb) return ra - rb;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });
  const perms = {
    ...DEFAULT_MANAGER_PERMISSIONS,
    ...(tenant.managerPermissions || {}),
  };
  const notifs = {
    ...DEFAULT_MANAGER_NOTIFICATIONS,
    ...(tenant.managerNotifications || {}),
  };
  const workflow = resolveTenantWorkflow(tenant, ownerData);
  const confirmationType = workflow.confirmationType;
  const messaging = await messagingFieldsWithLineCount(
    tenantId,
    tenant,
    ownerData,
    snap.docs
  );
  return {
    tenantId,
    industry: tenant.industry || "custom",
    subscriptionPlan: normalizeSubscriptionPlan(tenant.subscriptionPlan),
    ownerUid: tenant.ownerUid,
    isOwner,
    managerPermissions: perms,
    managerNotifications: notifs,
    confirmationType,
    bookingRequiresApproval: bookingRequiresApproval(confirmationType),
    managersApproveAppointments: managersApproveAppointments(workflow),
    members,
    ...messaging,
  };
});

/**
 * Owner-only: team payout overview for the web Team payouts page.
 * Params: { fromMs?, toMs? } (defaults to the current month).
 * Returns { members, entries, truncated } — members carry payout settings, Stripe status, and
 * period totals; entries are paymentLedger rows in the range (newest first, max 500).
 */
exports.getTeamPayoutSummary = functions
  .runWith({ secrets: [stripeSecretKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }
    const ctx = await getMemberAccessContext(context.auth.uid);
    if (!ctx.isOwner) {
      throw new functions.https.HttpsError("permission-denied", "Only the shop owner can view team payouts.");
    }
    const tenantId = ctx.tenantId;
    const tenant = ctx.tenant;
    const ownerUid = (tenant.ownerUid || "").toString();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let fromMs = Number(data && data.fromMs);
    let toMs = Number(data && data.toMs);
    if (!Number.isFinite(fromMs) || fromMs <= 0) fromMs = monthStart;
    if (!Number.isFinite(toMs) || toMs <= 0) toMs = now.getTime();
    if (toMs < fromMs) [fromMs, toMs] = [toMs, fromMs];

    const MAX_ENTRIES = 500;
    const [usersSnap, ledgerSnap] = await Promise.all([
      db.collection("users").where("tenantId", "==", tenantId).get(),
      db
        .collection("tenants")
        .doc(tenantId)
        .collection("paymentLedger")
        .where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(fromMs))
        .where("createdAt", "<=", admin.firestore.Timestamp.fromMillis(toMs))
        .orderBy("createdAt", "desc")
        .limit(MAX_ENTRIES + 1)
        .get(),
    ]);

    const secretKey = stripeSecretKey.value();
    const stripe = secretKey ? new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" }) : null;

    async function stripeStatus(accountId) {
      if (!accountId) return "not_connected";
      if (!stripe) return "unknown";
      try {
        const account = await stripe.accounts.retrieve(accountId);
        if (account.charges_enabled && account.payouts_enabled) return "active";
        if (account.details_submitted) return "restricted";
        return "incomplete";
      } catch (err) {
        console.warn("getTeamPayoutSummary account", accountId, err.message);
        return "unknown";
      }
    }

    const members = await Promise.all(
      usersSnap.docs.map(async (doc) => {
        const d = doc.data() || {};
        const isOwner = doc.id === ownerUid;
        const settings = normalizeMemberSettings(d.memberSettings);
        const accountId = (isOwner ? tenant.stripeAccountId : d.stripeAccountId || "").toString().trim();
        const fn = (d.firstName || "").toString().trim();
        const ln = (d.lastName || "").toString().trim();
        return {
          uid: doc.id,
          displayName: (d.displayName || d.name || `${fn} ${ln}`.trim() || "Member").toString(),
          profilePhotoUrl: (d.profilePhotoUrl || "").toString(),
          isOwner,
          payoutMode: isOwner ? null : settings.payoutMode,
          paymentSplitEnabled: !isOwner && settings.paymentSplitEnabled,
          paymentSplitPercent: isOwner ? 0 : settings.paymentSplitPercent,
          paymentSplitAppliesTo: settings.paymentSplitAppliesTo,
          canTakePayments: isOwner || settings.canTakePayments !== false,
          stripeStatus: await stripeStatus(accountId),
          totals: { count: 0, grossCents: 0, memberCents: 0, studioCents: 0, studioReturnedCents: 0, feeCents: 0 },
        };
      })
    );
    const byUid = {};
    members.forEach((m) => { byUid[m.uid] = m; });

    const docs = ledgerSnap.docs.slice(0, MAX_ENTRIES);
    const entries = docs.map((doc) => {
      const l = doc.data() || {};
      const memberUid = (l.attributedMemberUid || ownerUid).toString();
      const isOwnerEntry = memberUid === ownerUid;
      const service = Math.round(Number(l.serviceCents) || 0);
      const split = l.splitApplied === true;
      // Owner charges are all studio money; a member keeps their split share, or all of it when no split applies.
      const memberCents = isOwnerEntry ? 0 : split ? Math.round(Number(l.artistShareCents) || 0) : service;
      const studioCents = isOwnerEntry ? service : split ? Math.round(Number(l.studioServiceShareCents) || 0) : 0;
      const entry = {
        id: doc.id,
        createdAtMs: l.createdAt && l.createdAt.toMillis ? l.createdAt.toMillis() : null,
        memberUid,
        paymentKind: (l.paymentKind || "service").toString(),
        grossCents: Math.round(Number(l.grossCents) || 0),
        serviceCents: service,
        feeCents: Math.round(Number(l.stripeFeeCents) || 0),
        splitApplied: split,
        splitPercentApplied: Math.round(Number(l.splitPercentApplied) || 0),
        memberCents,
        studioCents,
        studioShareStatus: (l.studioShareStatus || (split ? "pending" : "not_applicable")).toString(),
        studioReturnedCents: Math.round(Number(l.studioShareReversedCents) || 0),
      };
      const m = byUid[memberUid];
      if (m) {
        m.totals.count += 1;
        m.totals.grossCents += entry.grossCents;
        m.totals.memberCents += entry.memberCents;
        m.totals.studioCents += entry.studioCents;
        m.totals.studioReturnedCents += entry.studioReturnedCents;
        m.totals.feeCents += entry.feeCents;
      }
      return entry;
    });

    members.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return (a.displayName || "").localeCompare(b.displayName || "");
    });
    return { fromMs, toMs, members, entries, truncated: ledgerSnap.size > MAX_ENTRIES };
  });

/** Owner-only: save manager permission toggles and notification prefs on tenant. */
exports.updateTenantManagerPolicy = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  await assertTenantOwnerUid(uid, tenantId);
  const incomingPerms = (data && data.managerPermissions) || {};
  const incomingNotifs = (data && data.managerNotifications) || {};
  const managerPermissions = { ...DEFAULT_MANAGER_PERMISSIONS };
  const managerNotifications = { ...DEFAULT_MANAGER_NOTIFICATIONS };
  for (const key of Object.keys(DEFAULT_MANAGER_PERMISSIONS)) {
    if (typeof incomingPerms[key] === "boolean") managerPermissions[key] = incomingPerms[key];
  }
  for (const key of Object.keys(DEFAULT_MANAGER_NOTIFICATIONS)) {
    if (typeof incomingNotifs[key] === "boolean") managerNotifications[key] = incomingNotifs[key];
  }
  await db.collection("tenants").doc(tenantId).update({
    managerPermissions,
    managerNotifications,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** Owner-only: change member access role and/or job title. */
exports.updateTenantMember = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const memberUid = ((data && data.memberUid) || "").toString().trim();
  if (!memberUid) {
    throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
  }
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const tenant = await assertTenantOwnerUid(uid, tenantId);
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  const isOwnerMember = memberUid === tenant.ownerUid;
  if (isOwnerMember && uid !== memberUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot change the owner's profile from another account."
    );
  }
  if (isOwnerMember && uid === memberUid) {
    const patch = {};
    if (data && data.jobTitle != null) {
      patch.jobTitle = normalizeJobTitle(data.jobTitle);
    }
    if (data && data.isBookable != null) {
      patch.isBookable = Boolean(data.isBookable);
    }
    if (data && data.showOnTeamPage != null) {
      patch.showOnTeamPage = Boolean(data.showOnTeamPage);
    }
    if (data && data.showOnTeamHome != null) {
      patch.showOnTeamHome = Boolean(data.showOnTeamHome);
    }
    if (data && data.providerAboutText != null) {
      patch.providerAboutText = (data.providerAboutText || "")
        .toString()
        .trim()
        .slice(0, 2000);
    }
    if (data && data.profilePhotoUrl != null) {
      patch.profilePhotoUrl = (data.profilePhotoUrl || "")
        .toString()
        .trim()
        .slice(0, 2000);
    }
    if (!Object.keys(patch).length) {
      throw new functions.https.HttpsError("invalid-argument", "Nothing to update.");
    }
    await memberRef.set(patch, { merge: true });
    return { ok: true };
  }
  if (isOwnerMember) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot change the owner's role."
    );
  }
  const patch = {};
  if (data && data.accessRole != null) {
    const next = parseAccessRole(data.accessRole);
    if (next === "owner") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Cannot assign owner role."
      );
    }
    patch.role = next;
    patch.accessRole = next;
  }
  if (data && data.jobTitle != null) {
    patch.jobTitle = normalizeJobTitle(data.jobTitle);
  }
  if (data && data.memberSettings != null) {
    const existing = normalizeMemberSettings(memberSnap.data().memberSettings);
    const incoming =
      data.memberSettings && typeof data.memberSettings === "object"
        ? data.memberSettings
        : {};
    patch.memberSettings = normalizeMemberSettings({ ...existing, ...incoming });
  }
  if (data && data.isBookable != null) {
    patch.isBookable = Boolean(data.isBookable);
  }
  if (data && data.showOnTeamPage != null) {
    patch.showOnTeamPage = Boolean(data.showOnTeamPage);
  }
  if (data && data.showOnTeamHome != null) {
    patch.showOnTeamHome = Boolean(data.showOnTeamHome);
  }
  if (data && data.providerAboutText != null) {
    patch.providerAboutText = (data.providerAboutText || "")
      .toString()
      .trim()
      .slice(0, 2000);
  }
  if (data && data.profilePhotoUrl != null) {
    patch.profilePhotoUrl = (data.profilePhotoUrl || "")
      .toString()
      .trim()
      .slice(0, 2000);
  }
  if (data && data.memberSlug != null) {
    const nextSlug = normalizeMemberSlugInput(data.memberSlug);
    if (!nextSlug) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Page URL must use letters, numbers, and hyphens only."
      );
    }
    const clashSnap = await db
      .collection("users")
      .where("tenantId", "==", tenantId)
      .where("memberSlug", "==", nextSlug)
      .limit(2)
      .get();
    const taken = clashSnap.docs.some((doc) => doc.id !== memberUid);
    if (taken) {
      throw new functions.https.HttpsError(
        "already-exists",
        "That page URL is already in use on your team."
      );
    }
    patch.memberSlug = nextSlug;
  }
  if (data && data.providerGalleryImages != null) {
    patch.providerGalleryImages = normalizeProviderGalleryImages(data.providerGalleryImages);
  }
  if (!Object.keys(patch).length) {
    throw new functions.https.HttpsError("invalid-argument", "Nothing to update.");
  }
  await memberRef.set(patch, { merge: true });
  return { ok: true };
});

/** Owner-only: remove a team member from the business. */
exports.removeTenantMember = functions
  .runWith({
    secrets: [
      sms.twilioAccountSid,
      sms.twilioAuthToken,
      stripeSecretKey,
      stripeSubscriptionPriceIds,
    ],
  })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const uid = context.auth.uid;
  const memberUid = ((data && data.memberUid) || "").toString().trim();
  if (!memberUid) {
    throw new functions.https.HttpsError("invalid-argument", "memberUid is required.");
  }
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("not-found", "User profile not found.");
  }
  const tenantId = userDoc.data().tenantId;
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No tenant linked.");
  }
  const tenant = await assertTenantOwnerUid(uid, tenantId);
  if (memberUid === tenant.ownerUid || memberUid === uid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Cannot remove the owner."
    );
  }
  const memberRef = db.collection("users").doc(memberUid);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists || memberSnap.data().tenantId !== tenantId) {
    throw new functions.https.HttpsError("not-found", "Team member not found.");
  }
  const memberData = memberSnap.data();
  const heldSmsSlot =
    sms.occupiesSmsLineSlot(memberData) || memberData.smsLineRequestPending === true;
  const hadPersonalSms =
    heldSmsSlot || memberData.smsEnabled === true;

  const smsRelease = await sms.releaseMemberSms(memberData);
  const { unassignedBookings, clearedThreads } = await unassignMemberFromTenantRecords(
    tenantId,
    memberUid
  );

  await memberRef.set(
    {
      tenantId: admin.firestore.FieldValue.delete(),
      tenantSlug: admin.firestore.FieldValue.delete(),
      role: admin.firestore.FieldValue.delete(),
      accessRole: admin.firestore.FieldValue.delete(),
      jobTitle: admin.firestore.FieldValue.delete(),
      memberSlug: admin.firestore.FieldValue.delete(),
      isBookable: false,
      providerAboutText: admin.firestore.FieldValue.delete(),
      providerGalleryImages: admin.firestore.FieldValue.delete(),
      memberSettings: admin.firestore.FieldValue.delete(),
      workflow: admin.firestore.FieldValue.delete(),
      smsPhoneNumber: admin.firestore.FieldValue.delete(),
      smsPhoneNumberSid: admin.firestore.FieldValue.delete(),
      smsStatus: "off",
      smsEnabled: false,
      smsEnabledAt: admin.firestore.FieldValue.delete(),
      smsProvisionError: admin.firestore.FieldValue.delete(),
      smsSuspendedAt: admin.firestore.FieldValue.delete(),
      smsSuspendReason: admin.firestore.FieldValue.delete(),
      smsLineRequestPending: admin.firestore.FieldValue.delete(),
      smsLineRequestedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const plan = normalizeSubscriptionPlan(tenant.subscriptionPlan);
  const paidExtras = await maybeReduceSmsExtraAfterReleasingOccupiedLine(
    stripeClientFromSecret(),
    tenantId,
    tenant,
    plan,
    heldSmsSlot
  );
  return {
    ok: true,
    releasedPersonalSms: hadPersonalSms && smsRelease.released,
    unassignedBookings,
    clearedThreads,
    smsExtraPaid: paidExtras != null ? paidExtras : sms.smsExtraPaidQuantity(tenant),
  };
});
