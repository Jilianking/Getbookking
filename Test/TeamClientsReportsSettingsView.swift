//
//  TeamClientsReportsSettingsView.swift
//

import SwiftUI

struct TeamClientsReportsSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    var body: some View {
        List {
            Section(
                header: Text("Manager access"),
                footer: Text("Applies to the Clients drawer and Insights/Payments areas.")
                    .font(.caption2)
            ) {
                TeamPermissionToggle(
                    viewModel: viewModel,
                    title: "Access client list",
                    keyPath: \.accessClientList
                )
                TeamPermissionToggle(
                    viewModel: viewModel,
                    title: "View earnings & reports",
                    keyPath: \.viewEarningsReports
                )
            }

            TeamManagerPolicySaveSection(viewModel: viewModel, label: "Save")
        }
        .navigationTitle("Clients & reports")
        .navigationBarTitleDisplayMode(.inline)
    }
}
