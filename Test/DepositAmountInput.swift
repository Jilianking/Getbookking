//
//  DepositAmountInput.swift
//  Per-appointment deposit entry (Approve + deposit, Deposit to confirm).
//

import SwiftUI

enum DepositAmountInput {
    static let minimumUSD: Double = 0.50

    static func parse(_ raw: String) -> Double? {
        let cleaned = raw
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let value = Double(cleaned), value > 0 else { return nil }
        return value
    }

    static func isValidForLink(_ amount: Double?) -> Bool {
        guard let amount else { return false }
        return amount >= minimumUSD
    }

    static func initialText(defaultAmount: Double?) -> String {
        guard let defaultAmount, defaultAmount > 0 else { return "" }
        return String(format: "%.2f", defaultAmount)
    }
}

struct PerAppointmentDepositSection: View {
    let sectionTitle: String
    let sendToggleTitle: String
    @Binding var amountText: String
    @Binding var sendViaText: Bool
    let canSendSms: Bool
    var skipSendCaption: String = "Skip sending — confirm without deposit"
    var unavailableSmsCaption: String = "Texting or client phone is unavailable — confirm without sending a link."

    private var parsedAmount: Double? {
        DepositAmountInput.parse(amountText)
    }

    private var amountIsValid: Bool {
        DepositAmountInput.isValidForLink(parsedAmount)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            BookingRequestSectionHeader(title: sectionTitle)

            VStack(alignment: .leading, spacing: 8) {
                Text("Deposit amount")
                    .font(.subheadline)
                HStack(spacing: 8) {
                    TextField("0.00", text: $amountText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospacedDigit())
                    Text("USD")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                if !amountText.isEmpty, !amountIsValid {
                    Text("Enter at least \(formattedMinimum) to send a payment link.")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Text("Set the deposit for this appointment — it can differ from your default in Settings.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }

            Toggle(sendToggleTitle, isOn: $sendViaText)
                .disabled(!canSendSms)

            Text(toggleCaption)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var toggleCaption: String {
        if !canSendSms { return unavailableSmsCaption }
        if sendViaText {
            return amountIsValid
                ? "Client will receive a text with payment link"
                : "Enter a deposit amount to send a link"
        }
        return skipSendCaption
    }

    private var formattedMinimum: String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f.string(from: NSNumber(value: DepositAmountInput.minimumUSD)) ?? "$0.50"
    }
}
