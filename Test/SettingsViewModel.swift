//
//  SettingsViewModel.swift
//
//  Settings: scheduling type, availability, profile.
//

import Foundation
import Combine
import FirebaseAuth

class SettingsViewModel: ObservableObject {
    @Published var workflowMode: WorkflowMode = .approval
    @Published var responseTimeHours: Int = 24
    @Published var timeSlots: [TimeSlot] = [TimeSlot(open: 9, close: 18)]
    @Published var daysOpen: Set<Int> = [1, 2, 3, 4, 5]
    @Published var timeZoneId: String = ""
    @Published var blockedDates: Set<String> = []
    @Published var availableDates: Set<String> = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false
    @Published var hasProfile = false

    private let firebaseService = FirebaseService()

    let dayLabels: [(Int, String)] = [
        (0, "Sun"), (1, "Mon"), (2, "Tue"), (3, "Wed"),
        (4, "Thu"), (5, "Fri"), (6, "Sat")
    ]

    var sortedDaysOpen: [Int] {
        Array(daysOpen).sorted()
    }

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run {
                workflowMode = .approval
                responseTimeHours = 24
                timeSlots = [TimeSlot(open: 9, close: 18)]
                daysOpen = [1, 2, 3, 4, 5]
                timeZoneId = TimeZone.current.identifier
                blockedDates = []
                availableDates = []
                hasProfile = false
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
            await MainActor.run {
                if let p = profile {
                    hasProfile = true
                    workflowMode = p.workflow.mode
                    responseTimeHours = p.workflow.responseTimeHours
                    timeSlots = p.availability.timeSlots.isEmpty
                        ? [TimeSlot(open: 9, close: 18)]
                        : p.availability.timeSlots
                    daysOpen = Set(p.availability.daysOpen)
                    timeZoneId = p.availability.timeZone.isEmpty ? TimeZone.current.identifier : p.availability.timeZone
                    blockedDates = Set(p.availability.blockedDates)
                    availableDates = Set(p.availability.availableDates)
                } else {
                    hasProfile = false
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

    func saveWorkflow() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            try await firebaseService.updateProviderProfile(uid: uid, updates: [
                "workflow": [
                    "mode": workflowMode.rawValue,
                    "responseTimeHours": responseTimeHours
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

    func saveAvailability() async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            let slotsData = timeSlots.map { ["open": $0.open, "close": $0.close] }
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
        timeSlots.append(TimeSlot(open: last.open, close: last.close))
    }

    func removeTimeSlot(at index: Int) {
        guard timeSlots.count > 1 else { return }
        timeSlots.remove(at: index)
    }

    func updateTimeSlot(at index: Int, open: Int, close: Int) {
        guard index >= 0, index < timeSlots.count else { return }
        timeSlots[index] = TimeSlot(id: timeSlots[index].id, open: open, close: close)
    }

    func updateTimeSlot(id: String, open: Int? = nil, close: Int? = nil) {
        guard let idx = timeSlots.firstIndex(where: { $0.id == id }) else { return }
        let s = timeSlots[idx]
        timeSlots[idx] = TimeSlot(id: id, open: open ?? s.open, close: close ?? s.close)
    }
}
