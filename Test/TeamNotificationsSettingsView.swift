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
                footer: Text("Booking alerts are under Booking settings. Client texting and message presets are under Messaging.")
                    .font(.caption2)
            ) {
                if viewModel.smsCanUse {
                    TeamPermissionToggle(
                        viewModel: viewModel,
                        title: "Send client text notifications",
                        keyPath: \.sendClientNotifications
                    )
                } else {
                    HStack {
                        Text("Send client text notifications")
                        Spacer()
                        Text("Requires client texting")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                TeamNotificationToggle(
                    viewModel: viewModel,
                    title: "Daily summary email",
                    keyPath: \.dailySummaryEmail
                )
            }

            TeamManagerPolicySaveSection(viewModel: viewModel, label: "Save")
        }
        .appListSurface()
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
    }
}
