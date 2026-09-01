//
//  PaymentsSettingsView.swift
//  Tap to Pay name and Stripe account shortcuts.
//

import SwiftUI

struct PaymentsSettingsView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var stripeConnectLaunch: StripeConnectLaunchCoordinator

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                #if TAP_TO_PAY_ENABLED
                if viewModel.canEditTapToPayDisplayName {
                    tapToPayNameSection
                }
                #endif

                if viewModel.canTakePayments {
                    stripePayoutsSection
                }

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical, 16)
        }
        .appScreenBackground()
        .navigationTitle("Payment settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var stripePayoutsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Account")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(spacing: 0) {
                Button {
                    Task {
                        if viewModel.stripeConnected {
                            await viewModel.openExpressDashboard(isDemoMode: authViewModel.isDemoMode)
                        } else {
                            stripeConnectLaunch.prepareOpening()
                            _ = await stripeConnectLaunch.openConnect(
                                from: viewModel,
                                isDemoMode: authViewModel.isDemoMode
                            )
                        }
                    }
                } label: {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Payouts & Stripe account")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                            Text("Balance, bank account, and account details")
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                        Spacer()
                        if viewModel.isOpeningStripeDashboard || viewModel.isConnectingStripe {
                            ProgressView().scaleEffect(0.9)
                        } else {
                            Image(systemName: "arrow.up.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(
                    authViewModel.isDemoMode
                        || viewModel.isOpeningStripeDashboard
                        || viewModel.isConnectingStripe
                        || stripeConnectLaunch.isOpening
                )
            }
            .appCard()
            .padding(.horizontal)

            Text(
                viewModel.stripeConnected
                    ? "Opens your Stripe Dashboard for payouts and account details."
                    : "Connect Stripe first to open your payout account."
            )
            .font(.caption)
            .foregroundStyle(AppDesign.textSecondary)
            .padding(.horizontal)
        }
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayNameSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tap to Pay screen name")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(alignment: .leading, spacing: 12) {
                Text("Customers see “Pay \(viewModel.effectiveTapToPayDisplayName)” on their phone during Tap to Pay. This is not the bank statement descriptor.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(
                    "Name on Tap to Pay screen",
                    text: $viewModel.tapToPayDisplayNameDraft,
                    prompt: Text(viewModel.tapToPayDisplayNamePlaceholder)
                )
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .disabled(viewModel.isSavingTapToPayDisplayName)

                Button {
                    Task { await viewModel.saveTapToPayDisplayName() }
                } label: {
                    HStack {
                        Text("Save Tap to Pay screen name")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.accentGreen)
                        if viewModel.isSavingTapToPayDisplayName {
                            Spacer()
                            ProgressView().scaleEffect(0.9)
                        }
                    }
                }
                .disabled(viewModel.isSavingTapToPayDisplayName)

                if viewModel.tapToPayDisplayNameSaveSuccess {
                    Text("Saved — Tap to Pay will show Pay \(viewModel.effectiveTapToPayDisplayName).")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                }
            }
            .padding(16)
            .appCard()
            .padding(.horizontal)
        }
    }
    #endif
}
