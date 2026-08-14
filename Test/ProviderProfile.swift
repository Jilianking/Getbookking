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

/// One bookable slot pattern on Edit availability: optional service link + duration + space between.
struct OnlineBookableSlotPattern: Identifiable, Equatable {
    var id: String
    /// Tenant service id when linked; nil = custom / duration-only.
    var serviceId: String?
    /// Display name when not linked to a service (or cache of service name).
    var label: String
    var durationMinutes: Int
    /// Minutes free after the appointment before the next start.
    var bufferMinutes: Int

    init(
        id: String = UUID().uuidString,
        serviceId: String? = nil,
        label: String = "",
        durationMinutes: Int = 30,
        bufferMinutes: Int = 0
    ) {
        self.id = id
        self.serviceId = serviceId
        self.label = label
        self.durationMinutes = max(5, durationMinutes)
        self.bufferMinutes = max(0, bufferMinutes)
    }

    var stepMinutes: Int { durationMinutes + bufferMinutes }

    var summaryLine: String {
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = name.isEmpty ? "Custom slot" : name
        if bufferMinutes > 0 {
            return "\(title) · \(durationMinutes) min · \(bufferMinutes) min between"
        }
        return "\(title) · \(durationMinutes) min"
    }

    func firestoreMap() -> [String: Any] {
        var m: [String: Any] = [
            "id": id,
            "label": label,
            "durationMinutes": durationMinutes,
            "bufferMinutes": bufferMinutes
        ]
        if let sid = serviceId, !sid.isEmpty {
            m["serviceId"] = sid
        }
        return m
    }

    static func fromFirestore(_ raw: Any?) -> OnlineBookableSlotPattern? {
        guard let m = raw as? [String: Any] else { return nil }
        let id = (m["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let uid = (id?.isEmpty == false) ? id! : UUID().uuidString
        let sid = (m["serviceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = (m["label"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let dur: Int = {
            if let n = m["durationMinutes"] as? Int { return n }
            if let n = m["durationMinutes"] as? Double { return Int(n) }
            return 30
        }()
        let buf: Int = {
            if let n = m["bufferMinutes"] as? Int { return n }
            if let n = m["bufferMinutes"] as? Double { return Int(n) }
            return 0
        }()
        return OnlineBookableSlotPattern(
            id: uid,
            serviceId: (sid?.isEmpty == false) ? sid : nil,
            label: label,
            durationMinutes: dur,
            bufferMinutes: buf
        )
    }

    static func parseList(_ raw: Any?) -> [OnlineBookableSlotPattern] {
        guard let arr = raw as? [Any] else { return [] }
        return arr.compactMap { fromFirestore($0) }
    }
}

/// Partial-day block on the availability calendar (minutes from midnight).
struct BlockedTimeRange: Identifiable, Equatable {
    var id: String
    /// `yyyy-MM-dd`
    var dateYmd: String
    var startMinutes: Int
    var endMinutes: Int

    init(
        id: String = UUID().uuidString,
        dateYmd: String,
        startMinutes: Int,
        endMinutes: Int
    ) {
        self.id = id
        self.dateYmd = dateYmd
        self.startMinutes = max(0, min(startMinutes, 24 * 60 - 1))
        self.endMinutes = max(0, min(endMinutes, 24 * 60))
        if self.endMinutes <= self.startMinutes {
            self.endMinutes = min(self.startMinutes + 30, 24 * 60)
        }
    }

    var summaryLine: String {
        let a = BusinessHoursWeekly.formatTime(minutes: startMinutes)
        let b = BusinessHoursWeekly.formatTime(minutes: endMinutes)
        return "\(a) – \(b)"
    }

    func firestoreMap() -> [String: Any] {
        [
            "id": id,
            "date": dateYmd,
            "startMin": startMinutes,
            "endMin": endMinutes,
        ]
    }

    static func fromFirestore(_ any: Any?) -> BlockedTimeRange? {
        guard let m = any as? [String: Any] else { return nil }
        let date = (m["date"] as? String ?? m["dateYmd"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !date.isEmpty else { return nil }
        let start: Int = {
            if let n = m["startMin"] as? Int { return n }
            if let n = m["startMinutes"] as? Int { return n }
            if let n = m["startMin"] as? Double { return Int(n) }
            return 0
        }()
        let end: Int = {
            if let n = m["endMin"] as? Int { return n }
            if let n = m["endMinutes"] as? Int { return n }
            if let n = m["endMin"] as? Double { return Int(n) }
            return start + 60
        }()
        let id = (m["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        return BlockedTimeRange(id: id, dateYmd: date, startMinutes: start, endMinutes: end)
    }

    static func parseList(_ raw: Any?) -> [BlockedTimeRange] {
        guard let arr = raw as? [Any] else { return [] }
        return arr.compactMap { fromFirestore($0) }
    }
}

struct ProviderAvailability {
    var timeSlots: [TimeSlot]     // Legacy; prefer `businessHoursWeekly` when set
    var daysOpen: [Int]          // 0=Sun, 1=Mon, ..., 6=Sat – shop hours
    var timeZone: String
    var blockedDates: [String]   // "yyyy-MM-dd" – full day off
    var availableDates: [String] // "yyyy-MM-dd" – legacy fixed-slot opt-in days
    /// Tenant weekly hours (Mon–Sun); drives booking slots when present.
    var businessHoursWeekly: BusinessHoursWeekly?
    var businessHoursExceptions: [BusinessHoursException]
    /// Legacy online windows (no longer edited in Availability calendar).
    var onlineBookableWeekly: BusinessHoursWeekly?
    var onlineSlotsConfigured: Bool
    var onlineSlotStepMinutes: Int
    var onlineSlotPatterns: [OnlineBookableSlotPattern]
    /// Partial-day unavailability (inside shop hours).
    var blockedTimeRanges: [BlockedTimeRange]

    static let `default` = ProviderAvailability(
        timeSlots: [TimeSlot(open: 9, close: 18)],
        daysOpen: [1, 2, 3, 4, 5],
        timeZone: TimeZone.current.identifier,
        blockedDates: [],
        availableDates: [],
        businessHoursWeekly: nil,
        businessHoursExceptions: [],
        onlineBookableWeekly: nil,
        onlineSlotsConfigured: false,
        onlineSlotStepMinutes: 30,
        onlineSlotPatterns: [],
        blockedTimeRanges: []
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
        // Owner blocks mirrored on tenant for public /book
        if let dates = tenant["blockedDates"] as? [String], !dates.isEmpty {
            // Prefer user availability when non-empty; tenant is backup for web only.
        }
        if merged.blockedTimeRanges.isEmpty {
            let fromTenant = BlockedTimeRange.parseList(tenant["blockedTimeRanges"])
            if !fromTenant.isEmpty {
                merged.blockedTimeRanges = fromTenant
            }
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

    /// Open windows for a calendar day: shop hours + exceptions (not online autofill).
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
        // Legacy online windows only if shop weekly missing
        if onlineSlotsConfigured, let online = onlineBookableWeekly {
            let weekday = calendar.component(.weekday, from: dayStart) - 1
            let index = weekday == 0 ? 6 : weekday - 1
            if online.days.indices.contains(index) {
                return online.days[index]
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

    func isFullDayBlocked(on dayStart: Date, calendar: Calendar) -> Bool {
        blockedDates.contains(Self.dateKey(dayStart, calendar: calendar))
    }

    func partialBlocks(on dayStart: Date, calendar: Calendar) -> [BlockedTimeRange] {
        let key = Self.dateKey(dayStart, calendar: calendar)
        return blockedTimeRanges.filter { $0.dateYmd == key }
    }

    /// Whether a start at `startMin` with duration `durationMin` is covered by a partial block.
    func isStartBlockedByPartial(dateYmd: String, startMin: Int, durationMin: Int) -> Bool {
        let end = startMin + max(5, durationMin)
        for b in blockedTimeRanges where b.dateYmd == dateYmd {
            // Overlap: start < blockEnd && end > blockStart
            if startMin < b.endMinutes && end > b.startMinutes {
                return true
            }
        }
        return false
    }

    func isBookableDay(on dayStart: Date, calendar: Calendar) -> Bool {
        if isFullDayBlocked(on: dayStart, calendar: calendar) { return false }
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
    case payInFull = "pay_in_full"

    var displayName: String {
        switch self {
        case .instantBook: return "Instant book"
        case .requestApprove: return "Request + approve"
        case .depositToConfirm: return "Deposit to confirm"
        case .approveAndDeposit: return "Approve + deposit"
        case .consultationFirst: return "Consultation first"
        case .payInFull: return "Pay in full"
        }
    }

    var description: String {
        switch self {
        case .instantBook: return "No approval – customer books immediately"
        case .requestApprove: return "Manual approval required"
        case .depositToConfirm: return "Auto-confirm once deposit paid"
        case .approveAndDeposit: return "Approve first, then deposit"
        case .consultationFirst: return "Consultation, then book service"
        case .payInFull: return "Charge the trip total at checkout"
        }
    }

    var requiresApproval: Bool {
        switch self {
        case .instantBook, .depositToConfirm, .payInFull: return false
        case .requestApprove, .approveAndDeposit, .consultationFirst: return true
        }
    }

    var requiresDeposit: Bool {
        switch self {
        case .instantBook, .requestApprove, .payInFull: return false
        case .depositToConfirm, .approveAndDeposit: return true
        case .consultationFirst: return false
        }
    }

    var requiresPaymentAtCheckout: Bool {
        switch self {
        case .depositToConfirm, .payInFull: return true
        default: return false
        }
    }

    /// Uses fixed date selection (tap to select available) vs block dates (shop hours, tap to block)
    var usesFixedSlots: Bool {
        switch self {
        case .instantBook, .depositToConfirm, .payInFull: return true
        case .requestApprove, .approveAndDeposit, .consultationFirst: return false
        }
    }
}
