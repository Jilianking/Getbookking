//
//  PushNotificationManager.swift
//
//  Push (APNs + FCM) is disabled until Apple Developer Program enrollment + portal setup.
//  Re-add FirebaseMessaging, entitlements `aps-environment`, and UIBackgroundModes remote-notification
//  when ready — see docs/PUSH_NOTIFICATIONS.md
//

import UIKit

@MainActor
final class PushNotificationManager {
    static let shared = PushNotificationManager()

    private init() {}

    func configure(application: UIApplication) {
        // no-op: remote notifications not registered
    }

    /// No-op while push is disabled.
    func clearTokenForSignOut(providerUid: String? = nil) async {}
}
