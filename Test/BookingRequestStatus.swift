//
//  BookingRequestStatus.swift
//  Workflow status helpers for tenant booking requests.
//

import Foundation

enum BookingRequestStatus {
    static let new = "new"
    static let pending = "pending"
    static let pendingDeposit = "pending_deposit"
    static let pendingPayment = "pending_payment"
    static let pendingConsultation = "pending_consultation"
    static let confirmed = "confirmed"
    static let declined = "declined"
    static let cancelled = "cancelled"

    static func normalized(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isNew(_ status: String) -> Bool {
        normalized(status) == new
    }

    /// Client-side in-flight: awaiting deposit, consult, or legacy pending.
    static func isInFlightPending(_ status: String) -> Bool {
        switch normalized(status) {
        case pending, pendingDeposit, pendingPayment, pendingConsultation:
            return true
        default:
            return false
        }
    }

    static func canShowAccept(_ status: String) -> Bool {
        isNew(status)
    }

    static func canShowDecline(_ status: String) -> Bool {
        isNew(status) || isInFlightPending(status)
    }

    static func displayLabel(_ status: String) -> String {
        switch normalized(status) {
        case new: return "New"
        case pending: return "Pending"
        case pendingDeposit: return "Awaiting deposit"
        case pendingPayment: return "Awaiting payment"
        case pendingConsultation: return "Consult scheduled"
        case confirmed: return "Confirmed"
        case declined: return "Declined"
        case cancelled: return "Cancelled"
        default:
            let raw = status.trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.isEmpty { return "Unknown" }
            return raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    /// Status after provider accepts and locks time (confirm sheet).
    static func targetStatusAfterAccept(
        confirmationType: BookingConfirmationType,
        requiresDeposit: Bool,
        sendDepositLink: Bool
    ) -> String {
        if confirmationType == .consultationFirst {
            return pendingConsultation
        }
        if requiresDeposit, sendDepositLink {
            return pendingDeposit
        }
        return confirmed
    }

    /// Owner / managers with approve permission, or the assigned member on their own request.
    static func canManageBookingActions(
        _ teamAccess: EffectiveTeamAccess,
        assignedMemberUid: String? = nil,
        currentUserUid: String? = nil
    ) -> Bool {
        if teamAccess.canApproveRejectRequests { return true }
        let assigned = (assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let me = (currentUserUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !assigned.isEmpty, !me.isEmpty else { return false }
        return assigned == me
    }
}
