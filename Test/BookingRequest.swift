//
//  BookingRequest.swift
//
//  Model for web booking requests (tenants/{tenantId}/bookingRequests).
//

import Foundation

struct BookingRequest: Identifiable {
    var documentId: String?
    var id: String { documentId ?? UUID().uuidString }
    var status: String
    var source: String?
    var serviceId: String?
    var serviceSlug: String?
    var serviceName: String?
    var tenantId: String?
    var customerId: String?
    var customerName: String?
    var customerPhone: String?
    var customerEmail: String?
    var bookingModeUsed: String?
    var preferredDays: [String]?
    var preferredTime: String?
    var requestedStartTime: Date?
    var notes: String?
    var formResponses: [String: Any]?
    var createdAt: Date?
    /// Set when provider opens the request in the app (does not change workflow `status`).
    var readAt: Date?
    var assignedMemberUid: String?
    var assignedMemberName: String?
    var assignedMemberEmail: String?
    var smsConsentAccepted: Bool?
    var smsConsentAt: Date?

    var hasAssignedMember: Bool {
        let uid = (assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (assignedMemberEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !uid.isEmpty || !name.isEmpty || !email.isEmpty
    }

    var assignedMemberDisplayLabel: String? {
        let name = (assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        let email = (assignedMemberEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !email.isEmpty { return email }
        return nil
    }

    /// Matches team filter (`BookingAssigneeFilter` keys + member uid).
    func matchesAssigneeFilter(key: String, roster: [TenantTeamMember]) -> Bool {
        if key == BookingAssigneeFilter.allKey { return true }
        if key == BookingAssigneeFilter.unassignedKey { return !hasAssignedMember }
        guard let member = roster.first(where: { $0.uid == key }) else { return true }
        let memberUid = member.uid.trimmingCharacters(in: .whitespacesAndNewlines)
        let memberEmail = member.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let memberName = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let reqUid = (assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !reqUid.isEmpty, reqUid == memberUid { return true }
        let reqEmail = (assignedMemberEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !reqEmail.isEmpty, !memberEmail.isEmpty, reqEmail == memberEmail { return true }
        let reqName = (assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !reqName.isEmpty, !memberName.isEmpty, reqName == memberName { return true }
        return false
    }
}

enum BookingAssigneeFilter {
    static let allKey = "__all__"
    static let unassignedKey = "__unassigned__"
}
