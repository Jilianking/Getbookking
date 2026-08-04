//
//  BookingFormStyle.swift
//
//  Public /book layout for form booking types only: standard card vs guided wizard.
//  Calendar / slots is a Booking type in Booking settings (not a Design layout).
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
            return "Multi-step wizard for service, project details, and contact info."
        }
    }

    /// Form-layout choices only (never calendar — that is Booking type Calendar / slots).
    static var formCases: [BookingFormStyle] { allCases }

    static func resolved(stored: String?) -> BookingFormStyle {
        let raw = (stored ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Legacy Design value that meant Online booking → treat form style as standard;
        // Booking type Calendar / slots migrates via BookingMode.
        if raw == "calendar" || raw == "online" || raw == "online_booking" || raw == "appointments" {
            return .standard
        }
        return BookingFormStyle(rawValue: raw) ?? .standard
    }
}
