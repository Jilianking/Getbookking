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
