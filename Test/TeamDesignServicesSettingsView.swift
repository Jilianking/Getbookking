//
//  TeamDesignServicesSettingsView.swift
//

import SwiftUI

struct TeamDesignServicesSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var isSoloBusinessSettings: Bool = false

    var body: some View {
        List {
            if isSoloBusinessSettings {
                Section {
                    Text("Edit your services, pricing, and website layout on the Design tab.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } footer: {
                    Text("Solo accounts manage services directly — no team permissions needed.")
                        .font(.caption2)
                }
            } else {
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
        }
        .appListSurface()
        .navigationTitle("Design & services")
        .navigationBarTitleDisplayMode(.inline)
    }
}
