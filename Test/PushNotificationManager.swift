//
//  PushNotificationManager.swift
//  Firebase Cloud Messaging (FCM) + APNs: register device, persist token for Cloud Functions.
//

import CryptoKit
import FirebaseAuth
import FirebaseFirestore
import FirebaseMessaging
import Foundation
import UIKit
import UserNotifications

/// Handles APNs registration via FCM, stores tokens under `users/{uid}/deviceTokens/{id}` for server-side sends.
@MainActor
final class PushNotificationManager: NSObject {
    static let shared = PushNotificationManager()

    private let db = Firestore.firestore()

    private override init() {
        super.init()
    }

    func configure(application: UIApplication) {
        UNUserNotificationCenter.current().delegate = self
        Messaging.messaging().delegate = self

        Task {
            await requestAuthorizationAndRegister(application: application)
        }
    }

    /// Call after sign-in if notifications were denied earlier (optional re-prompt path).
    func requestAuthorizationAndRegister(application: UIApplication) async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            if granted {
                application.registerForRemoteNotifications()
            }
        } catch {
            print("PushNotificationManager: authorization error — \(error.localizedDescription)")
        }
    }

    func applicationDidRegisterForRemoteNotifications(deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func applicationDidFailToRegisterForRemoteNotifications(error: Error) {
        print("PushNotificationManager: APNs registration failed — \(error.localizedDescription)")
    }

    /// Remove FCM token from Firestore and invalidate locally (e.g. sign-out).
    /// Pass `providerUid` when calling **after** capturing it, so Firestore cleanup still runs if sign-out clears `Auth` first.
    func clearTokenForSignOut(providerUid: String? = nil) async {
        let uid = providerUid ?? Auth.auth().currentUser?.uid
        if let uid {
            do {
                let token = try await Messaging.messaging().token()
                let docId = Self.stableDocId(forToken: token)
                try await db.collection("users").document(uid).collection("deviceTokens").document(docId).delete()
            } catch {
                // ignore — token may already be invalid
            }
        }
        do {
            try await Messaging.messaging().deleteToken()
        } catch {
            print("PushNotificationManager: deleteToken — \(error.localizedDescription)")
        }
    }

    private func saveFCMTokenToFirestore(_ token: String) async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        let docId = Self.stableDocId(forToken: token)
        do {
            try await db.collection("users").document(uid).collection("deviceTokens").document(docId).setData([
                "token": token,
                "platform": "ios",
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)
        } catch {
            print("PushNotificationManager: failed to save token — \(error.localizedDescription)")
        }
    }

    private static func stableDocId(forToken token: String) -> String {
        let digest = SHA256.hash(data: Data(token.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - MessagingDelegate

extension PushNotificationManager: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken, !token.isEmpty else { return }
        Task { @MainActor in
            await PushNotificationManager.shared.saveFCMTokenToFirestore(token)
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completionHandler()
    }
}
