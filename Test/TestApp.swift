//
//  TestApp.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import SwiftUI
import UIKit
import FirebaseCore

@main
struct TestApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var authViewModel = AuthViewModel()
    @StateObject private var sessionStore = TenantSessionStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authViewModel)
                .environmentObject(sessionStore)
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        AppNavigationAppearance.configure()
        FirebaseApp.configure()
        PushNotificationManager.shared.configure(application: application)
        #if TAP_TO_PAY_ENABLED
        TapToPayAppLifecycle.configureTerminalAtLaunch()
        #endif
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotificationManager.shared.setAPNSToken(deviceToken)
    }
}
