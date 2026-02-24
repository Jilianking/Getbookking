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
    var durationMinutes: Int
    var isActive: Bool
    var bookingModeOverride: String?
    var formSchema: [[String: Any]]?
}
