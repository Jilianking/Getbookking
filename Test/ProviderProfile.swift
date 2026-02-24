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

struct ProviderAvailability {
    var openHour: Int      // 0-23
    var closeHour: Int     // 0-23
    var daysOpen: [Int]    // 0=Sun, 1=Mon, ..., 6=Sat
    var timeZone: String

    static let `default` = ProviderAvailability(
        openHour: 9,
        closeHour: 18,
        daysOpen: [1, 2, 3, 4, 5],
        timeZone: TimeZone.current.identifier
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
