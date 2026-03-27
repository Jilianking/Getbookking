//
//  DisplayFontOption.swift
//
//  Hero font choices for the public site hero title (`heroFont`). Web UI/body uses Inter.
//  See `fontStackForDisplayKey` in web/index.html for CSS family mapping.
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
    case poiretOne = "poiret-one"
    case foglihtenNo06 = "foglihten-no06"
    case butler = "butler"

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
        case .poiretOne: return "Poiret One"
        case .foglihtenNo06: return "Foglihten No06"
        case .butler: return "Butler"
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
