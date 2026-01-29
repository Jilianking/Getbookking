import Foundation

struct Request: Codable, Identifiable {
    var id: String?
    var clientId: String?
    var customerName: String
    var customerEmail: String
    var customerPhone: String?
    var service: ServiceType
    var preferredTime: String
    var description: String?
    var promoCode: String?
    var status: RequestStatus
    var submittedAt: Date
    var reviewedAt: Date?
    var reviewedBy: String?
    var notes: String?
    var referenceImages: [String]?
    var smsConsent: Bool?
    var appointmentDate: Date?
    var appointmentTime: Date?
    var duration: Double?
    var price: Double?
    var depositAmount: Double?
    var depositLink: String?
    var depositPaid: Bool?
    var completedAt: Date?
    var cancelledAt: Date?
    var cashTips: Double?
    var takeHomeTips: Double?
    
    enum ServiceType: String, Codable {
        case custom = "custom"
        case flash = "flash"
        case touchup = "touchup"
        case coverup = "coverup"
    }
    
    enum RequestStatus: String, Codable {
        case pending = "pending"
        case discussed = "discussed"
        case depositPending = "deposit_pending"
        case confirmed = "confirmed"
        case completed = "completed"
        case cancelled = "cancelled"
        case declined = "declined"
    }
}

