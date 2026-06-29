//
//  TeamBookingSettingsView.swift
//

import SwiftUI

struct TeamBookingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel
    /// Solo Business settings: owner booking type only (no manager sections).
    var isSoloBusinessSettings: Bool = false

    var body: some View {
        List {
            if isSoloBusinessSettings {
                soloBookingSection
            } else {
                studioBookingPolicySection
                managerAccessSection
                managerAlertsSection
            }

            saveSection

            if let err = settingsViewModel.errorMessage ?? teamPolicyViewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle("Booking settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var soloBookingSection: some View {
        Section(
            header: Text("How clients book"),
            footer: Text("Choose how clients book appointments with you.")
                .font(.caption2)
        ) {
            Picker("Booking type", selection: $settingsViewModel.confirmationType) {
                ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                    Text(type.displayName).tag(type)
                }
            }
            if settingsViewModel.confirmationType.requiresDeposit {
                HStack {
                    Text("Deposit amount")
                    TextField("0", value: Binding(
                        get: { settingsViewModel.depositAmount ?? 0 },
                        set: { settingsViewModel.depositAmount = $0 > 0 ? $0 : nil }
                    ), format: .number)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                    Text("USD")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var studioBookingPolicySection: some View {
        Section(
            header: Text("Studio booking policy"),
            footer: clientBookingFooter
        ) {
            Toggle("Owner sets team booking type", isOn: $settingsViewModel.managersApproveAppointments)
                .onChange(of: settingsViewModel.managersApproveAppointments) { _, enabled in
                    if !enabled {
                        teamPolicyViewModel.permissions.approveRejectRequests = false
                    }
                }

            if settingsViewModel.managersApproveAppointments {
                Picker("Booking confirmation", selection: $settingsViewModel.confirmationType) {
                    ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                        Text(type.displayName).tag(type)
                    }
                }
                if settingsViewModel.confirmationType.requiresDeposit {
                    HStack {
                        Text("Deposit amount")
                        TextField("0", value: Binding(
                            get: { settingsViewModel.depositAmount ?? 0 },
                            set: { settingsViewModel.depositAmount = $0 > 0 ? $0 : nil }
                        ), format: .number)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 80)
                        Text("USD")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var managerAccessSection: some View {
        Section(
            header: Text("Manager access"),
            footer: Text("Applies to everyone with the Manager role.")
                .font(.caption2)
        ) {
            TeamPermissionToggle(
                viewModel: teamPolicyViewModel,
                title: "View all bookings",
                keyPath: \.viewAllBookings
            )
            TeamApproveRejectRow(
                viewModel: teamPolicyViewModel,
                managersApproveAppointments: settingsViewModel.managersApproveAppointments
            )
            TeamPermissionToggle(
                viewModel: teamPolicyViewModel,
                title: "Manage artist schedules",
                keyPath: \.manageArtistSchedules
            )
        }
    }

    private var managerAlertsSection: some View {
        Section(
            header: Text("Manager booking alerts"),
            footer: Text("Push and email delivery depends on your notification setup.")
                .font(.caption2)
        ) {
            TeamNotificationToggle(
                viewModel: teamPolicyViewModel,
                title: "Notify manager on new booking",
                keyPath: \.onNewBooking
            )
            TeamNotificationToggle(
                viewModel: teamPolicyViewModel,
                title: "Notify manager on cancellation",
                keyPath: \.onCancellation
            )
        }
    }

    private var saveSection: some View {
        Section {
            Button {
                Task { await saveAll() }
            } label: {
                HStack {
                    Text("Save booking settings")
                    if settingsViewModel.isLoading || teamPolicyViewModel.isSavingPolicy {
                        Spacer()
                        ProgressView().scaleEffect(0.9)
                    }
                }
            }
            .disabled(settingsViewModel.isLoading || teamPolicyViewModel.isSavingPolicy)

            if settingsViewModel.saveSuccess || teamPolicyViewModel.saveSuccess {
                Label("Saved", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            }
        }
    }

    private var clientBookingFooter: some View {
        Group {
            if settingsViewModel.managersApproveAppointments {
                Text("Your booking type applies to everyone on the team. Turn off to let each person choose their own in Settings → My booking type.")
            } else {
                Text("Each person chooses their booking type in Settings → My booking type.")
            }
        }
        .font(.caption2)
    }

    private func saveAll() async {
        if isSoloBusinessSettings {
            await settingsViewModel.saveSoloBusinessBookingWorkflow()
        } else {
            await settingsViewModel.saveWorkflow(isOwner: true)
            await teamPolicyViewModel.saveManagerPolicy()
            await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
        await authViewModel.refreshTeamAccess()
    }
}
