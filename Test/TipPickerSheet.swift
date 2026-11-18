//
//  TipPickerSheet.swift
//  Shown before charging (hand the phone to the client): 15% · 20% · 25% · Custom · No tip.
//  The tip goes on top of the total with no card fee, 100% to the staff member.
//

import SwiftUI

enum ShopTipSettings {
    /// Tips are on unless the owner turned them off (tenant.tipsEnabled == false).
    static func enabled(_ tenant: [String: Any]?) -> Bool {
        (tenant?["tipsEnabled"] as? Bool) != false
    }

    static func percents(_ tenant: [String: Any]?) -> [Int] {
        let raw = (tenant?["tipPercents"] as? [Any]) ?? []
        let parsed = raw.compactMap { ($0 as? NSNumber)?.intValue }.filter { $0 > 0 && $0 <= 100 }
        return parsed.count == 3 ? parsed : [15, 20, 25]
    }

    /// Tip on the service amount (before tax and fees), rounded to the cent.
    static func tipCents(percent: Int, serviceCents: Int) -> Int {
        Int((Double(serviceCents) * Double(percent) / 100).rounded())
    }
}

struct TipPickerSheet: View {
    let serviceCents: Int
    /// Total before the tip (service + tax + fees) so each choice can show the new total.
    var baseTotalCents: Int = 0
    var feeCents: Int = 0
    var taxCents: Int = 0
    /// Card fee on the tip is added for the client (Tap to Pay vs. card entry rates differ).
    var channel: CardCheckoutChannel = .tapToPay
    let percents: [Int]
    /// Called with the chosen tip in cents (0 = no tip).
    let onChoose: (Int) -> Void
    let onCancel: () -> Void

    @State private var showCustom = false
    @State private var customText = ""

    private func usd(_ cents: Int) -> String { CardCheckoutPricing.formatUSD(cents: cents) }

    private var base: Int { baseTotalCents > 0 ? baseTotalCents : serviceCents }

    /// What the client pays with this tip: total + tip + the card fee on the tip.
    private func totalWith(_ tip: Int) -> Int {
        base + tip + CardCheckoutPricing.tipCardFeeCents(tipCents: tip, channel: channel)
    }

    private var customTipCents: Int {
        let dollars = Double(customText.replacingOccurrences(of: ",", with: ".")) ?? 0
        return max(0, Int((dollars * 100).rounded()))
    }

    private var summaryLine: String {
        var parts = ["Service \(usd(serviceCents))"]
        if taxCents > 0 { parts.append("Tax \(usd(taxCents))") }
        if feeCents > 0 { parts.append("Fees \(usd(feeCents))") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                Text("Add a tip?")
                    .font(.largeTitle.weight(.bold))
                    .padding(.top, 8)
                Text(summaryLine)
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .multilineTextAlignment(.center)

                ForEach(percents, id: \.self) { pct in
                    let cents = ShopTipSettings.tipCents(percent: pct, serviceCents: serviceCents)
                    Button { onChoose(cents) } label: {
                        HStack {
                            Text("\(pct)%").font(.title2.weight(.semibold))
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(usd(cents)).font(.title3.weight(.semibold))
                                Text("Total \(usd(totalWith(cents)))")
                                    .font(.caption)
                                    .opacity(0.8)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 18)
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(.white)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AppDesign.brandDark))
                    }
                    .buttonStyle(.plain)
                }

                if showCustom {
                    HStack(spacing: 10) {
                        Text("$").font(.title2)
                        TextField("0.00", text: $customText)
                            .keyboardType(.decimalPad)
                            .font(.title2)
                        Button("Add") {
                            let dollars = Double(customText.replacingOccurrences(of: ",", with: ".")) ?? 0
                            onChoose(max(0, Int((dollars * 100).rounded())))
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AppDesign.brandDark)
                    }
                    .padding(.horizontal, 4)
                    if customTipCents > 0 {
                        Text("Tip \(usd(customTipCents)) · Total \(usd(totalWith(customTipCents)))")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                } else {
                    Button("Custom amount") { showCustom = true }
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AppDesign.chipBorder, lineWidth: 1))
                        .buttonStyle(.plain)
                }

                Button("No tip · Total \(usd(base))") { onChoose(0) }
                    .font(.headline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding(.top, 4)

                Spacer()
            }
            .padding(20)
            .appScreenBackground()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back", action: onCancel)
                }
            }
        }
    }
}
