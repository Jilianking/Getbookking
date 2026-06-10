//
//  SettingsViewModel.swift
//
//  Settings: scheduling type, availability, profile.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

class SettingsViewModel: ObservableObject {
    /// Studio-wide booking policy (owner edits in Business → Booking settings).
    @Published var confirmationType: BookingConfirmationType = .requestApprove
    @Published var managersApproveAppointments: Bool = true
    @Published var depositAmount: Double?
    /// This user's personal booking flow (Settings → My booking type).
    @Published var personalConfirmationType: BookingConfirmationType = .requestApprove
    @Published var personalDepositAmount: Double?
    /// When true, personal flow follows studio policy instead of `personalConfirmationType`.
    @Published var usesStudioBookingPolicy: Bool = false
    @Published var personalSaveSuccess = false
    @Published var timeSlots: [TimeSlot] = [TimeSlot(open: 9, close: 18)]
    @Published var daysOpen: Set<Int> = [1, 2, 3, 4, 5]
    @Published var timeZoneId: String = TimeZone.current.identifier
    @Published var blockedDates: Set<String> = []
    @Published var availableDates: Set<String> = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false
    @Published var hasProfile = false
    @Published var tenantId: String?
    @Published var selectedIndustry: String = BookingTemplate.custom.rawValue
    @Published var isSavingService = false
    @Published var profilePhotoUrl: String = ""
    @Published var isUploadingLogo = false
    @Published var accountDisplayName: String = ""
    @Published var businessDisplayName: String = ""
    /// Editable studio name (Settings → Account); synced to user profile + tenant.
    @Published var businessNameDraft: String = ""
    @Published var isSavingBusinessName = false
    @Published var businessNameSaveSuccess = false
    /// Editable full name (Settings → Account); persisted to Firestore + Firebase Auth display name.
    @Published var accountFullNameDraft: String = ""
    @Published var isSavingAccountName = false
    @Published var accountNameSaveSuccess = false
    /// Resolved from `tenants/{id}.subscriptionPlan` (same source as web); defaults to Solo.
    @Published var tenantSubscriptionPlan: SubscriptionPlan = .solo
    /// True when the signed-in user is `tenants.ownerUid`.
    @Published var isTenantOwner: Bool = false
    /// Shareable team invite URL (owner creates via Cloud Function).
    @Published var teamInviteShareURL: URL?
    @Published var isCreatingTeamInvite = false
    @Published var teamInviteError: String?

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    /// Tenant-wide policy from `tenants.workflow` (shown read-only to non-owners).
    @Published var tenantConfirmationType: BookingConfirmationType = .requestApprove
    @Published var tenantBookingRequiresApproval: Bool = true

    let dayLabels: [(Int, String)] = [
        (0, "Sun"), (1, "Mon"), (2, "Tue"), (3, "Wed"),
        (4, "Thu"), (5, "Fri"), (6, "Sat")
    ]

    var sortedDaysOpen: [Int] {
        Array(daysOpen).sorted()
    }

    /// Human-readable name for headers (avoids legacy staff placeholder last name `Member`).
    static func accountDisplayString(from profile: ProviderProfile) -> String {
        let fn = profile.firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let ln = profile.lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let composed = "\(fn) \(ln)".trimmingCharacters(in: .whitespacesAndNewlines)
        if !composed.isEmpty {
            if ln.lowercased() == "member", !fn.isEmpty { return fn }
            return composed
        }
        let rawName = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if rawName.isEmpty {
            return profile.business.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return rawName.replacingOccurrences(
            of: #"\s+Member$"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
    }

    func hasInvalidSlot(_ slot: TimeSlot) -> Bool {
        slot.close <= slot.open
    }

    var effectiveBookingConfirmationType: BookingConfirmationType {
        if isTenantOwner { return personalConfirmationType }
        if managersApproveAppointments { return tenantConfirmationType }
        return personalConfirmationType
    }

    var ownerControlsTeamBookingType: Bool {
        managersApproveAppointments
    }

    func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil; teamInviteError = nil }
        if isDemoMode {
            await MainActor.run {
                confirmationType = .requestApprove
                personalConfirmationType = .requestApprove
                usesStudioBookingPolicy = false
                managersApproveAppointments = true
                depositAmount = nil
                timeSlots = [TimeSlot(open: 9, close: 18)]
                daysOpen = [1, 2, 3, 4, 5]
                timeZoneId = TimeZone.current.identifier
                blockedDates = []
                availableDates = []
                hasProfile = false
                tenantId = nil
                selectedIndustry = BookingTemplate.custom.rawValue
                profilePhotoUrl = ""
                accountDisplayName = "Demo User"
                accountFullNameDraft = "Demo User"
                businessDisplayName = "Demo Studio"
                businessNameDraft = "Demo Studio"
                tenantSubscriptionPlan = .solo
                isTenantOwner = false
                teamInviteShareURL = nil
                teamInviteError = nil
                isCreatingTeamInvite = false
                isLoading = false
            }
            return
        }
        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            var industry: String?
            var tid: String?
            var planResolved = SubscriptionPlan.solo
            var ownerMatch = false
            var resolvedTenantType = BookingConfirmationType.requestApprove
            var resolvedTenantRequiresApproval = true
            var tenantDeposit: Double?
            var tenantManagersApprove = true
            var memberSettings = TeamMemberSettings()
            var resolvedBusinessName = profile?.business.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if let p = profile, let tenantIdFromProfile = p.tenantId {
                tid = tenantIdFromProfile
                memberSettings = (try? await firebaseService.fetchUserMemberSettings(uid: uid)) ?? TeamMemberSettings()
                if let tenant = try? await firebaseService.fetchTenant(tenantId: tenantIdFromProfile) {
                    industry = tenant["industry"] as? String
                    planResolved = SubscriptionPlan.normalized(fromFirestore: tenant["subscriptionPlan"] as? String)
                    if let ownerUid = tenant["ownerUid"] as? String, !ownerUid.isEmpty {
                        ownerMatch = (ownerUid == uid)
                    }
                    if resolvedBusinessName.isEmpty {
                        let tenantName = (tenant["displayName"] as? String ?? tenant["businessName"] as? String ?? "")
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if !tenantName.isEmpty { resolvedBusinessName = tenantName }
                    }
                    if let wf = tenant["workflow"] as? [String: Any],
                       let typeRaw = wf["confirmationType"] as? String,
                       let type = BookingConfirmationType(rawValue: typeRaw) {
                        resolvedTenantType = type
                        resolvedTenantRequiresApproval = type.requiresApproval
                        tenantDeposit = wf["depositAmount"] as? Double
                        if let ma = wf["managersApproveAppointments"] as? Bool {
                            tenantManagersApprove = ma
                        }
                    }
                }
            }
            await MainActor.run {
                if let p = profile {
                    hasProfile = true
                    tenantId = tid
                    tenantSubscriptionPlan = planResolved
                    isTenantOwner = ownerMatch
                    tenantConfirmationType = resolvedTenantType
                    tenantBookingRequiresApproval = resolvedTenantRequiresApproval
                    selectedIndustry = industry ?? BookingTemplate.custom.rawValue
                    profilePhotoUrl = p.profilePhotoUrl
                    let shown = Self.accountDisplayString(from: p)
                    accountDisplayName = shown
                    accountFullNameDraft = shown
                    businessDisplayName = resolvedBusinessName
                    businessNameDraft = resolvedBusinessName
                    personalConfirmationType = p.workflow.confirmationType
                    personalDepositAmount = p.workflow.depositAmount
                    usesStudioBookingPolicy = memberSettings.useStudioBookingPolicy
                    if ownerMatch {
                        confirmationType = resolvedTenantType
                        managersApproveAppointments = tenantManagersApprove
                        depositAmount = tenantDeposit
                    } else {
                        managersApproveAppointments = tenantManagersApprove
                    }
                    timeSlots = p.availability.timeSlots.isEmpty
                        ? [TimeSlot(open: 9, close: 18)]
                        : p.availability.timeSlots
                    daysOpen = Set(p.availability.daysOpen)
                    timeZoneId = Self.normalizedTimeZoneId(
                        p.availability.timeZone.isEmpty ? TimeZone.current.identifier : p.availability.timeZone
                    )
                    blockedDates = Set(p.availability.blockedDates)
                    availableDates = Set(p.availability.availableDates)
                } else {
                    hasProfile = false
                    tenantId = nil
                    tenantSubscriptionPlan = .solo
                    isTenantOwner = false
                    selectedIndustry = BookingTemplate.custom.rawValue
                    profilePhotoUrl = ""
                    accountDisplayName = ""
                    accountFullNameDraft = ""
                    businessDisplayName = ""
                    businessNameDraft = ""
                }
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func saveBusinessName() async {
        guard isTenantOwner else {
            await MainActor.run {
                errorMessage = "Only the business owner can update the business name."
            }
            return
        }
        guard let uid = Auth.auth().currentUser?.uid, let tid = tenantId else { return }
        let trimmed = businessNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await MainActor.run {
            isSavingBusinessName = true
            errorMessage = nil
            businessNameSaveSuccess = false
        }
        do {
            try await firebaseService.syncBusinessName(uid: uid, tenantId: tid, name: trimmed)
            await MainActor.run {
                businessDisplayName = trimmed
                businessNameDraft = trimmed
                isSavingBusinessName = false
                businessNameSaveSuccess = true
                NotificationCenter.default.post(
                    name: .tenantBusinessNameDidChange,
                    object: nil,
                    userInfo: ["businessName": trimmed]
                )
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    businessNameSaveSuccess = false
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isSavingBusinessName = false
            }
        }
    }

    func uploadProfilePhoto(imageData: Data) async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { isUploadingLogo = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadProviderProfilePhoto(uid: uid, imageData: imageData)
            try await firebaseService.updateProviderProfile(uid: uid, updates: ["profilePhotoUrl": url])
            await MainActor.run {
                profilePhotoUrl = url
                isUploadingLogo = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingLogo = false
            }
        }
    }

    func removeProfilePhoto() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil }
        do {
            try? await firebaseService.deleteProviderProfilePhotoFile(uid: uid)
            try await firebaseService.updateProviderProfile(uid: uid, updates: ["profilePhotoUrl": ""])
            await MainActor.run { profilePhotoUrl = "" }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func saveAccountFullName() async {
        guard let user = Auth.auth().currentUser else { return }
        let uid = user.uid
        let trimmed = accountFullNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await MainActor.run {
            isSavingAccountName = true
            errorMessage = nil
            accountNameSaveSuccess = false
        }
        do {
            let parts = trimmed.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            let firstName = parts.first ?? ""
            let lastName = parts.dropFirst().joined(separator: " ")
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "firstName": firstName,
                "lastName": lastName,
                "name": trimmed,
                "displayName": trimmed,
            ])
            let change = user.createProfileChangeRequest()
            change.displayName = trimmed
            try await change.commitChanges()
            await MainActor.run {
                accountDisplayName = trimmed
                accountFullNameDraft = trimmed
                isSavingAccountName = false
                accountNameSaveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    accountNameSaveSuccess = false
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isSavingAccountName = false
            }
        }
    }

    func saveWorkflow(isOwner: Bool) async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        guard isOwner else {
            await MainActor.run {
                errorMessage = "Only the business owner can update booking workflow."
            }
            return
        }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            if tenantId != nil {
                var callable: [String: Any] = [
                    "managersApproveAppointments": managersApproveAppointments,
                ]
                if managersApproveAppointments {
                    callable["confirmationType"] = confirmationType.rawValue
                    if let amount = depositAmount { callable["depositAmount"] = amount }
                }
                let result = try await functions.httpsCallable("updateTenantBookingWorkflow").call(callable)
                if let data = result.data as? [String: Any] {
                    await MainActor.run {
                        if let requires = data["bookingRequiresApproval"] as? Bool {
                            tenantBookingRequiresApproval = requires
                        }
                        if let ma = data["managersApproveAppointments"] as? Bool {
                            managersApproveAppointments = ma
                        }
                        tenantConfirmationType = confirmationType
                    }
                }
            }
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "workflow": [
                    "managersApproveAppointments": managersApproveAppointments,
                ] as [String: Any]
            ])
            await MainActor.run {
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func savePersonalWorkflow() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil; personalSaveSuccess = false }
        do {
            var workflowData: [String: Any] = [
                "confirmationType": personalConfirmationType.rawValue,
                "responseTimeHours": ProviderWorkflow.default.responseTimeHours,
            ]
            if personalConfirmationType.requiresDeposit, let amount = personalDepositAmount, amount > 0 {
                workflowData["depositAmount"] = amount
            }
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "workflow": workflowData
            ])
            await MainActor.run {
                personalSaveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    personalSaveSuccess = false
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func saveAvailability() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            let slotsData = timeSlots.map { slot -> [String: Any] in
                var d: [String: Any] = ["open": slot.open, "close": slot.close, "type": slot.type.rawValue]
                if let label = slot.customLabel { d["customLabel"] = label }
                if let days = slot.recurringDays { d["recurringDays"] = days }
                return d
            }
            let resolvedTimeZone = Self.normalizedTimeZoneId(timeZoneId)
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "availability": [
                    "timeSlots": slotsData,
                    "daysOpen": Array(daysOpen).sorted(),
                    "timeZone": resolvedTimeZone,
                    "blockedDates": Array(blockedDates).sorted(),
                    "availableDates": Array(availableDates).sorted()
                ]
            ])
            await MainActor.run {
                timeZoneId = resolvedTimeZone
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func toggleDay(_ day: Int) {
        if daysOpen.contains(day) {
            daysOpen.remove(day)
        } else {
            daysOpen.insert(day)
        }
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    func dateString(from date: Date) -> String {
        Self.dateFormatter.string(from: date)
    }

    func isDateBlocked(_ date: Date) -> Bool {
        blockedDates.contains(dateString(from: date))
    }

    func toggleBlockedDate(_ date: Date) {
        let key = dateString(from: date)
        if blockedDates.contains(key) {
            blockedDates.remove(key)
        } else {
            blockedDates.insert(key)
        }
    }

    func isDateAvailable(_ date: Date) -> Bool {
        availableDates.contains(dateString(from: date))
    }

    func toggleAvailableDate(_ date: Date) {
        let key = dateString(from: date)
        if availableDates.contains(key) {
            availableDates.remove(key)
        } else {
            availableDates.insert(key)
        }
    }

    func addTimeSlot() {
        let last = timeSlots.last ?? TimeSlot(open: 9, close: 18)
        timeSlots.append(TimeSlot(open: last.open, close: last.close, type: last.type, customLabel: last.type == .custom ? last.customLabel : nil, recurringDays: last.type == .recurring ? last.recurringDays : nil))
    }

    func removeTimeSlot(at index: Int) {
        guard timeSlots.count > 1 else { return }
        timeSlots.remove(at: index)
    }

    func updateTimeSlot(at index: Int, open: Int, close: Int) {
        guard index >= 0, index < timeSlots.count else { return }
        let s = timeSlots[index]
        timeSlots[index] = TimeSlot(id: s.id, open: open, close: close, type: s.type, customLabel: s.customLabel, recurringDays: s.recurringDays)
    }

    func updateTimeSlot(id: String, open: Int? = nil, close: Int? = nil, type: SlotType? = nil, customLabel: String? = nil, recurringDays: [Int]? = nil) {
        guard let idx = timeSlots.firstIndex(where: { $0.id == id }) else { return }
        let s = timeSlots[idx]
        let newType = type ?? s.type
        let newCustomLabel = newType == .custom ? (customLabel ?? s.customLabel) : nil
        let newRecurringDays = newType == .recurring ? (recurringDays ?? s.recurringDays ?? [1, 2, 3, 4, 5]) : nil
        timeSlots[idx] = TimeSlot(
            id: id,
            open: open ?? s.open,
            close: close ?? s.close,
            type: newType,
            customLabel: newCustomLabel,
            recurringDays: newRecurringDays
        )
    }

    func toggleRecurringDay(slotId: String, day: Int) {
        guard let idx = timeSlots.firstIndex(where: { $0.id == slotId }) else { return }
        var days = Set(timeSlots[idx].recurringDays ?? [1, 2, 3, 4, 5])
        if days.contains(day) {
            days.remove(day)
        } else {
            days.insert(day)
        }
        timeSlots[idx].recurringDays = Array(days).sorted()
    }

    func setSlotCustomLabel(id: String, _ label: String) {
        guard let idx = timeSlots.firstIndex(where: { $0.id == id }) else { return }
        let s = timeSlots[idx]
        timeSlots[idx] = TimeSlot(id: s.id, open: s.open, close: s.close, type: s.type, customLabel: label.isEmpty ? nil : label, recurringDays: s.recurringDays)
    }

    /// Applies the selected service template: form schema + default services + industry. Website Design stays editable after.
    func applyTemplateAndSave() async {
        guard let tid = tenantId,
              let template = BookingTemplate(rawValue: selectedIndustry) else { return }
        await MainActor.run { isSavingService = true; errorMessage = nil; saveSuccess = false }
        do {
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let schema = template.formFields.map { $0.toFirestore() }
            let existingServices = try await firebaseService.fetchTenantServices(tenantId: tid)
            for svc in existingServices {
                try await firebaseService.deleteTenantService(tenantId: tid, serviceId: svc.id)
            }
            for (index, item) in template.defaultServices.enumerated() {
                _ = try await firebaseService.createTenantService(
                    tenantId: tid,
                    name: item.name,
                    durationMinutes: item.durationMinutes,
                    sortOrder: index
                )
            }
            let currentStoredTheme = tenant?["webThemeId"] as? String
            let currentFamily = WebTheme(rawValue: currentStoredTheme ?? "")?.family ?? .classic
            let nextTheme = WebTheme.theme(for: currentFamily, industry: template.rawValue)
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "formSchema": schema,
                "industry": template.rawValue,
                "webThemeId": nextTheme.rawValue
            ])
            await MainActor.run {
                isSavingService = false
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run {
                isSavingService = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Owner-only: creates a single-use invite link (7-day expiry) via Cloud Function.
    func createTeamInviteLink() async {
        await MainActor.run {
            isCreatingTeamInvite = true
            teamInviteError = nil
            teamInviteShareURL = nil
        }
        do {
            let result = try await functions.httpsCallable("createTenantInvite").call([
                "baseUrl": Constants.Hosting.bookingWebOrigin,
            ])
            guard let data = result.data as? [String: Any],
                  let joinUrlString = data["joinUrl"] as? String,
                  let url = URL(string: joinUrlString) else {
                throw NSError(
                    domain: "SettingsViewModel",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid response from server."]
                )
            }
            await MainActor.run {
                teamInviteShareURL = url
                isCreatingTeamInvite = false
            }
        } catch {
            await MainActor.run {
                teamInviteError = error.localizedDescription
                isCreatingTeamInvite = false
            }
        }
    }

    static let sortedTimeZoneIdentifiers: [String] = TimeZone.knownTimeZoneIdentifiers.sorted()

    static func shortTimeZoneLabel(_ id: String) -> String {
        let known: [String: String] = [
            "America/New_York": "America/NY",
            "America/Los_Angeles": "America/LA",
            "America/Chicago": "America/CHI",
            "America/Denver": "America/DEN",
            "America/Phoenix": "America/PHX",
        ]
        if let mapped = known[id] { return mapped }
        let parts = id.split(separator: "/")
        guard parts.count == 2 else { return id }
        return "\(parts[0])/\(parts[1].prefix(3))"
    }

    static func normalizedTimeZoneId(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, TimeZone(identifier: trimmed) != nil {
            return trimmed
        }
        return TimeZone.current.identifier
    }
}
