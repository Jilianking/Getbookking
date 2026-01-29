import Foundation

struct Client: Codable, Identifiable {
    var id: String?
    var name: String
    var email: String
    var phone: String?
    var createdAt: Date
    var lastContact: Date?
    var totalAppointments: Int
    var notes: String?
    var preferences: ClientPreferences?
    
    struct ClientPreferences: Codable {
        var preferredTime: String?
        var tattooStyle: String?
        var allergies: [String]?
    }
}

