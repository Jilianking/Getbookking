//
//  GalleryLayoutStyle.swift
//
//  Full-page `/gallery` presentation — independent of web template (Classic, Luxe, Blade, Stonecut, Studio 12).
//  Firestore: `galleryLayoutStyle`. Cinematic is not offered (maps to classic grid on read).
//

import Foundation

enum GalleryLayoutStyle: String, CaseIterable, Identifiable {
    /// Standard grid (portfolio `.gallery-grid` or Studio 12 native page grid).
    case classicGrid = "classic_grid"
    case masonry
    case horizontalStrip = "horizontal_strip"

    var id: String { rawValue }

    var menuTitle: String {
        switch self {
        case .classicGrid: return "Classic grid"
        case .masonry: return "Masonry"
        case .horizontalStrip: return "Horizontal strip"
        }
    }

    var detail: String {
        switch self {
        case .classicGrid:
            return "Even grid of tiles — works with every site template."
        case .masonry:
            return "Variable-height columns for an editorial look."
        case .horizontalStrip:
            return "Scroll sideways through portrait-style tiles."
        }
    }

    static func fromStored(_ value: String?) -> GalleryLayoutStyle {
        let key = (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
        if key.isEmpty || key == "legacy" || key == "default" { return .classicGrid }
        if key == "cinematic" { return .classicGrid }
        return GalleryLayoutStyle(rawValue: key) ?? .classicGrid
    }
}
