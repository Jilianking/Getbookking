//
//  CardCheckoutPricing.swift
//
//  Customer pays service + grossed-up processing fees; provider nets full service amount.
//

import Foundation
import SwiftUI

enum CardCheckoutChannel: Equatable {
    case online
    case tapToPay
}

struct CardCheckoutBreakdown: Equatable {
    let serviceCents: Int
    /// Total pass-through fees added to the customer bill (card processing + platform).
    let passThroughFeeCents: Int
    let platformFeeCents: Int
    let totalCents: Int
    let channel: CardCheckoutChannel

    var cardProcessingFeeCents: Int {
        max(0, passThroughFeeCents - platformFeeCents)
    }

    var hasPassThroughFees: Bool { passThroughFeeCents > 0 }
}

enum CardCheckoutPricing {
    static let platformFeeBps = 100

    private static let stripeOnlineBps = 290
    private static let stripeOnlineFixedCents = 30
    private static let stripeCardPresentBps = 270
    private static let stripeCardPresentFixedCents = 5

    static func breakdown(
        serviceCents: Int,
        channel: CardCheckoutChannel = .online
    ) -> CardCheckoutBreakdown {
        let service = max(0, serviceCents)
        guard service > 0 else {
            return CardCheckoutBreakdown(
                serviceCents: 0,
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

        let combinedBps = stripeBps + platformFeeBps
        let total = Int(ceil(Double(service + stripeFixed) / (1.0 - Double(combinedBps) / 10_000.0)))
        let passThrough = total - service
        let platformFee = platformFeeCents(totalCents: total)

        return CardCheckoutBreakdown(
            serviceCents: service,
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

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Service")
                Spacer()
                Text(CardCheckoutPricing.formatUSD(cents: breakdown.serviceCents))
            }
            if breakdown.cardProcessingFeeCents > 0 {
                HStack {
                    Text("Card processing")
                    Spacer()
                    Text(CardCheckoutPricing.formatUSD(cents: breakdown.cardProcessingFeeCents))
                }
            }
            if breakdown.platformFeeCents > 0 {
                HStack {
                    Text("Platform fee (1%)")
                    Spacer()
                    Text(CardCheckoutPricing.formatUSD(cents: breakdown.platformFeeCents))
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
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
