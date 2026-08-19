//
//  ManagerSettingsViewModel.swift
//
//  Owner: team roster, manager permissions, invites with role + job title.
//

import Foundation
import Combine
import UIKit
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
    @Published var managersApproveAppointments: Bool = false
    /// Set by parent toolbar or in-list invite button.
    @Published var presentInviteSheet = false

    // Client texting (Twilio) — from listTenantMembers / Cloud Functions
    @Published var subscriptionStatus: String = ""
    @Published var subscriptionPaid: Bool = false
    @Published var subscriptionTrialing: Bool = false
    /// Tenant has a Stripe Customer for Get Bookking plan billing (Customer Portal).
    @Published var hasStripeBillingCustomer: Bool = false
    @Published var smsEnabled: Bool = false
    @Published var smsStatus: String = "off"
    @Published var smsPhoneNumber: String = ""
    @Published var smsCanUse: Bool = false
    @Published var smsProvisionError: String = ""
    @Published var smsMonthlyUsageCount: Int = 0
    @Published var smsMonthlyUsageRemaining: Int = 1000
    @Published var smsMonthlyLimit: Int = 1000
    @Published var isOpeningBillingWebsite = false
    @Published var isSyncingBilling = false
    @Published var isOpeningBillingPortal = false
    @Published var isStartingSubscription = false
    /// Set before opening web billing; triggers sync when app becomes active again.
    @Published var shouldSyncBillingAfterWeb = false
    @Published var isProvisioningSms = false
    @Published var isProvisioningMemberSms = false
    /// UID of the member currently being provisioned (so UI can spin only that row).
    @Published var provisioningMemberUid: String? = nil
    /// SMS line entitlements from listTenantMembers
    @Published var smsFreeIncluded: Int = 1
    @Published var smsMaxLines: Int = 1
    @Published var smsLinesUsed: Int = 0
    @Published var smsLineCapacity: Int = 1
    @Published var smsExtraPaid: Int = 0
    @Published var smsFreeRemaining: Int = 1
    @Published var smsNeedsPurchaseForNextLine: Bool = false
    @Published var smsNeedsMonthlyExtraForNextLine: Bool = false
    @Published var smsNeedsOneTimePurchaseForNextLine: Bool = false
    @Published var smsAtMaxLines: Bool = false
    @Published var smsCanAddWithoutPurchase: Bool = true
    @Published var smsCanPurchaseExtra: Bool = false
    @Published var smsCanPurchaseSoloReplacement: Bool = false
    @Published var smsExtraMonthlyPriceLabel: String = "$12/mo"
    @Published var smsExtraOneTimeReplacementLabel: String = "$12"
    @Published var smsNextLineIsFree: Bool = true
    /// Lifetime Twilio number acquisitions (free allotment Solo 1 · Studio/Shop 2).
    @Published var smsLifetimeNumbersBought: Int = 0
    /// After lifetime free Twilio buys (Solo 1 · Studio/Shop 2), refresh charges $12.
    @Published var smsRefreshNeedsPurchase: Bool = false
    @Published var isRefreshingSmsLine = false
    @Published var refreshingSmsLineId: String? = nil
    @Published var isReleasingSmsLine = false
    @Published var releasingSmsLineId: String? = nil
    /// TestFlight: Twilio number buy/provision disabled (all plans).
    @Published var smsPhonePurchasingBlockedDuringTestFlight = false
    @Published var smsPhonePurchaseBlockMessage = ""

    var smsPhonePurchaseBlockedDisplayMessage: String {
        let trimmed = smsPhonePurchaseBlockMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Phone number purchasing is blocked during TestFlight."
        }
        return trimmed
    }

    /// True when the next line requires any payment (server-driven).
    var smsMustChargeForNextLine: Bool {
        if smsAtMaxLines { return false }
        return smsNeedsPurchaseForNextLine
    }

    /// Solo only: one-time $12 to get another number after the included lifetime get (not monthly).
    var smsMustPaySoloReplacementFee: Bool {
        tenantSubscriptionPlan == .solo && smsMustChargeForNextLine && !smsAtMaxLines
    }

    /// 3rd+ concurrent line: $12 now + recurring smsExtra on subscription.
    var smsMustChargeMonthlyForNextLine: Bool {
        smsNeedsMonthlyExtraForNextLine
    }

    /// Under 2 concurrent lines but lifetime free allotment used: $12 one-time only.
    var smsMustChargeOneTimeForNextLine: Bool {
        smsNeedsOneTimePurchaseForNextLine || smsMustPaySoloReplacementFee
    }

    var smsNextLinePurchaseLabel: String {
        if smsNeedsMonthlyExtraForNextLine {
            return "\(smsExtraOneTimeReplacementLabel) now + \(smsExtraMonthlyPriceLabel)"
        }
        if smsNeedsOneTimePurchaseForNextLine || smsMustPaySoloReplacementFee {
            return smsExtraOneTimeReplacementLabel
        }
        return smsExtraMonthlyPriceLabel
    }

    /// Current recurring smsExtra on subscription (0 when ≤ included concurrent lines).
    var smsExtraSubscriptionStatusLabel: String {
        if smsExtraPaid > 0 {
            return "\(smsExtraMonthlyPriceLabel) × \(smsExtraPaid)"
        }
        if smsLinesUsed <= smsFreeIncluded {
            return "Included — $0/mo extra"
        }
        return "$0/mo extra"
    }

    @Published var smsPresetConfirmed: String = ManagerSettingsViewModel.defaultPresetConfirmed
    @Published var smsPresetDeclined: String = ManagerSettingsViewModel.defaultPresetDeclined
    @Published var smsQuickPresets: [String] = ManagerSettingsViewModel.defaultQuickReplyPresets

    static let maxQuickReplies = 12
    static let defaultPresetConfirmed =
        "{business}: Your appointment request for {service} is confirmed. Reply STOP to opt out."
    static let defaultPresetDeclined =
        "{business}: We're unable to take this request at this time. Reply STOP to opt out."
    static let defaultQuickReplyPresets: [String] = [
        "Thanks for reaching out! We'll get back to you shortly.",
        "See you at your appointment!",
        "Can you share your preferred date and time?",
    ]

    var smsPhoneDisplay: String {
        PhoneFormatting.displayUS(smsPhoneNumber)
    }

    /// Independent members without an active/pending line (eligible for add/request).
    var membersEligibleForPersonalSms: [TenantTeamMember] {
        members.filter { member in
            guard member.accessRole != .owner else { return false }
            guard member.memberSettings.payoutMode == .independent
                || member.memberSettings.payoutMode == .shopSplit else { return false }
            let status = member.smsStatus.lowercased()
            if status == "active" || status == "pending" { return false }
            if !member.smsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
            return true
        }
    }

    var membersWithPendingSmsLineRequest: [TenantTeamMember] {
        members.filter { $0.smsLineRequestPending && $0.accessRole != .owner }
    }

    /// Studio + personal lines currently occupying capacity (for Messaging roster).
    var smsLineAssignments: [SmsLineAssignmentRow] {
        var rows: [SmsLineAssignmentRow] = []
        let studioStatus = smsStatus.lowercased()
        let studioPhone = smsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        if studioStatus == "active" || studioStatus == "pending" || studioStatus == "failed" || !studioPhone.isEmpty {
            rows.append(
                SmsLineAssignmentRow(
                    id: "studio",
                    kind: .studio,
                    name: "Studio",
                    roleLabel: "Business line",
                    phone: studioPhone,
                    status: studioStatus.isEmpty ? "off" : studioStatus,
                    memberUid: nil,
                    usageCount: smsMonthlyUsageCount,
                    usageLimit: smsMonthlyLimit
                )
            )
        }
        for member in members where member.accessRole != .owner {
            let status = member.smsStatus.lowercased()
            let phone = member.smsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
            let requestPending = member.smsLineRequestPending
            let occupies = status == "active" || status == "pending" || status == "failed" || !phone.isEmpty
            if !occupies && !requestPending { continue }
            let displayStatus: String
            if requestPending && status != "active" && status != "pending" {
                displayStatus = "requested"
            } else {
                displayStatus = status.isEmpty ? "off" : status
            }
            rows.append(
                SmsLineAssignmentRow(
                    id: member.uid,
                    kind: .personal,
                    name: member.displayName.isEmpty ? "Team member" : member.displayName,
                    roleLabel: "Personal line",
                    phone: phone,
                    status: displayStatus,
                    memberUid: member.uid,
                    usageCount: member.smsMonthlyUsageCount,
                    usageLimit: member.smsMonthlyLimit > 0 ? member.smsMonthlyLimit : 1000
                )
            )
        }
        // Unassigned = unused free included only (0–1 buys left under allotment).
        // Never show open slots from paid prepaid capacity.
        let open = max(0, smsFreeIncluded - smsLinesUsed)
        if open > 0 {
            for i in 0..<open {
                rows.append(
                    SmsLineAssignmentRow(
                        id: "open-\(i)",
                        kind: .open,
                        name: "Unassigned slot",
                        roleLabel: "Available capacity",
                        phone: "",
                        status: "open",
                        memberUid: nil,
                        usageCount: 0,
                        usageLimit: 1000
                    )
                )
            }
        }
        return rows
    }

    func isProvisioningMember(uid: String) -> Bool {
        isProvisioningMemberSms && provisioningMemberUid == uid
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
            managersApproveAppointments = data["managersApproveAppointments"] as? Bool ?? false
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
            if let hasBilling = data["hasStripeBillingCustomer"] as? Bool {
                hasStripeBillingCustomer = hasBilling
            } else {
                let cid = (data["stripeCustomerId"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                hasStripeBillingCustomer = !cid.isEmpty
            }
            smsEnabled = data["smsEnabled"] as? Bool ?? false
            smsStatus = (data["smsStatus"] as? String) ?? "off"
            smsPhoneNumber = (data["smsPhoneNumber"] as? String) ?? ""
            smsCanUse = data["smsCanUse"] as? Bool ?? false
            smsProvisionError = (data["smsProvisionError"] as? String) ?? ""
            smsMonthlyLimit = (data["smsMonthlyLimit"] as? Int) ?? 1000
            smsMonthlyUsageCount = (data["smsMonthlyUsageCount"] as? Int) ?? 0
            smsMonthlyUsageRemaining = (data["smsMonthlyUsageRemaining"] as? Int) ?? smsMonthlyLimit
            smsPresetConfirmed = (data["smsPresetConfirmed"] as? String) ?? Self.defaultPresetConfirmed
            smsPresetDeclined = (data["smsPresetDeclined"] as? String) ?? Self.defaultPresetDeclined
            if let quick = data["smsQuickPresets"] as? [String], !quick.isEmpty {
                smsQuickPresets = quick
            } else {
                smsQuickPresets = Self.defaultQuickReplyPresets
            }
            smsFreeIncluded = (data["smsFreeIncluded"] as? Int) ?? tenantSubscriptionPlan.freeIncludedSmsLines
            smsMaxLines = (data["smsMaxLines"] as? Int) ?? tenantSubscriptionPlan.maxSmsLines
            smsLinesUsed = (data["smsLinesUsed"] as? Int) ?? 0
            smsLineCapacity = (data["smsLineCapacity"] as? Int) ?? smsFreeIncluded
            smsExtraPaid = (data["smsExtraPaid"] as? Int) ?? 0
            smsFreeRemaining = (data["smsFreeRemaining"] as? Int) ?? max(0, smsFreeIncluded - smsLinesUsed)
            smsNeedsPurchaseForNextLine = data["smsNeedsPurchaseForNextLine"] as? Bool ?? false
            smsNeedsMonthlyExtraForNextLine = data["smsNeedsMonthlyExtraForNextLine"] as? Bool ?? false
            smsNeedsOneTimePurchaseForNextLine = data["smsNeedsOneTimePurchaseForNextLine"] as? Bool ?? false
            smsAtMaxLines = data["smsAtMaxLines"] as? Bool ?? false
            smsCanAddWithoutPurchase = data["smsCanAddWithoutPurchase"] as? Bool ?? true
            smsCanPurchaseExtra = data["smsCanPurchaseExtra"] as? Bool ?? (tenantSubscriptionPlan != .solo)
            smsCanPurchaseSoloReplacement = data["smsCanPurchaseSoloReplacement"] as? Bool
                ?? (tenantSubscriptionPlan == .solo && smsNeedsPurchaseForNextLine)
            smsExtraMonthlyPriceLabel = (data["smsExtraMonthlyPriceLabel"] as? String) ?? "$12/mo"
            smsExtraOneTimeReplacementLabel = (data["smsExtraOneTimeReplacementLabel"] as? String) ?? "$12"
            smsNextLineIsFree = data["smsNextLineIsFree"] as? Bool ?? (smsLinesUsed < smsFreeIncluded)
            smsLifetimeNumbersBought = (data["smsLifetimeNumbersBought"] as? Int) ?? 0
            smsRefreshNeedsPurchase = data["smsRefreshNeedsPurchase"] as? Bool
                ?? (smsLifetimeNumbersBought >= smsFreeIncluded)
            smsPhonePurchasingBlockedDuringTestFlight =
                data["smsPhonePurchasingBlockedDuringTestFlight"] as? Bool ?? false
            smsPhonePurchaseBlockMessage = (data["smsPhonePurchaseBlockMessage"] as? String) ?? ""
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func syncBillingFromStripe() async {
        guard isTenantOwner else { return }
        isSyncingBilling = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("syncTenantBillingFromStripe").call([:])
            await load(isDemoMode: false)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isSyncingBilling = false
    }

    func openStripeBillingPortal() async {
        guard isTenantOwner else { return }
        if !hasStripeBillingCustomer {
            errorMessage = "Billing is not set up yet. Use Sign up for Stripe first."
            return
        }
        isOpeningBillingPortal = true
        errorMessage = nil
        do {
            let result = try await functions.httpsCallable("createBillingPortalSession").call([
                "marketingOrigin": Constants.Hosting.marketingWebOrigin,
            ])
            guard let data = result.data as? [String: Any],
                  let urlString = (data["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !urlString.isEmpty,
                  let url = URL(string: urlString) else {
                throw NSError(
                    domain: "ManagerSettings",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Stripe did not return a billing portal URL."]
                )
            }
            shouldSyncBillingAfterWeb = true
            await UIApplication.shared.open(url)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isOpeningBillingPortal = false
    }

    func syncBillingAfterWebIfNeeded() async {
        guard shouldSyncBillingAfterWeb else { return }
        shouldSyncBillingAfterWeb = false
        await syncBillingFromStripe()
    }

    /// Ends free trial now and activates paid plan via Stripe (card already on file).
    /// Prefer this over opening the Customer Portal — the portal cannot end a trial early.
    @discardableResult
    func startSubscriptionToday() async -> Bool {
        guard isTenantOwner else { return false }
        if !hasStripeBillingCustomer {
            await openBillingToStartSubscription()
            return false
        }
        isStartingSubscription = true
        errorMessage = nil
        defer { isStartingSubscription = false }
        do {
            let result = try await functions.httpsCallable("startSubscriptionToday").call([:])
            let data = result.data as? [String: Any] ?? [:]
            let status = ((data["subscriptionStatus"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            await load(isDemoMode: false)
            if status == "active" || subscriptionPaid {
                return true
            }
            // Sync once more from Stripe in case Firestore lagged.
            await syncBillingFromStripe()
            return subscriptionPaid
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return false
        }
    }

    /// Opens getbookking.com billing (fallback when no Stripe customer / web signup).
    func openBillingToStartSubscription() async {
        guard isTenantOwner else { return }
        isOpeningBillingWebsite = true
        errorMessage = nil
        defer { isOpeningBillingWebsite = false }
        guard let url = URL(string: Constants.Hosting.marketingBillingStartURL) else { return }
        shouldSyncBillingAfterWeb = true
        await UIApplication.shared.open(url)
    }

    /// Opens marketing billing Client texting section to purchase an extra number.
    func openBillingForExtraSmsLine() async {
        guard isTenantOwner else { return }
        isOpeningBillingWebsite = true
        errorMessage = nil
        defer { isOpeningBillingWebsite = false }
        guard let url = URL(string: Constants.Hosting.marketingBillingMessagingURL) else { return }
        shouldSyncBillingAfterWeb = true
        await UIApplication.shared.open(url)
    }

    func requestSmsProvisioning(consentAccepted: Bool, forceReprovision: Bool = false) async {
        guard isTenantOwner else { return }
        if smsPhonePurchasingBlockedDuringTestFlight {
            errorMessage = smsPhonePurchaseBlockedDisplayMessage
            return
        }
        if !forceReprovision {
            guard consentAccepted else {
                errorMessage = "Accept the client texting terms to continue."
                return
            }
        }
        isProvisioningSms = true
        errorMessage = nil
        do {
            var payload: [String: Any] = ["smsConsentAccepted": true]
            if forceReprovision {
                payload["forceReprovision"] = true
            }
            _ = try await functions.httpsCallable("requestTenantSmsProvisioning").call(payload)
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await load(isDemoMode: false)
                if smsStatus == "active" { break }
                if smsStatus == "failed" { break }
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isProvisioningSms = false
    }

    func requestMemberSmsProvisioning(memberUid: String?, consentAccepted: Bool, forceReprovision: Bool = false) async {
        guard consentAccepted || forceReprovision else {
            errorMessage = "Accept the client texting terms to continue."
            return
        }
        if smsPhonePurchasingBlockedDuringTestFlight {
            errorMessage = smsPhonePurchaseBlockedDisplayMessage
            return
        }
        let targetUid = (memberUid?.isEmpty == false ? memberUid : Auth.auth().currentUser?.uid)
        isProvisioningMemberSms = true
        provisioningMemberUid = targetUid
        errorMessage = nil
        defer {
            isProvisioningMemberSms = false
            provisioningMemberUid = nil
        }
        do {
            var payload: [String: Any] = ["smsConsentAccepted": true]
            if let memberUid, !memberUid.isEmpty {
                payload["memberUid"] = memberUid
            }
            if forceReprovision {
                payload["forceReprovision"] = true
            }
            _ = try await functions.httpsCallable("requestMemberSmsProvisioning").call(payload)
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await load(isDemoMode: false)
                if let uid = targetUid,
                   let member = members.first(where: { $0.uid == uid }),
                   member.smsStatus == "active" { break }
                if let uid = targetUid,
                   let member = members.first(where: { $0.uid == uid }),
                   member.smsStatus == "failed" { break }
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    /// Member (or owner for a member): request a personal number — free capacity provisions; paid needs owner purchase.
    @discardableResult
    func requestSmsPhoneNumber(
        memberUid: String?,
        consentAccepted: Bool,
        paidPurchaseAuthorizationId: String? = nil
    ) async -> Bool {
        guard consentAccepted else {
            errorMessage = "Accept the client texting terms to continue."
            return false
        }
        if smsPhonePurchasingBlockedDuringTestFlight {
            errorMessage = smsPhonePurchaseBlockedDisplayMessage
            return false
        }
        let targetUid = (memberUid?.isEmpty == false ? memberUid : Auth.auth().currentUser?.uid)
        isProvisioningMemberSms = true
        provisioningMemberUid = targetUid
        errorMessage = nil
        defer {
            isProvisioningMemberSms = false
            provisioningMemberUid = nil
        }
        var didProvision = false
        do {
            var payload: [String: Any] = ["smsConsentAccepted": true]
            if let memberUid, !memberUid.isEmpty {
                payload["memberUid"] = memberUid
            }
            if let paidPurchaseAuthorizationId, !paidPurchaseAuthorizationId.isEmpty {
                payload["smsPaidLinePurchaseAuthorizationId"] = paidPurchaseAuthorizationId
            }
            let result = try await functions.httpsCallable("requestSmsPhoneNumber").call(payload)
            let data = result.data as? [String: Any] ?? [:]
            if data["needsOwnerPurchase"] as? Bool == true {
                errorMessage = (data["message"] as? String)
                    ?? "Request sent. Your studio owner can add a number under Messaging or billing."
                await load(isDemoMode: false)
                return false
            }
            if data["alreadyActive"] as? Bool == true {
                await load(isDemoMode: false)
                return true
            }
            didProvision = true
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await load(isDemoMode: false)
                if let uid = targetUid,
                   let member = members.first(where: { $0.uid == uid }),
                   member.smsStatus == "active" { break }
                if let uid = targetUid,
                   let member = members.first(where: { $0.uid == uid }),
                   member.smsStatus == "failed" { break }
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        return didProvision
    }

    func clearSmsLineRequest(memberUid: String) async {
        guard isTenantOwner, !memberUid.isEmpty else { return }
        isUpdatingMember = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("clearSmsLineRequest").call(["memberUid": memberUid])
            await load(isDemoMode: false)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isUpdatingMember = false
    }

    /// Owner: after free capacity — start personal line for a teammate (delegates to request SMS phone number).
    func ownerEnablePersonalSmsLine(for memberUid: String, consentAccepted: Bool) async {
        if smsMustChargeForNextLine {
            errorMessage = "This texting number requires a \(smsNextLinePurchaseLabel) purchase first."
            return
        }
        _ = await requestSmsPhoneNumber(memberUid: memberUid, consentAccepted: consentAccepted)
    }

    /// Owner: charge the saved Stripe method, then use the one-time server authorization
    /// to provision this teammate's personal number.
    @discardableResult
    func purchaseAndEnablePersonalSmsLine(for memberUid: String, consentAccepted: Bool) async -> Bool {
        guard isTenantOwner, consentAccepted, !memberUid.isEmpty else { return false }
        if smsPhonePurchasingBlockedDuringTestFlight {
            errorMessage = smsPhonePurchaseBlockedDisplayMessage
            return false
        }
        isProvisioningMemberSms = true
        provisioningMemberUid = memberUid
        errorMessage = nil
        defer {
            isProvisioningMemberSms = false
            provisioningMemberUid = nil
        }
        do {
            let purchase = try await functions.httpsCallable("purchaseSmsExtraLine").call([
                "memberUid": memberUid
            ])
            let data = purchase.data as? [String: Any] ?? [:]
            guard let authorizationId = data["smsPaidLinePurchaseAuthorizationId"] as? String,
                  !authorizationId.isEmpty else {
                errorMessage = "Stripe did not confirm the texting-number payment. No number was set up."
                return false
            }
            return await requestSmsPhoneNumber(
                memberUid: memberUid,
                consentAccepted: true,
                paidPurchaseAuthorizationId: authorizationId
            )
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return false
        }
    }

    /// Owner: permanently release a studio or personal texting number.
    func releaseSmsPhoneNumber(scope: String, memberUid: String?) async -> Bool {
        guard isTenantOwner else { return false }
        isReleasingSmsLine = true
        if scope == "studio" {
            releasingSmsLineId = "studio"
        } else if let memberUid {
            releasingSmsLineId = memberUid
        } else {
            releasingSmsLineId = nil
        }
        errorMessage = nil
        defer {
            isReleasingSmsLine = false
            releasingSmsLineId = nil
        }
        do {
            var payload: [String: Any] = ["scope": scope]
            if let memberUid, !memberUid.isEmpty {
                payload["memberUid"] = memberUid
            }
            _ = try await functions.httpsCallable("releaseSmsPhoneNumber").call(payload)
            await load(isDemoMode: false)
            return true
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return false
        }
    }

    /// Owner: refresh a studio or personal number (new Twilio buy). Charges $12 after lifetime free allotment.
    @discardableResult
    func refreshSmsPhoneNumber(scope: String, memberUid: String?) async -> Bool {
        guard isTenantOwner else { return false }
        if smsPhonePurchasingBlockedDuringTestFlight {
            errorMessage = smsPhonePurchaseBlockedDisplayMessage
            return false
        }
        isRefreshingSmsLine = true
        if scope == "studio" {
            refreshingSmsLineId = "studio"
        } else if let memberUid {
            refreshingSmsLineId = memberUid
        } else {
            refreshingSmsLineId = nil
        }
        errorMessage = nil
        defer {
            isRefreshingSmsLine = false
            refreshingSmsLineId = nil
        }
        do {
            var payload: [String: Any] = ["scope": scope]
            if let memberUid, !memberUid.isEmpty {
                payload["memberUid"] = memberUid
            }
            _ = try await functions.httpsCallable("refreshSmsPhoneNumber").call(payload)
            for _ in 0..<16 {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await load(isDemoMode: false)
                if scope == "studio" {
                    if smsStatus == "active" || smsStatus == "failed" { break }
                } else if let memberUid,
                          let member = members.first(where: { $0.uid == memberUid }) {
                    if member.smsStatus == "active" || member.smsStatus == "failed" { break }
                }
            }
            return true
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return false
        }
    }

    func saveMessagingPresets() async {
        guard isTenantOwner else { return }
        isSavingPolicy = true
        errorMessage = nil
        saveSuccess = false
        let confirmed = smsPresetConfirmed.trimmingCharacters(in: .whitespacesAndNewlines)
        let declined = smsPresetDeclined.trimmingCharacters(in: .whitespacesAndNewlines)
        let quick = smsQuickPresets
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .prefix(Self.maxQuickReplies)
            .map { String($0.prefix(300)) }
        do {
            _ = try await functions.httpsCallable("updateTenantMessagingPresets").call([
                "smsPresetConfirmed": confirmed.isEmpty ? Self.defaultPresetConfirmed : confirmed,
                "smsPresetDeclined": declined.isEmpty ? Self.defaultPresetDeclined : declined,
                "smsQuickPresets": quick.isEmpty ? Self.defaultQuickReplyPresets : Array(quick),
            ])
            saveSuccess = true
            await load(isDemoMode: false)
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await MainActor.run { saveSuccess = false }
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isSavingPolicy = false
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

    func patchMemberGallery(uid: String, imageURLs: [String]) {
        members = members.map { member in
            guard member.uid == uid else { return member }
            return TenantTeamMember(
                uid: member.uid,
                displayName: member.displayName,
                email: member.email,
                phone: member.phone,
                profilePhotoUrl: member.profilePhotoUrl,
                accessRole: member.accessRole,
                jobTitle: member.jobTitle,
                memberSlug: member.memberSlug,
                isBookable: member.isBookable,
                showOnTeamPage: member.showOnTeamPage,
                showOnTeamHome: member.showOnTeamHome,
                providerAboutText: member.providerAboutText,
                providerGalleryImages: imageURLs,
                smsEnabled: member.smsEnabled,
                smsStatus: member.smsStatus,
                smsPhoneNumber: member.smsPhoneNumber,
                smsLineRequestPending: member.smsLineRequestPending,
                smsMonthlyUsageCount: member.smsMonthlyUsageCount,
                smsMonthlyLimit: member.smsMonthlyLimit,
                memberSettings: member.memberSettings,
                personalConfirmationType: member.personalConfirmationType,
                effectiveConfirmationType: member.effectiveConfirmationType
            )
        }
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
        memberSettings: TeamMemberSettings,
        isBookable: Bool? = nil,
        showOnTeamPage: Bool? = nil,
        showOnTeamHome: Bool? = nil,
        providerAboutText: String? = nil
    ) async -> Bool {
        guard isTenantOwner else { return false }
        isUpdatingMember = true
        errorMessage = nil
        saveSuccess = false
        var payload: [String: Any] = [
            "memberUid": memberUid,
            "accessRole": accessRole == .manager ? "manager" : "member",
            "jobTitle": jobTitle,
            "memberSettings": memberSettings.firestoreDictionary,
        ]
        if let isBookable {
            payload["isBookable"] = isBookable
        }
        if let showOnTeamPage {
            payload["showOnTeamPage"] = showOnTeamPage
        }
        if let showOnTeamHome {
            payload["showOnTeamHome"] = showOnTeamHome
        }
        if let providerAboutText {
            payload["providerAboutText"] = providerAboutText
        }
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

    func saveOwnerPublicProfile(
        memberUid: String,
        jobTitle: String,
        isBookable: Bool,
        providerAboutText: String
    ) async -> Bool {
        guard isTenantOwner else { return false }
        isUpdatingMember = true
        errorMessage = nil
        saveSuccess = false
        let payload: [String: Any] = [
            "memberUid": memberUid,
            "jobTitle": jobTitle,
            "isBookable": isBookable,
            "providerAboutText": providerAboutText,
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
                    phone: (row["phone"] as? String) ?? "",
                    profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                    accessRole: .owner,
                    jobTitle: (row["jobTitle"] as? String) ?? "",
                    memberSlug: (row["memberSlug"] as? String) ?? "",
                    isBookable: row["isBookable"] as? Bool ?? true,
                    showOnTeamPage: row["showOnTeamPage"] as? Bool ?? (row["isBookable"] as? Bool ?? true),
                    showOnTeamHome: row["showOnTeamHome"] as? Bool ?? (row["isBookable"] as? Bool ?? true),
                    providerAboutText: (row["providerAboutText"] as? String) ?? "",
                    providerGalleryImages: Self.parseProviderGalleryImages(row),
                    smsEnabled: row["smsEnabled"] as? Bool ?? false,
                    smsStatus: (row["smsStatus"] as? String) ?? "off",
                    smsPhoneNumber: (row["smsPhoneNumber"] as? String) ?? "",
                    smsLineRequestPending: row["smsLineRequestPending"] as? Bool ?? false,
                    smsMonthlyUsageCount: (row["smsMonthlyUsageCount"] as? Int) ?? 0,
                    smsMonthlyLimit: (row["smsMonthlyLimit"] as? Int) ?? 1000,
                    memberSettings: TeamMemberSettings(),
                    personalConfirmationType: Self.parsePersonalConfirmationType(row),
                    effectiveConfirmationType: Self.parseEffectiveConfirmationType(row)
                )
            }
            return TenantTeamMember(
                uid: uid,
                displayName: name,
                email: (row["email"] as? String) ?? "",
                phone: (row["phone"] as? String) ?? "",
                profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                accessRole: role,
                jobTitle: (row["jobTitle"] as? String) ?? "",
                memberSlug: (row["memberSlug"] as? String) ?? "",
                isBookable: row["isBookable"] as? Bool ?? (role == .member),
                showOnTeamPage: row["showOnTeamPage"] as? Bool ?? (row["isBookable"] as? Bool ?? (role == .member)),
                showOnTeamHome: row["showOnTeamHome"] as? Bool ?? (row["isBookable"] as? Bool ?? (role == .member)),
                providerAboutText: (row["providerAboutText"] as? String) ?? "",
                providerGalleryImages: Self.parseProviderGalleryImages(row),
                smsEnabled: row["smsEnabled"] as? Bool ?? false,
                smsStatus: (row["smsStatus"] as? String) ?? "off",
                smsPhoneNumber: (row["smsPhoneNumber"] as? String) ?? "",
                smsLineRequestPending: row["smsLineRequestPending"] as? Bool ?? false,
                smsMonthlyUsageCount: (row["smsMonthlyUsageCount"] as? Int) ?? 0,
                smsMonthlyLimit: (row["smsMonthlyLimit"] as? Int) ?? 1000,
                memberSettings: TeamMemberSettings(dictionary: row["memberSettings"] as? [String: Any]),
                personalConfirmationType: Self.parsePersonalConfirmationType(row),
                effectiveConfirmationType: Self.parseEffectiveConfirmationType(row)
            )
        }
    }

    private static func parsePersonalConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["personalConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func parseEffectiveConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["effectiveConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func parseProviderGalleryImages(_ row: [String: Any]) -> [String] {
        guard let raw = row["providerGalleryImages"] as? [Any] else { return [] }
        return raw.compactMap { item -> String? in
            let s = (item as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return s.isEmpty ? nil : s
        }
    }

    private var demoMembers: [TenantTeamMember] {
        [
            TenantTeamMember(uid: "demo-owner", displayName: "Josh Torres", email: "", phone: "", profilePhotoUrl: "", accessRole: .owner, jobTitle: "", memberSlug: "josh-torres", isBookable: true, showOnTeamPage: true, showOnTeamHome: true, providerAboutText: "", providerGalleryImages: [], smsEnabled: false, smsStatus: "off", smsPhoneNumber: "", smsLineRequestPending: false, smsMonthlyUsageCount: 0, smsMonthlyLimit: 1000, memberSettings: TeamMemberSettings(), personalConfirmationType: "request_approve", effectiveConfirmationType: "request_approve"),
            TenantTeamMember(uid: "demo-mgr", displayName: "Maya Rodriguez", email: "maya@studio.com", phone: "", profilePhotoUrl: "", accessRole: .manager, jobTitle: "", memberSlug: "", isBookable: false, showOnTeamPage: false, showOnTeamHome: false, providerAboutText: "", providerGalleryImages: [], smsEnabled: false, smsStatus: "off", smsPhoneNumber: "", smsLineRequestPending: false, smsMonthlyUsageCount: 0, smsMonthlyLimit: 1000, memberSettings: TeamMemberSettings(), personalConfirmationType: "request_approve", effectiveConfirmationType: "request_approve"),
            TenantTeamMember(uid: "demo-art", displayName: "Alex Lee", email: "alex@studio.com", phone: "(555) 010-0002", profilePhotoUrl: "", accessRole: .member, jobTitle: "Artist", memberSlug: "alex-lee", isBookable: true, showOnTeamPage: true, showOnTeamHome: true, providerAboutText: "Fine line and blackwork.", providerGalleryImages: [], smsEnabled: false, smsStatus: "off", smsPhoneNumber: "", smsLineRequestPending: false, smsMonthlyUsageCount: 0, smsMonthlyLimit: 1000, memberSettings: TeamMemberSettings(), personalConfirmationType: "instant_book", effectiveConfirmationType: "request_approve"),
        ]
    }
}

// MARK: - SMS line roster (Messaging)

struct SmsLineAssignmentRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case studio
        case personal
        case open
    }

    let id: String
    let kind: Kind
    let name: String
    let roleLabel: String
    let phone: String
    let status: String
    let memberUid: String?
    let usageCount: Int
    let usageLimit: Int

    var phoneDisplay: String {
        let trimmed = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "—" }
        return PhoneFormatting.displayUS(trimmed)
    }

    var statusLabel: String {
        switch status.lowercased() {
        case "active": return "Active"
        case "pending": return "Setting up"
        case "requested": return "Requested"
        case "open": return "Open — assign below"
        case "failed": return "Failed"
        default: return status.capitalized
        }
    }

    var usageLabel: String {
        "\(usageCount) of \(usageLimit)"
    }

    var canRelease: Bool {
        kind == .studio || kind == .personal
    }

    var canRefresh: Bool {
        guard kind == .studio || kind == .personal else { return false }
        let status = status.lowercased()
        return status == "active" || !phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
