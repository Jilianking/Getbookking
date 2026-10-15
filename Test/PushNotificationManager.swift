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
    /// Conversation from a tapped notification, kept until the main screen has appeared. On a cold
    /// launch the tap arrives before anything is listening, so the posted event alone was lost.
    private var pendingOpenThreadId: String?

    /// Hands over (once) the conversation a tapped notification asked to open.
    func takePendingOpenThreadId() -> String? {
        defer { pendingOpenThreadId = nil }
        return pendingOpenThreadId
    }

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

// Completion-handler versions, not the async ones: iOS must be told "done" on the main thread.
// The async didReceive finished on a background thread, which UIKit aborts on when the app is
// launched by tapping a notification (crash in builds 11, 16 and 18).
extension PushNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let finish = UncheckedSendableBox(completionHandler)
        DispatchQueue.main.async {
            finish.value([.banner, .sound, .badge])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let type = Self.stringValue(userInfo["type"])?.lowercased() ?? ""
        let threadId = type == "sms_message" ? Self.stringValue(userInfo["threadId"]) : nil
        let finish = UncheckedSendableBox(completionHandler)
        DispatchQueue.main.async {
            if let threadId, !threadId.isEmpty {
                MainActor.assumeIsolated {
                    PushNotificationManager.shared.pendingOpenThreadId = threadId
                }
                NotificationCenter.default.post(
                    name: .pushOpenMessagesThread,
                    object: nil,
                    userInfo: ["threadId": threadId]
                )
            }
            finish.value()
        }
    }

    private nonisolated static func stringValue(_ raw: Any?) -> String? {
        if let s = raw as? String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        if let n = raw as? NSNumber {
            return n.stringValue
        }
        return nil
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

extension Notification.Name {
    static let pushOpenMessagesThread = Notification.Name("pushOpenMessagesThread")
}

/// Carries a UIKit completion handler onto the main queue; it is only ever called there.
nonisolated private struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
