//
//  BusinessSettingsDetailView.swift
//
//  Solo plan: booking, design, and notifications without team-management sections.
//

import SwiftUI

struct BusinessSettingsDetailView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    var isDemoMode: Bool

    var body: some View {
        TeamSettingsHubView(
            settingsViewModel: settingsViewModel,
            teamPolicyViewModel: teamPolicyViewModel,
            isDemoMode: isDemoMode,
            includeTeamManagementSections: false
        )
        .environmentObject(authViewModel)
    }
}
