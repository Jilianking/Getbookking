//
//  TenantTeamAccess.swift
//
//  Effective permissions for the signed-in user (owner / manager / member).
//

import Foundation
import FirebaseFunctions
import FirebaseAuth

/// Resolved access for the current user against tenant policy + manager toggles.
struct EffectiveTeamAccess: Equatable {
    var isOwner: Bool = false
    var accessRole: TeamAccessRole = .owner
    var permissions: ManagerPermissions = .defaults
    var confirmationType: BookingConfirmationType = .requestApprove
    var bookingRequiresApproval: Bool = true
    var managersApproveAppointments: Bool = true
    var usesStudioBookingPolicy: Bool = false
    var subscriptionPlan: SubscriptionPlan = .solo
    /// Independent members connect own Stripe; studio_payroll uses studio account.
    var payoutMode: MemberPayoutMode = .independent
    var usesOwnPayments: Bool = false
    var canTakePayments: Bool = true
    /// Studio has an active shared texting line (prerequisite for personal lines).
    var studioSmsActive: Bool = false
    /// Independent member with an active personal texting line.
    var usesOwnSms: Bool = false
    var canSendClientSms: Bool = false
    var memberSmsStatus: String = "off"
    var memberSmsPhoneNumber: String = ""
    /// Owner-enabled self-edit of portfolio photos on the public site.
    var canEditPortfolio: Bool = false
    /// Owner-enabled self-edit of public bio on team/booking pages.
    var canEditPublicBio: Bool = false

    var canAccessWebsiteProfile: Bool {
        canEditPortfolio || canEditPublicBio
    }

    static let ownerFullAccess = EffectiveTeamAccess(
        isOwner: true,
        accessRole: .owner,
        permissions: ManagerPermissions(
            viewAllBookings: true,
            approveRejectRequests: true,
            editServicesPricing: true,
            manageBookingFormStyle: true,
            manageArtistSchedules: true,
            accessClientList: true,
            viewEarningsReports: true,
            sendClientNotifications: true
        ),
        confirmationType: .requestApprove,
        bookingRequiresApproval: true,
        managersApproveAppointments: true,
        usesStudioBookingPolicy: false,
        subscriptionPlan: .studio,
        payoutMode: .independent,
        usesOwnPayments: false,
        canTakePayments: true,
        canEditPortfolio: true,
        canEditPublicBio: true
    )

    var canManageBookingPolicy: Bool { isOwner }

    var canApproveRejectRequests: Bool {
        guard bookingRequiresApproval else { return false }
        if isOwner { return true }
        guard managersApproveAppointments else { return false }
        if accessRole == .manager { return permissions.approveRejectRequests }
        return false
    }

    var canManageBookingFormStyle: Bool {
        if isOwner { return true }
        if accessRole == .manager { return permissions.manageBookingFormStyle }
        return false
    }

    var canEditServicesPricing: Bool {
        if isOwner { return true }
        if accessRole == .manager { return permissions.editServicesPricing }
        return false
    }

    var canViewAllBookings: Bool {
        if isOwner { return true }
        if accessRole == .manager { return permissions.viewAllBookings }
        return false
    }

    var canAccessClientList: Bool {
        if isOwner { return true }
        if accessRole == .manager { return permissions.accessClientList }
        return false
    }

    var canManageArtistSchedules: Bool {
        if isOwner { return true }
        if accessRole == .manager { return permissions.manageArtistSchedules }
        return false
    }
}

enum TenantTeamAccessService {
    private static let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    static func fetchCurrentAccess(isDemoMode: Bool) async -> EffectiveTeamAccess {
        if isDemoMode { return .ownerFullAccess }
        guard Auth.auth().currentUser != nil else {
            return EffectiveTeamAccess()
        }
        do {
            let result = try await functions.httpsCallable("getMyTeamAccess").call([:])
            guard let data = result.data as? [String: Any] else {
                return EffectiveTeamAccess()
            }
            return parse(data)
        } catch {
            print("getMyTeamAccess failed: \(error)")
            return EffectiveTeamAccess()
        }
    }

    /// When Cloud Function lags or `users.role` ≠ `tenants.ownerUid`, trust Firestore owner uid.
    static func reconcileOwnerAccess(
        uid: String,
        current: EffectiveTeamAccess,
        firebaseService: FirebaseService
    ) async -> EffectiveTeamAccess {
        do {
            guard let profile = try await firebaseService.fetchProviderProfile(uid: uid),
                  let tenantId = profile.tenantId,
                  let tenant = try await firebaseService.fetchTenant(tenantId: tenantId),
                  let ownerUid = tenant["ownerUid"] as? String,
                  !ownerUid.isEmpty,
                  ownerUid == uid else {
                return current
            }
            return EffectiveTeamAccess(
                isOwner: true,
                accessRole: .owner,
                permissions: ManagerPermissions(
                    viewAllBookings: true,
                    approveRejectRequests: true,
                    editServicesPricing: true,
                    manageBookingFormStyle: true,
                    manageArtistSchedules: true,
                    accessClientList: true,
                    viewEarningsReports: true,
                    sendClientNotifications: true
                ),
                confirmationType: current.confirmationType,
                bookingRequiresApproval: current.bookingRequiresApproval,
                managersApproveAppointments: current.managersApproveAppointments,
                usesStudioBookingPolicy: current.usesStudioBookingPolicy,
                subscriptionPlan: SubscriptionPlan.normalized(fromFirestore: tenant["subscriptionPlan"] as? String),
                payoutMode: current.payoutMode,
                usesOwnPayments: current.usesOwnPayments,
                canTakePayments: true,
                canEditPortfolio: true,
                canEditPublicBio: true
            )
        } catch {
            return current
        }
    }

    static func parse(_ data: [String: Any]) -> EffectiveTeamAccess {
        let isOwner = data["isOwner"] as? Bool ?? false
        let role = TeamAccessRole.fromFirestore(data["accessRole"] as? String)
        let perms = ManagerPermissions(dictionary: data["managerPermissions"] as? [String: Any])
        let rawType = (data["confirmationType"] as? String) ?? BookingConfirmationType.requestApprove.rawValue
        let confirmation = BookingConfirmationType(rawValue: rawType) ?? .requestApprove
        let requiresApproval = data["bookingRequiresApproval"] as? Bool ?? confirmation.requiresApproval
        let managersApprove = data["managersApproveAppointments"] as? Bool ?? true
        let usesStudio = data["usesStudioBookingPolicy"] as? Bool ?? false
        let payoutRaw = (data["payoutMode"] as? String) ?? MemberPayoutMode.independent.rawValue
        let payoutMode = MemberPayoutMode(rawValue: payoutRaw) ?? .independent
        let usesOwnPayments = data["usesOwnPayments"] as? Bool ?? false
        let canTakePayments = data["canTakePayments"] as? Bool ?? true
        let studioSmsActive = data["studioSmsActive"] as? Bool ?? false
        let usesOwnSms = data["usesOwnSms"] as? Bool ?? false
        let canSendClientSms = data["canSendClientSms"] as? Bool ?? false
        let memberSmsStatus = (data["memberSmsStatus"] as? String) ?? "off"
        let memberSmsPhoneNumber = (data["memberSmsPhoneNumber"] as? String) ?? ""
        let canEditPortfolio = data["canEditPortfolio"] as? Bool ?? false
        let canEditPublicBio = data["canEditPublicBio"] as? Bool ?? false
        return EffectiveTeamAccess(
            isOwner: isOwner,
            accessRole: isOwner ? .owner : role,
            permissions: perms,
            confirmationType: confirmation,
            bookingRequiresApproval: requiresApproval,
            managersApproveAppointments: managersApprove,
            usesStudioBookingPolicy: usesStudio,
            subscriptionPlan: SubscriptionPlan.normalized(fromFirestore: data["subscriptionPlan"] as? String),
            payoutMode: payoutMode,
            usesOwnPayments: usesOwnPayments,
            canTakePayments: canTakePayments,
            studioSmsActive: studioSmsActive,
            usesOwnSms: usesOwnSms,
            canSendClientSms: canSendClientSms,
            memberSmsStatus: memberSmsStatus,
            memberSmsPhoneNumber: memberSmsPhoneNumber,
            canEditPortfolio: isOwner ? true : canEditPortfolio,
            canEditPublicBio: isOwner ? true : canEditPublicBio
        )
    }
}
