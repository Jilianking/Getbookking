//
//  PreviewColorSurface.swift
//
//  Maps tappable page bands (data-bk-color-surface) to tenant color fields.
//

import Foundation

enum PreviewColorSurface: String, Identifiable, CaseIterable {
    case page
    case hero
    case featured
    case card
    case about

    var id: String { rawValue }

    var label: String {
        switch self {
        case .page: return "Page & nav"
        case .hero: return "Hero"
        case .featured: return "Gallery strip"
        case .card: return "Card band"
        case .about: return "About & footer"
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
        case .hero: return "Tap grey area in the hero (not blue text boxes); long-press photo"
        case .featured: return "Featured work section"
        case .card: return "Card bands (services, When/Where, booking)"
        case .about: return "About and contact"
        }
    }

    init?(surfaceId: String) {
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
        case .card: return viewModel.cardSurfaceColorHex
        case .about: return viewModel.aboutSectionBackgroundColorHex
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
        case .card:
            viewModel.cardSurfaceColorHex = normalized
        case .about:
            viewModel.aboutSectionBackgroundColorHex = normalized
        }
    }
}
