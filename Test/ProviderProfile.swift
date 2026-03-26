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
    var business: String
    var industry: String
    var email: String
    var subscriptionPlan: String
    var subscriptionStatus: String
    var availability: ProviderAvailability
    var workflow: ProviderWorkflow
    var createdAt: Date?
}

enum SlotType: String, CaseIterable, Codable {
    case openBooking = "open_booking"
    case appointmentsOnly = "appointments_only"
    case walkIns = "walk_ins"
    case recurring = "recurring"
    case custom = "custom"

    var displayName: String {
        switch self {
        case .openBooking: return "Open booking"
        case .appointmentsOnly: return "Appointments only"
        case .walkIns: return "Walk-ins"
        case .recurring: return "Recurring"
        case .custom: return "Custom"
        }
    }
}

struct TimeSlot: Identifiable, Codable, Equatable {
    var id: String
    var open: Int   // 0-23
    var close: Int  // 0-23
    var type: SlotType
    var customLabel: String?
    var recurringDays: [Int]?  // 0=Sun..6=Sat, used when type == .recurring

    init(id: String = UUID().uuidString, open: Int, close: Int, type: SlotType = .openBooking, customLabel: String? = nil, recurringDays: [Int]? = nil) {
        self.id = id
        self.open = open
        self.close = close
        self.type = type
        self.customLabel = customLabel
        self.recurringDays = recurringDays
    }
}

struct ProviderAvailability {
    var timeSlots: [TimeSlot]     // Multiple ranges per day (e.g. 9–12, 14–18)
    var daysOpen: [Int]          // 0=Sun, 1=Mon, ..., 6=Sat – shop hours
    var timeZone: String
    var blockedDates: [String]   // "yyyy-MM-dd" – block from shop hours (approval mode)
    var availableDates: [String] // "yyyy-MM-dd" – selected for appointments (fixed slots mode)

    static let `default` = ProviderAvailability(
        timeSlots: [TimeSlot(open: 9, close: 18)],
        daysOpen: [1, 2, 3, 4, 5],
        timeZone: TimeZone.current.identifier,
        blockedDates: [],
        availableDates: []
    )
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
