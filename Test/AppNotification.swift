import Foundation

struct AppNotification: Codable, Identifiable {
    var id: String?
    var type: NotificationType
    var title: String
    var message: String
    var read: Bool
    var createdAt: Date
    var sourceId: String?
    var priority: NotificationPriority
    
    enum NotificationType: String, Codable {
        case request = "request"
        case message = "message"
        case payment = "payment"
        case system = "system"
    }
    
    enum NotificationPriority: String, Codable {
        case low = "low"
        case medium = "medium"
        case high = "high"
    }
}

