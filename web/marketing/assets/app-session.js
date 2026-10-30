/**
 * Signed-in shop portal session (Firebase Auth + tenant + team roster).
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";

  function firstName(displayName, email) {
    var trimmed = (displayName || "").trim();
    if (trimmed) return trimmed.split(/\s+/)[0];
    var local = (email || "").split("@")[0] || "";
    if (!local) return "";
    return local.charAt(0).toUpperCase() + local.slice(1);
  }

  function salutation(date) {
    var hour = (date || new Date()).getHours();
    if (hour >= 5 && hour < 12) return "Good morning";
    if (hour >= 12 && hour < 17) return "Good afternoon";
    return "Good evening";
  }

  function industryKind(industry) {
    var t = String(industry || "").toLowerCase();
    if (t === "barber") return "Shop";
    if (t === "hair") return "Salon";
    if (t === "nails") return "Studio";
    if (t === "tattoos") return "Studio";
    if (t === "fishing" || t === "charter") return "Charter";
    return "Shop";
  }

  function isTeamMode(members, ownerUid) {
    var list = members || [];
    if (list.length > 1) return true;
    return list.some(function (m) {
      var role = (m.accessRole || m.role || "").toLowerCase();
      if (role === "owner") return false;
      if (ownerUid && m.uid === ownerUid) return false;
      return true;
    });
  }

  function parseDepositAmount(raw) {
    if (typeof raw === "number" && raw > 0) return raw;
    var n = parseFloat(raw);
    return n > 0 ? n : null;
  }

  function accessFromTenant(tenant) {
    var wf = (tenant && tenant.workflow) || {};
    var smsStatus = String((tenant && tenant.smsStatus) || "").toLowerCase();
    var smsPhone = String((tenant && tenant.smsPhoneNumber) || "").trim();
    return {
      confirmationType: String(wf.confirmationType || "").trim(),
      depositAmount: parseDepositAmount(wf.depositAmount),
      canSendClientSms: smsStatus === "active" && !!smsPhone,
    };
  }

  function mergeAccess(fallback, data) {
    if (!data) return fallback;
    var amount = parseDepositAmount(data.depositAmount);
    return {
      confirmationType: String(
        data.confirmationType || fallback.confirmationType || ""
      ).trim(),
      depositAmount: amount != null ? amount : fallback.depositAmount,
      canSendClientSms:
        data.canSendClientSms != null
          ? !!data.canSendClientSms
          : fallback.canSendClientSms,
      accessRole: String(data.accessRole || "").trim().toLowerCase(),
      managerPermissions: data.managerPermissions || {},
      canTakePayments: data.canTakePayments === true,
      managersApproveAppointments: data.managersApproveAppointments === true,
      bookingRequiresApproval: data.bookingRequiresApproval !== false,
      canEditPortfolio: data.canEditPortfolio === true,
      canEditPublicBio: data.canEditPublicBio === true,
    };
  }

  function sessionPayload(user, tenantId, tenant, extras) {
    extras = extras || {};
    return {
      user: user,
      tenantId: tenantId,
      tenant: tenant,
      members: extras.members || [],
      ownerUid: extras.ownerUid || tenant.ownerUid || "",
      isOwner:
        extras.isOwner != null ? extras.isOwner : tenant.ownerUid === user.uid,
      teamMode: extras.teamMode === true,
      firstName: firstName(user.displayName, user.email),
      salutation: salutation(),
      shopName: tenant.displayName || tenant.businessName || "Shop",
      shopKind: industryKind(tenant.industry),
      access: extras.access || accessFromTenant(tenant),
    };
  }

  function load(user) {
    var db = firebase.firestore();
    var fns = firebase.app().functions(REGION);
    return db
      .collection("users")
      .doc(user.uid)
      .get()
      .then(function (userSnap) {
        var userData = userSnap.exists ? userSnap.data() : {};
        var tenantId = userData.tenantId;
        if (!tenantId) {
          var err = new Error("no-shop");
          err.code = "no-shop";
          throw err;
        }
        return db
          .collection("tenants")
          .doc(tenantId)
          .get()
          .then(function (tenantSnap) {
            if (!tenantSnap.exists) {
              var missing = new Error("no-shop");
              missing.code = "no-shop";
              throw missing;
            }
            var tenant = tenantSnap.data() || {};
            tenant.id = tenantSnap.id;
            var allowed =
              tenant.ownerUid === user.uid || userData.tenantId === tenantSnap.id;
            if (!allowed) {
              var denied = new Error("no-shop");
              denied.code = "no-shop";
              throw denied;
            }
            return Promise.all([
              fns.httpsCallable("listTenantMembers")({}).catch(function () {
                return { data: null };
              }),
              fns.httpsCallable("getMyTeamAccess")({}).catch(function () {
                return { data: null };
              }),
            ]).then(function (results) {
              var memberData = (results[0] && results[0].data) || {};
              var members = memberData.members || [];
              var ownerUid = memberData.ownerUid || tenant.ownerUid || "";
              var owner = !!(memberData.isOwner || tenant.ownerUid === user.uid);
              return sessionPayload(user, tenantSnap.id, tenant, {
                members: members,
                ownerUid: ownerUid,
                isOwner: owner,
                teamMode: isTeamMode(members, ownerUid),
                access: mergeAccess(
                  accessFromTenant(tenant),
                  results[1] && results[1].data
                ),
              });
            });
          });
      });
  }

  /**
   * What the signed-in person may see and do — the same rules as the iPhone app's team access:
   * owners see everything; managers get what Team → Permissions allows; staff see their own work.
   */
  function can(session, what) {
    if (!session) return false;
    if (session.isOwner) return true;
    var a = session.access || {};
    var manager = a.accessRole === "manager";
    var p = a.managerPermissions || {};
    switch (what) {
      case "viewAllBookings": return manager && p.viewAllBookings === true;
      case "approveRequests": return manager && p.approveRejectRequests === true && a.managersApproveAppointments === true && a.bookingRequiresApproval !== false;
      case "clients": return manager && p.accessClientList === true;
      case "earnings": return manager && p.viewEarningsReports === true;
      case "payments": return a.canTakePayments === true || (manager && p.viewEarningsReports === true);
      case "team": return manager;
      case "shop": return manager;
      case "insights": return true;
      case "editServices": return manager && p.editServicesPricing === true;
      case "website": return false;
      case "websiteProfile": return a.canEditPortfolio === true || a.canEditPublicBio === true;
      case "billing": return false;
      default: return false;
    }
  }

  global.ShopAppSession = { load: load, firstName: firstName, salutation: salutation };
  global.ShopAppAccess = { can: can };
})(window);
