//
//  PaymentsView.swift
//
//  Accept payments and manage earnings. Stripe Connect integration.
//

import SwiftUI

struct PaymentsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = PaymentsViewModel()
    @State private var showDepositLinkSheet = false
    #if TAP_TO_PAY_ENABLED
    @State private var showTapToPaySheet = false
    @State private var tapToPayAlertMessage: String?
    #endif
    @State private var showWithdrawSheet = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    paymentsIntro
                    if viewModel.needsStripeConnect {
                        StripeConnectBanner(
                            viewModel: viewModel,
                            isDemoMode: authViewModel.isDemoMode
                        )
                    } else if let err = viewModel.errorMessage {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    #if TAP_TO_PAY_ENABLED
                    PaymentActionCard(
                        icon: "wave.3.right.circle.fill",
                        iconColor: .blue,
                        title: "Tap to Pay on iPhone",
                        subtitle: tapToPayCardSubtitle,
                        action: { handleTapToPayTapped() }
                    )
                    .overlay {
                        if viewModel.isEnsuringTapToPayLocation {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(AppDesign.cardBackground.opacity(0.85))
                            ProgressView()
                        }
                    }
                    .allowsHitTesting(!viewModel.isEnsuringTapToPayLocation)
                    #endif

                    // Deposit Link
                    PaymentActionCard(
                        icon: "link",
                        iconColor: .green,
                        title: "Deposit Link",
                        subtitle: "Generate a link to request a deposit from customers",
                        action: { showDepositLinkSheet = true },
                        disabled: !viewModel.stripeConnected
                    )

                    // Withdraw to Bank
                    Button(action: { showWithdrawSheet = true }) {
                        HStack(spacing: 16) {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.green.opacity(0.2))
                                .frame(width: 48, height: 48)
                                .overlay(Image(systemName: "arrow.down.to.line").foregroundColor(.green))
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Withdraw to bank")
                                    .font(.subheadline.weight(.semibold))
                                Text(formatCurrency(viewModel.availableBalance))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text("Transfer to your connected account")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.secondary)
                        }
                        .padding(16)
                        .appCard()
                    }
                    .buttonStyle(.plain)
                    .disabled(!viewModel.stripeConnected || viewModel.availableBalance <= 0)
                    .opacity((viewModel.stripeConnected && viewModel.availableBalance > 0) ? 1 : 0.6)
                    .padding(.horizontal)

                    paymentsRecentActivity
                }
                .padding(.vertical, 20)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .sheet(isPresented: $showDepositLinkSheet, onDismiss: { viewModel.depositLinkUrl = nil }) {
                DepositLinkSheet(viewModel: viewModel) {
                    showDepositLinkSheet = false
                }
            }
            #if TAP_TO_PAY_ENABLED
            .sheet(isPresented: $showTapToPaySheet) {
                TapToPaySheet(viewModel: viewModel) {
                    showTapToPaySheet = false
                }
            }
            .alert("Tap to Pay", isPresented: Binding(
                get: { tapToPayAlertMessage != nil },
                set: { if !$0 { tapToPayAlertMessage = nil } }
            )) {
                Button("OK", role: .cancel) { tapToPayAlertMessage = nil }
            } message: {
                Text(tapToPayAlertMessage ?? "")
            }
            #endif
            .sheet(isPresented: $showWithdrawSheet) {
                WithdrawSheet(viewModel: viewModel) {
                    showWithdrawSheet = false
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayCardSubtitle: String {
        if !viewModel.stripeConnected {
            return "Set up Stripe to enable in-person payments"
        }
        if !viewModel.isTenantOwner {
            return "Ask your studio admin to enable Tap to Pay"
        }
        return "Accept contactless cards and wallets (1% platform fee)"
    }

    private func handleTapToPayTapped() {
        if authViewModel.isDemoMode {
            tapToPayAlertMessage = "Tap to Pay isn't available in demo mode."
            return
        }
        if let block = TapToPayEligibility.blockingMessage() {
            tapToPayAlertMessage = block
            return
        }
        if !viewModel.isTenantOwner {
            tapToPayAlertMessage = "Only the studio owner can enable Tap to Pay. Contact your admin."
            return
        }
        if !viewModel.stripeConnected {
            Task { await viewModel.createConnectAccountLink(isDemoMode: false) }
            return
        }
        Task {
            if viewModel.resolvedTapToPayLocationId.isEmpty {
                do {
                    try await viewModel.ensureTapToPayLocation()
                } catch {
                    tapToPayAlertMessage = FirebaseFunctionsErrorHelper.message(from: error)
                    return
                }
            }
            if viewModel.resolvedTapToPayLocationId.isEmpty {
                tapToPayAlertMessage = "Tap to Pay could not be set up. Add your business address under Website Design, then try again."
                return
            }
            showTapToPaySheet = true
        }
    }
    #endif

    private var paymentsIntro: some View {
        Text("Accept payments and manage your earnings")
            .font(.subheadline)
            .foregroundStyle(AppDesign.textSecondary)
            .padding(.horizontal)
    }

    private var paymentsRecentActivity: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recent activity")
                .font(.title3.weight(.bold))
                .padding(.horizontal)

            if viewModel.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(24)
                    .appCard()
                    .padding(.horizontal)
            } else if viewModel.transactions.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.largeTitle)
                        .foregroundColor(.secondary)
                    Text("No transactions yet")
                        .font(.subheadline.weight(.medium))
                    Text("When customers pay deposits or for services, they'll appear here")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(32)
                .appCard()
                .padding(.horizontal)
            } else {
                VStack(spacing: 0) {
                    ForEach(viewModel.transactions) { txn in
                        PaymentTransactionRow(transaction: txn, viewModel: viewModel)
                    }
                }
                .appCard()
                .padding(.horizontal)
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

private struct StripeConnectBanner: View {
    @ObservedObject var viewModel: PaymentsViewModel
    let isDemoMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                Task { await viewModel.createConnectAccountLink(isDemoMode: isDemoMode) }
            }) {
                HStack(spacing: 12) {
                    Image(systemName: "link.circle.fill")
                        .font(.title2)
                        .foregroundColor(.purple)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(viewModel.stripeStatusHint == nil
                            ? "Connect Stripe to accept payments"
                            : "Complete Stripe setup")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                        Text(viewModel.stripeStatusHint ?? "Deposits, tips, and service payments")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    if viewModel.isConnectingStripe {
                        ProgressView()
                            .scaleEffect(0.9)
                    } else {
                        Image(systemName: "chevron.right")
                            .foregroundColor(.secondary)
                    }
                }
                .padding()
                .background(Color.purple.opacity(0.08))
                .cornerRadius(12)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.purple.opacity(0.3), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isConnectingStripe)

            if let err = viewModel.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
        .padding(.horizontal)
    }
}

struct PaymentActionCard: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let action: () -> Void
    var disabled: Bool = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(iconColor.opacity(0.2))
                    .frame(width: 48, height: 48)
                    .overlay(Image(systemName: icon).foregroundColor(iconColor))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundColor(.secondary)
            }
            .padding(16)
            .appCard()
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .padding(.horizontal)
    }
}

struct PaymentTransactionRow: View {
    let transaction: PaymentTransaction
    @ObservedObject var viewModel: PaymentsViewModel
    @State private var showRefundConfirm = false

    private var isCredit: Bool { transaction.type == "charge" }
    private var typeLabel: String {
        switch transaction.type {
        case "charge": return "Payment"
        case "payout": return "Payout"
        case "refund": return "Refund"
        default: return transaction.type.capitalized
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
            Circle()
                .fill(isCredit ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                .frame(width: 40, height: 40)
                .overlay(
                    Image(systemName: isCredit ? "arrow.down" : "arrow.up")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(isCredit ? .green : .orange)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(transaction.customerName ?? typeLabel)
                    .font(.subheadline.weight(.medium))
                Text(transaction.createdAt?.formatted(.dateTime) ?? "")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text("\(isCredit ? "+" : "-")\(formatAmount(transaction.amount))")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(isCredit ? .green : .primary)
            }
            if let chargeId = transaction.chargeId {
                HStack(spacing: 12) {
                    Button(action: { Task { await viewModel.openReceipt(chargeId: chargeId) } }) {
                        Label("Receipt", systemImage: "doc.text")
                            .font(.caption)
                    }
                    .disabled(viewModel.isRefunding)
                    Button(action: { showRefundConfirm = true }) {
                        Label("Refund", systemImage: "arrow.uturn.backward")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                    .disabled(viewModel.isRefunding)
                    Spacer()
                }
                .padding(.leading, 52)
            }
        }
        .padding()
        .confirmationDialog("Refund", isPresented: $showRefundConfirm) {
            Button("Full refund", role: .destructive) {
                Task { await viewModel.createRefund(chargeId: transaction.chargeId!) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Refund this payment?")
        }
    }

    private func formatAmount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0"
    }
}

// MARK: - Deposit Link Sheet
struct DepositLinkSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void
    @State private var amountText = ""
    @FocusState private var isAmountFocused: Bool

    private static let suggestionAmounts: [(label: String, cents: Int)] = [
        ("$25", 2500),
        ("$50", 5000),
        ("$100", 10_000),
        ("$200", 20_000),
    ]

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var canCreate: Bool { amountCents >= 50 }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text("Enter deposit amount")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text("Customer pays this amount. Bookking retains a 1% platform fee on customer payments (not on your subscription).")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                TextField("0.00", text: $amountText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .focused($isAmountFocused)
                    .padding(.horizontal, 24)

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                }

                if let urlString = viewModel.depositLinkUrl, let url = URL(string: urlString) {
                    VStack(spacing: 16) {
                        Text("Link ready")
                            .font(.subheadline.weight(.semibold))
                        Text(urlString)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .padding(.horizontal)
                        ShareLink(item: url, subject: Text("Deposit link"), message: Text("Pay your deposit")) {
                            Label("Share", systemImage: "square.and.arrow.up")
                                .font(.body.weight(.medium))
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                } else {
                    Button(action: {
                        Task { await viewModel.createDepositLink(amountCents: amountCents) }
                    }) {
                        HStack {
                            if viewModel.isCreatingDepositLink {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text("Create link")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(canCreate ? Color.green : Color.gray)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                    }
                    .disabled(!canCreate || viewModel.isCreatingDepositLink)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 20)
            .navigationTitle("Deposit Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItem(placement: .keyboard) {
                    HStack(spacing: 12) {
                        ForEach(Self.suggestionAmounts, id: \.cents) { item in
                            Button(item.label) {
                                amountText = String(format: "%.2f", Double(item.cents) / 100)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
    }
}

// MARK: - Withdraw Sheet
struct WithdrawSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void
    @State private var amountText = ""

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var maxCents: Int { Int(viewModel.availableBalance * 100) }
    private var canWithdraw: Bool { amountCents >= 50 && amountCents <= maxCents }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text("Available: \(formatCurrency(viewModel.availableBalance))")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                TextField("0", text: $amountText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                }
                Button(action: { amountText = String(maxCents / 100) }) {
                    Text("Withdraw full balance")
                        .font(.subheadline)
                }
                .padding(.top, 8)
                Button(action: {
                    Task {
                        await viewModel.createPayout(amountCents: amountCents)
                        if !viewModel.isCreatingPayout && viewModel.errorMessage == nil {
                            onDismiss()
                        }
                    }
                }) {
                    HStack {
                        if viewModel.isCreatingPayout {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Withdraw")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(canWithdraw ? Color.green : Color.gray)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
                .disabled(!canWithdraw || viewModel.isCreatingPayout)
                Spacer(minLength: 0)
            }
            .padding(.top, 24)
            .navigationTitle("Withdraw to bank")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}
