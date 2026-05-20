//
//  TeamSettingsDetailView.swift
//

import SwiftUI

struct TeamSettingsDetailView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    var isDemoMode: Bool

    var body: some View {
        TeamSettingsHubView(
            settingsViewModel: settingsViewModel,
            teamPolicyViewModel: teamPolicyViewModel,
            isDemoMode: isDemoMode
        )
        .environmentObject(authViewModel)
    }
}
