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

struct Message: Codable, Identifiable {
    var id: String?
    var clientId: String
    var clientName: String
    var content: String
    var sender: MessageSender
    var createdAt: Date
    var read: Bool
    var threadId: String
    
    enum MessageSender: String, Codable {
        case client = "client"
        case admin = "admin"
    }

    /// Stable id for SwiftUI when backend id is nil
    var stableId: String {
        id ?? "\(clientId)-\(createdAt.timeIntervalSince1970)"
    }
}

