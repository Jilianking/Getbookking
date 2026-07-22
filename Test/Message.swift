import Foundation
import FirebaseFirestore

struct SmsThreadSummary: Identifiable, Equatable {
    var id: String { threadId }
    let threadId: String
    let clientName: String
    let lastMessageBody: String
    let lastMessageAt: Date?
    let assignedMemberUid: String?

    static func fromFirestore(document: QueryDocumentSnapshot) -> SmsThreadSummary? {
        let data = document.data()
        let threadId = ((data["threadId"] as? String) ?? document.documentID)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !threadId.isEmpty else { return nil }
        let storedName = (data["clientName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let counterpart = (data["counterpartPhone"] as? String) ?? threadId
        let clientName = storedName.isEmpty
            ? PhoneFormatting.displayUS(counterpart)
            : storedName
        let lastMessageBody = (data["lastMessageBody"] as? String) ?? ""
        let lastMessageAt = (data["lastMessageAt"] as? Timestamp)?.dateValue()
        let assignedMemberUid = (data["assignedMemberUid"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return SmsThreadSummary(
            threadId: threadId,
            clientName: clientName,
            lastMessageBody: lastMessageBody,
            lastMessageAt: lastMessageAt,
            assignedMemberUid: assignedMemberUid?.isEmpty == false ? assignedMemberUid : nil
        )
    }
}

enum MessagePaymentKind: String, Codable, Equatable {
    case deposit
    case payment

    var title: String {
        switch self {
        case .deposit: return "Deposit"
        case .payment: return "Payment"
        }
    }

    var requestVerb: String {
        switch self {
        case .deposit: return "Deposit request"
        case .payment: return "Payment request"
        }
    }
}

struct Message: Codable, Identifiable {
    var id: String?
    var clientId: String
    var clientName: String
    var content: String
    var sender: MessageSender
    var createdAt: Date
    var read: Bool
    var threadId: String
    /// When set, Messages UI shows an Apple Pay–style amount card.
    var paymentKind: MessagePaymentKind? = nil
    var amountCents: Int? = nil
    var paymentUrl: String? = nil

    enum MessageSender: String, Codable {
        case client = "client"
        case admin = "admin"
    }

    /// Stable id for SwiftUI when backend id is nil
    var stableId: String {
        id ?? "\(clientId)-\(createdAt.timeIntervalSince1970)"
    }

    var isPaymentRequest: Bool {
        guard let kind = paymentKind,
              let cents = amountCents, cents > 0,
              let url = paymentUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !url.isEmpty else { return false }
        return kind == .deposit || kind == .payment
    }

    var formattedPaymentAmount: String? {
        guard let cents = amountCents, cents > 0 else { return nil }
        return String(format: "$%.2f", Double(cents) / 100.0)
    }

    /// SMS body the client receives (and fallback plain-text content).
    static func paymentRequestSMSBody(
        kind: MessagePaymentKind,
        amountCents: Int,
        url: String
    ) -> String {
        let amount = String(format: "$%.2f", Double(amountCents) / 100.0)
        return "\(kind.requestVerb): \(amount)\nPay here: \(url)"
    }

    static func paymentRequestPreview(
        kind: MessagePaymentKind,
        amountCents: Int
    ) -> String {
        let amount = String(format: "$%.2f", Double(amountCents) / 100.0)
        return "\(kind.title) · \(amount)"
    }
}
