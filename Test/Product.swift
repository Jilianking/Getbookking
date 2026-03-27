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
    var price: Double
    var salePrice: Double?
    var imageUrl: String
    var isActive: Bool
}
