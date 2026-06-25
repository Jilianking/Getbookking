//
//  DemoPersona.swift
//
//  Marketing app demo personas (read-only sandbox on login).
//

import Foundation

enum DemoPersona: String, CaseIterable, Identifiable {
    case salon
    case gym

    var id: String { rawValue }

    var slug: String {
        switch self {
        case .salon: return "gilded-palm"
        case .gym: return "iron-district-gym"
        }
    }

    var businessName: String {
        switch self {
        case .salon: return "Maison Lumière"
        case .gym: return "Iron District Gym"
        }
    }

    var ownerFirstName: String {
        switch self {
        case .salon: return "Lina"
        case .gym: return "Jordan"
        }
    }

    var ownerLastName: String {
        switch self {
        case .salon: return "Vasquez"
        case .gym: return "Reyes"
        }
    }

    var ownerDisplayName: String { "\(ownerFirstName) \(ownerLastName)" }

    var ownerEmail: String {
        switch self {
        case .salon: return "demo-gilded-palm@getbookking.com"
        case .gym: return "demo-iron-district@getbookking.com"
        }
    }

    var industryLabel: String {
        switch self {
        case .salon: return "Hair Salon"
        case .gym: return "Personal trainer"
        }
    }

    var subtitle: String {
        switch self {
        case .salon: return "Luxe salon · shop & booking"
        case .gym: return "Blade · training & coaching"
        }
    }

    var iconSystemName: String {
        switch self {
        case .salon: return "sparkles"
        case .gym: return "figure.strengthtraining.traditional"
        }
    }
}

struct DemoPaymentsSnapshot {
    var availableBalanceCents: Int
    var pendingBalanceCents: Int
    var transactions: [[String: Any]]
}

enum DemoSnapshotParser {
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatterNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseDate(_ value: Any?) -> Date? {
        if let d = value as? Date { return d }
        if let n = value as? NSNumber {
            let seconds = n.doubleValue
            if seconds > 1_000_000_000_000 {
                return Date(timeIntervalSince1970: seconds / 1000)
            }
            if seconds > 0 { return Date(timeIntervalSince1970: seconds) }
        }
        guard let s = value as? String, !s.isEmpty else { return nil }
        return isoFormatter.date(from: s) ?? isoFormatterNoFrac.date(from: s)
    }

    static func bookingRequest(from dict: [String: Any], tenantId: String) -> BookingRequest? {
        let docId = (dict["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let docId, !docId.isEmpty else { return nil }
        return BookingRequest(
            documentId: docId,
            status: dict["status"] as? String ?? "NEW",
            source: dict["source"] as? String,
            serviceId: dict["serviceId"] as? String,
            serviceSlug: dict["serviceSlug"] as? String,
            serviceName: dict["serviceName"] as? String,
            tenantId: dict["tenantId"] as? String ?? tenantId,
            customerId: dict["customerId"] as? String,
            customerName: dict["customerName"] as? String,
            customerPhone: dict["customerPhone"] as? String,
            customerEmail: dict["customerEmail"] as? String,
            bookingModeUsed: dict["bookingModeUsed"] as? String,
            preferredDays: dict["preferredDays"] as? [String],
            preferredTime: dict["preferredTime"] as? String,
            requestedStartTime: parseDate(dict["requestedStartTime"]),
            notes: dict["notes"] as? String,
            formResponses: dict["formResponses"] as? [String: Any],
            createdAt: parseDate(dict["createdAt"]),
            readAt: parseDate(dict["readAt"]),
            assignedMemberUid: dict["assignedMemberUid"] as? String,
            assignedMemberName: dict["assignedMemberName"] as? String,
            assignedMemberEmail: dict["assignedMemberEmail"] as? String,
            smsConsentAccepted: dict["smsConsentAccepted"] as? Bool,
            smsConsentAt: parseDate(dict["smsConsentAt"])
        )
    }

    static func client(from dict: [String: Any]) -> Client? {
        let docId = (dict["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (dict["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let docId, !docId.isEmpty, !name.isEmpty else { return nil }
        let email = (dict["email"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return Client(
            id: docId,
            name: name,
            email: email,
            phone: dict["phone"] as? String,
            createdAt: parseDate(dict["createdAt"]) ?? Date(),
            lastContact: parseDate(dict["lastContact"]) ?? parseDate(dict["updatedAt"]),
            totalAppointments: dict["totalAppointments"] as? Int ?? 0,
            notes: dict["notes"] as? String,
            vip: dict["vip"] as? Bool ?? false,
            smsOptedIn: dict["smsOptedIn"] as? Bool,
            smsConsentAt: parseDate(dict["smsConsentAt"]),
            smsConsentSource: dict["smsConsentSource"] as? String
        )
    }

    static func smsThread(from dict: [String: Any]) -> SmsThreadSummary? {
        let threadId = ((dict["threadId"] as? String) ?? (dict["id"] as? String) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !threadId.isEmpty else { return nil }
        let storedName = (dict["clientName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let counterpart = (dict["counterpartPhone"] as? String) ?? threadId
        let clientName = storedName.isEmpty
            ? PhoneFormatting.displayUS(counterpart)
            : storedName
        let assignedRaw = (dict["assignedMemberUid"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return SmsThreadSummary(
            threadId: threadId,
            clientName: clientName,
            lastMessageBody: (dict["lastMessageBody"] as? String) ?? "",
            lastMessageAt: parseDate(dict["lastMessageAt"]),
            assignedMemberUid: assignedRaw?.isEmpty == false ? assignedRaw : nil
        )
    }

    static func smsMessage(from dict: [String: Any]) -> Message? {
        let body = (dict["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return nil }
        let direction = (dict["direction"] as? String ?? "").lowercased()
        let from = dict["from"] as? String ?? ""
        let to = dict["to"] as? String ?? ""
        let counterpartyPhone = direction == "outbound" ? to : from
        let threadId = PhoneFormatting.smsThreadId(
            (dict["threadId"] as? String) ?? counterpartyPhone
        )
        let displayName = (dict["clientName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let docId = dict["id"] as? String
        return Message(
            id: docId,
            clientId: counterpartyPhone,
            clientName: displayName.isEmpty
                ? PhoneFormatting.displayUS(counterpartyPhone)
                : displayName,
            content: body,
            sender: direction == "outbound" ? .admin : .client,
            createdAt: parseDate(dict["createdAt"]) ?? Date(),
            read: true,
            threadId: threadId
        )
    }

    static func payments(from dict: [String: Any]?) -> DemoPaymentsSnapshot? {
        guard let dict else { return nil }
        let txs = dict["transactions"] as? [[String: Any]] ?? []
        return DemoPaymentsSnapshot(
            availableBalanceCents: (dict["availableBalanceCents"] as? NSNumber)?.intValue ?? 0,
            pendingBalanceCents: (dict["pendingBalanceCents"] as? NSNumber)?.intValue ?? 0,
            transactions: txs
        )
    }

    static func providerProfile(
        persona: DemoPersona,
        tenantId: String,
        tenant: [String: Any],
        owner: [String: Any]
    ) -> ProviderProfile {
        let first = (owner["firstName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? persona.ownerFirstName
        let last = (owner["lastName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? persona.ownerLastName
        let name = (owner["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? persona.ownerDisplayName
        let business = (tenant["businessName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? (tenant["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? persona.businessName
        let industry = (tenant["industry"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? "hair"
        let plan = (tenant["subscriptionPlan"] as? String) ?? "solo"
        return ProviderProfile(
            tenantId: tenantId,
            tenantSlug: persona.slug,
            name: name,
            firstName: first,
            lastName: last,
            profilePhotoUrl: "",
            business: business,
            industry: industry,
            email: (owner["email"] as? String) ?? persona.ownerEmail,
            subscriptionPlan: plan,
            subscriptionStatus: (tenant["subscriptionStatus"] as? String) ?? "active",
            availability: .default,
            workflow: .default,
            createdAt: nil
        )
    }
}

enum DemoSessionError: LocalizedError {
    case loadFailed(String)

    var errorDescription: String? {
        switch self {
        case .loadFailed(let msg): return msg
        }
    }
}
