//
//  CardCheckoutPricing.swift
//
//  Customer pays service + optional sales tax + grossed-up processing fees;
//  provider nets full service amount.
//

import Foundation
import SwiftUI

enum CardCheckoutChannel: Equatable {
    case online
    case tapToPay
}

struct CardCheckoutBreakdown: Equatable {
    let serviceCents: Int
    /// Sales tax (exclusive), when in-person / applicable tax is enabled.
    let taxCents: Int
    /// Total pass-through fees added to the customer bill (card processing + platform).
    let passThroughFeeCents: Int
    let platformFeeCents: Int
    let totalCents: Int
    let channel: CardCheckoutChannel

    var cardProcessingFeeCents: Int {
        max(0, passThroughFeeCents - platformFeeCents)
    }

    var hasPassThroughFees: Bool { passThroughFeeCents > 0 }
    var hasSalesTax: Bool { taxCents > 0 }
}

enum CardCheckoutPricing {
    static let platformFeeBps = 100

    private static let stripeOnlineBps = 290
    private static let stripeOnlineFixedCents = 30
    private static let stripeCardPresentBps = 270
    /// In-person 5¢ + Tap to Pay authorization 10¢ (Stripe Terminal US pricing).
    private static let stripeCardPresentFixedCents = 15

    /// User-facing Stripe rate for this channel (e.g. "2.9% + 30¢").
    static func stripeRateLabel(for channel: CardCheckoutChannel) -> String {
        switch channel {
        case .online:
            return "2.9% + 30¢"
        case .tapToPay:
            return "2.7% + 15¢"
        }
    }

    static func breakdown(
        serviceCents: Int,
        channel: CardCheckoutChannel = .online,
        taxCents: Int = 0
    ) -> CardCheckoutBreakdown {
        let service = max(0, serviceCents)
        let tax = max(0, taxCents)
        guard service > 0 else {
            return CardCheckoutBreakdown(
                serviceCents: 0,
                taxCents: 0,
                passThroughFeeCents: 0,
                platformFeeCents: 0,
                totalCents: 0,
                channel: channel
            )
        }

        let stripeBps: Int
        let stripeFixed: Int
        switch channel {
        case .online:
            stripeBps = stripeOnlineBps
            stripeFixed = stripeOnlineFixedCents
        case .tapToPay:
            stripeBps = stripeCardPresentBps
            stripeFixed = stripeCardPresentFixedCents
        }

        // Fees are grossed up on the service amount only (tax is added on top), matching server.
        let combinedBps = stripeBps + platformFeeBps
        let servicePlusFees = Int(ceil(Double(service + stripeFixed) / (1.0 - Double(combinedBps) / 10_000.0)))
        let passThrough = servicePlusFees - service
        let total = servicePlusFees + tax
        let platformFee = platformFeeCents(totalCents: total)

        return CardCheckoutBreakdown(
            serviceCents: service,
            taxCents: tax,
            passThroughFeeCents: passThrough,
            platformFeeCents: platformFee,
            totalCents: total,
            channel: channel
        )
    }

    static func platformFeeCents(totalCents: Int) -> Int {
        let total = max(0, totalCents)
        guard total > 0 else { return 0 }
        return max(1, Int(round(Double(total * platformFeeBps) / 10_000.0)))
    }

    static func formatUSD(cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: Double(cents) / 100.0)) ?? "$0.00"
    }
}

struct CardCheckoutBreakdownView: View {
    let breakdown: CardCheckoutBreakdown
    var alwaysShowFeeLines: Bool = false
    /// Tighter type/padding for constrained screens (e.g. Tap to Pay entry).
    var compact: Bool = false
    @State private var showFeeDetails = false

    private var showFeeRow: Bool {
        alwaysShowFeeLines || breakdown.hasPassThroughFees
    }

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            HStack {
                Text("Service")
                Spacer()
                Text(CardCheckoutPricing.formatUSD(cents: breakdown.serviceCents))
            }
            if breakdown.hasSalesTax {
                HStack {
                    Text("Sales tax")
                    Spacer()
                    Text(CardCheckoutPricing.formatUSD(cents: breakdown.taxCents))
                }
            }
            if showFeeRow {
                HStack(alignment: .firstTextBaseline) {
                    HStack(spacing: 4) {
                        Text(compact ? "Fees" : "Processing & service fees")
                        Button {
                            showFeeDetails.toggle()
                        } label: {
                            Image(systemName: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Processing fee details")
                        .popover(isPresented: $showFeeDetails, arrowEdge: .bottom) {
                            feeDetailsPopover
                        }
                    }
                    Spacer()
                    Text(CardCheckoutPricing.formatUSD(cents: breakdown.passThroughFeeCents))
                }
            }
            Divider()
            HStack {
                Text("Customer pays")
                    .fontWeight(.semibold)
                Spacer()
                Text(CardCheckoutPricing.formatUSD(cents: breakdown.totalCents))
                    .fontWeight(.semibold)
            }
            HStack {
                Text("You receive")
                    .fontWeight(.semibold)
                Spacer()
                Text(CardCheckoutPricing.formatUSD(cents: breakdown.serviceCents))
                    .fontWeight(.semibold)
            }
        }
        .font(compact ? .caption : .subheadline)
        .foregroundStyle(.secondary)
        .padding(compact ? 10 : 12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onChange(of: breakdown) { _, _ in
            showFeeDetails = false
        }
    }

    private var feeDetailsPopover: some View {
        let stripeRate = CardCheckoutPricing.stripeRateLabel(for: breakdown.channel)
        return VStack(alignment: .leading, spacing: 6) {
            if breakdown.cardProcessingFeeCents > 0 {
                feeDetailLine(
                    title: "Card processing (Stripe \(stripeRate))",
                    amount: breakdown.cardProcessingFeeCents
                )
            }
            if breakdown.platformFeeCents > 0 {
                feeDetailLine(
                    title: "Platform fee (1%)",
                    amount: breakdown.platformFeeCents
                )
            }
            if breakdown.passThroughFeeCents <= 0 {
                Text("Includes Stripe card processing (\(stripeRate)) and a 1% platform fee.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("The business receives the full service amount.")
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            if breakdown.hasSalesTax {
                Text("Sales tax is collected for remittance.")
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(minWidth: 248, idealWidth: 268, maxWidth: 300, alignment: .leading)
        // Use the system sheet on iPhone so a compact popover can't float over controls.
        .presentationCompactAdaptation(.sheet)
    }

    private func feeDetailLine(title: String, amount: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(title)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Text(CardCheckoutPricing.formatUSD(cents: amount))
                .foregroundStyle(.primary)
        }
    }
}
