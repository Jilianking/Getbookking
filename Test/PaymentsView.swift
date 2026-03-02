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
                        if let err = viewModel.errorMessage {
                            Text(err)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(.horizontal)
                        }
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
                        action: { /* TODO: Stripe Terminal Tap to Pay */ },
                        disabled: !viewModel.stripeConnected
                    )

                    // 2. Deposit Link
                    PaymentActionCard(
                        icon: "link",
                        iconColor: .green,
                        title: "Deposit Link",
                        subtitle: "Generate a link to request a deposit from customers",
                        action: { /* TODO: Backend creates Payment Link */ },
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
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task { await viewModel.refresh(isDemoMode: authViewModel.isDemoMode) }
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
