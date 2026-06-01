//
//  TapToPayLocationStore.swift
//  Resolved Stripe Terminal location id (tenant Firestore, with Secrets.plist fallback).
//

import Combine
import Foundation

@MainActor
final class TapToPayLocationStore: ObservableObject {
    static let shared = TapToPayLocationStore()

    @Published private(set) var tenantLocationId: String = ""

    private init() {}

    func updateTenantLocationId(_ id: String) {
        tenantLocationId = id.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Tenant location from Firestore, else optional dev override in Secrets.plist.
    var resolvedLocationId: String {
        let fromTenant = tenantLocationId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !fromTenant.isEmpty { return fromTenant }
        return SecretsManager.shared.tapToPayLocationId.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
