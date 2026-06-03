//
//  WebColorPalette.swift
//
//  Curated site color presets per TemplateFamily (Design → Template tab).
//

import Foundation

struct WebColorPaletteTokens: Equatable, Hashable {
    var backgroundColor: String
    var cardSurfaceColor: String
    var textColor: String
    var primaryColor: String
    var primaryColorHover: String
    var featuredWorkBackgroundColor: String
    var featuredWorkTextColor: String
    var bookingFormCardBackgroundColor: String
    var galleryPageBackgroundColor: String
    var galleryPageTextColor: String
    var aboutSectionBackgroundColor: String
    var aboutSectionTextColor: String
    /// Nav · page · accent · surface · band — for preset card preview only.
    var stripColors: [String]
}

struct WebColorPalette: Identifiable, Hashable {
    let id: String
    let name: String
    let family: TemplateFamily
    let tokens: WebColorPaletteTokens
}

/// Swappable accent — same base theme, different highlight color.
struct WebColorAccentOption: Identifiable, Hashable {
    let id: String
    let name: String
    let primaryColor: String
    let primaryColorHover: String
}

/// How the design picker filters catalog colors (both tones, light only, or dark only).
enum WebColorPalettePickerTone: String, CaseIterable, Identifiable {
    case all
    case light
    case dark

    var id: String { rawValue }

    var segmentedTitle: String {
        switch self {
        case .all: return "All"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
}

/// Row in the color grid (`pickerId` is unique in `.all` when the same catalog id appears twice).
struct WebColorPalettePickerItem: Identifiable, Hashable {
    let pickerId: String
    let palette: WebColorPalette
    /// e.g. "Light" / "Dark" when `.all` shows both variants of one catalog name.
    let toneSubtitle: String?

    var id: String { pickerId }
}

enum WebColorPalettes {
    static let customPaletteId = "custom"

    /// Same catalog order for every template family (Original stays per-family in `all`).
    private static let universalCatalogCoreIds: [String] = [
        "sandstone", "soft-neutral", "ocean-slate", "slate-rust",
        "vintage-warm", "blush-mauve",
        "pearl-light", "soft-grey", "warm-linen", "cloud-mist",
        "burnt-accent", "ink-parchment", "charcoal-greige",
    ]
    private static let v3PaletteIdsOrdered: [String] = [
        "forest-sage", "midnight-plum", "coral-bloom", "arctic-mist", "copper-ledger",
        "lavender-haze", "olive-grove", "rose-quartz", "graphite-mint", "honey-linen",
        "baltic-blue", "terracotta-clay", "pearl-ash", "berry-noir", "sage-steam",
    ]
    private static let v3AccentOnlyIds: Set<String> = Set(v3PaletteIdsOrdered)

    private static var universalPickerCatalogIds: [String] {
        ["original"] + universalCatalogCoreIds + v3PaletteIdsOrdered
    }

    private static let catalogDisplayNames: [String: String] = [
        "slate-rust": "Slate & Rust",
        "burnt-accent": "Burnt Accent",
        "ink-parchment": "Ink & Parchment",
        "charcoal-greige": "Charcoal Greige",
        "blush-mauve": "Blush Mauve",
        "vintage-warm": "Vintage Warm",
        "pearl-light": "Pearl Light",
        "soft-grey": "Soft Grey",
        "warm-linen": "Warm Linen",
        "cloud-mist": "Cloud Mist",
        "ocean-slate": "Ocean Slate",
    ]

    /// Picker labels for dark-surface variants (avoids “Warm” / “Light” on near-black themes).
    private static let catalogDarkDisplayNames: [String: String] = [
        "sandstone": "Sandstone Night",
        "soft-neutral": "Neutral Charcoal",
        "ocean-slate": "Ocean Slate",
        "slate-rust": "Slate & Rust",
        "vintage-warm": "Rust Night",
        "blush-mauve": "Mauve Noir",
        "pearl-light": "Cool Slate",
        "soft-grey": "Charcoal Grey",
        "warm-linen": "Espresso Linen",
        "cloud-mist": "Storm Blue",
        "burnt-accent": "Burnt Accent",
        "ink-parchment": "Ink & Parchment",
        "charcoal-greige": "Charcoal Greige",
        "forest-sage": "Forest Night",
        "midnight-plum": "Midnight Plum",
        "coral-bloom": "Coral Noir",
        "arctic-mist": "Arctic Night",
        "copper-ledger": "Copper Ledger",
        "lavender-haze": "Lavender Haze",
        "olive-grove": "Olive Grove",
        "rose-quartz": "Rose Noir",
        "graphite-mint": "Graphite Mint",
        "honey-linen": "Amber Night",
        "baltic-blue": "Baltic Blue",
        "terracotta-clay": "Terracotta Clay",
        "pearl-ash": "Pearl Ash",
        "berry-noir": "Berry Noir",
        "sage-steam": "Sage Steam",
    ]

    private static func isLightFamily(_ family: TemplateFamily) -> Bool {
        switch family {
        case .classic, .luxe, .studio12: return true
        case .blade, .stonecut: return false
        }
    }

    private static func lightReferenceFamilies(excluding family: TemplateFamily) -> [TemplateFamily] {
        [.studio12, .classic, .luxe].filter { $0 != family }
    }

    private static func darkReferenceFamilies(excluding family: TemplateFamily) -> [TemplateFamily] {
        [.blade, .stonecut].filter { $0 != family }
    }

    private static func rawPalette(family: TemplateFamily, id: String) -> WebColorPalette? {
        all.first { $0.family == family && $0.id == id }
    }

    private static func catalogDisplayName(for id: String, fallback: String) -> String {
        catalogDisplayNames[id] ?? fallback
    }

    private static func pickerDisplayName(
        catalogId: String,
        forceLight: Bool,
        referenceName: String,
        toneAdapted: Bool
    ) -> String {
        if forceLight {
            return catalogDisplayName(for: catalogId, fallback: referenceName)
        }
        if toneAdapted {
            return catalogDarkDisplayNames[catalogId] ?? referenceName
        }
        return referenceName
    }

    private static let lightSourceFamilies: [TemplateFamily] = [.studio12, .classic, .luxe]
    private static let darkSourceFamilies: [TemplateFamily] = [.blade, .stonecut]

    /// Default picker tab: light templates → Light, dark templates → Dark.
    static func defaultPickerTone(for family: TemplateFamily) -> WebColorPalettePickerTone {
        isLightFamily(family) ? .light : .dark
    }

    /// Resolves a catalog id for `family` using the picker tone filter.
    private static func synthesizedPalette(
        family: TemplateFamily,
        id: String,
        tone: WebColorPalettePickerTone
    ) -> WebColorPalette? {
        switch tone {
        case .light:
            return synthesizedPaletteForced(family: family, id: id, forceLight: true)
        case .dark:
            return synthesizedPaletteForced(family: family, id: id, forceLight: false)
        case .all:
            return synthesizedPaletteForced(family: family, id: id, forceLight: isLightFamily(family))
        }
    }

    private static func synthesizedPaletteRecommended(family: TemplateFamily, id: String) -> WebColorPalette? {
        if id == "original" { return rawPalette(family: family, id: "original") }

        if let own = rawPalette(family: family, id: id) {
            return own
        }

        let refs = isLightFamily(family)
            ? lightReferenceFamilies(excluding: family)
            : darkReferenceFamilies(excluding: family)

        for ref in refs {
            if let refPalette = rawPalette(family: ref, id: id) {
                return WebColorPalette(
                    id: id,
                    name: catalogDisplayName(for: id, fallback: refPalette.name),
                    family: family,
                    tokens: refPalette.tokens
                )
            }
        }

        if isLightFamily(family), let darkRef = rawPalette(family: .blade, id: id) ?? rawPalette(family: .stonecut, id: id) {
            return WebColorPalette(
                id: id,
                name: catalogDisplayName(for: id, fallback: darkRef.name),
                family: family,
                tokens: lightTokensAdapted(from: darkRef.tokens, catalogId: id)
            )
        }

        if !isLightFamily(family), let lightRef = rawPalette(family: .studio12, id: id)
            ?? rawPalette(family: .classic, id: id)
            ?? rawPalette(family: .luxe, id: id) {
            return WebColorPalette(
                id: id,
                name: pickerDisplayName(
                    catalogId: id,
                    forceLight: false,
                    referenceName: lightRef.name,
                    toneAdapted: true
                ),
                family: family,
                tokens: darkTokensAdapted(from: lightRef.tokens, catalogId: id)
            )
        }

        return nil
    }

    /// Always light or always dark tokens for the catalog id (Original stays per-family).
    private static func synthesizedPaletteForced(family: TemplateFamily, id: String, forceLight: Bool) -> WebColorPalette? {
        if id == "original" { return rawPalette(family: family, id: "original") }

        let sources = forceLight ? lightSourceFamilies : darkSourceFamilies
        for source in sources {
            if let ref = rawPalette(family: source, id: id) {
                let refIsLight = isPaletteLight(tokens: ref.tokens)
                guard refIsLight == forceLight else { continue }
                return WebColorPalette(
                    id: id,
                    name: pickerDisplayName(
                        catalogId: id,
                        forceLight: forceLight,
                        referenceName: ref.name,
                        toneAdapted: false
                    ),
                    family: family,
                    tokens: ref.tokens
                )
            }
        }

        if forceLight {
            if let darkRef = rawPalette(family: .blade, id: id) ?? rawPalette(family: .stonecut, id: id) {
                return WebColorPalette(
                    id: id,
                    name: pickerDisplayName(
                        catalogId: id,
                        forceLight: true,
                        referenceName: darkRef.name,
                        toneAdapted: true
                    ),
                    family: family,
                    tokens: lightTokensAdapted(from: darkRef.tokens, catalogId: id)
                )
            }
        } else if let lightRef = rawPalette(family: .studio12, id: id)
            ?? rawPalette(family: .classic, id: id)
            ?? rawPalette(family: .luxe, id: id) {
            return WebColorPalette(
                id: id,
                name: pickerDisplayName(
                    catalogId: id,
                    forceLight: false,
                    referenceName: lightRef.name,
                    toneAdapted: true
                ),
                family: family,
                tokens: darkTokensAdapted(from: lightRef.tokens, catalogId: id)
            )
        }

        return nil
    }

    static func isPaletteLight(tokens: WebColorPaletteTokens) -> Bool {
        isPaletteLight(backgroundHex: tokens.backgroundColor)
    }

    static func isPaletteLight(backgroundHex: String) -> Bool {
        relativeLuminance(of: backgroundHex) > 0.55
    }

    private static func relativeLuminance(of hex: String) -> Double {
        guard let (r, g, b) = rgbComponents(fromHex: hex) else { return 1 }
        let sr = Double(r) / 255
        let sg = Double(g) / 255
        let sb = Double(b) / 255
        return 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
    }

    private static func rgbComponents(fromHex hex: String) -> (Int, Int, Int)? {
        var s = normalizeHex(hex)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = Int(s, radix: 16) else { return nil }
        return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
    }

    /// Light surfaces for a dark reference palette (same accent hue, readable on light pages).
    private static func lightTokensAdapted(from dark: WebColorPaletteTokens, catalogId: String) -> WebColorPaletteTokens {
        var next = dark
        switch catalogId {
        case "pearl-light", "cloud-mist":
            next.backgroundColor = "#FFFFFF"
            next.cardSurfaceColor = "#EEF1F4"
            next.textColor = "#1A1F28"
            next.featuredWorkBackgroundColor = "#F6F7F8"
            next.featuredWorkTextColor = "#1A1F28"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#2A3238"
            next.aboutSectionTextColor = "#F6F7F8"
        case "warm-linen":
            next.backgroundColor = "#FAF8F4"
            next.cardSurfaceColor = "#EDE6DC"
            next.textColor = "#3A3228"
            next.featuredWorkBackgroundColor = "#F5F2EC"
            next.featuredWorkTextColor = "#3A3228"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#3A3228"
            next.aboutSectionTextColor = "#FAF8F4"
        case "soft-grey":
            next.backgroundColor = "#F5F5F5"
            next.cardSurfaceColor = "#E5E5E5"
            next.textColor = "#2A2A2A"
            next.featuredWorkBackgroundColor = "#FAFAFA"
            next.featuredWorkTextColor = "#2A2A2A"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#2F3438"
            next.aboutSectionTextColor = "#F5F5F5"
        case "slate-rust":
            next.backgroundColor = "#E8EEF3"
            next.cardSurfaceColor = "#B8C9D6"
            next.textColor = "#1E2A33"
            next.featuredWorkBackgroundColor = "#E8EEF3"
            next.featuredWorkTextColor = "#1E2A33"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#1E2A33"
            next.aboutSectionTextColor = "#F4F8FB"
        case "vintage-warm":
            next.backgroundColor = "#F2EBE0"
            next.cardSurfaceColor = "#EDE0D4"
            next.textColor = "#1E2A33"
            next.featuredWorkBackgroundColor = "#F2EBE0"
            next.featuredWorkTextColor = "#1E2A33"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#1E2A33"
            next.aboutSectionTextColor = "#F2EBE0"
        case "ocean-slate":
            next.backgroundColor = "#F4F8FB"
            next.cardSurfaceColor = "#D4E4EF"
            next.textColor = "#2C3E50"
            next.featuredWorkBackgroundColor = "#F4F8FB"
            next.featuredWorkTextColor = "#2C3E50"
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#2C3E50"
            next.aboutSectionTextColor = "#F4F8FB"
        default:
            next.backgroundColor = "#F5F3EF"
            next.cardSurfaceColor = "#E5DFD6"
            next.textColor = "#2A2838"
            next.featuredWorkBackgroundColor = next.backgroundColor
            next.featuredWorkTextColor = next.textColor
            next.bookingFormCardBackgroundColor = "#FFFFFF"
            next.aboutSectionBackgroundColor = "#1E2A36"
            next.aboutSectionTextColor = "#F4F8FB"
        }
        if next.stripColors.count >= 5 {
            next.stripColors[0] = next.backgroundColor
            next.stripColors[1] = next.featuredWorkBackgroundColor
            next.stripColors[2] = next.primaryColor
            next.stripColors[3] = next.cardSurfaceColor
            next.stripColors[4] = next.aboutSectionBackgroundColor
        }
        return next
    }

    /// Dark surfaces for a light reference palette.
    private static func darkTokensAdapted(from light: WebColorPaletteTokens, catalogId: String) -> WebColorPaletteTokens {
        var next = light
        switch catalogId {
        case "vintage-warm", "burnt-accent":
            next.backgroundColor = "#1E1810"
            next.cardSurfaceColor = "#2A2018"
            next.textColor = "#FAF6F0"
            next.aboutSectionBackgroundColor = "#2A2018"
            next.aboutSectionTextColor = "#FAF6F0"
        case "blush-mauve":
            next.backgroundColor = "#1A1418"
            next.cardSurfaceColor = "#2A2228"
            next.textColor = "#F8F2EE"
            next.aboutSectionBackgroundColor = "#2A2228"
            next.aboutSectionTextColor = "#F8F2EE"
        case "soft-neutral", "charcoal-greige", "ink-parchment":
            next.backgroundColor = "#141410"
            next.cardSurfaceColor = "#222018"
            next.textColor = "#F5F0E8"
            next.aboutSectionBackgroundColor = "#222018"
            next.aboutSectionTextColor = "#F5F0E8"
        case "slate-rust":
            next.backgroundColor = "#1E2A33"
            next.cardSurfaceColor = "#2A3842"
            next.textColor = "#F2EBE0"
            next.aboutSectionBackgroundColor = "#2A3842"
            next.aboutSectionTextColor = "#F2EBE0"
        default:
            next.backgroundColor = "#0E1418"
            next.cardSurfaceColor = "#1A242C"
            next.textColor = "#E8F2F8"
            next.aboutSectionBackgroundColor = "#1A242C"
            next.aboutSectionTextColor = "#E8F2F8"
        }
        next.featuredWorkBackgroundColor = next.backgroundColor
        next.featuredWorkTextColor = next.textColor
        next.bookingFormCardBackgroundColor = next.cardSurfaceColor
        if next.stripColors.count >= 5 {
            next.stripColors[0] = next.backgroundColor
            next.stripColors[1] = next.featuredWorkBackgroundColor
            next.stripColors[2] = next.primaryColor
            next.stripColors[3] = next.cardSurfaceColor
            next.stripColors[4] = next.aboutSectionBackgroundColor
        }
        return next
    }

    static func usesAccentPicker(family: TemplateFamily) -> Bool { true }

    /// Dark templates: accent chips tweak highlight on top of a base palette. Light templates use the grid only.
    static func showsAccentChipRowInPicker(for family: TemplateFamily) -> Bool {
        family == .blade || family == .stonecut
    }

    static func isV3AccentPaletteId(_ id: String) -> Bool {
        v3AccentOnlyIds.contains(id)
    }

    /// Light templates apply the full v3 token set when a v3 accent chip is chosen; dark templates swap accent only.
    static func appliesFullPaletteForAccent(family: TemplateFamily, accentId: String) -> Bool {
        isV3AccentPaletteId(accentId) && (family == .classic || family == .luxe || family == .studio12)
    }

    private static func baseIds(for family: TemplateFamily) -> [String] {
        universalPickerCatalogIds.filter { synthesizedPaletteRecommended(family: family, id: $0) != nil }
    }

    static func palettes(for family: TemplateFamily, tone: WebColorPalettePickerTone? = nil) -> [WebColorPalette] {
        let resolvedTone = tone ?? defaultPickerTone(for: family)
        return pickerItems(for: family, tone: resolvedTone).map(\.palette)
    }

    static func pickerItems(for family: TemplateFamily, tone: WebColorPalettePickerTone) -> [WebColorPalettePickerItem] {
        let ids = baseIds(for: family)
        switch tone {
        case .light, .dark:
            return ids.compactMap { id in
                synthesizedPalette(family: family, id: id, tone: tone).map {
                    WebColorPalettePickerItem(pickerId: id, palette: $0, toneSubtitle: nil)
                }
            }
        case .all:
            var items: [WebColorPalettePickerItem] = []
            for id in ids {
                if id == "original" {
                    if let palette = rawPalette(family: family, id: "original") {
                        items.append(WebColorPalettePickerItem(pickerId: id, palette: palette, toneSubtitle: nil))
                    }
                    continue
                }
                if let light = synthesizedPalette(family: family, id: id, tone: .light) {
                    items.append(WebColorPalettePickerItem(
                        pickerId: "\(id)|light",
                        palette: light,
                        toneSubtitle: "Light"
                    ))
                }
                if let dark = synthesizedPalette(family: family, id: id, tone: .dark) {
                    items.append(WebColorPalettePickerItem(
                        pickerId: "\(id)|dark",
                        palette: dark,
                        toneSubtitle: "Dark"
                    ))
                }
            }
            return items
        }
    }

    /// Picker selection: match stored palette id, or primary hex when a v3 full theme was applied via accent.
    static func pickerPaletteIsActive(
        storedPaletteId: String,
        storedPrimaryHex: String,
        storedBackgroundHex: String,
        palette: WebColorPalette
    ) -> Bool {
        let resolved = resolvedPaletteId(stored: storedPaletteId, family: palette.family)
        if resolved == palette.id {
            if resolved == "original" || resolved == customPaletteId { return true }
            return isPaletteLight(backgroundHex: storedBackgroundHex) == isPaletteLight(tokens: palette.tokens)
        }
        if isV3AccentPaletteId(palette.id) {
            return normalizeHex(storedPrimaryHex) == normalizeHex(palette.tokens.primaryColor)
        }
        return false
    }

    static func palette(family: TemplateFamily, id: String, pickerTone: WebColorPalettePickerTone? = nil) -> WebColorPalette? {
        if let pickerTone {
            return synthesizedPalette(family: family, id: id, tone: pickerTone)
        }
        return synthesizedPaletteRecommended(family: family, id: id)
    }

    static func accentOptions(for family: TemplateFamily) -> [WebColorAccentOption] {
        switch family {
        case .blade: return bladeAccents
        case .stonecut: return stonecutAccents
        default: return accentsFromPalettes(family: family)
        }
    }

    /// Builds accent chips from catalog palettes (deduped by accent hex).
    private static func accentsFromPalettes(family: TemplateFamily) -> [WebColorAccentOption] {
        let orderedIds = baseIds(for: family)
        var seen = Set<String>()
        var result: [WebColorAccentOption] = []
        for id in orderedIds {
            guard let palette = synthesizedPaletteRecommended(family: family, id: id) else { continue }
            let key = normalizeHex(palette.tokens.primaryColor)
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            result.append(WebColorAccentOption(
                id: palette.id,
                name: palette.name,
                primaryColor: palette.tokens.primaryColor,
                primaryColorHover: palette.tokens.primaryColorHover
            ))
        }
        return result
    }

    static func tokensReplacingAccent(_ tokens: WebColorPaletteTokens, accent: WebColorAccentOption) -> WebColorPaletteTokens {
        var next = tokens
        next.primaryColor = accent.primaryColor
        next.primaryColorHover = accent.primaryColorHover
        if next.stripColors.count >= 3 {
            next.stripColors[2] = accent.primaryColor
        }
        return next
    }

    static func matchesAccent(storedPrimary: String, option: WebColorAccentOption) -> Bool {
        normalizeHex(storedPrimary) == normalizeHex(option.primaryColor)
    }

    static func normalizeHex(_ hex: String) -> String {
        hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    static func original(for family: TemplateFamily) -> WebColorPalette {
        palette(family: family, id: "original") ?? palettes(for: family).first!
    }

    static func resolvedPaletteId(stored: String?, family: TemplateFamily) -> String {
        let trimmed = (stored ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "original" }
        if trimmed == customPaletteId { return customPaletteId }
        let baseIds = Set(palettes(for: family).map(\.id))
        if baseIds.contains(trimmed) { return trimmed }
        if v3AccentOnlyIds.contains(trimmed) { return "original" }
        if palette(family: family, id: trimmed) != nil {
            return migratedBasePaletteId(from: trimmed, family: family) ?? "original"
        }
        return "original"
    }

    private static func migratedBasePaletteId(from legacyId: String, family: TemplateFamily) -> String? {
        let bases = baseIds(for: family)
        if bases.contains(legacyId) { return legacyId }
        if v3AccentOnlyIds.contains(legacyId) { return "original" }
        return nil
    }

    private static let bladeAccents: [WebColorAccentOption] = [
        a("gold", "Gold", "#C9A84C", "#E5C97A"),
        a("sandstone", "Sandstone", "#B8895A", "#D4A574"),
        a("ocean", "Ocean", "#6B8FA3", "#8FAFC2"),
        a("rust", "Rust", "#C45C3E", "#D97A5C"),
        a("forest-sage", "Forest Sage", "#6B9E7A", "#8BB898"),
        a("midnight-plum", "Midnight Plum", "#9B7AB8", "#B294CC"),
        a("coral-bloom", "Coral Bloom", "#E89078", "#F0A890"),
        a("arctic-mist", "Arctic Mist", "#78A8C4", "#94BCD4"),
        a("copper-ledger", "Copper", "#D4A050", "#E8B868"),
        a("lavender-haze", "Lavender", "#A894C8", "#BEAADC"),
        a("olive-grove", "Olive", "#A8A468", "#BEBA7C"),
        a("rose-quartz", "Rose", "#E0A0AC", "#ECB4BE"),
        a("graphite-mint", "Mint", "#5CB8A4", "#78CCB8"),
        a("honey-linen", "Honey", "#E8C050", "#F4D468"),
        a("baltic-blue", "Baltic Blue", "#5A8CC0", "#74A4D4"),
        a("terracotta-clay", "Terracotta", "#D88058", "#EC9870"),
        a("pearl-ash", "Pearl Ash", "#94A4B4", "#ACB8C8"),
        a("berry-noir", "Berry", "#C07090", "#D488A8"),
        a("sage-steam", "Sage Steam", "#88B098", "#A0C4B0"),
        a("slate", "Slate", "#6A7888", "#525E6C"),
        a("sky", "Sky", "#5A8CA8", "#457088"),
    ]

    private static let stonecutAccents: [WebColorAccentOption] = [
        a("crimson", "Crimson", "#C0221A", "#D42A20"),
        a("burnt", "Burnt", "#B84A20", "#D45A28"),
        a("parchment", "Parchment", "#E8E0D0", "#F5F0E8"),
        a("greige", "Greige", "#9A8B7A", "#B0A090"),
        a("forest-sage", "Forest Sage", "#5A8A68", "#72A080"),
        a("midnight-plum", "Midnight Plum", "#8A68A8", "#A080BE"),
        a("coral-bloom", "Coral Bloom", "#D07058", "#E08870"),
        a("arctic-mist", "Arctic Mist", "#6898B4", "#80ACCA"),
        a("copper-ledger", "Copper", "#B87830", "#D09048"),
        a("lavender-haze", "Lavender", "#9480B0", "#AA96C4"),
        a("olive-grove", "Olive", "#949058", "#ACA870"),
        a("rose-quartz", "Rose", "#C88898", "#DC9CAC"),
        a("graphite-mint", "Mint", "#50A890", "#68BCA4"),
        a("honey-linen", "Honey", "#C09838", "#D4AC50"),
        a("baltic-blue", "Baltic Blue", "#4A7CB0", "#6294C8"),
        a("terracotta-clay", "Terracotta", "#C07048", "#D48860"),
        a("pearl-ash", "Pearl Ash", "#8494A4", "#9CA8B8"),
        a("berry-noir", "Berry", "#A86888", "#BE80A0"),
        a("sage-steam", "Sage Steam", "#78A088", "#90B4A0"),
    ]

    private static func a(_ id: String, _ name: String, _ primary: String, _ hover: String) -> WebColorAccentOption {
        WebColorAccentOption(id: id, name: name, primaryColor: primary, primaryColorHover: hover)
    }

    static func firestoreUpdates(paletteId: String, tokens: WebColorPaletteTokens) -> [String: Any] {
        [
            "webColorPaletteId": paletteId,
            "backgroundColor": tokens.backgroundColor,
            "cardSurfaceColor": tokens.cardSurfaceColor,
            "textColor": tokens.textColor,
            "primaryColor": tokens.primaryColor,
            "primaryColorHover": tokens.primaryColorHover,
            "featuredWorkBackgroundColor": tokens.featuredWorkBackgroundColor,
            "featuredWorkTextColor": tokens.featuredWorkTextColor,
            "bookingFormCardBackgroundColor": tokens.bookingFormCardBackgroundColor,
            "galleryPageBackgroundColor": tokens.galleryPageBackgroundColor,
            "galleryPageTextColor": tokens.galleryPageTextColor,
            "aboutSectionBackgroundColor": tokens.aboutSectionBackgroundColor,
            "aboutSectionTextColor": tokens.aboutSectionTextColor,
        ]
    }

    private static func t(
        bg: String,
        card: String,
        text: String,
        accent: String,
        accentHover: String,
        featuredBg: String,
        featuredText: String,
        bookCard: String,
        aboutBg: String,
        aboutText: String,
        strip: [String]
    ) -> WebColorPaletteTokens {
        WebColorPaletteTokens(
            backgroundColor: bg,
            cardSurfaceColor: card,
            textColor: text,
            primaryColor: accent,
            primaryColorHover: accentHover,
            featuredWorkBackgroundColor: featuredBg,
            featuredWorkTextColor: featuredText,
            bookingFormCardBackgroundColor: bookCard,
            galleryPageBackgroundColor: featuredBg,
            galleryPageTextColor: featuredText,
            aboutSectionBackgroundColor: aboutBg,
            aboutSectionTextColor: aboutText,
            stripColors: strip
        )
    }

    private static let all: [WebColorPalette] = classic + luxe + blade + stonecut + studio12

    private static let classic: [WebColorPalette] = [
        WebColorPalette(id: "original", name: "Original", family: .classic, tokens: t(bg: "#FFFFFF", card: "#F5F5F5", text: "#1A1A1A", accent: "#111111", accentHover: "#333333", featuredBg: "#FFFFFF", featuredText: "#1A1A1A", bookCard: "#FFFFFF", aboutBg: "#1A1A1A", aboutText: "#F7F5F0", strip: ["#FFFFFF", "#FFFFFF", "#111111", "#F5F5F5", "#1A1A1A"])),
        WebColorPalette(id: "sandstone", name: "Sandstone", family: .classic, tokens: t(bg: "#FAF6F0", card: "#E8D5C4", text: "#3D2A1F", accent: "#B8895A", accentHover: "#8B5A3C", featuredBg: "#FAF6F0", featuredText: "#3D2A1F", bookCard: "#FFFFFF", aboutBg: "#2A1810", aboutText: "#FAF6F0", strip: ["#FAF6F0", "#FAF6F0", "#B8895A", "#E8D5C4", "#2A1810"])),
        WebColorPalette(id: "soft-neutral", name: "Soft Neutral", family: .classic, tokens: t(bg: "#F5F3EF", card: "#E5DFD6", text: "#3D3832", accent: "#9A8B7A", accentHover: "#7A6B5E", featuredBg: "#F5F3EF", featuredText: "#3D3832", bookCard: "#FFFFFF", aboutBg: "#2F3438", aboutText: "#F5F3EF", strip: ["#F5F3EF", "#F5F3EF", "#9A8B7A", "#E5DFD6", "#2F3438"])),
        WebColorPalette(id: "slate-rust", name: "Slate & Rust", family: .classic, tokens: t(bg: "#E8EEF3", card: "#B8C9D6", text: "#1E2A33", accent: "#C45C3E", accentHover: "#D97A5C", featuredBg: "#E8EEF3", featuredText: "#1E2A33", bookCard: "#FFFFFF", aboutBg: "#1E2A33", aboutText: "#F4F8FB", strip: ["#E8EEF3", "#E8EEF3", "#C45C3E", "#B8C9D6", "#1E2A33"])),
        WebColorPalette(id: "vintage-warm", name: "Vintage Warm", family: .classic, tokens: t(bg: "#F2EBE0", card: "#EDE6DC", text: "#1E2A33", accent: "#C45C3E", accentHover: "#A34A32", featuredBg: "#F2EBE0", featuredText: "#1E2A33", bookCard: "#FFFFFF", aboutBg: "#1E2A33", aboutText: "#F2EBE0", strip: ["#F2EBE0", "#F2EBE0", "#C45C3E", "#EDE6DC", "#1E2A33"])),
        WebColorPalette(id: "forest-sage", name: "Forest Sage", family: .classic, tokens: t(bg: "#F4F7F4", card: "#D8E4D6", text: "#1E2E24", accent: "#4A7C59", accentHover: "#356347", featuredBg: "#F4F7F4", featuredText: "#1E2E24", bookCard: "#FFFFFF", aboutBg: "#1E2E24", aboutText: "#F4F7F4", strip: ["#F4F7F4", "#F4F7F4", "#4A7C59", "#D8E4D6", "#1E2E24"])),
        WebColorPalette(id: "midnight-plum", name: "Midnight Plum", family: .classic, tokens: t(bg: "#FAF8FC", card: "#E8E0F0", text: "#2A1F38", accent: "#6B4F8C", accentHover: "#523A6E", featuredBg: "#FAF8FC", featuredText: "#2A1F38", bookCard: "#FFFFFF", aboutBg: "#2A1F38", aboutText: "#FAF8FC", strip: ["#FAF8FC", "#FAF8FC", "#6B4F8C", "#E8E0F0", "#2A1F38"])),
        WebColorPalette(id: "coral-bloom", name: "Coral Bloom", family: .classic, tokens: t(bg: "#FFF9F7", card: "#F5E0DA", text: "#3A2824", accent: "#E07A62", accentHover: "#C4624E", featuredBg: "#FFF9F7", featuredText: "#3A2824", bookCard: "#FFFFFF", aboutBg: "#3A2824", aboutText: "#FFF9F7", strip: ["#FFF9F7", "#FFF9F7", "#E07A62", "#F5E0DA", "#3A2824"])),
        WebColorPalette(id: "arctic-mist", name: "Arctic Mist", family: .classic, tokens: t(bg: "#F6FAFC", card: "#DCE8F0", text: "#1E2A36", accent: "#5A8CA8", accentHover: "#457088", featuredBg: "#F6FAFC", featuredText: "#1E2A36", bookCard: "#FFFFFF", aboutBg: "#1E2A36", aboutText: "#F6FAFC", strip: ["#F6FAFC", "#F6FAFC", "#5A8CA8", "#DCE8F0", "#1E2A36"])),
        WebColorPalette(id: "copper-ledger", name: "Copper Ledger", family: .classic, tokens: t(bg: "#FBF7F2", card: "#E8D9C8", text: "#3A2E22", accent: "#B87333", accentHover: "#945C28", featuredBg: "#FBF7F2", featuredText: "#3A2E22", bookCard: "#FFFFFF", aboutBg: "#3A2E22", aboutText: "#FBF7F2", strip: ["#FBF7F2", "#FBF7F2", "#B87333", "#E8D9C8", "#3A2E22"])),
        WebColorPalette(id: "lavender-haze", name: "Lavender Haze", family: .classic, tokens: t(bg: "#F9F8FC", card: "#E4E0EE", text: "#343040", accent: "#8A7AA8", accentHover: "#6E6088", featuredBg: "#F9F8FC", featuredText: "#343040", bookCard: "#FFFFFF", aboutBg: "#343040", aboutText: "#F9F8FC", strip: ["#F9F8FC", "#F9F8FC", "#8A7AA8", "#E4E0EE", "#343040"])),
        WebColorPalette(id: "olive-grove", name: "Olive Grove", family: .classic, tokens: t(bg: "#F6F5F0", card: "#E2DCC8", text: "#2E2C22", accent: "#7A7648", accentHover: "#5E5C38", featuredBg: "#F6F5F0", featuredText: "#2E2C22", bookCard: "#FFFFFF", aboutBg: "#2E2C22", aboutText: "#F6F5F0", strip: ["#F6F5F0", "#F6F5F0", "#7A7648", "#E2DCC8", "#2E2C22"])),
        WebColorPalette(id: "rose-quartz", name: "Rose Quartz", family: .classic, tokens: t(bg: "#FCF7F8", card: "#F0E0E4", text: "#3A2C30", accent: "#C48A96", accentHover: "#A4707C", featuredBg: "#FCF7F8", featuredText: "#3A2C30", bookCard: "#FFFFFF", aboutBg: "#3A2C30", aboutText: "#FCF7F8", strip: ["#FCF7F8", "#FCF7F8", "#C48A96", "#F0E0E4", "#3A2C30"])),
        WebColorPalette(id: "graphite-mint", name: "Graphite Mint", family: .classic, tokens: t(bg: "#F4F6F6", card: "#D8E4E2", text: "#1E2826", accent: "#3D8A7A", accentHover: "#2E6E60", featuredBg: "#F4F6F6", featuredText: "#1E2826", bookCard: "#FFFFFF", aboutBg: "#1E2826", aboutText: "#F4F6F6", strip: ["#F4F6F6", "#F4F6F6", "#3D8A7A", "#D8E4E2", "#1E2826"])),
        WebColorPalette(id: "honey-linen", name: "Honey Linen", family: .classic, tokens: t(bg: "#FBF8F0", card: "#F0E4C8", text: "#3A3220", accent: "#C9A030", accentHover: "#A88424", featuredBg: "#FBF8F0", featuredText: "#3A3220", bookCard: "#FFFFFF", aboutBg: "#3A3220", aboutText: "#FBF8F0", strip: ["#FBF8F0", "#FBF8F0", "#C9A030", "#F0E4C8", "#3A3220"])),
        WebColorPalette(id: "baltic-blue", name: "Baltic Blue", family: .classic, tokens: t(bg: "#F4F7FA", card: "#D4E0EC", text: "#1A2838", accent: "#2E5A88", accentHover: "#23466C", featuredBg: "#F4F7FA", featuredText: "#1A2838", bookCard: "#FFFFFF", aboutBg: "#1A2838", aboutText: "#F4F7FA", strip: ["#F4F7FA", "#F4F7FA", "#2E5A88", "#D4E0EC", "#1A2838"])),
        WebColorPalette(id: "terracotta-clay", name: "Terracotta Clay", family: .classic, tokens: t(bg: "#FAF5F0", card: "#E8D4C4", text: "#3A2A1E", accent: "#C06840", accentHover: "#9E5232", featuredBg: "#FAF5F0", featuredText: "#3A2A1E", bookCard: "#FFFFFF", aboutBg: "#3A2A1E", aboutText: "#FAF5F0", strip: ["#FAF5F0", "#FAF5F0", "#C06840", "#E8D4C4", "#3A2A1E"])),
        WebColorPalette(id: "pearl-ash", name: "Pearl Ash", family: .classic, tokens: t(bg: "#F6F7F8", card: "#E2E6EA", text: "#2C3238", accent: "#6A7888", accentHover: "#525E6C", featuredBg: "#F6F7F8", featuredText: "#2C3238", bookCard: "#FFFFFF", aboutBg: "#2C3238", aboutText: "#F6F7F8", strip: ["#F6F7F8", "#F6F7F8", "#6A7888", "#E2E6EA", "#2C3238"])),
        WebColorPalette(id: "berry-noir", name: "Berry Noir", family: .classic, tokens: t(bg: "#FAF6F8", card: "#E8DCE4", text: "#2E1E28", accent: "#8E4868", accentHover: "#703650", featuredBg: "#FAF6F8", featuredText: "#2E1E28", bookCard: "#FFFFFF", aboutBg: "#2E1E28", aboutText: "#FAF6F8", strip: ["#FAF6F8", "#FAF6F8", "#8E4868", "#E8DCE4", "#2E1E28"])),
        WebColorPalette(id: "sage-steam", name: "Sage Steam", family: .classic, tokens: t(bg: "#F5F8F6", card: "#DEE8E2", text: "#28302A", accent: "#6A9078", accentHover: "#527460", featuredBg: "#F5F8F6", featuredText: "#28302A", bookCard: "#FFFFFF", aboutBg: "#28302A", aboutText: "#F5F8F6", strip: ["#F5F8F6", "#F5F8F6", "#6A9078", "#DEE8E2", "#28302A"])),
    ]

    private static let luxe: [WebColorPalette] = [
        WebColorPalette(id: "original", name: "Original", family: .luxe, tokens: t(bg: "#FFFDF9", card: "#F5F0E8", text: "#1A1A1A", accent: "#C9A96E", accentHover: "#8B6914", featuredBg: "#FFFDF9", featuredText: "#1A1A1A", bookCard: "#FFFDF9", aboutBg: "#1A1A1A", aboutText: "#FFFDF9", strip: ["#FFFDF9", "#FFFDF9", "#C9A96E", "#F5F0E8", "#1A1A1A"])),
        WebColorPalette(id: "sandstone", name: "Sandstone", family: .luxe, tokens: t(bg: "#FAF6F0", card: "#E8D5C4", text: "#3D2A1F", accent: "#B8895A", accentHover: "#8B5A3C", featuredBg: "#FAF6F0", featuredText: "#3D2A1F", bookCard: "#FAF6F0", aboutBg: "#3D2A1F", aboutText: "#FAF6F0", strip: ["#FAF6F0", "#FAF6F0", "#B8895A", "#E8D5C4", "#3D2A1F"])),
        WebColorPalette(id: "blush-mauve", name: "Blush Mauve", family: .luxe, tokens: t(bg: "#F8F2EE", card: "#E8C4C0", text: "#4A322E", accent: "#B07A72", accentHover: "#8B635C", featuredBg: "#F8F2EE", featuredText: "#4A322E", bookCard: "#F8F2EE", aboutBg: "#4A322E", aboutText: "#F8F2EE", strip: ["#F8F2EE", "#F8F2EE", "#B07A72", "#E8C4C0", "#4A322E"])),
        WebColorPalette(id: "soft-neutral", name: "Soft Neutral", family: .luxe, tokens: t(bg: "#F5F3EF", card: "#E5DFD6", text: "#3D3832", accent: "#9A8B7A", accentHover: "#7A6B5E", featuredBg: "#F5F3EF", featuredText: "#3D3832", bookCard: "#F5F3EF", aboutBg: "#3D3832", aboutText: "#F5F3EF", strip: ["#F5F3EF", "#F5F3EF", "#9A8B7A", "#E5DFD6", "#3D3832"])),
        WebColorPalette(id: "slate-rust", name: "Slate & Rust", family: .luxe, tokens: t(bg: "#E8EEF3", card: "#B8C9D6", text: "#1E2A33", accent: "#C45C3E", accentHover: "#D97A5C", featuredBg: "#E8EEF3", featuredText: "#1E2A33", bookCard: "#FFFDF9", aboutBg: "#1E2A33", aboutText: "#F4F8FB", strip: ["#E8EEF3", "#E8EEF3", "#C45C3E", "#B8C9D6", "#1E2A33"])),
        WebColorPalette(id: "vintage-warm", name: "Vintage Warm", family: .luxe, tokens: t(bg: "#F2EBE0", card: "#EDE6DC", text: "#1E2A33", accent: "#C45C3E", accentHover: "#A34A32", featuredBg: "#F2EBE0", featuredText: "#1E2A33", bookCard: "#FFFDF9", aboutBg: "#1E2A33", aboutText: "#F2EBE0", strip: ["#F2EBE0", "#F2EBE0", "#C45C3E", "#EDE6DC", "#1E2A33"])),
        WebColorPalette(id: "forest-sage", name: "Forest Sage", family: .luxe, tokens: t(bg: "#F2F6F1", card: "#D5E2D2", text: "#243528", accent: "#5B8268", accentHover: "#456A52", featuredBg: "#F2F6F1", featuredText: "#243528", bookCard: "#F2F6F1", aboutBg: "#243528", aboutText: "#F2F6F1", strip: ["#F2F6F1", "#F2F6F1", "#5B8268", "#D5E2D2", "#243528"])),
        WebColorPalette(id: "midnight-plum", name: "Midnight Plum", family: .luxe, tokens: t(bg: "#F9F6FB", card: "#E5DBF0", text: "#322448", accent: "#7A5C9E", accentHover: "#5E4578", featuredBg: "#F9F6FB", featuredText: "#322448", bookCard: "#F9F6FB", aboutBg: "#322448", aboutText: "#F9F6FB", strip: ["#F9F6FB", "#F9F6FB", "#7A5C9E", "#E5DBF0", "#322448"])),
        WebColorPalette(id: "coral-bloom", name: "Coral Bloom", family: .luxe, tokens: t(bg: "#FFF8F5", card: "#F2DDD4", text: "#402E28", accent: "#D8866E", accentHover: "#B86E58", featuredBg: "#FFF8F5", featuredText: "#402E28", bookCard: "#FFF8F5", aboutBg: "#402E28", aboutText: "#FFF8F5", strip: ["#FFF8F5", "#FFF8F5", "#D8866E", "#F2DDD4", "#402E28"])),
        WebColorPalette(id: "arctic-mist", name: "Arctic Mist", family: .luxe, tokens: t(bg: "#F4F9FB", card: "#D8E6F0", text: "#243240", accent: "#6A96B0", accentHover: "#527A94", featuredBg: "#F4F9FB", featuredText: "#243240", bookCard: "#F4F9FB", aboutBg: "#243240", aboutText: "#F4F9FB", strip: ["#F4F9FB", "#F4F9FB", "#6A96B0", "#D8E6F0", "#243240"])),
        WebColorPalette(id: "copper-ledger", name: "Copper Ledger", family: .luxe, tokens: t(bg: "#FAF6F0", card: "#E6D4C0", text: "#3E3024", accent: "#C48A42", accentHover: "#A07034", featuredBg: "#FAF6F0", featuredText: "#3E3024", bookCard: "#FAF6F0", aboutBg: "#3E3024", aboutText: "#FAF6F0", strip: ["#FAF6F0", "#FAF6F0", "#C48A42", "#E6D4C0", "#3E3024"])),
        WebColorPalette(id: "lavender-haze", name: "Lavender Haze", family: .luxe, tokens: t(bg: "#F8F6FA", card: "#E0DAEA", text: "#38324A", accent: "#9A88B4", accentHover: "#7C6C98", featuredBg: "#F8F6FA", featuredText: "#38324A", bookCard: "#F8F6FA", aboutBg: "#38324A", aboutText: "#F8F6FA", strip: ["#F8F6FA", "#F8F6FA", "#9A88B4", "#E0DAEA", "#38324A"])),
        WebColorPalette(id: "olive-grove", name: "Olive Grove", family: .luxe, tokens: t(bg: "#F5F4EE", card: "#DED8C4", text: "#343028", accent: "#8A8654", accentHover: "#6C6840", featuredBg: "#F5F4EE", featuredText: "#343028", bookCard: "#F5F4EE", aboutBg: "#343028", aboutText: "#F5F4EE", strip: ["#F5F4EE", "#F5F4EE", "#8A8654", "#DED8C4", "#343028"])),
        WebColorPalette(id: "rose-quartz", name: "Rose Quartz", family: .luxe, tokens: t(bg: "#FBF6F7", card: "#ECD8DC", text: "#403034", accent: "#D098A4", accentHover: "#B0808C", featuredBg: "#FBF6F7", featuredText: "#403034", bookCard: "#FBF6F7", aboutBg: "#403034", aboutText: "#FBF6F7", strip: ["#FBF6F7", "#FBF6F7", "#D098A4", "#ECD8DC", "#403034"])),
        WebColorPalette(id: "graphite-mint", name: "Graphite Mint", family: .luxe, tokens: t(bg: "#F2F5F4", card: "#D4E2DE", text: "#24302C", accent: "#4A9484", accentHover: "#3A786A", featuredBg: "#F2F5F4", featuredText: "#24302C", bookCard: "#F2F5F4", aboutBg: "#24302C", aboutText: "#F2F5F4", strip: ["#F2F5F4", "#F2F5F4", "#4A9484", "#D4E2DE", "#24302C"])),
        WebColorPalette(id: "honey-linen", name: "Honey Linen", family: .luxe, tokens: t(bg: "#FAF6EE", card: "#EDE0C4", text: "#3E3424", accent: "#D4AC40", accentHover: "#B08C32", featuredBg: "#FAF6EE", featuredText: "#3E3424", bookCard: "#FAF6EE", aboutBg: "#3E3424", aboutText: "#FAF6EE", strip: ["#FAF6EE", "#FAF6EE", "#D4AC40", "#EDE0C4", "#3E3424"])),
        WebColorPalette(id: "baltic-blue", name: "Baltic Blue", family: .luxe, tokens: t(bg: "#F2F6FA", card: "#D0DEE8", text: "#1E3044", accent: "#3A6898", accentHover: "#2E5278", featuredBg: "#F2F6FA", featuredText: "#1E3044", bookCard: "#F2F6FA", aboutBg: "#1E3044", aboutText: "#F2F6FA", strip: ["#F2F6FA", "#F2F6FA", "#3A6898", "#D0DEE8", "#1E3044"])),
        WebColorPalette(id: "terracotta-clay", name: "Terracotta Clay", family: .luxe, tokens: t(bg: "#F9F4EE", card: "#E4D0BE", text: "#3E2C20", accent: "#CC7850", accentHover: "#A86040", featuredBg: "#F9F4EE", featuredText: "#3E2C20", bookCard: "#F9F4EE", aboutBg: "#3E2C20", aboutText: "#F9F4EE", strip: ["#F9F4EE", "#F9F4EE", "#CC7850", "#E4D0BE", "#3E2C20"])),
        WebColorPalette(id: "pearl-ash", name: "Pearl Ash", family: .luxe, tokens: t(bg: "#F4F6F8", card: "#DEE4EA", text: "#303840", accent: "#788898", accentHover: "#5E6C7C", featuredBg: "#F4F6F8", featuredText: "#303840", bookCard: "#F4F6F8", aboutBg: "#303840", aboutText: "#F4F6F8", strip: ["#F4F6F8", "#F4F6F8", "#788898", "#DEE4EA", "#303840"])),
        WebColorPalette(id: "berry-noir", name: "Berry Noir", family: .luxe, tokens: t(bg: "#F9F5F7", card: "#E4D6E0", text: "#342030", accent: "#A05878", accentHover: "#824460", featuredBg: "#F9F5F7", featuredText: "#342030", bookCard: "#F9F5F7", aboutBg: "#342030", aboutText: "#F9F5F7", strip: ["#F9F5F7", "#F9F5F7", "#A05878", "#E4D6E0", "#342030"])),
        WebColorPalette(id: "sage-steam", name: "Sage Steam", family: .luxe, tokens: t(bg: "#F3F7F4", card: "#DAE6DE", text: "#2C342E", accent: "#7A9E88", accentHover: "#5E8070", featuredBg: "#F3F7F4", featuredText: "#2C342E", bookCard: "#F3F7F4", aboutBg: "#2C342E", aboutText: "#F3F7F4", strip: ["#F3F7F4", "#F3F7F4", "#7A9E88", "#DAE6DE", "#2C342E"])),
    ]

    private static let blade: [WebColorPalette] = [
        WebColorPalette(id: "original", name: "Original", family: .blade, tokens: t(bg: "#0A0A08", card: "#141410", text: "#F5F0E8", accent: "#C9A84C", accentHover: "#E5C97A", featuredBg: "#0A0A08", featuredText: "#F5F0E8", bookCard: "#141410", aboutBg: "#141410", aboutText: "#F5F0E8", strip: ["#0A0A08", "#0A0A08", "#C9A84C", "#141410", "#C9A84C"])),
        WebColorPalette(id: "sandstone", name: "Sandstone", family: .blade, tokens: t(bg: "#2A1810", card: "#3D2A1F", text: "#FAF6F0", accent: "#B8895A", accentHover: "#D4A574", featuredBg: "#2A1810", featuredText: "#FAF6F0", bookCard: "#3D2A1F", aboutBg: "#3D2A1F", aboutText: "#FAF6F0", strip: ["#2A1810", "#2A1810", "#B8895A", "#3D2A1F", "#B8895A"])),
        WebColorPalette(id: "ocean-slate", name: "Ocean Slate", family: .blade, tokens: t(bg: "#1A2F45", card: "#243548", text: "#F4F8FB", accent: "#6B8FA3", accentHover: "#8FAFC2", featuredBg: "#1A2F45", featuredText: "#F4F8FB", bookCard: "#243548", aboutBg: "#243548", aboutText: "#F4F8FB", strip: ["#1A2F45", "#1A2F45", "#6B8FA3", "#243548", "#6B8FA3"])),
        WebColorPalette(id: "slate-rust", name: "Slate & Rust", family: .blade, tokens: t(bg: "#1E2A33", card: "#2A3842", text: "#F2EBE0", accent: "#C45C3E", accentHover: "#D97A5C", featuredBg: "#1E2A33", featuredText: "#F2EBE0", bookCard: "#2A3842", aboutBg: "#2A3842", aboutText: "#F2EBE0", strip: ["#1E2A33", "#1E2A33", "#C45C3E", "#2A3842", "#C45C3E"])),
        WebColorPalette(id: "forest-sage", name: "Forest Sage", family: .blade, tokens: t(bg: "#0E1410", card: "#1A241E", text: "#E8F0EA", accent: "#6B9E7A", accentHover: "#8BB898", featuredBg: "#0E1410", featuredText: "#E8F0EA", bookCard: "#1A241E", aboutBg: "#1A241E", aboutText: "#E8F0EA", strip: ["#0E1410", "#0E1410", "#6B9E7A", "#1A241E", "#1A241E"])),
        WebColorPalette(id: "midnight-plum", name: "Midnight Plum", family: .blade, tokens: t(bg: "#120E18", card: "#1E1828", text: "#EDE6F5", accent: "#9B7AB8", accentHover: "#B294CC", featuredBg: "#120E18", featuredText: "#EDE6F5", bookCard: "#1E1828", aboutBg: "#1E1828", aboutText: "#EDE6F5", strip: ["#120E18", "#120E18", "#9B7AB8", "#1E1828", "#1E1828"])),
        WebColorPalette(id: "coral-bloom", name: "Coral Bloom", family: .blade, tokens: t(bg: "#1A100E", card: "#2A1C18", text: "#FCEEE8", accent: "#E89078", accentHover: "#F0A890", featuredBg: "#1A100E", featuredText: "#FCEEE8", bookCard: "#2A1C18", aboutBg: "#2A1C18", aboutText: "#FCEEE8", strip: ["#1A100E", "#1A100E", "#E89078", "#2A1C18", "#2A1C18"])),
        WebColorPalette(id: "arctic-mist", name: "Arctic Mist", family: .blade, tokens: t(bg: "#0E1418", card: "#1A242C", text: "#E8F2F8", accent: "#78A8C4", accentHover: "#94BCD4", featuredBg: "#0E1418", featuredText: "#E8F2F8", bookCard: "#1A242C", aboutBg: "#1A242C", aboutText: "#E8F2F8", strip: ["#0E1418", "#0E1418", "#78A8C4", "#1A242C", "#1A242C"])),
        WebColorPalette(id: "copper-ledger", name: "Copper Ledger", family: .blade, tokens: t(bg: "#18120C", card: "#261E14", text: "#F5EDE4", accent: "#D4A050", accentHover: "#E8B868", featuredBg: "#18120C", featuredText: "#F5EDE4", bookCard: "#261E14", aboutBg: "#261E14", aboutText: "#F5EDE4", strip: ["#18120C", "#18120C", "#D4A050", "#261E14", "#261E14"])),
        WebColorPalette(id: "lavender-haze", name: "Lavender Haze", family: .blade, tokens: t(bg: "#141218", card: "#221E2A", text: "#EEEAF4", accent: "#A894C8", accentHover: "#BEAADC", featuredBg: "#141218", featuredText: "#EEEAF4", bookCard: "#221E2A", aboutBg: "#221E2A", aboutText: "#EEEAF4", strip: ["#141218", "#141218", "#A894C8", "#221E2A", "#221E2A"])),
        WebColorPalette(id: "olive-grove", name: "Olive Grove", family: .blade, tokens: t(bg: "#121410", card: "#1E2018", text: "#EEEBE0", accent: "#A8A468", accentHover: "#BEBA7C", featuredBg: "#121410", featuredText: "#EEEBE0", bookCard: "#1E2018", aboutBg: "#1E2018", aboutText: "#EEEBE0", strip: ["#121410", "#121410", "#A8A468", "#1E2018", "#1E2018"])),
        WebColorPalette(id: "rose-quartz", name: "Rose Quartz", family: .blade, tokens: t(bg: "#181214", card: "#261C20", text: "#F8ECEE", accent: "#E0A0AC", accentHover: "#ECB4BE", featuredBg: "#181214", featuredText: "#F8ECEE", bookCard: "#261C20", aboutBg: "#261C20", aboutText: "#F8ECEE", strip: ["#181214", "#181214", "#E0A0AC", "#261C20", "#261C20"])),
        WebColorPalette(id: "graphite-mint", name: "Graphite Mint", family: .blade, tokens: t(bg: "#0C1010", card: "#161E1C", text: "#E6F2EE", accent: "#5CB8A4", accentHover: "#78CCB8", featuredBg: "#0C1010", featuredText: "#E6F2EE", bookCard: "#161E1C", aboutBg: "#161E1C", aboutText: "#E6F2EE", strip: ["#0C1010", "#0C1010", "#5CB8A4", "#161E1C", "#161E1C"])),
        WebColorPalette(id: "honey-linen", name: "Honey Linen", family: .blade, tokens: t(bg: "#16140C", card: "#242018", text: "#F5F0E4", accent: "#E8C050", accentHover: "#F4D468", featuredBg: "#16140C", featuredText: "#F5F0E4", bookCard: "#242018", aboutBg: "#242018", aboutText: "#F5F0E4", strip: ["#16140C", "#16140C", "#E8C050", "#242018", "#242018"])),
        WebColorPalette(id: "baltic-blue", name: "Baltic Blue", family: .blade, tokens: t(bg: "#0A1018", card: "#141C28", text: "#E4ECF4", accent: "#5A8CC0", accentHover: "#74A4D4", featuredBg: "#0A1018", featuredText: "#E4ECF4", bookCard: "#141C28", aboutBg: "#141C28", aboutText: "#E4ECF4", strip: ["#0A1018", "#0A1018", "#5A8CC0", "#141C28", "#141C28"])),
        WebColorPalette(id: "terracotta-clay", name: "Terracotta Clay", family: .blade, tokens: t(bg: "#18100C", card: "#281C14", text: "#F5EBE4", accent: "#D88058", accentHover: "#EC9870", featuredBg: "#18100C", featuredText: "#F5EBE4", bookCard: "#281C14", aboutBg: "#281C14", aboutText: "#F5EBE4", strip: ["#18100C", "#18100C", "#D88058", "#281C14", "#281C14"])),
        WebColorPalette(id: "pearl-ash", name: "Pearl Ash", family: .blade, tokens: t(bg: "#101214", card: "#1C1E22", text: "#E8ECF0", accent: "#94A4B4", accentHover: "#ACB8C8", featuredBg: "#101214", featuredText: "#E8ECF0", bookCard: "#1C1E22", aboutBg: "#1C1E22", aboutText: "#E8ECF0", strip: ["#101214", "#101214", "#94A4B4", "#1C1E22", "#1C1E22"])),
        WebColorPalette(id: "berry-noir", name: "Berry Noir", family: .blade, tokens: t(bg: "#140C10", card: "#22141C", text: "#F0E6EC", accent: "#C07090", accentHover: "#D488A8", featuredBg: "#140C10", featuredText: "#F0E6EC", bookCard: "#22141C", aboutBg: "#22141C", aboutText: "#F0E6EC", strip: ["#140C10", "#140C10", "#C07090", "#22141C", "#22141C"])),
        WebColorPalette(id: "sage-steam", name: "Sage Steam", family: .blade, tokens: t(bg: "#0E1210", card: "#1A201C", text: "#E8F0EA", accent: "#88B098", accentHover: "#A0C4B0", featuredBg: "#0E1210", featuredText: "#E8F0EA", bookCard: "#1A201C", aboutBg: "#1A201C", aboutText: "#E8F0EA", strip: ["#0E1210", "#0E1210", "#88B098", "#1A201C", "#1A201C"])),
        WebColorPalette(id: "pearl-light", name: "Pearl Light", family: .blade, tokens: t(bg: "#FFFFFF", card: "#EEF1F4", text: "#1A1F28", accent: "#5A8CC0", accentHover: "#4678A8", featuredBg: "#F6F7F8", featuredText: "#1A1F28", bookCard: "#FFFFFF", aboutBg: "#2A3238", aboutText: "#F6F7F8", strip: ["#FFFFFF", "#F6F7F8", "#5A8CC0", "#EEF1F4", "#2A3238"])),
        WebColorPalette(id: "soft-grey", name: "Soft Grey", family: .blade, tokens: t(bg: "#F5F5F5", card: "#E5E5E5", text: "#2A2A2A", accent: "#6A7888", accentHover: "#525E6C", featuredBg: "#FAFAFA", featuredText: "#2A2A2A", bookCard: "#FFFFFF", aboutBg: "#2F3438", aboutText: "#F5F5F5", strip: ["#F5F5F5", "#FAFAFA", "#6A7888", "#E5E5E5", "#2F3438"])),
        WebColorPalette(id: "warm-linen", name: "Warm Linen", family: .blade, tokens: t(bg: "#FAF8F4", card: "#EDE6DC", text: "#3A3228", accent: "#B8895A", accentHover: "#9A7048", featuredBg: "#F5F2EC", featuredText: "#3A3228", bookCard: "#FFFFFF", aboutBg: "#3A3228", aboutText: "#FAF8F4", strip: ["#FAF8F4", "#F5F2EC", "#B8895A", "#EDE6DC", "#3A3228"])),
        WebColorPalette(id: "cloud-mist", name: "Cloud Mist", family: .blade, tokens: t(bg: "#F4F9FB", card: "#DCE8F0", text: "#1E2A36", accent: "#5A8CA8", accentHover: "#457088", featuredBg: "#EEF4F8", featuredText: "#1E2A36", bookCard: "#FFFFFF", aboutBg: "#1E2A36", aboutText: "#F4F9FB", strip: ["#F4F9FB", "#EEF4F8", "#5A8CA8", "#DCE8F0", "#1E2A36"])),
    ]

    private static let stonecut: [WebColorPalette] = [
        WebColorPalette(id: "original", name: "Original", family: .stonecut, tokens: t(bg: "#060604", card: "#0E0D0A", text: "#E8E0D0", accent: "#C0221A", accentHover: "#D42A20", featuredBg: "#060604", featuredText: "#E8E0D0", bookCard: "#0E0D0A", aboutBg: "#0E0D0A", aboutText: "#E8E0D0", strip: ["#060604", "#060604", "#C0221A", "#0E0D0A", "#C0221A"])),
        WebColorPalette(id: "burnt-accent", name: "Burnt Accent", family: .stonecut, tokens: t(bg: "#120E0C", card: "#1E1814", text: "#F5F0E8", accent: "#B84A20", accentHover: "#D45A28", featuredBg: "#120E0C", featuredText: "#F5F0E8", bookCard: "#1E1814", aboutBg: "#1E1814", aboutText: "#F5F0E8", strip: ["#120E0C", "#120E0C", "#B84A20", "#1E1814", "#B84A20"])),
        WebColorPalette(id: "ink-parchment", name: "Ink & Parchment", family: .stonecut, tokens: t(bg: "#060604", card: "#0E0D0A", text: "#E8E0D0", accent: "#E8E0D0", accentHover: "#F5F0E8", featuredBg: "#060604", featuredText: "#E8E0D0", bookCard: "#0E0D0A", aboutBg: "#0E0D0A", aboutText: "#E8E0D0", strip: ["#060604", "#060604", "#E8E0D0", "#0E0D0A", "#E8E0D0"])),
        WebColorPalette(id: "charcoal-greige", name: "Charcoal Greige", family: .stonecut, tokens: t(bg: "#2F3438", card: "#3D3832", text: "#F5F3EF", accent: "#9A8B7A", accentHover: "#B0A090", featuredBg: "#2F3438", featuredText: "#F5F3EF", bookCard: "#3D3832", aboutBg: "#3D3832", aboutText: "#F5F3EF", strip: ["#2F3438", "#2F3438", "#9A8B7A", "#3D3832", "#9A8B7A"])),
        WebColorPalette(id: "forest-sage", name: "Forest Sage", family: .stonecut, tokens: t(bg: "#0A100C", card: "#141C16", text: "#DDE8DF", accent: "#5A8A68", accentHover: "#72A080", featuredBg: "#0A100C", featuredText: "#DDE8DF", bookCard: "#141C16", aboutBg: "#141C16", aboutText: "#DDE8DF", strip: ["#0A100C", "#0A100C", "#5A8A68", "#141C16", "#141C16"])),
        WebColorPalette(id: "midnight-plum", name: "Midnight Plum", family: .stonecut, tokens: t(bg: "#0C0810", card: "#181220", text: "#E6DFF0", accent: "#8A68A8", accentHover: "#A080BE", featuredBg: "#0C0810", featuredText: "#E6DFF0", bookCard: "#181220", aboutBg: "#181220", aboutText: "#E6DFF0", strip: ["#0C0810", "#0C0810", "#8A68A8", "#181220", "#181220"])),
        WebColorPalette(id: "coral-bloom", name: "Coral Bloom", family: .stonecut, tokens: t(bg: "#140C0A", card: "#221816", text: "#F5E8E4", accent: "#D07058", accentHover: "#E08870", featuredBg: "#140C0A", featuredText: "#F5E8E4", bookCard: "#221816", aboutBg: "#221816", aboutText: "#F5E8E4", strip: ["#140C0A", "#140C0A", "#D07058", "#221816", "#221816"])),
        WebColorPalette(id: "arctic-mist", name: "Arctic Mist", family: .stonecut, tokens: t(bg: "#0A1014", card: "#161E26", text: "#E0ECF4", accent: "#6898B4", accentHover: "#80ACCA", featuredBg: "#0A1014", featuredText: "#E0ECF4", bookCard: "#161E26", aboutBg: "#161E26", aboutText: "#E0ECF4", strip: ["#0A1014", "#0A1014", "#6898B4", "#161E26", "#161E26"])),
        WebColorPalette(id: "copper-ledger", name: "Copper Ledger", family: .stonecut, tokens: t(bg: "#100C08", card: "#1C1610", text: "#EDE4D8", accent: "#B87830", accentHover: "#D09048", featuredBg: "#100C08", featuredText: "#EDE4D8", bookCard: "#1C1610", aboutBg: "#1C1610", aboutText: "#EDE4D8", strip: ["#100C08", "#100C08", "#B87830", "#1C1610", "#1C1610"])),
        WebColorPalette(id: "lavender-haze", name: "Lavender Haze", family: .stonecut, tokens: t(bg: "#0E0C12", card: "#1A1822", text: "#E8E4F0", accent: "#9480B0", accentHover: "#AA96C4", featuredBg: "#0E0C12", featuredText: "#E8E4F0", bookCard: "#1A1822", aboutBg: "#1A1822", aboutText: "#E8E4F0", strip: ["#0E0C12", "#0E0C12", "#9480B0", "#1A1822", "#1A1822"])),
        WebColorPalette(id: "olive-grove", name: "Olive Grove", family: .stonecut, tokens: t(bg: "#0E100C", card: "#1A1C14", text: "#E6E4D8", accent: "#949058", accentHover: "#ACA870", featuredBg: "#0E100C", featuredText: "#E6E4D8", bookCard: "#1A1C14", aboutBg: "#1A1C14", aboutText: "#E6E4D8", strip: ["#0E100C", "#0E100C", "#949058", "#1A1C14", "#1A1C14"])),
        WebColorPalette(id: "rose-quartz", name: "Rose Quartz", family: .stonecut, tokens: t(bg: "#120E10", card: "#20181C", text: "#F2E6E8", accent: "#C88898", accentHover: "#DC9CAC", featuredBg: "#120E10", featuredText: "#F2E6E8", bookCard: "#20181C", aboutBg: "#20181C", aboutText: "#F2E6E8", strip: ["#120E10", "#120E10", "#C88898", "#20181C", "#20181C"])),
        WebColorPalette(id: "graphite-mint", name: "Graphite Mint", family: .stonecut, tokens: t(bg: "#080C0C", card: "#121A18", text: "#DCECE8", accent: "#50A890", accentHover: "#68BCA4", featuredBg: "#080C0C", featuredText: "#DCECE8", bookCard: "#121A18", aboutBg: "#121A18", aboutText: "#DCECE8", strip: ["#080C0C", "#080C0C", "#50A890", "#121A18", "#121A18"])),
        WebColorPalette(id: "honey-linen", name: "Honey Linen", family: .stonecut, tokens: t(bg: "#100E08", card: "#1C1A12", text: "#EDE6D8", accent: "#C09838", accentHover: "#D4AC50", featuredBg: "#100E08", featuredText: "#EDE6D8", bookCard: "#1C1A12", aboutBg: "#1C1A12", aboutText: "#EDE6D8", strip: ["#100E08", "#100E08", "#C09838", "#1C1A12", "#1C1A12"])),
        WebColorPalette(id: "baltic-blue", name: "Baltic Blue", family: .stonecut, tokens: t(bg: "#080C14", card: "#121820", text: "#DEE8F0", accent: "#4A7CB0", accentHover: "#6294C8", featuredBg: "#080C14", featuredText: "#DEE8F0", bookCard: "#121820", aboutBg: "#121820", aboutText: "#DEE8F0", strip: ["#080C14", "#080C14", "#4A7CB0", "#121820", "#121820"])),
        WebColorPalette(id: "terracotta-clay", name: "Terracotta Clay", family: .stonecut, tokens: t(bg: "#120C08", card: "#201812", text: "#EDE4DC", accent: "#C07048", accentHover: "#D48860", featuredBg: "#120C08", featuredText: "#EDE4DC", bookCard: "#201812", aboutBg: "#201812", aboutText: "#EDE4DC", strip: ["#120C08", "#120C08", "#C07048", "#201812", "#201812"])),
        WebColorPalette(id: "pearl-ash", name: "Pearl Ash", family: .stonecut, tokens: t(bg: "#0C0E10", card: "#181A1E", text: "#E2E8EC", accent: "#8494A4", accentHover: "#9CA8B8", featuredBg: "#0C0E10", featuredText: "#E2E8EC", bookCard: "#181A1E", aboutBg: "#181A1E", aboutText: "#E2E8EC", strip: ["#0C0E10", "#0C0E10", "#8494A4", "#181A1E", "#181A1E"])),
        WebColorPalette(id: "berry-noir", name: "Berry Noir", family: .stonecut, tokens: t(bg: "#0E080C", card: "#1A1016", text: "#EAE0E6", accent: "#A86888", accentHover: "#BE80A0", featuredBg: "#0E080C", featuredText: "#EAE0E6", bookCard: "#1A1016", aboutBg: "#1A1016", aboutText: "#EAE0E6", strip: ["#0E080C", "#0E080C", "#A86888", "#1A1016", "#1A1016"])),
        WebColorPalette(id: "sage-steam", name: "Sage Steam", family: .stonecut, tokens: t(bg: "#0A0E0C", card: "#161C18", text: "#E0EAE4", accent: "#78A088", accentHover: "#90B4A0", featuredBg: "#0A0E0C", featuredText: "#E0EAE4", bookCard: "#161C18", aboutBg: "#161C18", aboutText: "#E0EAE4", strip: ["#0A0E0C", "#0A0E0C", "#78A088", "#161C18", "#161C18"])),
    ]

    private static let studio12: [WebColorPalette] = [
        WebColorPalette(id: "original", name: "Original", family: .studio12, tokens: t(bg: "#FAF7F2", card: "#E8D5C4", text: "#2A1F18", accent: "#B08060", accentHover: "#8A6040", featuredBg: "#FAF7F2", featuredText: "#2A1F18", bookCard: "#FFFDF9", aboutBg: "#2A1F18", aboutText: "#FAF7F2", strip: ["#FAF7F2", "#FAF7F2", "#B08060", "#E8D5C4", "#2A1F18"])),
        WebColorPalette(id: "sandstone", name: "Sandstone", family: .studio12, tokens: t(bg: "#FAF6F0", card: "#E8D5C4", text: "#2A1810", accent: "#B8895A", accentHover: "#8B5A3C", featuredBg: "#FAF6F0", featuredText: "#2A1810", bookCard: "#FFFDF9", aboutBg: "#2A1810", aboutText: "#FAF6F0", strip: ["#FAF6F0", "#FAF6F0", "#B8895A", "#E8D5C4", "#2A1810"])),
        WebColorPalette(id: "soft-neutral", name: "Soft Neutral", family: .studio12, tokens: t(bg: "#F5F3EF", card: "#E5DFD6", text: "#3D3832", accent: "#9A8B7A", accentHover: "#7A6B5E", featuredBg: "#F5F3EF", featuredText: "#3D3832", bookCard: "#FFFDF9", aboutBg: "#3D3832", aboutText: "#F5F3EF", strip: ["#F5F3EF", "#F5F3EF", "#9A8B7A", "#E5DFD6", "#3D3832"])),
        WebColorPalette(id: "ocean-slate", name: "Ocean Slate", family: .studio12, tokens: t(bg: "#F4F8FB", card: "#D4E4EF", text: "#2C3E50", accent: "#6B8FA3", accentHover: "#4A6578", featuredBg: "#F4F8FB", featuredText: "#2C3E50", bookCard: "#FFFDF9", aboutBg: "#2C3E50", aboutText: "#F4F8FB", strip: ["#F4F8FB", "#F4F8FB", "#6B8FA3", "#D4E4EF", "#2C3E50"])),
        WebColorPalette(id: "slate-rust", name: "Slate & Rust", family: .studio12, tokens: t(bg: "#E8EEF3", card: "#B8C9D6", text: "#1E2A33", accent: "#C45C3E", accentHover: "#D97A5C", featuredBg: "#E8EEF3", featuredText: "#1E2A33", bookCard: "#FFFDF9", aboutBg: "#1E2A33", aboutText: "#F4F8FB", strip: ["#E8EEF3", "#E8EEF3", "#C45C3E", "#B8C9D6", "#1E2A33"])),
        WebColorPalette(id: "vintage-warm", name: "Vintage Warm", family: .studio12, tokens: t(bg: "#F2EBE0", card: "#EDE6DC", text: "#1E2A33", accent: "#C45C3E", accentHover: "#A34A32", featuredBg: "#F2EBE0", featuredText: "#1E2A33", bookCard: "#FFFDF9", aboutBg: "#1E2A33", aboutText: "#F2EBE0", strip: ["#F2EBE0", "#F2EBE0", "#C45C3E", "#EDE6DC", "#1E2A33"])),
        WebColorPalette(id: "forest-sage", name: "Forest Sage", family: .studio12, tokens: t(bg: "#F3F7F2", card: "#D6E3D4", text: "#243628", accent: "#5A8266", accentHover: "#446A50", featuredBg: "#F3F7F2", featuredText: "#243628", bookCard: "#FFFDF9", aboutBg: "#243628", aboutText: "#F3F7F2", strip: ["#F3F7F2", "#F3F7F2", "#5A8266", "#D6E3D4", "#243628"])),
        WebColorPalette(id: "midnight-plum", name: "Midnight Plum", family: .studio12, tokens: t(bg: "#F8F5FA", card: "#E6DCF0", text: "#2E2240", accent: "#7258A0", accentHover: "#5A4480", featuredBg: "#F8F5FA", featuredText: "#2E2240", bookCard: "#FFFDF9", aboutBg: "#2E2240", aboutText: "#F8F5FA", strip: ["#F8F5FA", "#F8F5FA", "#7258A0", "#E6DCF0", "#2E2240"])),
        WebColorPalette(id: "coral-bloom", name: "Coral Bloom", family: .studio12, tokens: t(bg: "#FFF7F4", card: "#F0D8D0", text: "#3C2A24", accent: "#D47A64", accentHover: "#B86450", featuredBg: "#FFF7F4", featuredText: "#3C2A24", bookCard: "#FFFDF9", aboutBg: "#3C2A24", aboutText: "#FFF7F4", strip: ["#FFF7F4", "#FFF7F4", "#D47A64", "#F0D8D0", "#3C2A24"])),
        WebColorPalette(id: "arctic-mist", name: "Arctic Mist", family: .studio12, tokens: t(bg: "#F5FAFC", card: "#D6E6F0", text: "#263442", accent: "#5E90AC", accentHover: "#487490", featuredBg: "#F5FAFC", featuredText: "#263442", bookCard: "#FFFDF9", aboutBg: "#263442", aboutText: "#F5FAFC", strip: ["#F5FAFC", "#F5FAFC", "#5E90AC", "#D6E6F0", "#263442"])),
        WebColorPalette(id: "copper-ledger", name: "Copper Ledger", family: .studio12, tokens: t(bg: "#FAF7F0", card: "#E4D4C0", text: "#382C20", accent: "#B07038", accentHover: "#8E5A2C", featuredBg: "#FAF7F0", featuredText: "#382C20", bookCard: "#FFFDF9", aboutBg: "#382C20", aboutText: "#FAF7F0", strip: ["#FAF7F0", "#FAF7F0", "#B07038", "#E4D4C0", "#382C20"])),
        WebColorPalette(id: "lavender-haze", name: "Lavender Haze", family: .studio12, tokens: t(bg: "#F7F6FA", card: "#E2DEE8", text: "#363042", accent: "#8878A0", accentHover: "#6E6084", featuredBg: "#F7F6FA", featuredText: "#363042", bookCard: "#FFFDF9", aboutBg: "#363042", aboutText: "#F7F6FA", strip: ["#F7F6FA", "#F7F6FA", "#8878A0", "#E2DEE8", "#363042"])),
        WebColorPalette(id: "olive-grove", name: "Olive Grove", family: .studio12, tokens: t(bg: "#F4F3EC", card: "#DCD6C0", text: "#302E24", accent: "#7E7A4C", accentHover: "#62603C", featuredBg: "#F4F3EC", featuredText: "#302E24", bookCard: "#FFFDF9", aboutBg: "#302E24", aboutText: "#F4F3EC", strip: ["#F4F3EC", "#F4F3EC", "#7E7A4C", "#DCD6C0", "#302E24"])),
        WebColorPalette(id: "rose-quartz", name: "Rose Quartz", family: .studio12, tokens: t(bg: "#FAF6F7", card: "#E8D6DA", text: "#3C2E32", accent: "#B88490", accentHover: "#9A6C78", featuredBg: "#FAF6F7", featuredText: "#3C2E32", bookCard: "#FFFDF9", aboutBg: "#3C2E32", aboutText: "#FAF6F7", strip: ["#FAF6F7", "#FAF6F7", "#B88490", "#E8D6DA", "#3C2E32"])),
        WebColorPalette(id: "graphite-mint", name: "Graphite Mint", family: .studio12, tokens: t(bg: "#F3F6F5", card: "#D2E0DC", text: "#222E2A", accent: "#468878", accentHover: "#366C5E", featuredBg: "#F3F6F5", featuredText: "#222E2A", bookCard: "#FFFDF9", aboutBg: "#222E2A", aboutText: "#F3F6F5", strip: ["#F3F6F5", "#F3F6F5", "#468878", "#D2E0DC", "#222E2A"])),
        WebColorPalette(id: "honey-linen", name: "Honey Linen", family: .studio12, tokens: t(bg: "#FAF7EE", card: "#E8DCC0", text: "#383020", accent: "#B89438", accentHover: "#96782C", featuredBg: "#FAF7EE", featuredText: "#383020", bookCard: "#FFFDF9", aboutBg: "#383020", aboutText: "#FAF7EE", strip: ["#FAF7EE", "#FAF7EE", "#B89438", "#E8DCC0", "#383020"])),
        WebColorPalette(id: "baltic-blue", name: "Baltic Blue", family: .studio12, tokens: t(bg: "#F3F7FA", card: "#CEDCE8", text: "#1C2C3C", accent: "#346890", accentHover: "#285274", featuredBg: "#F3F7FA", featuredText: "#1C2C3C", bookCard: "#FFFDF9", aboutBg: "#1C2C3C", aboutText: "#F3F7FA", strip: ["#F3F7FA", "#F3F7FA", "#346890", "#CEDCE8", "#1C2C3C"])),
        WebColorPalette(id: "terracotta-clay", name: "Terracotta Clay", family: .studio12, tokens: t(bg: "#F8F3EC", card: "#E2CCB8", text: "#38281C", accent: "#B86C48", accentHover: "#965438", featuredBg: "#F8F3EC", featuredText: "#38281C", bookCard: "#FFFDF9", aboutBg: "#38281C", aboutText: "#F8F3EC", strip: ["#F8F3EC", "#F8F3EC", "#B86C48", "#E2CCB8", "#38281C"])),
        WebColorPalette(id: "pearl-ash", name: "Pearl Ash", family: .studio12, tokens: t(bg: "#F5F6F8", card: "#DEE2E8", text: "#2A3038", accent: "#6E7C8C", accentHover: "#566470", featuredBg: "#F5F6F8", featuredText: "#2A3038", bookCard: "#FFFDF9", aboutBg: "#2A3038", aboutText: "#F5F6F8", strip: ["#F5F6F8", "#F5F6F8", "#6E7C8C", "#DEE2E8", "#2A3038"])),
        WebColorPalette(id: "berry-noir", name: "Berry Noir", family: .studio12, tokens: t(bg: "#F8F4F6", card: "#E2D4DC", text: "#301C28", accent: "#905870", accentHover: "#74445A", featuredBg: "#F8F4F6", featuredText: "#301C28", bookCard: "#FFFDF9", aboutBg: "#301C28", aboutText: "#F8F4F6", strip: ["#F8F4F6", "#F8F4F6", "#905870", "#E2D4DC", "#301C28"])),
        WebColorPalette(id: "sage-steam", name: "Sage Steam", family: .studio12, tokens: t(bg: "#F4F8F5", card: "#DCE8E0", text: "#2A322C", accent: "#689078", accentHover: "#527460", featuredBg: "#F4F8F5", featuredText: "#2A322C", bookCard: "#FFFDF9", aboutBg: "#2A322C", aboutText: "#F4F8F5", strip: ["#F4F8F5", "#F4F8F5", "#689078", "#DCE8E0", "#2A322C"])),
    ]
}
