//
//  DisplayFontOption.swift
//
//  Google Fonts for public site display headings (`heroFont` on tenant). See web/index.html.
//

import Foundation

enum DisplayFontOption: String, CaseIterable, Identifiable {
    case kanit = "kanit"
    case oswald = "oswald"
    case playfair = "playfair"
    case plusJakartaSans = "plus-jakarta-sans"
    case teko = "teko"
    case libreBaskerville = "libre-baskerville"
    case cormorantGaramond = "cormorant-garamond"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .kanit: return "Kanit"
        case .oswald: return "Oswald"
        case .playfair: return "Playfair Display"
        case .plusJakartaSans: return "Plus Jakarta Sans"
        case .teko: return "Teko"
        case .libreBaskerville: return "Libre Baskerville"
        case .cormorantGaramond: return "Cormorant Garamond"
        }
    }

    /// Maps Firestore `heroFont` / legacy `headlineFont`; unknown values default to Kanit.
    static func fromStored(_ value: String?) -> DisplayFontOption {
        guard let v = value?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else {
            return .kanit
        }
        return DisplayFontOption(rawValue: v) ?? .kanit
    }
}
