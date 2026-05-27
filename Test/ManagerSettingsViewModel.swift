//
//  ManagerSettingsViewModel.swift
//
//  Owner: team roster, manager permissions, invites with role + job title.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

@MainActor
final class ManagerSettingsViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false
    @Published var tenantId: String?
    @Published var tenantIndustry: String = BookingTemplate.custom.rawValue
    @Published var tenantSubscriptionPlan: SubscriptionPlan = .solo
    @Published var isTenantOwner = false

    @Published var members: [TenantTeamMember] = []
    @Published var permissions = ManagerPermissions.defaults
    @Published var notifications = ManagerNotifications.defaults

    @Published var inviteJobTitlePresetId: String = ""
    @Published var inviteCustomJobTitle: String = ""
    @Published var teamInviteShareURL: URL?
    @Published var isCreatingTeamInvite = false
    @Published var teamInviteError: String?

    @Published var isSavingPolicy = false
    @Published var isUpdatingMember = false
    /// From tenant booking policy (`request_approve`, etc.).
    @Published var tenantBookingRequiresApproval: Bool = true
    @Published var tenantDefaultConfirmationType: String = BookingConfirmationType.requestApprove.rawValue
    @Published var managersApproveAppointments: Bool = true
    /// Set by parent toolbar or in-list invite button.
    @Published var presentInviteSheet = false

    // Client texting (Twilio) — from listTenantMembers / Cloud Functions
    @Published var subscriptionStatus: String = ""
    @Published var subscriptionPaid: Bool = false
    @Published var subscriptionTrialing: Bool = false
    @Published var smsEnabled: Bool = false
    @Published var smsStatus: String = "off"
    @Published var smsPhoneNumber: String = ""
    @Published var smsCanUse: Bool = false
    @Published var smsProvisionError: String = ""
    @Published var isStartingSubscription = false
    @Published var isProvisioningSms = false

    var smsPhoneDisplay: String {
        PhoneFormatting.displayUS(smsPhoneNumber)
    }

    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    var resolvedInviteJobTitle: String {
        if inviteJobTitlePresetId == TeamJobTitleCatalog.customOptionId {
            let c = inviteCustomJobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return c.isEmpty ? TeamJobTitleCatalog.defaultTitle(for: tenantIndustry) : String(c.prefix(60))
        }
        if let match = TeamJobTitleCatalog.options(for: tenantIndustry).first(where: { $0.id == inviteJobTitlePresetId }) {
            return match.label
        }
        return TeamJobTitleCatalog.defaultTitle(for: tenantIndustry)
    }

    func load(isDemoMode: Bool) async {
        isLoading = true
        errorMessage = nil
        if isDemoMode {
            members = demoMembers
            permissions = .defaults
            notifications = .defaults
            isTenantOwner = true
            tenantSubscriptionPlan = .studio
            isLoading = false
            return
        }
        guard Auth.auth().currentUser != nil else {
            isLoading = false
            return
        }
        do {
            let listResult = try await functions.httpsCallable("listTenantMembers").call([:])
            guard let data = listResult.data as? [String: Any] else {
                throw NSError(domain: "ManagerSettings", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid team list."])
            }
            tenantId = data["tenantId"] as? String
            tenantIndustry = (data["industry"] as? String) ?? BookingTemplate.custom.rawValue
            tenantSubscriptionPlan = SubscriptionPlan.normalized(fromFirestore: data["subscriptionPlan"] as? String)
            isTenantOwner = data["isOwner"] as? Bool ?? false
            permissions = ManagerPermissions(dictionary: data["managerPermissions"] as? [String: Any])
            notifications = ManagerNotifications(dictionary: data["managerNotifications"] as? [String: Any])
            tenantBookingRequiresApproval = data["bookingRequiresApproval"] as? Bool ?? true
            tenantDefaultConfirmationType = (data["confirmationType"] as? String)
                ?? BookingConfirmationType.requestApprove.rawValue
            managersApproveAppointments = data["managersApproveAppointments"] as? Bool ?? true
            if !managersApproveAppointments || !tenantBookingRequiresApproval {
                permissions.approveRejectRequests = false
            }
            members = Self.parseMembers(data["members"] as? [[String: Any]], ownerUid: data["ownerUid"] as? String)
            if inviteJobTitlePresetId.isEmpty {
                inviteJobTitlePresetId = TeamJobTitleCatalog.primaryOptions(for: tenantIndustry).first?.id ?? "team_member"
            }
            subscriptionStatus = (data["subscriptionStatus"] as? String) ?? ""
            subscriptionPaid = data["subscriptionPaid"] as? Bool ?? false
            subscriptionTrialing = data["subscriptionTrialing"] as? Bool ?? false
            smsEnabled = data["smsEnabled"] as? Bool ?? false
            smsStatus = (data["smsStatus"] as? String) ?? "off"
            smsPhoneNumber = (data["smsPhoneNumber"] as? String) ?? ""
            smsCanUse = data["smsCanUse"] as? Bool ?? false
            smsProvisionError = (data["smsProvisionError"] as? String) ?? ""
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func startSubscriptionToday() async {
        guard isTenantOwner else { return }
        isStartingSubscription = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("startSubscriptionToday").call([:])
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await load(isDemoMode: false)
        } catch {
            errorMessage = error.localizedDescription
        }
        isStartingSubscription = false
    }

    func requestSmsProvisioning(consentAccepted: Bool) async {
        guard isTenantOwner else { return }
        guard consentAccepted else {
            errorMessage = "Accept the client texting terms to continue."
            return
        }
        isProvisioningSms = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("requestTenantSmsProvisioning").call([
                "smsConsentAccepted": true,
            ])
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await load(isDemoMode: false)
                if smsStatus == "active" { break }
                if smsStatus == "failed" { break }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isProvisioningSms = false
    }

    func saveManagerPolicy() async {
        guard isTenantOwner else { return }
        isSavingPolicy = true
        errorMessage = nil
        saveSuccess = false
        do {
            _ = try await functions.httpsCallable("updateTenantManagerPolicy").call([
                "managerPermissions": permissions.firestoreDictionary,
                "managerNotifications": notifications.firestoreDictionary,
            ])
            saveSuccess = true
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await MainActor.run { saveSuccess = false }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isSavingPolicy = false
    }

    func createTeamInviteLink() async {
        guard isTenantOwner else { return }
        isCreatingTeamInvite = true
        teamInviteError = nil
        teamInviteShareURL = nil
        do {
            let result = try await functions.httpsCallable("createTenantInvite").call([
                "baseUrl": Constants.Hosting.bookingWebOrigin,
                "accessRole": TeamAccessRole.member.firestoreValue,
                "jobTitle": resolvedInviteJobTitle,
            ])
            guard let data = result.data as? [String: Any],
                  let joinUrlString = data["joinUrl"] as? String,
                  let url = URL(string: joinUrlString) else {
                throw NSError(domain: "ManagerSettings", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid invite response."])
            }
            teamInviteShareURL = url
        } catch {
            teamInviteError = error.localizedDescription
        }
        isCreatingTeamInvite = false
    }

    func demoteManager(uid: String) async -> Bool {
        guard let member = members.first(where: { $0.uid == uid }) else { return false }
        return await saveMemberSettings(
            memberUid: uid,
            accessRole: .member,
            jobTitle: member.jobTitle.isEmpty ? TeamJobTitleCatalog.defaultTitle(for: tenantIndustry) : member.jobTitle,
            memberSettings: member.memberSettings
        )
    }

    func promoteToManager(uid: String) async -> Bool {
        guard let member = members.first(where: { $0.uid == uid }) else { return false }
        return await saveMemberSettings(
            memberUid: uid,
            accessRole: .manager,
            jobTitle: "Manager",
            memberSettings: member.memberSettings
        )
    }

    func member(byUid uid: String) -> TenantTeamMember? {
        members.first { $0.uid == uid }
    }

    func removeFromTeam(uid: String) async {
        isUpdatingMember = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("removeTenantMember").call(["memberUid": uid])
            await load(isDemoMode: false)
        } catch {
            errorMessage = error.localizedDescription
        }
        isUpdatingMember = false
    }

    func saveMemberSettings(
        memberUid: String,
        accessRole: TeamAccessRole,
        jobTitle: String,
        memberSettings: TeamMemberSettings
    ) async -> Bool {
        guard isTenantOwner else { return false }
        isUpdatingMember = true
        errorMessage = nil
        saveSuccess = false
        let payload: [String: Any] = [
            "memberUid": memberUid,
            "accessRole": accessRole == .manager ? "manager" : "member",
            "jobTitle": jobTitle,
            "memberSettings": memberSettings.firestoreDictionary,
        ]
        do {
            _ = try await functions.httpsCallable("updateTenantMember").call(payload)
            await load(isDemoMode: false)
            saveSuccess = true
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await MainActor.run { saveSuccess = false }
            }
            isUpdatingMember = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isUpdatingMember = false
            return false
        }
    }

    private static func parseMembers(_ raw: [[String: Any]]?, ownerUid: String?) -> [TenantTeamMember] {
        guard let raw else { return [] }
        return raw.compactMap { row in
            guard let uid = row["uid"] as? String else { return nil }
            let role = TeamAccessRole.fromFirestore(row["accessRole"] as? String ?? row["role"] as? String)
            let fn = (row["firstName"] as? String) ?? ""
            let ln = (row["lastName"] as? String) ?? ""
            var name = "\(fn) \(ln)".trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { name = (row["displayName"] as? String) ?? (row["name"] as? String) ?? "Member" }
            if uid == ownerUid {
                return TenantTeamMember(
                    uid: uid,
                    displayName: name,
                    email: (row["email"] as? String) ?? "",
                    profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                    accessRole: .owner,
                    jobTitle: "",
                    memberSettings: TeamMemberSettings()
                )
            }
            return TenantTeamMember(
                uid: uid,
                displayName: name,
                email: (row["email"] as? String) ?? "",
                profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                accessRole: role,
                jobTitle: (row["jobTitle"] as? String) ?? "",
                memberSettings: TeamMemberSettings(dictionary: row["memberSettings"] as? [String: Any])
            )
        }
    }

    private var demoMembers: [TenantTeamMember] {
        [
            TenantTeamMember(uid: "demo-owner", displayName: "Josh Torres", email: "", profilePhotoUrl: "", accessRole: .owner, jobTitle: "", memberSettings: TeamMemberSettings()),
            TenantTeamMember(uid: "demo-mgr", displayName: "Maya Rodriguez", email: "maya@studio.com", profilePhotoUrl: "", accessRole: .manager, jobTitle: "", memberSettings: TeamMemberSettings()),
            TenantTeamMember(uid: "demo-art", displayName: "Alex Lee", email: "alex@studio.com", profilePhotoUrl: "", accessRole: .member, jobTitle: "Artist", memberSettings: TeamMemberSettings()),
        ]
    }
}
