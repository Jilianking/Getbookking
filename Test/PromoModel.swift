import Foundation

struct Promo: Codable, Identifiable {
    var id: String?
    var code: String
    var description: String?
    var discountType: DiscountType
    var discountValue: Double
    var isActive: Bool
    var usageCount: Int
    var maxUses: Int?
    var expiresAt: Date?
    var createdAt: Date
    var updatedAt: Date?
    
    enum DiscountType: String, Codable {
        case percentage = "percentage"
        case fixed = "fixed"
    }
}

