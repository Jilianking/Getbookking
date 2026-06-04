//
//  TeamBookingSettingsView.swift
//

import SwiftUI

struct TeamBookingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel

    var body: some View {
        List {
            Section(
                header: Text("Client booking flow"),
                footer: clientBookingFooter
            ) {
                Toggle("Managers approve appointments", isOn: $settingsViewModel.managersApproveAppointments)
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

    private var clientBookingFooter: some View {
        Group {
            if settingsViewModel.managersApproveAppointments {
                Text("Default flow for the studio when managers approve requests. Per-artist overrides are on Team → member profile.")
            } else {
                Text("Booking confirmation is set per team member on Team → member profile.")
            }
        }
        .font(.caption2)
    }

    private func saveAll() async {
        await settingsViewModel.saveWorkflow(isOwner: true)
        await teamPolicyViewModel.saveManagerPolicy()
        await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
        await authViewModel.refreshTeamAccess()
    }
}
