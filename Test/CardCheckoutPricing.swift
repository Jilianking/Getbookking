//
//  CardCheckoutPricing.swift
//
//  Restaurant-style checkout: service amount + card processing surcharge on top.
//

import Foundation
import SwiftUI

struct CardCheckoutBreakdown: Equatable {
    let serviceCents: Int
    let surchargeCents: Int
    let totalCents: Int
    let surchargeEnabled: Bool
    let surchargeBps: Int

    var surchargePercentLabel: String {
        String(format: "%.1f%%", Double(surchargeBps) / 100.0)
    }
}

enum CardCheckoutPricing {
    static let defaultSurchargeBps = 300

    static func breakdown(
        serviceCents: Int,
        surchargeEnabled: Bool,
        surchargeBps: Int = defaultSurchargeBps
    ) -> CardCheckoutBreakdown {
        let service = max(0, serviceCents)
        let bps = min(500, max(0, surchargeBps))
        var surcharge = 0
        if surchargeEnabled, bps > 0, service > 0 {
            surcharge = Int(round(Double(service * bps) / 10_000.0))
            if surcharge < 1, service >= 50 { surcharge = 1 }
        }
        return CardCheckoutBreakdown(
            serviceCents: service,
            surchargeCents: surcharge,
            totalCents: service + surcharge,
            surchargeEnabled: surchargeEnabled,
            surchargeBps: bps
        )
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
            if breakdown.surchargeCents > 0 {
                HStack {
                    Text("Card processing (\(breakdown.surchargePercentLabel))")
                    Spacer()
                    Text(CardCheckoutPricing.formatUSD(cents: breakdown.surchargeCents))
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
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
