import Foundation

struct Event: Codable, Identifiable {
    var id: String?
    var title: String
    var start: Date
    var end: Date?
    var type: EventType
    var status: EventStatus
    var clientId: String
    var clientName: String
    var notes: String?
    var color: String?
    var documents: [String]?
    
    enum EventType: String, Codable {
        case appointment = "appointment"
        case consultation = "consultation"
        case touchup = "touchup"
        case flash = "flash"
    }
    
    enum EventStatus: String, Codable {
        case confirmed = "confirmed"
        case pending = "pending"
        case cancelled = "cancelled"
    }
}

