//
//  SettingsViewModel.swift
//
//  Settings: scheduling type, availability, profile.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

class SettingsViewModel: ObservableObject, BusinessHoursEditing {
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
    @Published var businessHours: String = ""
    @Published var businessHoursWeekly: BusinessHoursWeekly = .defaultOfficeHours
    @Published var businessHoursExceptions: [BusinessHoursException] = []
    @Published var showBusinessHoursOnPage: Bool = true
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
    @Published var industryCustomLabel: String = ""
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

    /// Account deletion / ownership transfer (Settings → Account).
    @Published var deletionEligibility: AccountDeletionEligibility?
    @Published var transferCandidates: [TenantTeamMember] = []
    @Published var isLoadingAccountLifecycle = false
    @Published var isDeletingAccount = false
    @Published var isTransferringOwnership = false
    @Published var accountLifecycleMessage: String?

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

    func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    var effectiveBookingConfirmationType: BookingConfirmationType {
        if isTenantOwner { return personalConfirmationType }
        if managersApproveAppointments { return tenantConfirmationType }
        return personalConfirmationType
    }

    var ownerControlsTeamBookingType: Bool {
        managersApproveAppointments
    }

    var businessHoursSummary: String {
        let lines = businessHoursWeekly.formattedDisplayString()
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
        guard let first = lines.first else { return "Set your weekly hours" }
        if lines.count == 1 { return first }
        return first + " · " + "\(lines.count) day groups"
    }

    private func applyTenantBusinessHours(from tenant: [String: Any]?) {
        guard let tenant else { return }
        businessHours = tenant["businessHours"] as? String ?? ""
        businessHoursExceptions = BusinessHoursException.parseList(tenant["businessHoursExceptions"])
        if let weeklyRaw = tenant["businessHoursWeekly"] as? [String: Any],
           let parsed = BusinessHoursWeekly.fromFirestore(weeklyRaw) {
            businessHoursWeekly = parsed
            businessHours = DesignViewModel.businessHoursDisplayString(weekly: parsed, exceptions: businessHoursExceptions)
        } else if businessHours.isEmpty {
            businessHoursWeekly = .defaultOfficeHours
            businessHours = DesignViewModel.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
        }
        showBusinessHoursOnPage = tenant["showBusinessHoursOnPage"] as? Bool ?? true
        daysOpen = Set(ProviderAvailability.daysOpen(from: businessHoursWeekly))
    }

    func syncBusinessHoursStringFromWeekly() {
        businessHours = DesignViewModel.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
    }

    func replaceBusinessHoursDay(index: Int, schedule: DaySchedule) {
        guard businessHoursWeekly.days.indices.contains(index) else { return }
        var w = businessHoursWeekly
        w.days[index] = schedule
        w.normalizeDay(at: index)
        businessHoursWeekly = w
        syncBusinessHoursStringFromWeekly()
        daysOpen = Set(ProviderAvailability.daysOpen(from: businessHoursWeekly))
    }

    func upsertBusinessHoursException(_ item: BusinessHoursException) {
        var list = businessHoursExceptions
        if let i = list.firstIndex(where: { $0.id == item.id }) {
            list[i] = item
        } else {
            list.append(item)
        }
        businessHoursExceptions = list.sorted { $0.dateYmd < $1.dateYmd }
        syncBusinessHoursStringFromWeekly()
    }

    func removeBusinessHoursException(id: String) {
        businessHoursExceptions.removeAll { $0.id == id }
        syncBusinessHoursStringFromWeekly()
    }

    func applySchedule(_ schedule: DaySchedule, toIndices indices: Set<Int>) {
        var w = businessHoursWeekly
        for i in indices where w.days.indices.contains(i) {
            w.days[i] = schedule
            w.normalizeDay(at: i)
        }
        businessHoursWeekly = w
        syncBusinessHoursStringFromWeekly()
        daysOpen = Set(ProviderAvailability.daysOpen(from: businessHoursWeekly))
    }

    func saveBusinessHours() async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        let hoursString = DesignViewModel.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
        var updates: [String: Any] = [
            "businessHours": hoursString,
            "showBusinessHoursOnPage": showBusinessHoursOnPage,
            "businessHoursWeekly": businessHoursWeekly.firestoreDayMap(),
            "businessHoursExceptions": businessHoursExceptions.map { $0.toFirestore() },
        ]
        if let doc = try? await firebaseService.fetchTenant(tenantId: tid),
           let clearedOverrides = Self.webCopyOverridesWithoutContactHours(doc) {
            updates["webCopyOverrides"] = clearedOverrides
        }
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: updates)
            await MainActor.run {
                businessHours = hoursString
                daysOpen = Set(ProviderAvailability.daysOpen(from: businessHoursWeekly))
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

    private static func webCopyOverridesWithoutContactHours(_ doc: [String: Any]?) -> [String: String]? {
        var map: [String: String] = [:]
        if let overrides = doc?["webCopyOverrides"] as? [String: String] {
            map = overrides
        } else if let overrides = doc?["webCopyOverrides"] as? [String: Any] {
            for (k, v) in overrides {
                if let s = v as? String { map[k] = s }
            }
        }
        guard map.removeValue(forKey: "wc.contact.hours") != nil else { return nil }
        return map
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
                businessHoursWeekly = .defaultOfficeHours
                businessHoursExceptions = []
                businessHours = DesignViewModel.businessHoursDisplayString(weekly: .defaultOfficeHours, exceptions: [])
                showBusinessHoursOnPage = true
                daysOpen = [1, 2, 3, 4, 5]
                timeZoneId = TimeZone.current.identifier
                blockedDates = []
                availableDates = []
                hasProfile = false
                tenantId = nil
                selectedIndustry = BookingTemplate.custom.rawValue
                industryCustomLabel = ""
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
            var industryLabel: String?
            var tid: String?
            var planResolved = SubscriptionPlan.solo
            var ownerMatch = false
            var resolvedTenantType = BookingConfirmationType.requestApprove
            var resolvedTenantRequiresApproval = true
            var tenantDeposit: Double?
            var tenantManagersApprove = true
            var memberSettings = TeamMemberSettings()
            var resolvedBusinessName = profile?.business.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var loadedTenant: [String: Any]?
            if let p = profile, let tenantIdFromProfile = p.tenantId {
                tid = tenantIdFromProfile
                memberSettings = (try? await firebaseService.fetchUserMemberSettings(uid: uid)) ?? TeamMemberSettings()
                if let tenant = try? await firebaseService.fetchTenant(tenantId: tenantIdFromProfile) {
                    loadedTenant = tenant
                    industry = tenant["industry"] as? String
                    industryLabel = tenant["industryCustomLabel"] as? String
                    planResolved = SubscriptionPlan.normalized(fromFirestore: tenant["subscriptionPlan"] as? String)
                    if let ownerUid = tenant["ownerUid"] as? String, !ownerUid.isEmpty {
                        ownerMatch = (ownerUid == uid)
                    }
                    if resolvedBusinessName.isEmpty {
                        let tenantName = (tenant["businessName"] as? String ?? tenant["displayName"] as? String ?? "")
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
                    industryCustomLabel = (industryLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
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
                    applyTenantBusinessHours(from: loadedTenant)
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
                    industryCustomLabel = ""
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
            let resolvedTimeZone = Self.normalizedTimeZoneId(timeZoneId)
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "availability": [
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

    func loadAccountLifecycle(isDemoMode: Bool) async {
        if isDemoMode {
            await MainActor.run {
                deletionEligibility = nil
                transferCandidates = []
            }
            return
        }
        await MainActor.run {
            isLoadingAccountLifecycle = true
            accountLifecycleMessage = nil
        }
        do {
            let eligibilityResult = try await functions
                .httpsCallable("getAccountDeletionEligibility")
                .call([:])
            let eligibilityData = eligibilityResult.data as? [String: Any] ?? [:]
            let parsed = AccountDeletionEligibility(data: eligibilityData)
            var candidates: [TenantTeamMember] = []
            if parsed.isOwner, parsed.otherTeamMemberCount > 0 {
                let membersResult = try await functions
                    .httpsCallable("listTenantMembers")
                    .call([:])
                let membersData = membersResult.data as? [String: Any]
                let ownerUid = membersData?["ownerUid"] as? String
                candidates = Self.parseTransferCandidates(
                    membersData?["members"] as? [[String: Any]],
                    ownerUid: ownerUid
                )
            }
            await MainActor.run {
                deletionEligibility = parsed
                transferCandidates = candidates
                isLoadingAccountLifecycle = false
            }
        } catch {
            await MainActor.run {
                deletionEligibility = nil
                transferCandidates = []
                accountLifecycleMessage = error.localizedDescription
                isLoadingAccountLifecycle = false
            }
        }
    }

    func deleteAccount(confirmPhrase: String, shutdownConfirmPhrase: String? = nil) async throws {
        await MainActor.run {
            isDeletingAccount = true
            accountLifecycleMessage = nil
        }
        defer {
            Task { @MainActor in isDeletingAccount = false }
        }
        var payload: [String: Any] = [
            "confirmPhrase": confirmPhrase,
        ]
        if let shutdownConfirmPhrase, !shutdownConfirmPhrase.isEmpty {
            payload["shutdownConfirmPhrase"] = shutdownConfirmPhrase
        }
        _ = try await functions.httpsCallable("deleteMyAccount").call(payload)
    }

    func transferOwnership(to newOwnerUid: String, confirmPhrase: String) async throws {
        await MainActor.run {
            isTransferringOwnership = true
            accountLifecycleMessage = nil
        }
        defer {
            Task { @MainActor in isTransferringOwnership = false }
        }
        _ = try await functions.httpsCallable("transferTenantOwnership").call([
            "newOwnerUid": newOwnerUid,
            "confirmPhrase": confirmPhrase,
        ])
    }

    private static func parseTransferCandidates(
        _ raw: [[String: Any]]?,
        ownerUid: String?
    ) -> [TenantTeamMember] {
        TenantSessionStore.parseTeamMembers(raw, ownerUid: ownerUid)
            .filter { $0.accessRole != .owner }
    }
}

struct AccountDeletionEligibility {
    let hasProfile: Bool
    let isOwner: Bool
    let teamMemberCount: Int
    let otherTeamMemberCount: Int
    let requiresTransfer: Bool
    let requiresShutdownConfirm: Bool
    let canDelete: Bool
    let businessName: String
    let hasStripeConnectAccount: Bool
    let stripeBalanceBlocksDeletion: Bool
    let stripeBalanceBlockMessage: String

    init(data: [String: Any]) {
        hasProfile = data["hasProfile"] as? Bool ?? false
        isOwner = data["isOwner"] as? Bool ?? false
        teamMemberCount = data["teamMemberCount"] as? Int ?? 0
        otherTeamMemberCount = data["otherTeamMemberCount"] as? Int ?? 0
        requiresTransfer = data["requiresTransfer"] as? Bool ?? false
        requiresShutdownConfirm = data["requiresShutdownConfirm"] as? Bool ?? requiresTransfer
        canDelete = data["canDelete"] as? Bool ?? true
        businessName = (data["businessName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        hasStripeConnectAccount = data["hasStripeConnectAccount"] as? Bool ?? false
        stripeBalanceBlocksDeletion = data["stripeBalanceBlocksDeletion"] as? Bool ?? false
        stripeBalanceBlockMessage = (data["stripeBalanceBlockMessage"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
