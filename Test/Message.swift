import Foundation

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

