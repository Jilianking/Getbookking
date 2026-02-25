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
    var business: String
    var email: String
    var subscriptionPlan: String
    var subscriptionStatus: String
    var availability: ProviderAvailability
    var workflow: ProviderWorkflow
    var createdAt: Date?
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
    var mode: WorkflowMode
    var responseTimeHours: Int

    static let `default` = ProviderWorkflow(
        mode: .approval,
        responseTimeHours: 24
    )
}

enum WorkflowMode: String, CaseIterable {
    case approval = "approval"
    case fixedSlots = "fixed_slots"

    var displayName: String {
        switch self {
        case .approval: return "Approval-based"
        case .fixedSlots: return "Fixed time slots"
        }
    }

    var description: String {
        switch self {
        case .approval: return "Review and approve each request"
        case .fixedSlots: return "Customers pick from available slots"
        }
    }
}
