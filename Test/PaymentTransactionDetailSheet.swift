//
//  PaymentTransactionDetailSheet.swift
//

import SwiftUI

struct PaymentTransactionDetailSheet: View {
    let transaction: PaymentTransaction
    @ObservedObject var viewModel: PaymentsViewModel
    var drawerState: DrawerState
    @EnvironmentObject private var sessionStore: TenantSessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var showRefundSheet = false
    @State private var receiptDetail: PaymentReceiptDetail?
    @State private var showReceiptSheet = false
    @State private var showReceiptShare = false
    @State private var receiptPDFURL: URL?
    @State private var isLoadingReceipt = false
    @State private var isPreparingShare = false

    private var businessName: String {
        let fromTenant = (sessionStore.tenant?["businessName"] as? String
            ?? sessionStore.tenant?["displayName"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return fromTenant.isEmpty ? "Receipt" : fromTenant
    }

    private var serviceLabel: String {
        let trimmed = (transaction.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed.lowercased() != "payment" { return trimmed }
        return transaction.channelLabel
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 12) {
                        Text("\(transaction.isCredit ? "+" : "-")\(PaymentsViewModel.formatUSD(transaction.amount))")
                            .font(.system(size: 40, weight: .bold, design: .rounded))
                            .foregroundStyle(transaction.isCredit ? Color.green : AppDesign.textPrimary)
                        if transaction.isPaid {
                            Label("Paid", systemImage: "checkmark.circle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.green)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 6)
                                .background(Color.green.opacity(0.12))
                                .clipShape(Capsule())
                        } else if transaction.status == "pending" {
                            Text("Pending")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 6)
                                .background(Color.orange.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)

                    detailCard(title: "Client") {
                        HStack(spacing: 14) {
                            Circle()
                                .fill(Color.orange.opacity(0.18))
                                .frame(width: 48, height: 48)
                                .overlay(
                                    Text(transaction.initials)
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(.orange)
                                )
                            VStack(alignment: .leading, spacing: 4) {
                                Text(transaction.displayTitle)
                                    .font(.headline)
                                Text(transaction.subtitleText)
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                            Spacer(minLength: 0)
                        }
                    }

                    detailCard(title: "Breakdown") {
                        breakdownRow(label: "Service", value: serviceLabel, valueIsText: true)
                        Divider()
                        breakdownRow(label: "Subtotal", value: PaymentsViewModel.formatUSD(transaction.grossAmount > 0 ? transaction.grossAmount : transaction.amount))
                        Divider()
                        breakdownRow(
                            label: "Processing fee",
                            value: transaction.feeAmount > 0 ? PaymentsViewModel.formatUSD(transaction.feeAmount) : "Paid by client",
                            valueIsText: transaction.feeAmount <= 0
                        )
                        Divider()
                        HStack {
                            Text("You received")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(PaymentsViewModel.formatUSD(transaction.amount))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.green)
                        }
                    }

                    if transaction.chargeId != nil {
                        HStack(spacing: 12) {
                            Button {
                                Task { await openReceipt() }
                            } label: {
                                Label("View receipt", systemImage: "doc.text")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .disabled(isLoadingReceipt)

                            Menu {
                                Button {
                                    Task { await shareReceiptPDF() }
                                } label: {
                                    Label("Share PDF", systemImage: "doc.fill")
                                }
                                Button {
                                    Task { await sendReceiptInMessages() }
                                } label: {
                                    Label("Send in Messages", systemImage: "message")
                                }
                            } label: {
                                Label("Share receipt", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .disabled(isPreparingShare || isLoadingReceipt)
                        }

                        Button("Refund payment") {
                            showRefundSheet = true
                        }
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .disabled(viewModel.isRefunding)
                    }
                }
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle("Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showRefundSheet) {
                PaymentRefundSheet(
                    transaction: transaction,
                    viewModel: viewModel,
                    onRefunded: { dismiss() }
                )
            }
            .overlay {
                if isLoadingReceipt {
                    ProgressView("Loading receipt…")
                        .padding(20)
                        .background(.ultraThinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
            .sheet(isPresented: $showReceiptSheet) {
                if let receiptDetail {
                    PaymentReceiptSheet(
                        detail: receiptDetail,
                        drawerState: drawerState,
                        onDismissAll: {
                            showReceiptSheet = false
                            dismiss()
                        }
                    )
                }
            }
            .sheet(isPresented: $showReceiptShare, onDismiss: { receiptPDFURL = nil }) {
                if let receiptPDFURL {
                    ReceiptShareSheet(items: [receiptPDFURL])
                }
            }
        }
    }

    @ViewBuilder
    private func detailCard(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    @ViewBuilder
    private func breakdownRow(label: String, value: String, valueIsText: Bool = false) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(valueIsText ? AppDesign.textSecondary : AppDesign.textPrimary)
        }
    }

    @MainActor
    private func loadReceiptDetail() async -> PaymentReceiptDetail? {
        guard let chargeId = transaction.chargeId else { return nil }
        isLoadingReceipt = true
        defer { isLoadingReceipt = false }
        let detail = await viewModel.fetchReceiptDetail(
            chargeId: chargeId,
            fallbackTransaction: transaction,
            businessName: businessName
        )
        receiptDetail = detail
        return detail
    }

    private func openReceipt() async {
        guard await loadReceiptDetail() != nil else { return }
        showReceiptSheet = true
    }

    private func shareReceiptPDF() async {
        isPreparingShare = true
        defer { isPreparingShare = false }
        let detail: PaymentReceiptDetail?
        if let receiptDetail {
            detail = receiptDetail
        } else {
            detail = await loadReceiptDetail()
        }
        guard let detail else { return }
        guard let url = viewModel.receiptPDFURL(for: detail) else { return }
        receiptPDFURL = url
        showReceiptShare = true
    }

    @MainActor
    private func sendReceiptInMessages() async {
        isPreparingShare = true
        defer { isPreparingShare = false }
        let detail: PaymentReceiptDetail?
        if let receiptDetail {
            detail = receiptDetail
        } else {
            detail = await loadReceiptDetail()
        }
        guard let detail else { return }
        openMessagesCompose(with: detail)
        dismiss()
    }

    private func openMessagesCompose(with detail: PaymentReceiptDetail) {
        drawerState.messagesComposeBody = detail.smsBody()
        drawerState.messagesShouldOpenCompose = true
        drawerState.selectedSection = .messages
        drawerState.isOpen = false
    }
}
