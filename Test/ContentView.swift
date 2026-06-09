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
    @AppStorage(AppAppearanceStorage.key) private var appearanceRaw = AppAppearance.system.rawValue

    private var appAppearance: AppAppearance {
        AppAppearance(rawValue: appearanceRaw) ?? .system
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
                Task { await authViewModel.refreshTenantLogoFromServer() }
                TapToPayAppLifecycle.warmUpReaderIfConfigured()
                StripeConnectRefresh.request()
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AuthViewModel())
}
