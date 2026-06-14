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
    @Published private(set) var memberLocationId: String = ""
    @Published private(set) var usesMemberLocation: Bool = false

    private init() {}

    func updateTenantLocationId(_ id: String) {
        tenantLocationId = id.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func updateMemberLocationId(_ id: String) {
        memberLocationId = id.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func applyConnectStatus(terminalLocationId: String?, paymentScope: String?) {
        let loc = (terminalLocationId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let scope = (paymentScope ?? "tenant").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if scope == "user" {
            usesMemberLocation = true
            memberLocationId = loc
        } else {
            usesMemberLocation = false
            tenantLocationId = loc
        }
    }

    /// Resolved location from Connect status, else optional dev override in Secrets.plist.
    var resolvedLocationId: String {
        let primary = usesMemberLocation ? memberLocationId : tenantLocationId
        let trimmed = primary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return SecretsManager.shared.tapToPayLocationId.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
