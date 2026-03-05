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

                    // Connect Stripe banner
                    if !viewModel.stripeConnected {
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
                        if let err = viewModel.errorMessage {
                            Text(err)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(.horizontal)
                        }
                    }

                    // 1. Tap to Pay
                    PaymentActionCard(
                        icon: "wave.3.right",
                        iconColor: .blue,
                        title: "Tap to Pay",
                        subtitle: "Hold your iPhone for the customer to tap",
                        action: { /* TODO: Stripe Terminal Tap to Pay */ },
                        disabled: !viewModel.stripeConnected
                    )

                    // 2. Deposit Link
                    PaymentActionCard(
                        icon: "link",
                        iconColor: .green,
                        title: "Deposit Link",
                        subtitle: "Generate a link to request a deposit from customers",
                        action: { showDepositLinkSheet = true },
                        disabled: !viewModel.stripeConnected
                    )

                    // 3. Withdraw to Bank
                    Button(action: { /* TODO: Backend creates payout */ }) {
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
            .sheet(isPresented: $showDepositLinkSheet, onDismiss: { viewModel.depositLinkUrl = nil }) {
                DepositLinkSheet(viewModel: viewModel) {
                    showDepositLinkSheet = false
                }
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
