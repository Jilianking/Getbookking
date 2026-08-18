//
//  BookingMode.swift
//
//  Whether public /book uses an inquiry form or calendar/slot picking.
//  In Booking settings UI this is one row on the Booking type picker
//  (“Calendar / slots”); Instant / Request+approve / Deposit stay as
//  BookingConfirmationType. Nested confirmation still uses confirmationType.
//

import Foundation

enum BookingMode: String, CaseIterable, Identifiable, Codable {
    /// Public /book uses Standard or Guided form (Design).
    case form = "form"
    /// Public /book uses day + time calendar; availability applies.
    case calendarSlots = "calendar_slots"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .form: return "Form request"
        case .calendarSlots: return "Calendar / slots"
        }
    }

    var subtitle: String {
        switch self {
        case .form:
            return "Clients submit an inquiry form. Layout is Standard or Guided in Design."
        case .calendarSlots:
            return "Clients pick a day and time on /book. Set hours and availability under Scheduling."
        }
    }

    static func resolved(stored: String?) -> BookingMode {
        let raw = (stored ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw == "calendar_slots" || raw == "calendar" || raw == "slots"
            || raw == "slot_booking" || raw == "online_booking" || raw == "online" {
            return .calendarSlots
        }
        if raw == "form" || raw == "inquiry" || raw == "request" {
            return .form
        }
        return .form
    }

    /// Legacy: Design used bookingFormStyleId == calendar for online booking.
    static func resolved(workflowMode: String?, bookingFormStyleId: String?) -> BookingMode {
        let modeRaw = (workflowMode ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !modeRaw.isEmpty {
            return resolved(stored: modeRaw)
        }
        let style = (bookingFormStyleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if style == "calendar" || style == "online" || style == "online_booking" || style == "appointments" {
            return .calendarSlots
        }
        return .form
    }
}

// MARK: - Single Booking type picker (includes Calendar / slots)

/// Rows in the Booking type control: classic confirmation types + Calendar / slots.
enum StudioBookingTypeOption: String, CaseIterable, Identifiable, Hashable {
    case instantBook = "instant_book"
    case requestApprove = "request_approve"
    case depositToConfirm = "deposit_to_confirm"
    case approveAndDeposit = "approve_and_deposit"
    case consultationFirst = "consultation_first"
    case calendarSlots = "calendar_slots"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .calendarSlots: return "Calendar / slots"
        default:
            return confirmationType?.displayName ?? rawValue
        }
    }

    var description: String {
        switch self {
        case .calendarSlots:
            return "Clients pick a day and time. Choose confirmation below."
        default:
            return confirmationType?.description ?? ""
        }
    }

    /// Non-calendar options map 1:1 to confirmation type.
    var confirmationType: BookingConfirmationType? {
        switch self {
        case .calendarSlots: return nil
        case .instantBook: return .instantBook
        case .requestApprove: return .requestApprove
        case .depositToConfirm: return .depositToConfirm
        case .approveAndDeposit: return .approveAndDeposit
        case .consultationFirst: return .consultationFirst
        }
    }

    var isCalendarSlots: Bool { self == .calendarSlots }

    static func from(mode: BookingMode, confirmation: BookingConfirmationType) -> StudioBookingTypeOption {
        if mode == .calendarSlots { return .calendarSlots }
        switch confirmation {
        case .instantBook: return .instantBook
        case .requestApprove: return .requestApprove
        case .depositToConfirm: return .depositToConfirm
        case .approveAndDeposit: return .approveAndDeposit
        case .consultationFirst: return .consultationFirst
        case .payInFull: return .instantBook
        }
    }

    /// Applies picker selection onto mode + confirmation (keeps confirmation when choosing calendar).
    func apply(toMode mode: inout BookingMode, confirmation: inout BookingConfirmationType) {
        if isCalendarSlots {
            mode = .calendarSlots
            return
        }
        mode = .form
        if let t = confirmationType {
            confirmation = t
        }
    }
}

// MARK: - Fishing charter (calendar only)

/// Charter plan: guests always pick a slot; pay later, deposit, or full price.
enum CharterPaymentPolicy: String, CaseIterable, Identifiable, Hashable {
    case requestApprove = "request_approve"
    case deposit = "deposit"
    case payInFull = "pay_in_full"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .requestApprove: return "Request & approve"
        case .deposit: return "Deposit"
        case .payInFull: return "Pay in full"
        }
    }

    var confirmationType: BookingConfirmationType {
        switch self {
        case .requestApprove: return .requestApprove
        case .deposit: return .depositToConfirm
        case .payInFull: return .payInFull
        }
    }

    static func from(confirmation: BookingConfirmationType) -> CharterPaymentPolicy {
        switch confirmation {
        case .payInFull: return .payInFull
        case .depositToConfirm, .approveAndDeposit: return .deposit
        default: return .requestApprove
        }
    }
}

/// Charter calendar capacity: one dock vs overlapping hulls. Not team assignment.
enum CharterBookBy: String, CaseIterable, Identifiable, Hashable {
    case location = "location"
    case boat = "boat"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .location: return "One location"
        case .boat: return "By boat"
        }
    }

    static func resolved(_ raw: String?) -> CharterBookBy {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s == "boat" || s == "boats" || s == "fleet" { return .boat }
        return .location
    }
}

enum CharterBufferMinutes: Int, CaseIterable, Identifiable, Hashable {
    case none = 0
    case fifteen = 15
    case thirty = 30
    case sixty = 60

    var id: Int { rawValue }

    var displayName: String {
        switch self {
        case .none: return "None"
        case .fifteen: return "15 min"
        case .thirty: return "30 min"
        case .sixty: return "1 hour"
        }
    }

    static func resolved(_ raw: Any?) -> CharterBufferMinutes {
        if let n = raw as? Int, let v = CharterBufferMinutes(rawValue: n) { return v }
        if let n = raw as? Double, let v = CharterBufferMinutes(rawValue: Int(n)) { return v }
        return .thirty
    }
}

enum CharterLastBooking: Int, CaseIterable, Identifiable, Hashable {
    case endOfHours = -1
    case hour10 = 600
    case hour11 = 660
    case hour12 = 720
    case hour13 = 780
    case hour14 = 840
    case hour15 = 900
    case hour16 = 960
    case hour17 = 1020
    case hour18 = 1080
    case hour19 = 1140
    case hour20 = 1200

    var id: Int { rawValue }

    var displayName: String {
        if self == .endOfHours { return "End of hours" }
        let h = rawValue / 60
        let m = rawValue % 60
        let cal = Calendar(identifier: .gregorian)
        let d = cal.date(from: DateComponents(calendar: cal, year: 2000, month: 1, day: 1, hour: h, minute: m)) ?? Date()
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "h:mm a"
        return f.string(from: d)
    }

    static func resolved(_ raw: Any?) -> CharterLastBooking {
        guard let n = (raw as? Int) ?? (raw as? Double).map({ Int($0) }), n >= 0 else {
            return .endOfHours
        }
        return CharterLastBooking(rawValue: n) ?? .endOfHours
    }
}
