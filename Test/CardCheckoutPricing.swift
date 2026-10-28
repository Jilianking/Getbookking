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

    /// Mirror of card and Tap to Pay in `functions/checkoutRates.js`.
    /// Klarna, Affirm, and Link bank are priced on the web checkout.
    var rate: CheckoutRate {
        switch self {
        case .online:
            return CheckoutRate(bps: 290, fixedCents: 30, label: "2.9% + 30¢")
        case .tapToPay:
            return CheckoutRate(bps: 270, fixedCents: 15, label: "2.7% + 15¢")
        }
    }
}

/// One priced method. Platform fee (1%) is applied on top of `bps` + `fixedCents`.
struct CheckoutRate: Equatable {
    let bps: Int
    let fixedCents: Int
    let label: String
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

    /// User-facing Stripe rate for this channel (e.g. "2.9% + 30¢").
    static func stripeRateLabel(for channel: CardCheckoutChannel) -> String {
        channel.rate.label
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

        let feeBase = service + tax
        let total = exactTotalCents(feeBase: feeBase, rate: channel.rate)
        let passThrough = max(0, total - service - tax)
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

    /// Smallest total that leaves `feeBase` after Stripe's nearest-cent fee and the 1% platform fee.
    /// Mirror of `computeCardCheckoutAmounts` in functions/checkoutRates.js.
    static func exactTotalCents(feeBase: Int, rate: CheckoutRate) -> Int {
        let combinedBps = rate.bps + platformFeeBps
        var total = Int(ceil(Double(feeBase + rate.fixedCents) / (1.0 - Double(combinedBps) / 10_000.0)))
        while total > feeBase && netAfterFees(total: total - 1, rate: rate) >= feeBase {
            total -= 1
        }
        while netAfterFees(total: total, rate: rate) < feeBase {
            total += 1
        }
        return total
    }

    private static func netAfterFees(total: Int, rate: CheckoutRate) -> Int {
        let stripe = Int((Double(total * rate.bps) / 10_000.0).rounded()) + rate.fixedCents
        return total - stripe - platformFeeCents(totalCents: total)
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
                                .foregroundStyle(AppDesign.brandWarm)
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
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if breakdown.hasSalesTax {
                Text("Sales tax is collected for remittance.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
