//
//  PersonalBookingSettingsView.swift
//
//  Each team member's own booking flow (self-managed when owner policy is off).
//

import SwiftUI

struct PersonalBookingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @State private var depositAmountText = ""
    @FocusState private var isDepositAmountFocused: Bool

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
                        depositAmountField
                    }
                } footer: {
                    Text("Choose how clients book with you. Only applies to your calendar and requests.")
                        .font(.caption2)
                }

                Section {
                    Button {
                        applyDepositAmountFromText()
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
        .onAppear { syncDepositAmountTextFromModel() }
        .onChange(of: viewModel.personalConfirmationType) { _, _ in
            syncDepositAmountTextFromModel()
        }
        .onChange(of: viewModel.personalDepositAmount) { _, _ in
            guard !isDepositAmountFocused else { return }
            syncDepositAmountTextFromModel()
        }
    }

    private var depositAmountField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Deposit amount")
                .font(.subheadline)
            HStack(spacing: 8) {
                TextField("0.00", text: $depositAmountText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                    .focused($isDepositAmountFocused)
                    .onChange(of: depositAmountText) { _, newValue in
                        viewModel.personalDepositAmount = Self.parseDepositAmount(newValue)
                    }
                Text("USD")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func syncDepositAmountTextFromModel() {
        guard !isDepositAmountFocused else { return }
        if let amount = viewModel.personalDepositAmount, amount > 0 {
            depositAmountText = String(format: "%.2f", amount)
        } else {
            depositAmountText = ""
        }
    }

    private func applyDepositAmountFromText() {
        viewModel.personalDepositAmount = Self.parseDepositAmount(depositAmountText)
    }

    private static func parseDepositAmount(_ raw: String) -> Double? {
        let cleaned = raw
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let value = Double(cleaned), value > 0 else { return nil }
        return value
    }
}
