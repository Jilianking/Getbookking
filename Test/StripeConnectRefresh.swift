//
//  StripeConnectRefresh.swift
//
//  Broadcast when the app becomes active so Stripe Connect status re-syncs after Safari onboarding.
//

import Foundation

extension Notification.Name {
    static let stripeConnectShouldRefresh = Notification.Name("stripeConnectShouldRefresh")
}

enum StripeConnectRefresh {
    static func request() {
        NotificationCenter.default.post(name: .stripeConnectShouldRefresh, object: nil)
    }
}
