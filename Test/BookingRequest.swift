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
    /// Charter occupancy (website + app). ISO `YYYY-MM-DD` in the tenant timezone.
    var scheduledDate: String? = nil
    var scheduledStartMin: Int? = nil
    var boatId: String? = nil
    var durationMinutes: Int? = nil
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
    /// Cents collected on this booking (deposit or pay-in-full).
    var paidCents: Int? = nil
    var stripePaymentIntentId: String? = nil
    /// `pending` | `refunded` | `failed` | `already_refunded` after a paid cancel.
    var cancelRefundStatus: String? = nil

    var isRefundPending: Bool {
        (cancelRefundStatus ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "pending"
    }

    var statusPillText: String {
        if BookingRequestStatus.normalized(status) == BookingRequestStatus.cancelled, isRefundPending {
            return "refund_pending"
        }
        return status
    }

    var refundablePaidCents: Int {
        let n = paidCents ?? 0
        return n > 0 ? n : 0
    }

    var cancelConfirmMessage: String {
        let paid = refundablePaidCents
        if paid > 0 {
            let dollars = String(format: "%.2f", Double(paid) / 100)
            return "This trip will be cancelled and the guest will be texted. $\(dollars) will be refunded. Refunds typically take 5–10 business days."
        }
        return "This trip will be cancelled and the guest will be texted. The time will open for new bookings."
    }

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

    static func intField(_ raw: Any?) -> Int? {
        if let n = raw as? Int { return n }
        if let n = raw as? Double { return Int(n) }
        if let n = raw as? NSNumber { return n.intValue }
        if let s = raw as? String { return Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    static func isoDateString(from date: Date, timeZone: TimeZone = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let p = cal.dateComponents([.year, .month, .day], from: date)
        let y = p.year ?? 0
        let m = p.month ?? 0
        let d = p.day ?? 0
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    static func minutesSinceMidnight(from date: Date, timeZone: TimeZone = .current) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal.component(.hour, from: date) * 60 + cal.component(.minute, from: date)
    }

    static func date(fromScheduledDate iso: String?, startMin: Int?, timeZone: TimeZone = .current) -> Date? {
        let raw = (iso ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let startMin, raw.count >= 10 else { return nil }
        let parts = raw.split(separator: "-")
        guard parts.count == 3,
              let y = Int(parts[0]), let mo = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        var comps = DateComponents()
        comps.calendar = Calendar(identifier: .gregorian)
        comps.timeZone = timeZone
        comps.year = y
        comps.month = mo
        comps.day = d
        comps.hour = startMin / 60
        comps.minute = startMin % 60
        comps.second = 0
        return comps.date
    }

    /// Departure instant: use the server-computed tenant-timezone instant when available.
    var departureStart: Date? {
        if let requestedStartTime { return requestedStartTime }
        return Self.date(fromScheduledDate: scheduledDate, startMin: scheduledStartMin)
    }

    var occupiesCharterSlot: Bool {
        let date = (scheduledDate ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return date.count >= 10 && scheduledStartMin != nil
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
