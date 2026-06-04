//
//  TeamSettingsHubView.swift
//
//  Owner: team-wide configuration menu (drill-downs per topic).
//

import SwiftUI

struct TeamSettingsHubView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel
    var isDemoMode: Bool
    /// When false (Solo), hide manager-only sections and team-oriented copy.
    var includeTeamManagementSections: Bool = true

    var body: some View {
        List {
            if includeTeamManagementSections {
                Section {
                    Text("Studio-wide rules for managers and booking. Per-person job title, overrides, and payment split are on the Team screen.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    Text("Booking, your website services, and client texting for your business.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if teamPolicyViewModel.isLoading && teamPolicyViewModel.members.isEmpty {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }

            Section {
                NavigationLink {
                    TeamBookingSettingsView(
                        settingsViewModel: settingsViewModel,
                        teamPolicyViewModel: teamPolicyViewModel
                    )
                    .environmentObject(authViewModel)
                } label: {
                    settingsRow(
                        title: "Booking settings",
                        subtitle: "Client flow, manager access, booking alerts"
                    )
                }

                NavigationLink {
                    TeamDesignServicesSettingsView(viewModel: teamPolicyViewModel)
                        .environmentObject(authViewModel)
                } label: {
                    settingsRow(
                        title: "Design & services",
                        subtitle: "Services and pricing on Design"
                    )
                }

                if includeTeamManagementSections {
                    NavigationLink {
                        TeamClientsReportsSettingsView(viewModel: teamPolicyViewModel)
                            .environmentObject(authViewModel)
                    } label: {
                        settingsRow(
                            title: "Clients & reports",
                            subtitle: "Client list and earnings for managers"
                        )
                    }
                }

                NavigationLink {
                    TeamClientMessagingSettingsView(viewModel: teamPolicyViewModel)
                        .environmentObject(authViewModel)
                } label: {
                    settingsRow(
                        title: "Messaging",
                        subtitle: "Texting number, monthly limit, confirm/decline presets"
                    )
                }

                NavigationLink {
                    TeamNotificationsSettingsView(viewModel: teamPolicyViewModel)
                        .environmentObject(authViewModel)
                } label: {
                    settingsRow(
                        title: "Notifications",
                        subtitle: "Client SMS toggles and summary email"
                    )
                }
            }

            if let err = teamPolicyViewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle(includeTeamManagementSections ? "Team settings" : "Business settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await teamPolicyViewModel.load(isDemoMode: isDemoMode)
        }
        .refreshable {
            await teamPolicyViewModel.load(isDemoMode: isDemoMode)
        }
    }

    private func settingsRow(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.medium))
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
