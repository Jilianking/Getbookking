//
//  TeamDesignServicesSettingsView.swift
//

import SwiftUI

struct TeamDesignServicesSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    var body: some View {
        List {
            Section(
                header: Text("Manager access"),
                footer: Text("Controls editing services and pricing on the Design tab.")
                    .font(.caption2)
            ) {
                TeamPermissionToggle(
                    viewModel: viewModel,
                    title: "Edit services & pricing",
                    keyPath: \.editServicesPricing
                )
            }

            TeamManagerPolicySaveSection(viewModel: viewModel, label: "Save")
        }
        .navigationTitle("Design & services")
        .navigationBarTitleDisplayMode(.inline)
    }
}
