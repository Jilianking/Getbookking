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

    private var isSoloBusinessSettings: Bool { !includeTeamManagementSections }

    private var isCharterPlan: Bool {
        settingsViewModel.tenantSubscriptionPlan.isCharterPlan
            || authViewModel.tenantSubscriptionPlan.isCharterPlan
    }

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
                    Text(isCharterPlan
                         ? "Booking, boats, and client texting for your charters."
                         : "Booking and client texting for your business.")
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
                        teamPolicyViewModel: teamPolicyViewModel,
                        isSoloBusinessSettings: isSoloBusinessSettings
                    )
                    .environmentObject(authViewModel)
                } label: {
                    settingsRow(
                        title: "Booking settings",
                        subtitle: bookingSettingsSubtitle
                    )
                }

                if isCharterPlan {
                    NavigationLink {
                        CharterBoatsSettingsView(viewModel: settingsViewModel)
                    } label: {
                        settingsRow(
                            title: "Boats",
                            subtitle: settingsViewModel.charterBoats.isEmpty
                                ? "Add a boat so guests can book"
                                : "\(settingsViewModel.charterBoats.count) boat\(settingsViewModel.charterBoats.count == 1 ? "" : "s")"
                        )
                    }
                }

                NavigationLink {
                    BusinessServicesSettingsView(viewModel: settingsViewModel)
                } label: {
                    settingsRow(
                        title: isCharterPlan ? "Trips" : "Services",
                        subtitle: isCharterPlan
                            ? "Name, duration, itinerary, and pricing"
                            : "Name, duration, and pricing for booking"
                    )
                }

                NavigationLink {
                    BusinessShopShippingSettingsView()
                } label: {
                    settingsRow(
                        title: "Shipping & pickup",
                        subtitle: "Pickup address visibility + pickup/shipping options"
                    )
                }

                if includeTeamManagementSections {
                    NavigationLink {
                        TeamDesignServicesSettingsView(
                            viewModel: teamPolicyViewModel,
                            isSoloBusinessSettings: isSoloBusinessSettings
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        settingsRow(
                            title: "Design & services",
                            subtitle: "Manager access to services and pricing"
                        )
                    }

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

                if !isCharterPlan {
                    NavigationLink {
                        TeamNotificationsSettingsView(
                            viewModel: teamPolicyViewModel,
                            isSoloBusinessSettings: isSoloBusinessSettings
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        settingsRow(
                            title: "Notifications",
                            subtitle: isSoloBusinessSettings
                                ? "Client texts and summary email"
                                : "Client SMS toggles and summary email"
                        )
                    }
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

    private var bookingSettingsSubtitle: String {
        if isCharterPlan {
            return "Request, deposit, or pay in full"
        }
        if isSoloBusinessSettings {
            return "Booking type, deposits, and client flow"
        }
        return "Client flow, owner access, booking alerts"
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
