//
//  PaymentRefundSheet.swift
//

import SwiftUI

private enum RefundMode: String, CaseIterable, Identifiable {
    case full
    case partial

    var id: String { rawValue }

    var label: String {
        switch self {
        case .full: return "Full refund"
        case .partial: return "Partial refund"
        }
    }
}

struct PaymentRefundSheet: View {
    let transaction: PaymentTransaction
    @ObservedObject var viewModel: PaymentsViewModel
    var onRefunded: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var refundMode: RefundMode = .full
    @State private var partialAmountText = ""
    @State private var localError: String?
    @State private var balanceLoaded = false
    /// Remaining refundable cents from Stripe (includes Dashboard/API refunds). nil until loaded.
    @State private var remainingRefundableCents: Int?
    /// Stable per attempt so retries of the same submit do not create duplicate Stripe refunds.
    @State private var refundAttemptId = UUID().uuidString
    @State private var cancelRefundBlocked = false
    @State private var cancelRefundBlockedReason: String?
    @FocusState private var amountFocused: Bool

    private var chargeTotalUSD: Double {
        transaction.grossAmount > 0 ? transaction.grossAmount : transaction.amount
    }

    private var chargeTotalCents: Int {
        Int(round(chargeTotalUSD * 100))
    }

    private var maxRefundCents: Int {
        if let remaining = remainingRefundableCents {
            return max(0, remaining)
        }
        return chargeTotalCents
    }

    private var maxRefundUSD: Double {
        Double(maxRefundCents) / 100
    }

    private var partialAmountCents: Int {
        let value = Double(partialAmountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var availableCents: Int {
        Int(round(max(0, viewModel.availableBalance) * 100))
    }

    private var refundAmountCents: Int {
        switch refundMode {
        case .full: return maxRefundCents
        case .partial: return partialAmountCents
        }
    }

    private var insufficientFunds: Bool {
        balanceLoaded && refundAmountCents > availableCents
    }

    private var alreadyFullyRefunded: Bool {
        remainingRefundableCents == 0
    }

    private var canSubmitPartial: Bool {
        partialAmountCents >= 50 && partialAmountCents <= maxRefundCents
    }

    private var canSubmit: Bool {
        guard !alreadyFullyRefunded else { return false }
        guard !cancelRefundBlocked else { return false }
        guard !insufficientFunds else { return false }
        switch refundMode {
        case .full: return maxRefundCents >= 50
        case .partial: return canSubmitPartial
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Amount paid")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppDesign.textSecondary)
                    Text(PaymentsViewModel.formatUSD(chargeTotalUSD))
                        .font(.title2.weight(.bold))
                    Text("Refunds come out of your available balance. Partial refunds cannot exceed what remains on this payment (including any refunds made in Stripe).")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                    if let remaining = remainingRefundableCents, remaining < chargeTotalCents {
                        Text("Already refunded: \(PaymentsViewModel.formatUSD(Double(chargeTotalCents - remaining) / 100)). Remaining: \(PaymentsViewModel.formatUSD(Double(remaining) / 100)).")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    if balanceLoaded {
                        HStack(spacing: 4) {
                            Text("Available balance:")
                                .foregroundStyle(AppDesign.textSecondary)
                            Text(PaymentsViewModel.formatUSD(Double(availableCents) / 100))
                                .fontWeight(.semibold)
                                .foregroundStyle(insufficientFunds ? .red : AppDesign.textPrimary)
                        }
                        .font(.caption)
                    }
                }

                Picker("Refund type", selection: $refundMode) {
                    ForEach(RefundMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(alreadyFullyRefunded || cancelRefundBlocked)

                if refundMode == .partial {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Refund amount")
                            .font(.subheadline.weight(.medium))
                        TextField("0.00", text: $partialAmountText)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                            .font(.title3.monospacedDigit())
                            .focused($amountFocused)
                            .disabled(alreadyFullyRefunded || cancelRefundBlocked)
                        Text("Max \(PaymentsViewModel.formatUSD(maxRefundUSD))")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                } else {
                    HStack {
                        Text("Customer receives")
                            .foregroundStyle(AppDesign.textSecondary)
                        Spacer()
                        Text(PaymentsViewModel.formatUSD(maxRefundUSD))
                            .fontWeight(.semibold)
                    }
                    .font(.subheadline)
                    .padding(14)
                    .appCard()
                }

                if cancelRefundBlocked {
                    Text(cancelRefundBlockedReason ?? "A refund is already pending for this cancelled booking.")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if alreadyFullyRefunded {
                    Text("This payment has already been fully refunded.")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if insufficientFunds {
                    Text("Not enough available funds for this refund. Funds from recent payments become available after they finish settling (usually about 2 business days). Try again then, or refund a smaller amount.")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if let localError {
                    Text(localError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Spacer(minLength: 0)

                Button {
                    Task { await submitRefund() }
                } label: {
                    HStack {
                        if viewModel.isRefunding {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text(submitTitle)
                                .fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(.white)
                    .background(canSubmit ? Color.orange : Color.gray)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit || viewModel.isRefunding)
            }
            .padding(20)
            .appScreenBackground()
            .navigationTitle("Refund payment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onChange(of: refundMode) { _, mode in
                localError = nil
                refundAttemptId = UUID().uuidString
                if mode == .partial {
                    amountFocused = true
                }
            }
            .onChange(of: partialAmountText) { _, _ in
                refundAttemptId = UUID().uuidString
            }
            .task {
                await refreshRefundContext()
            }
        }
    }

    private var submitTitle: String {
        switch refundMode {
        case .full:
            return "Refund \(PaymentsViewModel.formatUSD(maxRefundUSD))"
        case .partial:
            guard canSubmitPartial else { return "Refund" }
            return "Refund \(PaymentsViewModel.formatUSD(Double(partialAmountCents) / 100))"
        }
    }

    @MainActor
    private func refreshRefundContext() async {
        async let balance: Void = viewModel.refreshAvailableBalance()
        async let remaining: (
            remainingRefundableCents: Int?,
            refundBlocked: Bool,
            refundBlockedReason: String?
        ) = {
            guard let chargeId = transaction.chargeId else {
                return (remainingRefundableCents: nil as Int?, refundBlocked: false, refundBlockedReason: nil as String?)
            }
            return await viewModel.fetchChargeRefundStatus(chargeId: chargeId)
        }()
        _ = await balance
        let status = await remaining
        remainingRefundableCents = status.remainingRefundableCents
        cancelRefundBlocked = status.refundBlocked || transaction.refundBlocked
        cancelRefundBlockedReason = status.refundBlockedReason ?? transaction.refundBlockedReason
        balanceLoaded = true
    }

    @MainActor
    private func submitRefund() async {
        guard let chargeId = transaction.chargeId else { return }
        localError = nil

        // Re-check available balance and remaining (Dashboard/API may have changed either).
        await refreshRefundContext()
        if cancelRefundBlocked {
            localError = cancelRefundBlockedReason ?? "A refund is already pending for this cancelled booking."
            return
        }
        if alreadyFullyRefunded {
            localError = "This payment has already been fully refunded."
            return
        }
        if refundAmountCents > availableCents {
            localError = "Not enough available funds for this refund. Try again then, or refund a smaller amount."
            return
        }
        if let remaining = remainingRefundableCents, refundAmountCents > remaining {
            localError = "Refund amount exceeds what remains on this payment."
            return
        }

        let amountCents: Int?
        switch refundMode {
        case .full:
            amountCents = nil
        case .partial:
            guard canSubmitPartial else {
                localError = "Enter an amount between $0.50 and \(PaymentsViewModel.formatUSD(maxRefundUSD))."
                return
            }
            amountCents = partialAmountCents
        }

        let attemptKey = refundAttemptId
        let ok = await viewModel.createRefund(
            chargeId: chargeId,
            amountCents: amountCents,
            idempotencyKey: attemptKey
        )
        if ok {
            dismiss()
            onRefunded()
        } else {
            localError = viewModel.errorMessage ?? "Refund could not be completed."
            // Keep the same attemptKey on failure so a user retry of the identical
            // request collapses in Stripe; rotating happens when mode/amount changes.
        }
    }
}
