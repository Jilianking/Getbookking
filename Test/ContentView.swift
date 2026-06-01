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
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, authViewModel.isAuthenticated, !authViewModel.isDemoMode {
                Task { await authViewModel.refreshTenantLogoFromServer() }
                TapToPayAppLifecycle.warmUpReaderIfConfigured()
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AuthViewModel())
}
