//
//  MetaTracking.swift
//  Meta (Facebook) SDK for Get Bookking's own app-install ads: installs, app opens,
//  sign-ups, and App Store purchases (logged automatically by the SDK).
//  Apple's "Allow tracking" prompt is shown once, to signed-in owners, never at first launch.
//  If they decline, the SDK sends no advertising ID and Meta measures with AEM / SKAdNetwork.
//

import UIKit
import AppTrackingTransparency
import FacebookCore

enum MetaTracking {
    /// False until the Client Token from Meta (App settings → Advanced) is in Info.plist.
    static var isConfigured: Bool {
        guard let token = Bundle.main.object(forInfoDictionaryKey: "FacebookClientToken") as? String else { return false }
        return !token.isEmpty && token != "PASTE_CLIENT_TOKEN_HERE"
    }

    /// Call from AppDelegate didFinishLaunching.
    static func configure(_ application: UIApplication, launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        guard isConfigured else {
            #if DEBUG
            print("MetaTracking: add FacebookClientToken to Support/AppFontInfo.plist to turn on the Meta SDK.")
            #endif
            return
        }
        ApplicationDelegate.shared.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    /// Shows Apple's tracking prompt once, a moment after the signed-in app appears.
    @MainActor
    static func requestTrackingIfNeeded(isDemoMode: Bool) async {
        guard isConfigured, !isDemoMode else { return }
        guard ATTrackingManager.trackingAuthorizationStatus == .notDetermined else { return }
        // Let the dashboard settle first; Apple only shows the prompt while the app is active.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard UIApplication.shared.applicationState == .active else { return }
        _ = await ATTrackingManager.requestTrackingAuthorization()
    }

    /// A new business finished sign-up in the app.
    static func logCompleteRegistration(plan: String) {
        guard isConfigured else { return }
        AppEvents.shared.logEvent(.completedRegistration, parameters: [
            .registrationMethod: "app",
            .content: plan,
        ])
    }
}
