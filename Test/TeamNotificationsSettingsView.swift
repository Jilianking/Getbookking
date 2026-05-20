//
//  TeamNotificationsSettingsView.swift
//

import SwiftUI

struct TeamNotificationsSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    var body: some View {
        List {
            Section(
                header: Text("Manager notifications"),
                footer: Text("Booking alerts are under Booking settings.")
                    .font(.caption2)
            ) {
                TeamPermissionToggle(
                    viewModel: viewModel,
                    title: "Send client notifications",
                    keyPath: \.sendClientNotifications
                )
                TeamNotificationToggle(
                    viewModel: viewModel,
                    title: "Daily summary email",
                    keyPath: \.dailySummaryEmail
                )
            }

            TeamManagerPolicySaveSection(viewModel: viewModel, label: "Save")
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
    }
}
