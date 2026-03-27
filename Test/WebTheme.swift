//
//  WebTheme.swift
//
//  Visual layouts for the public booking site, scoped by business type (Settings → industry).
//  Stored as `webThemeId` on the tenant document.
//

import Foundation

/// One web layout option. Each case maps to exactly one `BookingTemplate` industry.
enum WebTheme: String, CaseIterable, Identifiable {
    /// Hair: hero → featured → meet + contact → sidebar (matches tattoo-style flow).
    case hairSalonV1 = "hair-salon-v1"
    /// Barber: same structural layout as hair; distinct theme id for barber tenants.
    case barberShopV1 = "barber-shop-v1"
    /// Tattoo: full tattoo template on web.
    case tattooStudioV1 = "tattoo-studio-v1"
    /// Nails: classic service card list home.
    case nailSalonV1 = "nail-salon-v1"
    /// Pet grooming: same structural layout as hair/barber (hero, featured, meet, sidebar).
    case petGroomingV1 = "pet-grooming-v1"
    /// Custom: default card list.
    case customStandard = "custom-standard"
    /// Luxe: elegant full-width hero, service cards, promo strip, team section. Works with any industry.
    case luxeV1 = "luxe-v1"

    var id: String { rawValue }

    /// True for templates available to every industry (not tied to one business type).
    var isUniversal: Bool {
        switch self {
        case .luxeV1: return true
        default: return false
        }
    }

    /// Business type this theme belongs to (must match Settings). Ignored for universal themes.
    var bookingIndustry: BookingTemplate {
        switch self {
        case .hairSalonV1: return .hair
        case .barberShopV1: return .barber
        case .tattooStudioV1: return .tattoos
        case .nailSalonV1: return .nails
        case .petGroomingV1: return .petGrooming
        case .customStandard: return .custom
        case .luxeV1: return .custom
        }
    }

    var displayName: String {
        switch self {
        case .hairSalonV1: return "Classic"
        case .barberShopV1: return "Classic"
        case .tattooStudioV1: return "Classic"
        case .nailSalonV1: return "Classic"
        case .petGroomingV1: return "Classic"
        case .customStandard: return "Classic"
        case .luxeV1: return "Luxe"
        }
    }

    var detail: String {
        switch self {
        case .hairSalonV1: return "Hero, featured work, about, sidebar"
        case .barberShopV1: return "Hero, featured work, about, sidebar"
        case .tattooStudioV1: return "Hero, featured work, about, sidebar"
        case .nailSalonV1: return "Hero, featured work, about, sidebar"
        case .petGroomingV1: return "Hero, featured work, about, sidebar"
        case .customStandard: return "Hero, featured work, about, sidebar"
        case .luxeV1: return "Elegant hero, services, promo, team, sidebar"
        }
    }

    var icon: String {
        switch self {
        case .hairSalonV1: return "rectangle.split.3x3"
        case .barberShopV1: return "mustache.fill"
        case .tattooStudioV1: return "photo.on.rectangle.angled"
        case .nailSalonV1: return "square.grid.2x2"
        case .petGroomingV1: return "pawprint.fill"
        case .customStandard: return "list.bullet.rectangle"
        case .luxeV1: return "sparkles"
        }
    }

    /// Themes shown in Website Design for the current business type from Settings.
    static func themes(forIndustry industry: String?) -> [WebTheme] {
        guard let raw = industry?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let bt = BookingTemplate(rawValue: raw) else {
            return [.customStandard] + allCases.filter(\.isUniversal)
        }
        return allCases.filter { $0.bookingIndustry == bt || $0.isUniversal }
    }

    /// Default theme when `webThemeId` is missing or invalid for the current industry.
    static func defaultTheme(forIndustry industry: String?) -> WebTheme {
        let list = themes(forIndustry: industry)
        return list.first ?? .customStandard
    }

    /// Resolves stored id; falls back if industry changed in Settings and old id no longer applies.
    static func resolvedThemeId(stored: String?, industry: String?) -> String {
        let allowed = Set(themes(forIndustry: industry).map(\.rawValue))
        if let s = stored, allowed.contains(s) { return s }
        return defaultTheme(forIndustry: industry).rawValue
    }
}
