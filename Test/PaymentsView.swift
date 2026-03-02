//
//  PaymentsView.swift
//
//  Accept payments and manage earnings. Stripe Connect integration.
//

import SwiftUI

struct PaymentsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var viewModel = PaymentsViewModel()
    @State private var showWithdrawConfirm = false
    @State private var showDepositSheet = false
    @State private var depositAmountCents = 500
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Accept payments and manage your earnings")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    // Connect Stripe banner (not connected)
                    if viewModel.stripeStatus == .notConnected {
                        Button(action: { Task { await viewModel.createConnectAccountLink() } }) {
                            HStack(spacing: 12) {
                                Image(systemName: "link.circle.fill")
                                    .font(.title2)
                                    .foregroundColor(.purple)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Connect Stripe to accept payments")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(.primary)
                                    Text("Deposits, tips, and service payments")
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
                        .padding(.horizontal)
                    }

                    // Approval pending (onboarding done, Stripe reviewing)
                    if viewModel.stripeStatus == .pendingApproval {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.title2)
                                .foregroundColor(.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Setup complete")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundColor(.primary)
                                Text("You've finished connecting Stripe. Your account is under review and we'll notify you when you can start accepting payments.")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                        }
                        .padding()
                        .background(Color.orange.opacity(0.08))
                        .cornerRadius(12)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.orange.opacity(0.3), lineWidth: 1)
                        )
                        .padding(.horizontal)
                    }

                    // 1. Tap to Pay
                    PaymentActionCard(
                        icon: "wave.3.right",
                        iconColor: .blue,
                        title: "Tap to Pay",
                        subtitle: "Hold your iPhone for the customer to tap",
                        action: { Task { await viewModel.startTapToPay() } },
                        disabled: !viewModel.stripeConnected
                    )

                    // 2. Deposit Link
                    PaymentActionCard(
                        icon: "link",
                        iconColor: .green,
                        title: "Deposit Link",
                        subtitle: "Generate a link to request a deposit from customers",
                        action: { showDepositSheet = true },
                        disabled: !viewModel.stripeConnected
                    )

                    // 3. Withdraw to Bank
                    Button(action: { showWithdrawConfirm = true }) {
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
                        .padding()
                        .background(Color(.systemBackground))
                        .cornerRadius(12)
                        .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .disabled(!viewModel.stripeConnected || viewModel.availableBalance <= 0)
                    .opacity((viewModel.stripeConnected && viewModel.availableBalance > 0) ? 1 : 0.6)
                    .padding(.horizontal)
                    .disabled(viewModel.isWithdrawing)

                    if let err = viewModel.errorMessage, !err.isEmpty {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // 4. Recent Activity
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Recent activity")
                            .font(.title3.weight(.bold))
                            .padding(.horizontal)

                        if viewModel.isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(24)
                                .background(Color(.systemBackground))
                                .cornerRadius(12)
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
                            .background(Color(.systemBackground))
                            .cornerRadius(12)
                            .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                            .padding(.horizontal)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(viewModel.transactions) { txn in
                                    PaymentTransactionRow(transaction: txn)
                                }
                            }
                            .background(Color(.systemBackground))
                            .cornerRadius(12)
                            .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                            .padding(.horizontal)
                        }
                    }
                }
                .padding(.vertical, 20)
            }
            .background(Color.gray.opacity(0.06))
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task { await viewModel.refresh(isDemoMode: authViewModel.isDemoMode) }
                }
            }
            .confirmationDialog("Withdraw to bank", isPresented: $showWithdrawConfirm) {
                Button("Withdraw \(formatCurrency(viewModel.availableBalance))", role: .none) {
                    Task { await viewModel.withdrawToBank() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Transfer \(formatCurrency(viewModel.availableBalance)) to your connected bank account?")
            }
            .sheet(isPresented: $showDepositSheet) {
                DepositLinkSheet(
                    amountCents: $depositAmountCents,
                    isCreating: viewModel.isCreatingDepositLink,
                    depositLinkUrl: viewModel.depositLinkUrl,
                    onCreate: { amountCents, productName, productDescription in
                        Task {
                            await viewModel.createDepositLink(
                                amountCents: amountCents,
                                productName: productName,
                                productDescription: productDescription
                            )
                        }
                    },
                    onDismiss: {
                        viewModel.clearDepositLink()
                        showDepositSheet = false
                    }
                )
            }
        }
        .navigationViewStyle(.stack)
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

private struct DepositLinkSheet: View {
    @Binding var amountCents: Int
    let isCreating: Bool
    let depositLinkUrl: String?
    let onCreate: (Int, String?, String?) -> Void
    let onDismiss: () -> Void

    @State private var useCustomAmount = false
    @State private var customAmountText = ""
    @State private var productNameOption = "Deposit"
    @State private var customProductName = ""
    @State private var productDescription = ""

    private let presets: [(String, Int)] = [
        ("$5", 500),
        ("$10", 1000),
        ("$25", 2500),
        ("$50", 5000),
    ]

    private let productNamePresets = ["Deposit", "Booking deposit", "Service deposit"]

    private var resolvedAmountCents: Int {
        if useCustomAmount {
            let cleaned = customAmountText.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
            if let dollars = Double(cleaned), dollars > 0 {
                return Int(dollars * 100)
            }
            return 0
        }
        return amountCents
    }

    private var resolvedProductName: String {
        if productNameOption == "Custom" { return customProductName }
        return productNameOption
    }

    private var canGenerate: Bool {
        let cents = resolvedAmountCents
        guard cents >= 50 else { return false }
        if productNameOption == "Custom" { return !customProductName.trimmingCharacters(in: .whitespaces).isEmpty }
        return true
    }

    var body: some View {
        NavigationView {
            Group {
                if let url = depositLinkUrl {
                    VStack(spacing: 24) {
                        Image(systemName: "link.circle.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.green)
                        Text("Link created")
                            .font(.title2.weight(.semibold))
                        Text("Share this link with your customer to collect the deposit.")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        ShareLink(item: URL(string: url) ?? URL(string: "https://")!, subject: Text("Deposit request")) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding()
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Done", action: onDismiss)
                            .foregroundColor(.secondary)
                    }
                    .padding()
                } else {
                    Form {
                        Section("Deposit amount") {
                            ForEach(presets, id: \.1) { label, cents in
                                Button(action: {
                                    useCustomAmount = false
                                    amountCents = cents
                                }) {
                                    HStack {
                                        Text(label)
                                        Spacer()
                                        if !useCustomAmount && amountCents == cents {
                                            Image(systemName: "checkmark.circle.fill")
                                                .foregroundColor(.green)
                                        }
                                    }
                                }
                                .foregroundColor(.primary)
                            }
                            Button(action: { useCustomAmount = true }) {
                                HStack {
                                    Text("Custom")
                                    Spacer()
                                    if useCustomAmount {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(.green)
                                    }
                                }
                            }
                            .foregroundColor(.primary)
                            if useCustomAmount {
                                TextField("Amount (e.g. 75 or 75.50)", text: $customAmountText)
                                    .keyboardType(.decimalPad)
                            }
                        }

                        Section("Label") {
                            Picker("Type", selection: $productNameOption) {
                                ForEach(productNamePresets, id: \.self) { name in
                                    Text(name).tag(name)
                                }
                                Text("Custom").tag("Custom")
                            }
                            .pickerStyle(.menu)
                            if productNameOption == "Custom" {
                                TextField("Product name", text: $customProductName)
                            }
                        }

                        Section {
                            TextField("Description (optional)", text: $productDescription, axis: .vertical)
                                .lineLimit(3...6)
                        } header: {
                            Text("Description")
                        } footer: {
                            Text("Shown to the customer on the payment page.")
                        }

                        Section {
                            Button(action: {
                                onCreate(resolvedAmountCents, resolvedProductName.isEmpty ? nil : resolvedProductName, productDescription.isEmpty ? nil : productDescription)
                            }) {
                                if isCreating {
                                    ProgressView()
                                        .frame(maxWidth: .infinity)
                                        .padding()
                                } else {
                                    Text("Generate link")
                                        .frame(maxWidth: .infinity)
                                        .padding()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canGenerate || isCreating)
                        }
                    }
                    .formStyle(.grouped)
                }
            }
            .navigationTitle("Deposit Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
            }
        }
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
            .padding()
            .background(Color(.systemBackground))
            .cornerRadius(12)
            .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .padding(.horizontal)
    }
}

struct PaymentTransactionRow: View {
    let transaction: PaymentTransaction

    private var isCredit: Bool {
        transaction.type == "deposit" || transaction.type == "service_payment"
    }

    var body: some View {
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
                Text(transaction.customerName ?? transaction.type)
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
        .padding()
    }

    private func formatAmount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0"
    }
}
