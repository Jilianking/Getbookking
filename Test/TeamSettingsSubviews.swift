//
//  TeamSettingsSubviews.swift
//

import SwiftUI

struct TeamManagerPolicySaveSection: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var label: String = "Save"
    /// When set, runs instead of `saveManagerPolicy` (e.g. messaging presets).
    var saveAction: (() async -> Void)?

    var body: some View {
        Section {
            Button {
                Task {
                    if let saveAction {
                        await saveAction()
                    } else {
                        await viewModel.saveManagerPolicy()
                        await authViewModel.refreshTeamAccess()
                    }
                }
            } label: {
                HStack {
                    Text(label)
                    if viewModel.isSavingPolicy {
                        Spacer()
                        ProgressView().scaleEffect(0.9)
                    }
                }
            }
            .disabled(viewModel.isSavingPolicy)

            if viewModel.saveSuccess {
                Label("Saved", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            }
        }
    }
}

struct TeamPermissionToggle: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    let title: String
    let keyPath: WritableKeyPath<ManagerPermissions, Bool>

    var body: some View {
        Toggle(title, isOn: Binding(
            get: { viewModel.permissions[keyPath: keyPath] },
            set: { viewModel.permissions[keyPath: keyPath] = $0 }
        ))
    }
}

struct TeamNotificationToggle: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    let title: String
    let keyPath: WritableKeyPath<ManagerNotifications, Bool>

    var body: some View {
        Toggle(title, isOn: Binding(
            get: { viewModel.notifications[keyPath: keyPath] },
            set: { viewModel.notifications[keyPath: keyPath] = $0 }
        ))
    }
}

struct TeamApproveRejectRow: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var managersApproveAppointments: Bool

    var body: some View {
        if !managersApproveAppointments {
            HStack {
                Text("Approve & reject requests")
                Spacer()
                Text("Off")
                    .foregroundStyle(.secondary)
            }
            Text("Turn on Owner sets team booking type above to enable manager approvals for the studio flow.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        } else if viewModel.tenantBookingRequiresApproval {
            TeamPermissionToggle(
                viewModel: viewModel,
                title: "Approve & reject requests",
                keyPath: \.approveRejectRequests
            )
        } else {
            HStack {
                Text("Approve & reject requests")
                Spacer()
                Text("Off")
                    .foregroundStyle(.secondary)
            }
            Text("Choose Request + approve (or similar) under Booking confirmation to enable approvals.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
