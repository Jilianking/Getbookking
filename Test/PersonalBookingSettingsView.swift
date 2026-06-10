//
//  PersonalBookingSettingsView.swift
//
//  Each team member's own booking flow (self-managed when owner policy is off).
//

import SwiftUI

struct PersonalBookingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel

    private var ownerControlsTeam: Bool {
        viewModel.managersApproveAppointments && !viewModel.isTenantOwner
    }

    var body: some View {
        List {
            if ownerControlsTeam {
                Section {
                    LabeledContent("Booking type", value: viewModel.tenantConfirmationType.displayName)
                } footer: {
                    Text("Your owner set the team booking type in Settings → Booking settings. Turn that off there to choose your own.")
                        .font(.caption2)
                }
            } else {
                Section {
                    Picker("Booking type", selection: $viewModel.personalConfirmationType) {
                        ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                            Text(type.displayName).tag(type)
                        }
                    }
                    if viewModel.personalConfirmationType.requiresDeposit {
                        HStack {
                            Text("Deposit amount")
                            TextField("0", value: Binding(
                                get: { viewModel.personalDepositAmount ?? 0 },
                                set: { viewModel.personalDepositAmount = $0 > 0 ? $0 : nil }
                            ), format: .number)
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .frame(width: 80)
                            Text("USD")
                                .foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text("Choose how clients book with you. Only applies to your calendar and requests.")
                        .font(.caption2)
                }

                Section {
                    Button {
                        Task {
                            await viewModel.savePersonalWorkflow()
                            await authViewModel.refreshTeamAccess()
                        }
                    } label: {
                        HStack {
                            Text("Save")
                            if viewModel.isLoading {
                                Spacer()
                                ProgressView().scaleEffect(0.9)
                            }
                        }
                    }
                    if viewModel.personalSaveSuccess {
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.subheadline)
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
        .appListSurface()
        .navigationTitle("My booking type")
        .navigationBarTitleDisplayMode(.inline)
    }
}
