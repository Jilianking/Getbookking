//
//  PreviewColorSurface.swift
//
//  Maps tappable page bands (data-bk-color-surface) to tenant color fields.
//

import Foundation

/// One paint tap from the WebView — surface role + optional `data-bk-surface-key` kept together
/// so SwiftUI cannot open the sheet before the key binding lands.
struct PreviewSurfacePaintRequest: Identifiable, Equatable {
    let id: UUID
    let surface: PreviewColorSurface
    let surfaceKey: String?

    init(surface: PreviewColorSurface, surfaceKey: String? = nil) {
        self.id = UUID()
        self.surface = surface
        let trimmed = (surfaceKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.surfaceKey = trimmed.isEmpty ? nil : trimmed
    }
}

enum PreviewColorSurface: String, Identifiable, CaseIterable {
    case page
    case hero
    case featured
    case gallery
    case card
    case about
    /// Menu drawer fill (Classic / Luxe / Studio 12 accent drawer).
    case sidebar
    /// Page menu icon (opens the drawer).
    case sidebarOpen
    /// Close icon inside the drawer.
    case sidebarClose
    case sidebarText

    var id: String { rawValue }

    var label: String {
        switch self {
        case .page: return "Page & nav"
        case .hero: return "Hero"
        case .featured: return "Featured / About"
        case .gallery: return "Gallery page"
        case .card: return "Card band"
        case .about: return "Contact"
        case .sidebar: return "Sidebar background"
        case .sidebarOpen: return "Open icon"
        case .sidebarClose: return "Close icon"
        case .sidebarText: return "Sidebar text"
        }
    }

    /// Blade / Stonecut / Classic: hero band uses page background. Luxe / Studio 12: hero image slot tint.
    static func heroUsesPageBackground(family: TemplateFamily) -> Bool {
        switch family {
        case .blade, .stonecut, .classic: return true
        case .luxe, .studio12: return false
        }
    }

    var hint: String {
        switch self {
        case .page: return "Top bar and page base"
        case .hero: return "With Background armed: tap open area in the hero (not blue text). Long-press photo. Luxe hero is photo-only."
        case .featured: return "Featured work / home About (not contact footer)"
        case .gallery: return "Full gallery page background"
        case .card: return "Card bands (services, When/Where, booking)"
        case .about: return "Location / Hours / Connect (not © legal bar)"
        case .sidebar: return "Drawer panel fill"
        case .sidebarOpen: return "Hamburger that opens the menu"
        case .sidebarClose: return "Icon that closes the drawer"
        case .sidebarText: return "Links and title inside the drawer"
        }
    }

    init?(surfaceId: String) {
        // Legacy paint / chrome id from single "Hamburger" chip.
        if surfaceId == "sidebarHamburger" {
            self = .sidebarOpen
            return
        }
        self.init(rawValue: surfaceId)
    }

    func hex(from viewModel: DesignViewModel) -> String {
        switch self {
        case .page: return viewModel.backgroundColorHex
        case .hero:
            if Self.heroUsesPageBackground(family: viewModel.activeTemplateFamily) {
                return viewModel.backgroundColorHex
            }
            return viewModel.previewHeroSlotColorHex
        case .featured: return viewModel.featuredWorkBackgroundColorHex
        case .gallery: return viewModel.galleryPageBackgroundColorHex
        case .card: return viewModel.cardSurfaceColorHex
        case .about: return viewModel.aboutSectionBackgroundColorHex
        case .sidebar: return viewModel.sidebarBackgroundColorHex
        case .sidebarOpen: return viewModel.resolvedSidebarOpenIconColorHex
        case .sidebarClose: return viewModel.resolvedSidebarCloseIconColorHex
        case .sidebarText: return viewModel.resolvedSidebarTextColorHex
        }
    }

    func applyColorHex(_ hex: String, to viewModel: DesignViewModel) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        switch self {
        case .page:
            viewModel.backgroundColorHex = normalized
        case .hero:
            if Self.heroUsesPageBackground(family: viewModel.activeTemplateFamily) {
                viewModel.backgroundColorHex = normalized
                viewModel.syncPreviewHeroSlotColorFromTokens()
            } else {
                viewModel.previewHeroSlotColorHex = normalized
            }
        case .featured:
            viewModel.featuredWorkBackgroundColorHex = normalized
        case .gallery:
            viewModel.galleryPageBackgroundColorHex = normalized
        case .card:
            viewModel.cardSurfaceColorHex = normalized
        case .about:
            viewModel.aboutSectionBackgroundColorHex = normalized
        case .sidebar:
            viewModel.sidebarBackgroundColorHex = normalized
        case .sidebarOpen:
            viewModel.sidebarIconColorHome = normalized
            viewModel.sidebarIconColorBooking = normalized
        case .sidebarClose:
            viewModel.sidebarCloseIconColorHex = normalized
        case .sidebarText:
            viewModel.sidebarTextColorHex = normalized
        }
    }
}
