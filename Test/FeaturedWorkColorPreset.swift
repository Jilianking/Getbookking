//
//  FeaturedWorkColorPreset.swift
//
//  Curated background + text pairs for the home “Featured work” section (tattoo template).
//

import SwiftUI

struct FeaturedWorkColorPreset: Identifiable, Hashable {
    let id: String
    let name: String
    let backgroundHex: String
    let textHex: String
}

enum FeaturedWorkColorPresets {
    /// Curated, readable pairs.
    static let all: [FeaturedWorkColorPreset] = [
        FeaturedWorkColorPreset(id: "white", name: "White", backgroundHex: "#FFFFFF", textHex: "#111111"),
        FeaturedWorkColorPreset(id: "softGray", name: "Soft gray", backgroundHex: "#F4F4F5", textHex: "#18181B"),
        FeaturedWorkColorPreset(id: "stone", name: "Stone", backgroundHex: "#F5F5F4", textHex: "#1C1917"),
        FeaturedWorkColorPreset(id: "warmPaper", name: "Warm paper", backgroundHex: "#FAF8F5", textHex: "#1C1917"),
        FeaturedWorkColorPreset(id: "coolSlate", name: "Cool slate", backgroundHex: "#F8FAFC", textHex: "#0F172A"),
        FeaturedWorkColorPreset(id: "sand", name: "Sand", backgroundHex: "#F5F0E8", textHex: "#292524"),
        FeaturedWorkColorPreset(id: "mist", name: "Mist", backgroundHex: "#EEF2FF", textHex: "#1E1B4B"),
        FeaturedWorkColorPreset(id: "ink", name: "Ink", backgroundHex: "#0F172A", textHex: "#F8FAFC"),
        FeaturedWorkColorPreset(id: "charcoal", name: "Charcoal", backgroundHex: "#1C1917", textHex: "#FAFAF9")
    ]

    /// Picks the preset whose background is closest in RGB to the given hex (legacy custom colors).
    static func nearest(toBackgroundHex hex: String) -> FeaturedWorkColorPreset? {
        let target = normalizeHex(hex)
        guard target.count == 6 else { return all.first }
        if let exact = all.first(where: { normalizeHex($0.backgroundHex) == target }) {
            return exact
        }
        return all.min(by: {
            colorDistance($0.backgroundHex, targetSix: target) < colorDistance($1.backgroundHex, targetSix: target)
        })
    }

    private static func normalizeHex(_ s: String) -> String {
        var x = s.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if x.hasPrefix("#") { x.removeFirst() }
        return x
    }

    private static func rgb(fromHex hex: String) -> (Int, Int, Int)? {
        let n = normalizeHex(hex)
        guard n.count == 6, let v = Int(n, radix: 16) else { return nil }
        return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    }

    private static func colorDistance(_ presetHex: String, targetSix: String) -> Double {
        guard let a = rgb(fromHex: presetHex), let b = rgb(fromHex: targetSix) else { return .infinity }
        let dr = Double(a.0 - b.0), dg = Double(a.1 - b.1), db = Double(a.2 - b.2)
        return dr * dr + dg * dg + db * db
    }
}
