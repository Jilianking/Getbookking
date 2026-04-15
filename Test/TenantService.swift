//
//  TenantService.swift
//
//  Model for services in tenants/{tenantId}/services.
//

import Foundation

struct TenantService: Identifiable {
    var id: String
    var slug: String
    var name: String
    /// When `nil`, no duration is stored (Classic “+” panel and optional booking hints stay empty).
    var durationMinutes: Int?
    /// Shown on Blade service cards and anywhere the web reads `description`.
    var description: String?
    /// Blade / web display order (`sortOrder` in Firestore). Lower values appear first (01, 02, …).
    var sortOrder: Int
    /// If non-nil and > 0, Blade shows “From $X”; otherwise “Book for pricing”.
    var price: Double?
    var isActive: Bool
    var bookingModeOverride: String?
    var formSchema: [[String: Any]]?
}

extension TenantService {
    var bladePriceCaption: String {
        if let p = price, p > 0 {
            if p.rounded() == p {
                return "From $\(Int(p))"
            }
            return String(format: "From $%.2f", p)
        }
        return "Book for pricing"
    }
}
