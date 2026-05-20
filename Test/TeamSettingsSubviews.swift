//
//  TeamSettingsSubviews.swift
//

import SwiftUI

struct TeamManagerPolicySaveSection: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var label: String = "Save"

    var body: some View {
        Section {
            Button {
                Task {
                    await viewModel.saveManagerPolicy()
                    await authViewModel.refreshTeamAccess()
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

    var body: some View {
        if viewModel.tenantBookingRequiresApproval {
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
            Text("Use Request + approve (or similar) under Client booking flow above to enable approvals.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
