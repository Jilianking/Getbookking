//
//  TeamNotificationsSettingsView.swift
//

import SwiftUI

struct TeamNotificationsSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var isSoloBusinessSettings: Bool = false

    var body: some View {
        List {
            Section(
                header: Text(isSoloBusinessSettings ? "Notifications" : "Manager notifications"),
                footer: Text(notificationsFooter)
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

    private var notificationsFooter: String {
        if isSoloBusinessSettings {
            return "Client texting and message presets are under Business settings → Messaging."
        }
        return "Booking alerts are under Booking settings. Client texting and message presets are under Messaging."
    }
}
