//
//  ContentView.swift
//  Test
//
//  Phase 1: Auth flow — Login when not authenticated, Admin tabs when authenticated.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearanceStorage.key) private var appearanceRaw = AppAppearance.light.rawValue
    @State private var lastForegroundRefresh: Date?

    private var appAppearance: AppAppearance {
        AppAppearance.resolved(from: appearanceRaw)
    }

    var body: some View {
        Group {
            if authViewModel.isAuthenticated {
                AdminTabView()
                    .environmentObject(authViewModel)
            } else {
                LoginView()
                    .environmentObject(authViewModel)
            }
        }
        .preferredColorScheme(appAppearance.preferredColorScheme)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, authViewModel.isAuthenticated, !authViewModel.isDemoMode {
                TapToPayAppLifecycle.warmUpReaderIfConfigured()
                StripeConnectRefresh.request()
                let now = Date()
                if lastForegroundRefresh == nil || now.timeIntervalSince(lastForegroundRefresh!) >= 120 {
                    lastForegroundRefresh = now
                    Task { await authViewModel.refreshTenantLogoFromServer() }
                }
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AuthViewModel())
        .environmentObject(TenantSessionStore())
}
