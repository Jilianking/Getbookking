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
        let reqUid = (assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let member = roster.first(where: { $0.uid == key }) {
            let memberUid = member.uid.trimmingCharacters(in: .whitespacesAndNewlines)
            let memberEmail = member.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let memberName = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !reqUid.isEmpty, reqUid == memberUid { return true }
            let reqEmail = (assignedMemberEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !reqEmail.isEmpty, !memberEmail.isEmpty, reqEmail == memberEmail { return true }
            let reqName = (assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !reqName.isEmpty, !memberName.isEmpty, reqName == memberName { return true }
            return false
        }
        // Uid not on roster (e.g. owner missing from teamFilterRoster) — match by uid only.
        let keyUid = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !keyUid.isEmpty, !reqUid.isEmpty else { return false }
        return reqUid == keyUid
    }
}

enum BookingAssigneeFilter {
    static let allKey = "__all__"
    static let unassignedKey = "__unassigned__"
}

extension Array where Element == BookingRequest {
    /// Shop-wide when `canViewAllBookings`; otherwise only requests assigned to `currentUserUid`.
    func scopedForTeamAccess(
        _ access: EffectiveTeamAccess,
        currentUserUid: String?,
        roster: [TenantTeamMember]
    ) -> [BookingRequest] {
        if access.canViewAllBookings { return self }
        let uid = (currentUserUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !uid.isEmpty else { return [] }
        return filter { $0.matchesAssigneeFilter(key: uid, roster: roster) }
    }
}

enum BookingRequestPaymentLookup {
    private static let terminalStatuses: Set<String> = [
        "declined", "rejected", "cancelled", "canceled", "completed", "done",
    ]

    /// Best open booking for deposit/payment routing from a client phone thread.
    static func bookingRequestId(forClientPhone phone: String, in requests: [BookingRequest]) -> String? {
        guard let threadPhone = normalizedPhone(phone) else { return nil }
        let candidates = requests
            .filter { matches(phone: threadPhone, request: $0) && !isTerminal($0.status) }
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
        if let assigned = candidates.first(where: { hasAssignedMember($0) }) {
            return assigned.documentId
        }
        return candidates.first?.documentId
    }

    private static func normalizedPhone(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return PhoneFormatting.e164US(trimmed) ?? PhoneFormatting.e164US(PhoneFormatting.smsThreadId(trimmed))
    }

    private static func phone(for request: BookingRequest) -> String? {
        if let customer = request.customerPhone, let e164 = normalizedPhone(customer) { return e164 }
        if let form = request.formResponses?["phone"] as? String, let e164 = normalizedPhone(form) { return e164 }
        return nil
    }

    private static func matches(phone threadPhone: String, request: BookingRequest) -> Bool {
        guard let requestPhone = phone(for: request) else { return false }
        return requestPhone == threadPhone
    }

    private static func isTerminal(_ status: String) -> Bool {
        terminalStatuses.contains(status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    private static func hasAssignedMember(_ request: BookingRequest) -> Bool {
        !(request.assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
