//
//  BookingFormStyle.swift
//
//  Public /book layout: standard stacked form vs guided (grid + pills + sections).
//  Independent of site theme (Luxe, Blade, etc.); colors follow the active theme.
//

import Foundation

enum BookingFormStyle: String, CaseIterable, Identifiable {
    case standard
    case guided

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .guided: return "Guided"
        }
    }

    var subtitle: String {
        switch self {
        case .standard:
            return "Classic card with dropdowns and stacked fields."
        case .guided:
            return "4-step wizard: service, tattoo details, your info, then confirm. Uses your theme colors."
        }
    }

    static func resolved(stored: String?) -> BookingFormStyle {
        let raw = (stored ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return BookingFormStyle(rawValue: raw) ?? .standard
    }
}
