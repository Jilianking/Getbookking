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

    var id: String { rawValue }

    /// Business type this theme belongs to (must match Settings).
    var bookingIndustry: BookingTemplate {
        switch self {
        case .hairSalonV1: return .hair
        case .barberShopV1: return .barber
        case .tattooStudioV1: return .tattoos
        case .nailSalonV1: return .nails
        case .petGroomingV1: return .petGrooming
        case .customStandard: return .custom
        }
    }

    var displayName: String {
        switch self {
        case .hairSalonV1: return "Gallery & story"
        case .barberShopV1: return "Cuts & lineups"
        case .tattooStudioV1: return "Portfolio & studio"
        case .nailSalonV1: return "Classic cards"
        case .petGroomingV1: return "Hero & gallery"
        case .customStandard: return "Simple list"
        }
    }

    var detail: String {
        switch self {
        case .hairSalonV1: return "Hero, featured work, meet section, slide-out menu"
        case .barberShopV1: return "Stone hero, fades & gallery, meet + contact, sidebar"
        case .tattooStudioV1: return "Hero, featured work, about, slide-out menu"
        case .nailSalonV1: return "Logo, services grid, reviews-style sections"
        case .petGroomingV1: return "Hero, featured grooms, meet + contact, sidebar"
        case .customStandard: return "Compact booking list"
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
        }
    }

    /// Themes shown in Website Design for the current business type from Settings.
    static func themes(forIndustry industry: String?) -> [WebTheme] {
        guard let raw = industry?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let bt = BookingTemplate(rawValue: raw) else {
            return [.customStandard]
        }
        return WebTheme.allCases.filter { $0.bookingIndustry == bt }
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
