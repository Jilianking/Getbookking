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

    var hint: String {
        switch self {
        case .page: return "Top bar and page base"
        case .hero: return "Hero area (long-press if photo slot is on top)"
        case .featured: return "Featured work section"
        case .card: return "Promo and services band"
        case .about: return "About and contact"
        }
    }

    init?(surfaceId: String) {
        self.init(rawValue: surfaceId)
    }

    func hex(from viewModel: DesignViewModel) -> String {
        switch self {
        case .page: return viewModel.backgroundColorHex
        case .hero: return viewModel.previewHeroSlotColorHex
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
            viewModel.previewHeroSlotColorHex = normalized
        case .featured:
            viewModel.featuredWorkBackgroundColorHex = normalized
        case .card:
            viewModel.cardSurfaceColorHex = normalized
        case .about:
            viewModel.aboutSectionBackgroundColorHex = normalized
        }
    }
}
