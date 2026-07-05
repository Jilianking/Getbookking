//
//  ProviderProfile.swift
//  Test
//
//  Provider settings: profile, availability, workflow.
//

import Foundation

struct ProviderProfile {
    var tenantId: String?
    var tenantSlug: String?
    var name: String
    var firstName: String
    var lastName: String
    var profilePhotoUrl: String
    var business: String
    var industry: String
    var email: String
    var subscriptionPlan: String
    var subscriptionStatus: String
    var availability: ProviderAvailability
    var workflow: ProviderWorkflow
    var createdAt: Date?
    /// Multi-step app tour pending (new signups only).
    var appTourPending: Bool
}

struct TimeSlot: Identifiable, Codable, Equatable {
    var id: String
    var open: Int   // 0-23
    var close: Int  // 0-23

    init(id: String = UUID().uuidString, open: Int, close: Int) {
        self.id = id
        self.open = open
        self.close = close
    }
}

struct ProviderAvailability {
    var timeSlots: [TimeSlot]     // Legacy; prefer `businessHoursWeekly` when set
    var daysOpen: [Int]          // 0=Sun, 1=Mon, ..., 6=Sat – shop hours
    var timeZone: String
    var blockedDates: [String]   // "yyyy-MM-dd" – block from shop hours (approval mode)
    var availableDates: [String] // "yyyy-MM-dd" – selected for appointments (fixed slots mode)
    /// Tenant weekly hours (Mon–Sun); drives booking slots when present.
    var businessHoursWeekly: BusinessHoursWeekly?
    var businessHoursExceptions: [BusinessHoursException]

    static let `default` = ProviderAvailability(
        timeSlots: [TimeSlot(open: 9, close: 18)],
        daysOpen: [1, 2, 3, 4, 5],
        timeZone: TimeZone.current.identifier,
        blockedDates: [],
        availableDates: [],
        businessHoursWeekly: nil,
        businessHoursExceptions: []
    )

    static func mergingTenantBusinessHours(_ tenant: [String: Any]?, into base: ProviderAvailability) -> ProviderAvailability {
        var merged = base
        guard let tenant else { return merged }
        merged.businessHoursExceptions = BusinessHoursException.parseList(tenant["businessHoursExceptions"])
        if let weeklyRaw = tenant["businessHoursWeekly"] as? [String: Any],
           let weekly = BusinessHoursWeekly.fromFirestore(weeklyRaw) {
            merged.businessHoursWeekly = weekly
            merged.daysOpen = daysOpen(from: weekly)
        }
        return merged
    }

    /// Calendar weekday 0=Sun … 6=Sat for open days in `weekly` (Mon-first indices).
    static func daysOpen(from weekly: BusinessHoursWeekly) -> [Int] {
        weekly.days.enumerated().compactMap { index, day in
            guard !day.isClosed, !day.ranges.isEmpty else { return nil }
            return index == 6 ? 0 : index + 1
        }
    }

    /// Resolved schedule for a calendar day (exception overrides weekly; legacy time slots as fallback).
    func daySchedule(on dayStart: Date, calendar: Calendar) -> DaySchedule {
        let key = Self.dateKey(dayStart, calendar: calendar)
        if let ex = businessHoursExceptions.first(where: { $0.dateYmd == key }) {
            if ex.closedAllDay { return .closedSchedule }
            var sched = DaySchedule(isClosed: false, ranges: ex.ranges)
            sched.normalize()
            return sched
        }
        if let weekly = businessHoursWeekly {
            let weekday = calendar.component(.weekday, from: dayStart) - 1
            let index = weekday == 0 ? 6 : weekday - 1
            if weekly.days.indices.contains(index) {
                return weekly.days[index]
            }
        }
        let legacyRanges = timeSlots
            .filter { $0.close > $0.open }
            .map { BusinessHourTimeRange(startMinutes: $0.open * 60, endMinutes: $0.close * 60) }
        if legacyRanges.isEmpty {
            return .singleNineToFive()
        }
        return DaySchedule(isClosed: false, ranges: legacyRanges)
    }

    func isBookableDay(on dayStart: Date, calendar: Calendar) -> Bool {
        let sched = daySchedule(on: dayStart, calendar: calendar)
        return !sched.isClosed && !sched.ranges.isEmpty
    }

    private static func dateKey(_ date: Date, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = calendar.timeZone
        return f.string(from: date)
    }
}

struct ProviderWorkflow {
    var confirmationType: BookingConfirmationType
    var responseTimeHours: Int
    var depositAmount: Double?

    static let `default` = ProviderWorkflow(
        confirmationType: .requestApprove,
        responseTimeHours: 24,
        depositAmount: nil
    )
}

enum BookingConfirmationType: String, CaseIterable, Codable {
    case instantBook = "instant_book"
    case requestApprove = "request_approve"
    case depositToConfirm = "deposit_to_confirm"
    case approveAndDeposit = "approve_and_deposit"
    case consultationFirst = "consultation_first"

    var displayName: String {
        switch self {
        case .instantBook: return "Instant book"
        case .requestApprove: return "Request + approve"
        case .depositToConfirm: return "Deposit to confirm"
        case .approveAndDeposit: return "Approve + deposit"
        case .consultationFirst: return "Consultation first"
        }
    }

    var description: String {
        switch self {
        case .instantBook: return "No approval – customer books immediately"
        case .requestApprove: return "Manual approval required"
        case .depositToConfirm: return "Auto-confirm once deposit paid"
        case .approveAndDeposit: return "Approve first, then deposit"
        case .consultationFirst: return "Consultation, then book service"
        }
    }

    var requiresApproval: Bool {
        switch self {
        case .instantBook, .depositToConfirm: return false
        case .requestApprove, .approveAndDeposit, .consultationFirst: return true
        }
    }

    var requiresDeposit: Bool {
        switch self {
        case .instantBook, .requestApprove: return false
        case .depositToConfirm, .approveAndDeposit: return true
        case .consultationFirst: return false
        }
    }

    /// Uses fixed date selection (tap to select available) vs block dates (shop hours, tap to block)
    var usesFixedSlots: Bool {
        switch self {
        case .instantBook, .depositToConfirm: return true
        case .requestApprove, .approveAndDeposit, .consultationFirst: return false
        }
    }
}
