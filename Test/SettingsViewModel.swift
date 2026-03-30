//
//  SettingsViewModel.swift
//
//  Settings: scheduling type, availability, profile.
//

import Foundation
import Combine
import FirebaseAuth

class SettingsViewModel: ObservableObject {
    @Published var confirmationType: BookingConfirmationType = .requestApprove
    @Published var responseTimeHours: Int = 24
    @Published var depositAmount: Double?
    @Published var timeSlots: [TimeSlot] = [TimeSlot(open: 9, close: 18)]
    @Published var daysOpen: Set<Int> = [1, 2, 3, 4, 5]
    @Published var timeZoneId: String = ""
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

    private let firebaseService = FirebaseService()

    let dayLabels: [(Int, String)] = [
        (0, "Sun"), (1, "Mon"), (2, "Tue"), (3, "Wed"),
        (4, "Thu"), (5, "Fri"), (6, "Sat")
    ]

    var sortedDaysOpen: [Int] {
        Array(daysOpen).sorted()
    }

    func hasInvalidSlot(_ slot: TimeSlot) -> Bool {
        slot.close <= slot.open
    }

    func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run {
                confirmationType = .requestApprove
                responseTimeHours = 24
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
            if let p = profile, let tenantIdFromProfile = p.tenantId {
                tid = tenantIdFromProfile
                if let tenant = try? await firebaseService.fetchTenant(tenantId: tenantIdFromProfile) {
                    industry = tenant["industry"] as? String
                }
            }
            await MainActor.run {
                if let p = profile {
                    let fullName = "\(p.firstName) \(p.lastName)".trimmingCharacters(in: .whitespacesAndNewlines)
                    hasProfile = true
                    tenantId = tid
                    selectedIndustry = industry ?? BookingTemplate.custom.rawValue
                    profilePhotoUrl = p.profilePhotoUrl
                    accountDisplayName = !fullName.isEmpty ? fullName : (!p.name.isEmpty ? p.name : p.business)
                    confirmationType = p.workflow.confirmationType
                    responseTimeHours = p.workflow.responseTimeHours
                    depositAmount = p.workflow.depositAmount
                    timeSlots = p.availability.timeSlots.isEmpty
                        ? [TimeSlot(open: 9, close: 18)]
                        : p.availability.timeSlots
                    daysOpen = Set(p.availability.daysOpen)
                    timeZoneId = p.availability.timeZone.isEmpty ? TimeZone.current.identifier : p.availability.timeZone
                    blockedDates = Set(p.availability.blockedDates)
                    availableDates = Set(p.availability.availableDates)
                } else {
                    hasProfile = false
                    tenantId = nil
                    selectedIndustry = BookingTemplate.custom.rawValue
                    profilePhotoUrl = ""
                    accountDisplayName = ""
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

    func saveWorkflow() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            var workflowData: [String: Any] = [
                "confirmationType": confirmationType.rawValue,
                "responseTimeHours": responseTimeHours
            ]
            if let amount = depositAmount { workflowData["depositAmount"] = amount }
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "workflow": workflowData
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
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "availability": [
                    "timeSlots": slotsData,
                    "daysOpen": Array(daysOpen).sorted(),
                    "timeZone": timeZoneId.isEmpty ? TimeZone.current.identifier : timeZoneId,
                    "blockedDates": Array(blockedDates).sorted(),
                    "availableDates": Array(availableDates).sorted()
                ]
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
}
