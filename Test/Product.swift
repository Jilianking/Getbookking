//
//  Product.swift
//
//  Model for products in tenants/{tenantId}/products.
//

import Foundation

struct Product: Identifiable {
    var id: String
    var name: String
    var category: String
    /// Optional detail line (stored in Firestore for future web use).
    var description: String
    var price: Double
    var salePrice: Double?
    var imageUrl: String
    var isActive: Bool
}
