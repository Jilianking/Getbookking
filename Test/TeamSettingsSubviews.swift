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
    /// Live studio policy: owner sets team type + confirmation type requires approval.
    var bookingRequiresApproval: Bool

    private var canEnable: Bool {
        managersApproveAppointments && bookingRequiresApproval
    }

    var body: some View {
        Toggle(
            "Approve & reject requests",
            isOn: Binding(
                get: { viewModel.permissions.approveRejectRequests },
                set: { viewModel.permissions.approveRejectRequests = $0 }
            )
        )
        .disabled(!canEnable)

        if !canEnable, let caption = disabledCaption {
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var disabledCaption: String? {
        if !managersApproveAppointments {
            return "Turn on Owner sets team booking type above to enable manager approvals for the studio flow."
        }
        if !bookingRequiresApproval {
            return "Choose Request + approve, Approve + deposit, or Consultation first under Booking confirmation to enable approvals."
        }
        return nil
    }
}
