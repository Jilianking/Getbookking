//
//  PushNotificationManager.swift
//  APNs + FCM device tokens → Firestore users/{uid}/deviceTokens/{sha256}
//

import CryptoKit
import FirebaseAuth
import FirebaseFirestore
import FirebaseMessaging
import UIKit
import UserNotifications

@MainActor
final class PushNotificationManager: NSObject {
    static let shared = PushNotificationManager()

    private let db = Firestore.firestore()
    private var pendingFCMToken: String?

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

    private func requestAuthorizationAndRegister(application: UIApplication) async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .badge, .sound]
            )
            guard granted else { return }
            application.registerForRemoteNotifications()
        } catch {
            #if DEBUG
            print("Push authorization failed:", error.localizedDescription)
            #endif
        }
    }

    func setAPNSToken(_ deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func syncTokenAfterSignIn() {
        guard let token = pendingFCMToken else { return }
        Task { await persistFCMToken(token) }
    }

    func clearTokenForSignOut(providerUid: String? = nil) async {
        pendingFCMToken = nil
        if let token = Messaging.messaging().fcmToken {
            let docId = Self.documentId(for: token)
            if let uid = providerUid ?? Auth.auth().currentUser?.uid {
                try? await db.collection("users").document(uid)
                    .collection("deviceTokens").document(docId).delete()
            }
        }
        try? await Messaging.messaging().deleteToken()
    }

    private func persistFCMToken(_ token: String) async {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        guard let uid = Auth.auth().currentUser?.uid else {
            pendingFCMToken = trimmed
            return
        }
        pendingFCMToken = nil

        let docId = Self.documentId(for: trimmed)
        let ref = db.collection("users").document(uid).collection("deviceTokens").document(docId)
        do {
            try await ref.setData([
                "token": trimmed,
                "platform": "ios",
                "updatedAt": FieldValue.serverTimestamp(),
            ], merge: true)
        } catch {
            #if DEBUG
            print("Failed to save FCM token:", error.localizedDescription)
            #endif
        }
    }

    private static func documentId(for token: String) -> String {
        let digest = SHA256.hash(data: Data(token.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

extension PushNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }
}

extension PushNotificationManager: MessagingDelegate {
    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor in
            await persistFCMToken(fcmToken)
        }
    }
}
