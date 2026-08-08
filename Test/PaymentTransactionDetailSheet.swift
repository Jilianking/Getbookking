//
//  PaymentTransactionDetailSheet.swift
//

import SwiftUI
import UIKit

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
    @State private var showFeeDetails = false

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

    private var teamMemberLabel: String {
        let n = (transaction.attributedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Team member" : n
    }

    private var feeBreakdownForPopover: CardCheckoutBreakdown {
        let serviceCents: Int = {
            if let s = transaction.sourcePaymentService, s > 0 {
                return Int(round(s * 100))
            }
            if let total = transaction.sourcePaymentTotal, total > 0,
               let fee = transaction.sourcePassThroughFee, fee > 0 {
                return max(0, Int(round((total - fee) * 100)))
            }
            return Int(round(transaction.amount * 100))
        }()
        return CardCheckoutPricing.breakdown(serviceCents: max(serviceCents, 0), channel: .online)
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

                    detailCard(title: transaction.isStudioShareLine ? "Team member" : "Client") {
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
                                if transaction.isStudioShareLine {
                                    Text(teamMemberLabel)
                                        .font(.headline)
                                    Text(transaction.studioSharePartyLabel ?? "Studio share")
                                        .font(.caption)
                                        .foregroundStyle(AppDesign.textSecondary)
                                } else {
                                    Text(transaction.displayTitle)
                                        .font(.headline)
                                    Text(transaction.subtitleText)
                                        .font(.caption)
                                        .foregroundStyle(AppDesign.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }

                    detailCard(title: "Breakdown") {
                        if transaction.isStudioShareLine {
                            studioShareBreakdown
                        } else {
                            paymentBreakdown
                        }
                    }

                    if !transaction.isStudioShareLine, transaction.chargeId != nil {
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
    private var studioShareBreakdown: some View {
        breakdownRow(
            label: transaction.isCredit ? "From" : "Sent to",
            value: transaction.isCredit ? teamMemberLabel : "Studio",
            valueIsText: true
        )
        if let total = transaction.sourcePaymentTotal, total > 0 {
            Divider()
            breakdownRow(label: "Total charged", value: PaymentsViewModel.formatUSD(total))
        } else if let service = transaction.sourcePaymentService, service > 0 {
            Divider()
            breakdownRow(label: "Total charged", value: PaymentsViewModel.formatUSD(service))
        }
        Divider()
        processingFeeRow
        Divider()
        HStack {
            Text(transaction.isCredit ? "Your split" : "Studio split")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(PaymentsViewModel.formatUSD(transaction.amount))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(transaction.isCredit ? .green : AppDesign.textPrimary)
        }
    }

    @ViewBuilder
    private var paymentBreakdown: some View {
        if transaction.isPayoutLine {
            payoutBreakdown
        } else {
            breakdownRow(label: "Service", value: serviceLabel, valueIsText: true)
            Divider()
            breakdownRow(
                label: "Subtotal",
                value: PaymentsViewModel.formatUSD(transaction.grossAmount > 0 ? transaction.grossAmount : transaction.amount)
            )
            Divider()
            processingFeeRow
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
    }

    /// Standard Instant/bank withdraw — no card “Paid by client” fee estimate.
    @ViewBuilder
    private var payoutBreakdown: some View {
        breakdownRow(label: "Service", value: "Payout", valueIsText: true)
        Divider()
        breakdownRow(
            label: "Amount",
            value: PaymentsViewModel.formatUSD(transaction.grossAmount > 0 ? transaction.grossAmount : transaction.amount)
        )
        let payoutFee = transaction.displayedProcessingFee
        if payoutFee > 0 {
            Divider()
            HStack {
                Text("Instant fee")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                Spacer()
                Text(PaymentsViewModel.formatUSD(payoutFee))
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textPrimary)
            }
        }
        Divider()
        HStack {
            Text(transaction.isCredit ? "Credited" : "Withdrawn")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(PaymentsViewModel.formatUSD(transaction.amount))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(transaction.isCredit ? .green : AppDesign.textPrimary)
        }
    }

    private var processingFeeRow: some View {
        let fee = transaction.displayedProcessingFee
        let stripeRate = CardCheckoutPricing.stripeRateLabel(for: .online)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            HStack(spacing: 4) {
                Text("Processing fee")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                Button {
                    showFeeDetails.toggle()
                } label: {
                    Image(systemName: "info.circle")
                        .font(.caption)
                        .foregroundStyle(AppDesign.brandWarm)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Processing fee details")
                .popover(isPresented: $showFeeDetails, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if feeBreakdownForPopover.cardProcessingFeeCents > 0 {
                            HStack {
                                Text("Card processing (Stripe \(stripeRate))")
                                Spacer(minLength: 8)
                                Text(CardCheckoutPricing.formatUSD(cents: feeBreakdownForPopover.cardProcessingFeeCents))
                            }
                        }
                        if feeBreakdownForPopover.platformFeeCents > 0 {
                            HStack {
                                Text("Platform fee (1%)")
                                Spacer(minLength: 8)
                                Text(CardCheckoutPricing.formatUSD(cents: feeBreakdownForPopover.platformFeeCents))
                            }
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .padding(12)
                    .frame(minWidth: 248, idealWidth: 268, maxWidth: 300, alignment: .leading)
                    .background(.ultraThinMaterial)
                    .presentationBackground(.ultraThinMaterial)
                    .presentationCompactAdaptation(.popover)
                }
            }
            Spacer(minLength: 12)
            HStack(spacing: 4) {
                if fee > 0 {
                    Text(PaymentsViewModel.formatUSD(fee))
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textPrimary)
                }
                if fee > 0 || transaction.processingFeePaidByClient {
                    Text(fee > 0 ? "(Paid by client)" : "Paid by client")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            .multilineTextAlignment(.trailing)
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
        guard let detail,
              let url = PaymentReceiptPDFExporter.writePDF(detail: detail) else { return }
        receiptPDFURL = url
        showReceiptShare = true
    }

    private func sendReceiptInMessages() async {
        guard let detail = await loadReceiptDetail() else { return }
        let shareText = detail.messagesShareLinkOrBody()
        UIPasteboard.general.string = shareText
        drawerState.messagesComposePhone = nil
        drawerState.messagesComposeClientName = nil
        drawerState.messagesComposeBookingRequestId = nil
        drawerState.messagesComposeBody = shareText
        drawerState.messagesShouldOpenCompose = true
        drawerState.selectedSection = .messages
        drawerState.isOpen = false
        dismiss()
    }
}
