//
//  PaymentSettingsView.swift
//
//  Stripe Connect, shop sales tax, and tax document links (Settings).
//

import SwiftUI

struct PaymentSettingsView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    let isDemoMode: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                stripeAccountSection
                if viewModel.stripeConnected {
                    salesTaxSection
                    taxReportingSection
                }
                #if TAP_TO_PAY_ENABLED
                // Apple 4.3: merchant education must remain reachable outside onboarding,
                // including before Stripe Connect finishes.
                if viewModel.canTakePayments {
                    tapToPaySection
                }
                #endif

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 4)
                }
            }
            .padding(16)
        }
        .appScreenBackground()
        .navigationTitle("Payment settings")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await viewModel.refreshStripeConnectStatus(isDemoMode: isDemoMode)
            await viewModel.reloadShopTaxSetting(isDemoMode: isDemoMode)
        }
    }

    private var stripeAccountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Stripe account")

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "s.circle.fill")
                        .font(.title3)
                        .foregroundStyle(AppDesign.accentGreen)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Payment processing")
                            .font(.body.weight(.medium))
                        Text(stripeStatusSubtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(stripeStatusLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(stripeStatusColor)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                if !viewModel.stripeConnected {
                    Divider().padding(.leading, 14)
                    Button {
                        Task { _ = await viewModel.createConnectAccountLink(isDemoMode: isDemoMode) }
                    } label: {
                        HStack {
                            Text(connectActionTitle)
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            if viewModel.isConnectingStripe {
                                ProgressView().scaleEffect(0.9)
                            } else {
                                Image(systemName: "arrow.up.right")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isConnectingStripe || isDemoMode)
                }
            }
            .appCard()
        }
    }

    private var salesTaxSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Shop sales tax")

            VStack(alignment: .leading, spacing: 0) {
                Toggle(isOn: shopTaxBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Collect sales tax")
                            .font(.body.weight(.medium))
                        Text("On shop orders at checkout. Calculated by Stripe from your tax registrations.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(.green)
                .disabled(isDemoMode || viewModel.isSavingShopTax)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                Divider().padding(.leading, 14)

                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Set up tax in Stripe",
                        subtitle: "Registrations, rates, and filing",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)
            }
            .appCard()

            Text("Uses your business address for pickup orders. Turn on only after completing Stripe Tax setup.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
        }
    }

    private var taxReportingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Tax & reporting")

            VStack(spacing: 0) {
                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Tax documents (1099-K)",
                        subtitle: "Download forms issued by Stripe",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)

                Divider().padding(.leading, 14)

                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Payouts & Stripe account",
                        subtitle: "Balance, bank account, and account details",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)
            }
            .appCard()

            Text("Tax forms and payout reports are provided by Stripe, not Bookking.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
        }
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "In-person checkout")

            NavigationLink {
                PaymentsSettingsView(viewModel: viewModel)
            } label: {
                paymentSettingsLinkRow(
                    title: "Tap to Pay settings",
                    subtitle: viewModel.stripeConnected
                        ? "Customer-facing name, signature, receipts, how to use"
                        : "How to use Tap to Pay, and settings after Stripe is connected"
                )
            }
            .buttonStyle(.plain)
            .appCard()
        }
    }
    #endif

    private var shopTaxBinding: Binding<Bool> {
        Binding(
            get: { viewModel.shopTaxEnabled },
            set: { newValue in
                viewModel.shopTaxEnabled = newValue
                Task { await viewModel.saveShopTaxEnabled(isDemoMode: isDemoMode) }
            }
        )
    }

    private var stripeStatusLabel: String {
        if viewModel.stripeConnected { return "Connected" }
        if viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted { return "In review" }
        if viewModel.stripeHasAccount { return "Setup" }
        return "Not connected"
    }

    private var stripeStatusColor: Color {
        if viewModel.stripeConnected { return AppDesign.accentGreen }
        if viewModel.stripeHasAccount { return AppDesign.brandWarm }
        return AppDesign.textSecondary
    }

    private var stripeStatusSubtitle: String {
        if viewModel.stripeConnected {
            return "Deposits, shop checkout, Tap to Pay, and payment links"
        }
        return viewModel.stripeStatusHint ?? "Connect to accept payments online and in person"
    }

    private var connectActionTitle: String {
        if viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted {
            return "Check status in Stripe"
        }
        if viewModel.stripeHasAccount {
            return "Finish setup in Stripe"
        }
        return "Connect Stripe"
    }

    private func paymentSettingsLinkRow(
        title: String,
        subtitle: String,
        isLoading: Bool = false
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if isLoading {
                ProgressView().scaleEffect(0.9)
            } else {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}
