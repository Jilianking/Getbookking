//
//  WebTheme.swift
//
//  Visual layouts for the public booking site, scoped by business type (Settings → industry).
//  Stored as `webThemeId` on the tenant document.
//

import Foundation

enum TemplateFamily: String, CaseIterable, Identifiable {
    case classic
    case luxe
    case blade
    case stonecut
    case studio12

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .classic: return "Classic"
        case .luxe: return "Luxe"
        case .blade: return "Blade"
        case .stonecut: return "Stonecut"
        case .studio12: return "Studio 12"
        }
    }

    var icon: String {
        switch self {
        case .classic: return "rectangle.split.3x3"
        case .luxe: return "sparkles"
        case .blade: return "moon.stars"
        case .stonecut: return "shield.lefthalf.filled"
        case .studio12: return "rectangle.split.2x1"
        }
    }

    var previewSubtitle: String {
        switch self {
        case .classic: return "Balanced portfolio layout with hero, gallery, and about"
        case .luxe: return "Elegant cream palette, refined sections"
        case .blade: return "Dark luxury, gold accents"
        case .stonecut: return "Moody editorial layout with bold contrast"
        case .studio12: return "Ivory editorial, marquee, horizontal gallery"
        }
    }

    var sectionTags: [String] {
        switch self {
        case .classic:
            return ["Hero", "Featured", "About", "Gallery", "Booking"]
        case .luxe:
            return ["Hero", "Services", "Gallery", "Promo", "Shop", "Booking"]
        case .blade:
            return ["Hero", "Services", "Gallery", "Reviews", "Shop", "Booking"]
        case .stonecut:
            return ["Hero", "Artists", "Portfolio", "Styles", "Process", "Booking"]
        case .studio12:
            return ["Hero", "Marquee", "Philosophy", "Services", "Gallery", "Booking", "Reviews"]
        }
    }
}

/// One web layout option. Each case maps to exactly one `BookingTemplate` industry.
enum WebTheme: String, CaseIterable, Identifiable {
    /// Hair: hero → featured → meet + contact → sidebar (matches tattoo-style flow).
    case hairSalonV1 = "hair-salon-v1"
    /// Barber: same structural layout as hair; distinct theme id for barber tenants.
    case barberShopV1 = "barber-shop-v1"
    /// Tattoo: full tattoo template on web.
    case tattooStudioV1 = "tattoo-studio-v1"
    /// Nails: classic portfolio template.
    case nailSalonV1 = "nail-salon-v1"
    /// Custom: neutral classic portfolio template.
    case customStandard = "custom-standard"
    /// Luxe: elegant full-width hero, service cards, promo strip, team section. Works with any industry.
    case luxeV1 = "luxe-v1"
    /// Blade: dark editorial layout, gold accents, services, gallery strip, reviews. Works with any industry.
    case bladeV1 = "blade-v1"
    /// Stonecut: dark editorial layout with red accents and dramatic typography. Works with any industry.
    case stonecutV1 = "stonecut-v1"
    /// Studio 12: editorial layout (ivory, serif headlines, marquee, horizontal gallery). Universal (any industry).
    case studio12V1 = "studio-12-v1"

    var id: String { rawValue }

    /// True for templates available to every industry (not tied to one business type).
    var isUniversal: Bool {
        switch self {
        case .luxeV1, .bladeV1, .stonecutV1, .studio12V1: return true
        default: return false
        }
    }

    /// Business type this theme belongs to (must match Settings). Ignored for universal themes.
    var bookingIndustry: BookingTemplate {
        switch self {
        case .hairSalonV1: return .hair
        case .studio12V1: return .custom
        case .barberShopV1: return .barber
        case .tattooStudioV1: return .tattoos
        case .nailSalonV1: return .nails
        case .customStandard: return .custom
        case .luxeV1: return .custom
        case .bladeV1: return .custom
        case .stonecutV1: return .custom
        }
    }

    var displayName: String {
        switch self {
        case .hairSalonV1: return "Classic"
        case .studio12V1: return "Studio 12"
        case .barberShopV1: return "Classic"
        case .tattooStudioV1: return "Classic"
        case .nailSalonV1: return "Classic"
        case .customStandard: return "Classic"
        case .luxeV1: return "Luxe"
        case .bladeV1: return "Blade"
        case .stonecutV1: return "Stonecut"
        }
    }

    var detail: String {
        switch self {
        case .hairSalonV1: return "Hero, featured work, about, sidebar"
        case .barberShopV1: return "Hero, featured work, about, sidebar"
        case .tattooStudioV1: return "Hero, featured work, about, sidebar"
        case .nailSalonV1: return "Hero, featured work, about, sidebar"
        case .customStandard: return "Hero, featured work, about, sidebar"
        case .luxeV1: return "Elegant hero, services, promo, team, sidebar"
        case .bladeV1: return "Dark hero, services, gallery, reviews, shop, sidebar"
        case .stonecutV1: return "Dark split hero, artists, styles, process, ticker"
        case .studio12V1: return "Marquee, services grid, gallery rail, testimonials"
        }
    }

    var icon: String {
        switch self {
        case .hairSalonV1: return "rectangle.split.3x3"
        case .barberShopV1: return "mustache.fill"
        case .tattooStudioV1: return "photo.on.rectangle.angled"
        case .nailSalonV1: return "square.grid.2x2"
        case .customStandard: return "list.bullet.rectangle"
        case .luxeV1: return "sparkles"
        case .bladeV1: return "moon.stars"
        case .stonecutV1: return "shield.lefthalf.filled"
        case .studio12V1: return "rectangle.split.2x1"
        }
    }

    /// Short marketing line for the template gallery card.
    var previewSubtitle: String {
        switch self {
        case .bladeV1: return "Dark luxury, gold accents"
        case .luxeV1: return "Elegant cream palette, refined sections"
        case .stonecutV1: return "Dark editorial with crimson accents"
        case .studio12V1: return "Ivory editorial, marquee, horizontal gallery"
        case .hairSalonV1, .barberShopV1: return "Portfolio hero, featured work, book flow"
        case .tattooStudioV1: return "Bold hero, featured grid, sidebar"
        case .nailSalonV1, .customStandard: return "Neutral portfolio layout with gallery and about"
        }
    }

    /// Section pills shown under each template card.
    var sectionTags: [String] {
        switch self {
        case .bladeV1:
            return ["Hero", "Services", "Gallery", "Reviews", "Shop", "Booking"]
        case .stonecutV1:
            return ["Hero", "Artists", "Portfolio", "Styles", "Process", "Booking"]
        case .luxeV1:
            return ["Hero", "Services", "Gallery", "Promo", "Shop", "Booking"]
        case .nailSalonV1, .customStandard:
            return ["Hero", "Featured", "About", "Gallery", "Booking"]
        case .hairSalonV1, .barberShopV1, .tattooStudioV1:
            return ["Hero", "Featured", "About", "Gallery", "Booking"]
        case .studio12V1:
            return ["Hero", "Marquee", "Philosophy", "Services", "Gallery", "Booking", "Reviews"]
        }
    }

    var family: TemplateFamily {
        switch self {
        case .luxeV1: return .luxe
        case .bladeV1: return .blade
        case .stonecutV1: return .stonecut
        case .studio12V1: return .studio12
        default: return .classic
        }
    }

    static func classicTheme(forIndustry industry: String?) -> WebTheme {
        switch BookingTemplate(rawValue: industry ?? "") {
        case .hair:
            return .hairSalonV1
        case .barber:
            return .barberShopV1
        case .tattoos:
            return .tattooStudioV1
        case .nails:
            return .nailSalonV1
        case .custom, .none:
            return .customStandard
        }
    }

    static func theme(for family: TemplateFamily, industry: String?) -> WebTheme {
        switch family {
        case .classic:
            return classicTheme(forIndustry: industry)
        case .luxe:
            return .luxeV1
        case .blade:
            return .bladeV1
        case .stonecut:
            return .stonecutV1
        case .studio12:
            return .studio12V1
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

    /// Industry-specific Classic themes only (Studio 12 is its own `TemplateFamily` in the app).
    static func classicVariants(forIndustry industry: String?) -> [WebTheme] {
        guard let raw = industry?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let bt = BookingTemplate(rawValue: raw) else { return [] }
        return allCases.filter { $0.family == .classic && $0.bookingIndustry == bt }
    }
}
