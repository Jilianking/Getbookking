//
//  TeamView.swift
//
//  Drawer destination: roster, invites, per-member config; policy is in Settings → Team settings.
//

import SwiftUI
import FirebaseAuth

struct TeamView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var teamViewModel = ManagerSettingsViewModel()
    @State private var hasLoadedTeamContext = false
    var drawerState: DrawerState
    let sectionTitle: String

    private var showsOwnerTeamUI: Bool {
        authViewModel.isDemoMode
            || authViewModel.teamAccess.isOwner
            || teamViewModel.isTenantOwner
    }

    var body: some View {
        NavigationStack {
            Group {
                if !hasLoadedTeamContext && !authViewModel.isDemoMode {
                    ProgressView("Loading team…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if showsOwnerTeamUI {
                    ManagerSettingsView(
                        viewModel: teamViewModel,
                        showInlineNavigationTitle: false
                    )
                    .environmentObject(authViewModel)
                } else {
                    TeamMemberOverviewContent(viewModel: teamViewModel)
                        .environmentObject(authViewModel)
                }
            }
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                if showsOwnerTeamUI && hasLoadedTeamContext && teamViewModel.tenantSubscriptionPlan.allowsTeamInvites {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            teamViewModel.teamInviteShareURL = nil
                            teamViewModel.teamInviteError = nil
                            teamViewModel.presentInviteSheet = true
                        } label: {
                            Image(systemName: "person.badge.plus")
                        }
                        .accessibilityLabel("Invite team member")
                    }
                }
            }
        }
        .task(id: authViewModel.isAuthenticated) {
            await reloadTeamContext()
        }
        .refreshable {
            await reloadTeamContext()
        }
    }

    private func reloadTeamContext() async {
        if authViewModel.isDemoMode {
            await teamViewModel.load(isDemoMode: true)
            hasLoadedTeamContext = true
            return
        }
        async let access: () = authViewModel.refreshTeamAccess()
        async let roster: () = teamViewModel.load(isDemoMode: false)
        _ = await (access, roster)
        if teamViewModel.isTenantOwner && !authViewModel.teamAccess.isOwner {
            await authViewModel.refreshTeamAccess()
        }
        hasLoadedTeamContext = true
    }
}

// MARK: - Non-owner: my role + read-only roster

private struct TeamMemberOverviewContent: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    var body: some View {
        List {
            Section(header: Text("My role")) {
                HStack {
                    Text("Access")
                    Spacer()
                    Text(authViewModel.teamAccess.accessRole.displayName)
                        .foregroundStyle(.secondary)
                }
                if authViewModel.teamAccess.accessRole == .member {
                    Text("Job title and permissions are set by the business owner.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                TeamPermissionSummaryRow(
                    title: "View all bookings",
                    enabled: authViewModel.teamAccess.canViewAllBookings
                )
                TeamPermissionSummaryRow(
                    title: "Approve & reject requests",
                    enabled: authViewModel.teamAccess.canApproveRejectRequests
                )
                TeamPermissionSummaryRow(
                    title: "Edit services & pricing",
                    enabled: authViewModel.teamAccess.canEditServicesPricing
                )
                TeamPermissionSummaryRow(
                    title: "Manage artist schedules",
                    enabled: authViewModel.teamAccess.canManageArtistSchedules
                )
                TeamPermissionSummaryRow(
                    title: "Access client list",
                    enabled: authViewModel.teamAccess.canAccessClientList
                )
                TeamPermissionSummaryRow(
                    title: "View earnings & reports",
                    enabled: authViewModel.teamAccess.isOwner
                        || (authViewModel.teamAccess.accessRole == .manager
                            && authViewModel.teamAccess.permissions.viewEarningsReports)
                )
            } header: {
                Text("What I can do")
            } footer: {
                Text("Your access follows Settings → Team settings. Per-person options are on member profiles.")
                    .font(.caption2)
            }

            if !viewModel.members.isEmpty {
                Section(header: Text("Team members")) {
                    ForEach(viewModel.members) { member in
                        TeamMemberRow(member: member)
                    }
                }
            }

            if let err = viewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
    }
}

struct TeamPermissionSummaryRow: View {
    let title: String
    let enabled: Bool

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Image(systemName: enabled ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(enabled ? .green : .secondary)
        }
        .font(.subheadline)
    }
}
