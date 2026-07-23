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
    @FocusState private var amountFocused: Bool

    private var chargeTotalUSD: Double {
        transaction.grossAmount > 0 ? transaction.grossAmount : transaction.amount
    }

    private var maxRefundCents: Int {
        Int(round(chargeTotalUSD * 100))
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

    private var canSubmitPartial: Bool {
        partialAmountCents >= 50 && partialAmountCents <= maxRefundCents
    }

    private var canSubmit: Bool {
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
                    Text("Refunds come out of your available balance. Partial refunds cannot exceed the amount paid.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
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

                if refundMode == .partial {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Refund amount")
                            .font(.subheadline.weight(.medium))
                        TextField("0.00", text: $partialAmountText)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                            .font(.title3.monospacedDigit())
                            .focused($amountFocused)
                        Text("Max \(PaymentsViewModel.formatUSD(chargeTotalUSD))")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                } else {
                    HStack {
                        Text("Customer receives")
                            .foregroundStyle(AppDesign.textSecondary)
                        Spacer()
                        Text(PaymentsViewModel.formatUSD(chargeTotalUSD))
                            .fontWeight(.semibold)
                    }
                    .font(.subheadline)
                    .padding(14)
                    .appCard()
                }

                if insufficientFunds {
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
                if mode == .partial {
                    amountFocused = true
                }
            }
            .task {
                await viewModel.refreshAvailableBalance()
                balanceLoaded = true
            }
        }
    }

    private var submitTitle: String {
        switch refundMode {
        case .full:
            return "Refund \(PaymentsViewModel.formatUSD(chargeTotalUSD))"
        case .partial:
            guard canSubmitPartial else { return "Refund" }
            return "Refund \(PaymentsViewModel.formatUSD(Double(partialAmountCents) / 100))"
        }
    }

    @MainActor
    private func submitRefund() async {
        guard let chargeId = transaction.chargeId else { return }
        localError = nil

        let amountCents: Int?
        switch refundMode {
        case .full:
            amountCents = nil
        case .partial:
            guard canSubmitPartial else {
                localError = "Enter an amount between $0.50 and \(PaymentsViewModel.formatUSD(chargeTotalUSD))."
                return
            }
            amountCents = partialAmountCents
        }

        let ok = await viewModel.createRefund(chargeId: chargeId, amountCents: amountCents)
        if ok {
            dismiss()
            onRefunded()
        } else {
            localError = viewModel.errorMessage ?? "Refund could not be completed."
        }
    }
}
