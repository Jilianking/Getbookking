//
//  ServiceColors.swift
//  One color per service on the schedule. Same palette and the same pick as the web calendar
//  (FNV-1a hash of the service id, falling back to the lowercased service name), so a service
//  is the same color in the app and on the website.
//

import SwiftUI

enum ServiceColors {
    /// Warm, distinct, readable on cream. Keep in sync with SERVICE_COLORS in web/marketing/assets/app-dashboard.js.
    static let palette: [String] = [
        "#C0644A", // terracotta
        "#6F8F5E", // sage
        "#5B7DA6", // slate blue
        "#8A5A8C", // plum
        "#C49A2C", // mustard
        "#3F8C88", // teal
        "#C2607A", // rose
        "#8B6F47", // bronze
        "#5E5BA6", // indigo
        "#8C8A3E", // olive
    ]

    static func hex(serviceId: String?, serviceName: String?) -> String? {
        let id = (serviceId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let key = id.isEmpty ? name : id
        guard !key.isEmpty else { return nil }
        var hash: UInt32 = 0x811C9DC5
        for scalar in key.unicodeScalars {
            hash ^= UInt32(scalar.value)
            hash = hash &* 0x01000193
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    static func color(for event: Event) -> Color {
        guard let hex = event.color, !hex.isEmpty else { return AppDesign.calendarAppointmentAccent }
        return Color(hex: hex)
    }
}
