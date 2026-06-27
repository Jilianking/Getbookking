//
//  DesignViewModel.swift
//
//  Web page design: branding, form fields, services, contact.
//

import Foundation
import Combine
import SwiftUI
import UIKit
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions

enum DesignTab: String, CaseIterable {
    case template
    case home
    case gallery
    case book
    case about
    case team
    case shop

    static let manageTabs: [DesignTab] = [.gallery, .book, .about, .team, .shop]

    /// Manage segment tabs; omit `.team` when the tenant is Solo (no public team pages).
    static func manageTabs(showTeam: Bool) -> [DesignTab] {
        var tabs: [DesignTab] = [.gallery, .book, .about]
        if showTeam { tabs.append(.team) }
        tabs.append(.shop)
        return tabs
    }

    var manageSegmentTitle: String {
        switch self {
        case .gallery: return "Gallery"
        case .book: return "Book"
        case .about: return "About"
        case .team: return "Team"
        case .shop: return "Shop"
        default: return rawValue.capitalized
        }
    }
}

/// Editable “Your experience” steps on Studio 12 home (`studio12ProcessSteps` in Firestore).
struct Studio12ProcessStep: Identifiable, Equatable {
    var id: Int
    var title: String
    var body: String
}

class DesignViewModel: ObservableObject, BusinessHoursEditing {
    @Published var tenantId: String?
    @Published var tenantSlug: String?
    @Published var bookingUrl: String = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false
    /// True while browsing Design in a live demo (read-only; no Storage/Firestore writes).
    @Published private(set) var isDemoReadOnly = false
    /// Drives a friendly alert when the user tries to upload or save in demo mode.
    @Published var showDemoBlockedAlert = false
    @Published private(set) var isApplyingBladeStarters = false
    @Published private(set) var isSavingBladeServices = false
    /// Bumped when Firestore content affecting the public site changes so the in-app WKWebView reloads (same path would otherwise stay stale).
    @Published private(set) var webPreviewReloadToken: UInt64 = 0
    /// Bumped when site colors change in-app — Design patches WKWebView instead of full reload.
    @Published private(set) var webPreviewColorPatchToken: UInt64 = 0
    /// Set while Quick edit is active; flushed when the session ends (toggle off or leave Design).
    private(set) var pendingWebPreviewReload = false

    // Home: appearance + hero + featured work
    @Published var displayName: String = ""
    /// App business name from signup/settings (`businessName` / `users.business`); used as website fallback prompt.
    @Published var appBusinessName: String = ""
    @Published var logoUrl: String = ""
    @Published var heroImageUrl: String = ""
    /// Pixel size of the last uploaded hero JPEG; public site (all templates) matches this aspect so the live hero matches the in-app crop.
    @Published var heroImagePixelWidth: Int = 16
    @Published var heroImagePixelHeight: Int = 9
    @Published var isUploadingHero = false
    /// Shown only on `/gallery` (not on home featured strip).
    @Published var galleryImages: [String] = []
    @Published var isUploadingGallery = false
    /// Home featured strip only; order matters. Independent from `galleryImages`.
    @Published var featuredWorkImages: [String] = []
    @Published var isUploadingFeaturedWork = false
    @Published var galleryGridLayout: String = "3x1"
    /// Full-page `/gallery` layout; independent of template (Classic, Luxe, Blade, Stonecut, Studio 12).
    @Published var galleryLayoutStyle: GalleryLayoutStyle = .classicGrid
    @Published var backgroundColorHex: String = "#FFFFFF"
    @Published var cardSurfaceColorHex: String = "#F5F5F5"
    @Published var textColorHex: String = "#333333"
    @Published var primaryColorHex: String = "#000000"
    @Published var primaryColorHoverHex: String = "#333333"
    @Published var successColorHex: String = "#22C55E"
    @Published var cardBorderRadius: Double = 12
    @Published var tagline: String = ""
    /// Luxe home hero line under the business name only (not booking / promo tagline).
    @Published var luxeHeroTagline: String = ""
    /// Luxe cream promo strip headline (above tagline + Book Now).
    @Published var luxePromoHeadline: String = ""
    /// Luxe home featured card strip (under hero): eyebrow + heading; empty uses “Gallery” / “Featured work” on the web.
    @Published var luxeFeaturedWorkEyebrow: String = ""
    @Published var luxeFeaturedWorkHeading: String = ""
    /// When false, the featured card strip is hidden on Luxe home (Gallery page must still be on to show it when true).
    @Published var luxeShowFeaturedWorkStrip: Bool = true
    /// Optional list under the featured strip on Luxe home; empty labels use “Services” / “What we offer”.
    @Published var luxeHomeServicesEyebrow: String = ""
    @Published var luxeHomeServicesHeading: String = ""
    /// When true, the home service list appears under the featured strip on the live Luxe site.
    @Published var luxeShowHomeServicesSection: Bool = false
    /// When true, the Luxe home service list is wrapped in `<details>` (starts collapsed on the web).
    @Published var luxeHomeServicesExpandableCard: Bool = false
    /// Blade hero italic line before the business name.
    @Published var bladeHeroTagline: String = ""
    /// Blade hero paragraph under the name (optional; falls back to About text on web).
    @Published var bladeHeroDescription: String = ""

    // MARK: - Studio 12 home only (`studio-12-v1`)
    /// Italic phrase in “Hair that reflects …” on Studio 12 hero (`heroTagline` in Firestore; web falls back to `heroSubtitle`).
    @Published var heroTagline: String = ""
    /// Optional overrides; empty uses industry defaults on the site (`studio12HeroEyebrow` / headline).
    @Published var studio12HeroEyebrow: String = ""
    /// One line; the public site splits into two display lines (`… that …` or balanced at a space).
    @Published var studio12HeroHeadline: String = ""
    @Published var studio12PhilosophyImageUrl: String = ""
    @Published var studio12PhilosophyImagePixelWidth: Int = 16
    @Published var studio12PhilosophyImagePixelHeight: Int = 9
    @Published var isUploadingStudio12Philosophy = false
    /// Three parts separated by ` · ` (space–middle dot–space); site renders as three lines with the last in italics.
    @Published var studio12PhilosophyHeadline: String = ""
    @Published var studio12ProcessSteps: [Studio12ProcessStep] = Studio12IndustryCopy.processSteps(for: .custom)
    /// Two parts separated by ` · `; site renders first line + italic second line.
    @Published var studio12BookCtaHeadline: String = ""
    @Published var studio12BookCtaBody: String = ""
    @Published var studio12BookCtaImageUrl: String = ""
    @Published var studio12BookCtaImagePixelWidth: Int = 16
    @Published var studio12BookCtaImagePixelHeight: Int = 9
    @Published var isUploadingStudio12BookCta = false
    /// When false, the “What we offer” grid is hidden on the public home page (default on).
    @Published var studio12ShowServicesSection: Bool = true
    /// When false, the “How it works / Your experience” block is hidden (default on).
    @Published var studio12ShowProcessSection: Bool = true

    /// Classic home “What I offer”: when false, duration lines are hidden on the live site (`classicShowServiceDuration` in Firestore).
    @Published var classicShowServiceDuration: Bool = true
    /// Classic featured strip copy; empty strings use industry defaults on the web.
    @Published var classicFeaturedWorkEyebrow: String = ""
    @Published var classicFeaturedWorkHeading: String = ""
    @Published var classicFeaturedWorkSub: String = ""
    @Published var classicFeaturedWorkEmpty: String = ""
    /// Classic “What I offer” block labels; empty uses “Services” / “What I offer”.
    @Published var classicServicesEyebrow: String = ""
    @Published var classicServicesHeading: String = ""
    /// When true, the live Classic home wraps the service list in `<details>` (tap to expand).
    @Published var classicServicesExpandableCard: Bool = false

    /// Classic dark About band: three headline stats row (`classicShowAboutStats` in Firestore).
    @Published var classicShowAboutStats: Bool = true
    @Published var classicStatYearsValue: String = "8+"
    @Published var classicStatYearsLabel: String = "Years exp."
    @Published var classicStatClientsValue: String = "500+"
    @Published var classicStatClientsLabel: String = "Clients"
    @Published var classicStatRatedValue: String = "5★"
    @Published var classicStatRatedLabel: String = "Rated"
    /// Classic dark About band: small eyebrow above the headline (empty uses “About” on the web).
    @Published var classicAboutEyebrow: String = ""
    /// Classic About headline (plain text). Empty uses the industry default HTML on the web.
    @Published var classicAboutHeading: String = ""

    // Section surfaces (Design tabs: Home / Gallery / About)
    /// Tattoo template default: warm paper — Featured, Gallery, and Book share this theme on the web.
    @Published var featuredWorkBackgroundColorHex: String = "#FAF8F5"
    @Published var featuredWorkTextColorHex: String = "#1C1917"
    @Published var bookingFormCardBackgroundColorHex: String = "#FFFFFF"
    @Published var galleryPageBackgroundColorHex: String = "#FAF8F5"
    @Published var galleryPageTextColorHex: String = "#1C1917"
    @Published var aboutSectionBackgroundColorHex: String = "#111111"
    @Published var aboutSectionTextColorHex: String = "#FFFFFF"
    /// Live quick-edit hero slot color (may differ from page bg when user paints the hero band).
    @Published var previewHeroSlotColorHex: String = "#FFFDF9"

    // Form fields
    @Published var formFields: [FormField] = []
    /// `/book` layout: `standard` (dropdowns) or `guided` (service grid + pills). Independent of `webThemeId`.
    @Published var bookingFormStyleId: String = BookingFormStyle.standard.rawValue

    // Services
    @Published var services: [TenantService] = []

    // Products (shop section)
    @Published var shopEnabled: Bool = false
    /// Public `/gallery` route and gallery nav links (default on).
    @Published var showGalleryPage: Bool = true
    /// Public `/book` route and booking nav / primary CTAs (default on).
    @Published var showBookPage: Bool = true
    /// Public `/about` route and About nav link to that URL (default on).
    @Published var showAboutPage: Bool = true
    /// Public `/team` roster page for Studio/Shop (default on).
    @Published var showTeamPage: Bool = true
    /// “Meet the team” strip on home before the footer (default on).
    @Published var showMeetTheTeamOnHome: Bool = true
    @Published var teamMemberVisibility: [TeamMemberVisibilityDraft] = []
    @Published var uploadingTeamMemberPhotoUid: String?
    @Published var products: [Product] = []
    @Published var shopOrders: [ShopOrder] = []
    @Published var isUploadingProduct = false

    // Template / industry (business type — set in Settings)
    @Published var industry: String?
    @Published var industryCustomLabel: String = ""
    /// Public site layout variant; see `WebTheme`. Scoped to current `industry`.
    @Published var webThemeId: String = ""
    /// Curated color preset for the active template family (`webColorPaletteId` on tenant).
    @Published var webColorPaletteId: String = "original"

    /// Portfolio-style web templates (featured strip, gallery, booking chrome, sidebar).
    var usesPortfolioStyleWebChrome: Bool {
        (WebTheme(rawValue: webThemeId)?.family ?? .classic) == .classic
    }

    // Sidebar appearance (empty = auto-detect: black on white bg, white on colored bg)
    @Published var sidebarIconColorHome: String = ""
    @Published var sidebarIconColorBooking: String = ""

    // About: about text + contact
    @Published var aboutText: String = ""
    @Published var contactPhone: String = ""
    @Published var contactEmail: String = ""
    @Published var contactAddress: String = ""
    @Published var contactAddressSuite: String = ""
    /// Short line for marketing (e.g. city, state) — Blade hero eyebrow; full street stays in `contactAddress`.
    @Published var serviceArea: String = ""
    /// Parsed/edited with US state picker; composed into `serviceArea` on save.
    @Published var serviceCity: String = ""
    @Published var serviceStateAbbr: String = ""
    @Published var businessHours: String = ""
    @Published var businessHoursWeekly: BusinessHoursWeekly = .defaultOfficeHours
    @Published var businessHoursExceptions: [BusinessHoursException] = []
    @Published var instagramHandle: String = ""
    @Published var showContactOnPage: Bool = true
    @Published var showBusinessHoursOnPage: Bool = true

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions()

    var hasTenant: Bool { tenantId != nil }

    @discardableResult
    func blockIfDemoReadOnly(showAlert: Bool = true) -> Bool {
        guard isDemoReadOnly else { return false }
        if showAlert {
            showDemoBlockedAlert = true
        }
        return true
    }

    var serviceStateMenuLabel: String {
        let abbr = serviceStateAbbr.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if abbr.isEmpty { return "State" }
        return USStateServiceAreaFormatting.displayName(forAbbr: abbr) ?? abbr
    }

    func normalizeServiceCityTitleCase() {
        serviceCity = USStateServiceAreaFormatting.titleCaseWords(serviceCity)
    }

    func composeServiceAreaForPersistence() {
        serviceArea = USStateServiceAreaFormatting.composedServiceArea(city: serviceCity, stateAbbr: serviceStateAbbr)
    }

    static func composedStreetAddress(street: String, suite: String) -> String {
        let s = street.trimmingCharacters(in: .whitespacesAndNewlines)
        let u = suite.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return u }
        guard !u.isEmpty else { return s }
        return s + "\n" + u
    }

    static func parsedStreetAndSuite(from tenant: [String: Any]?) -> (street: String, suite: String) {
        let storedSuite = (tenant?["contactAddressSuite"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let contactStreet = (tenant?["contactAddress"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !contactStreet.isEmpty {
            return (contactStreet, storedSuite)
        }
        let legacy = (tenant?["address"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !legacy.isEmpty else { return ("", storedSuite) }
        if !storedSuite.isEmpty {
            return (legacy.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? legacy, storedSuite)
        }
        let parts = legacy.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true)
        let street = parts.first.map(String.init) ?? legacy
        let suite = parts.count > 1 ? String(parts[1]) : ""
        return (street, suite)
    }

    static func normalizedInstagramHandle(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "@"))
    }

    private func contactAddressFirestoreUpdates() -> [String: Any] {
        let street = contactAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        let suite = contactAddressSuite.trimmingCharacters(in: .whitespacesAndNewlines)
        let composed = Self.composedStreetAddress(street: street, suite: suite)
        return [
            "contactAddress": street,
            "contactAddressSuite": suite,
            "address": composed,
        ]
    }

    func invalidateWebPreview() {
        webPreviewReloadToken &+= 1
    }

    func bumpWebPreviewColorPatch() {
        webPreviewColorPatchToken &+= 1
    }

    func deferWebPreviewReload() {
        pendingWebPreviewReload = true
    }

    @MainActor
    func flushDeferredWebPreviewReloadIfNeeded() {
        guard pendingWebPreviewReload else { return }
        pendingWebPreviewReload = false
        invalidateWebPreview()
    }

    /// Matches `studio12SplitHeroHeadline` in `web/index.html`.
    private static func splitStudio12HeroHeadline(_ raw: String) -> (line1: String, line2: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return ("", "") }
        let ns = s as NSString
        let length = ns.length
        if let regex = try? NSRegularExpression(pattern: "^(.+?)\\s+that\\s+(.+)$", options: [.caseInsensitive]),
           let r = regex.firstMatch(in: s, range: NSRange(location: 0, length: length)),
           r.numberOfRanges == 3 {
            let l1 = ns.substring(with: r.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines) + " that"
            let l2 = ns.substring(with: r.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            return (l1, l2)
        }
        let mid = length / 2
        let leftRange = NSRange(location: 0, length: max(0, mid))
        let leftMatch = ns.range(of: " ", options: .backwards, range: leftRange)
        let leftIdx = leftMatch.location != NSNotFound ? leftMatch.location : -1
        let rightSearchLen = max(0, length - mid)
        let rightMatch = ns.range(of: " ", options: [], range: NSRange(location: mid, length: rightSearchLen))
        let rightIdx = rightMatch.location != NSNotFound ? rightMatch.location : -1
        let breakAt: Int
        if leftIdx < 0 {
            breakAt = rightIdx
        } else if rightIdx < 0 {
            breakAt = leftIdx
        } else {
            breakAt = (mid - leftIdx <= rightIdx - mid) ? leftIdx : rightIdx
        }
        if breakAt <= 0 || breakAt >= length - 1 {
            return (s, "")
        }
        let line1 = ns.substring(with: NSRange(location: 0, length: breakAt)).trimmingCharacters(in: .whitespacesAndNewlines)
        let line2 = ns.substring(with: NSRange(location: breakAt + 1, length: length - breakAt - 1)).trimmingCharacters(in: .whitespacesAndNewlines)
        return (line1, line2)
    }

    /// Matches `studio12SplitMiddleDot` in `web/index.html`.
    private static func studio12SplitMiddleDotParts(_ raw: String, count: Int) -> [String] {
        let sep = " · "
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return Array(repeating: "", count: count) }
        var parts = s.components(separatedBy: sep).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        while parts.count < count { parts.append("") }
        if parts.count > count {
            let tail = parts[(count - 1)...].joined(separator: sep)
            parts = Array(parts.prefix(count - 1)) + [tail]
        }
        return parts
    }

    private static func trimmedFirestoreString(_ doc: [String: Any], key: String) -> String {
        (doc[key] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Firestore `webCopyOverrides` map values coerced to strings (preserves unrelated keys when merging).
    private static func coercedStringMap(_ value: Any?) -> [String: String] {
        guard let dict = value as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (k, v) in dict {
            if let s = v as? String {
                out[k] = s
            } else if v is NSNull {
                continue
            } else if let n = v as? NSNumber {
                out[k] = n.stringValue
            }
        }
        return out
    }

    /// Legacy `svc:<id>:name|description` from older previews; website labels use `wc.svc.<id>.*` overrides only.
    private func persistQuickEditServiceField(fieldKey: String, trimmed: String) async throws {
        guard let tid = tenantId else { return }
        let parts = fieldKey.split(separator: ":").map(String.init)
        guard parts.count == 3, parts[0] == "svc" else { return }
        let serviceId = parts[1]
        let field = parts[2]
        guard !serviceId.isEmpty, ["name", "description"].contains(field) else { return }
        if field == "name", trimmed.isEmpty {
            await MainActor.run { errorMessage = "Service name can’t be empty." }
            return
        }
        let wcKey = "wc.svc.\(serviceId).\(field)"
        try await persistWebCopyOverride(tenantId: tid, key: wcKey, value: trimmed)
        await MainActor.run { errorMessage = nil }
    }

    private func studio12ProcessStepsFirestorePayload() -> [[String: String]] {
        studio12ProcessSteps
            .sorted { $0.id < $1.id }
            .map { ["title": $0.title, "body": $0.body] }
    }

    /// Updates one Studio 12 “How it works” step from preview `data-edit-key` (`s12Process:<index>:title|body`).
    private func persistQuickEditStudio12ProcessField(fieldKey: String, trimmed: String) async throws {
        guard let tid = tenantId else { return }
        guard (WebTheme(rawValue: webThemeId)?.family ?? .classic) == .studio12 else { return }
        let parts = fieldKey.split(separator: ":").map(String.init)
        guard parts.count == 3, parts[0] == "s12Process", let index = Int(parts[1]) else { return }
        let field = parts[2]
        guard field == "title" || field == "body" else { return }

        var steps = await MainActor.run { studio12ProcessSteps }
        guard steps.indices.contains(index) else {
            await MainActor.run { errorMessage = "That step was not found. Refresh and try again." }
            return
        }
        if field == "title", trimmed.isEmpty {
            await MainActor.run { errorMessage = "Step title can't be empty." }
            return
        }
        if field == "title" {
            steps[index].title = trimmed
        } else {
            steps[index].body = trimmed
        }
        await MainActor.run { studio12ProcessSteps = steps }
        try await firebaseService.updateTenant(
            tenantId: tid,
            updates: ["studio12ProcessSteps": await MainActor.run { studio12ProcessStepsFirestorePayload() }]
        )
        await MainActor.run { errorMessage = nil }
    }

    /// Persists one `wc.*` quick-edit slot into `webCopyOverrides` (empty value removes override).
    private func persistWebCopyOverride(tenantId: String, key: String, value: String) async throws {
        guard key.hasPrefix("wc.") else { return }
        guard let doc = try await firebaseService.fetchTenant(tenantId: tenantId) else { return }
        var map = Self.coercedStringMap(doc["webCopyOverrides"])
        if value.isEmpty {
            map.removeValue(forKey: key)
        } else {
            map[key] = value
        }
        try await firebaseService.updateTenant(tenantId: tenantId, updates: ["webCopyOverrides": map])
    }

    /// Inline quick edit from the in-app WKWebView preview (`data-edit-key` in `web/index.html`).
    /// Set `invalidatePreview` to `false` when applying several edits before a single `invalidateWebPreview()` (see `saveQuickEditBatch`).
    func saveQuickEdit(fieldKey: String, value: String, invalidatePreview: Bool = true) async {
        guard let tid = tenantId else { return }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let fam = WebTheme(rawValue: webThemeId)?.family ?? .classic
        await MainActor.run { errorMessage = nil }
        do {
            switch fieldKey {
            case "displayName":
                try await firebaseService.updateTenant(tenantId: tid, updates: ["displayName": trimmed])
                await MainActor.run {
                    displayName = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxeHeroTagline":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxeHeroTagline": trimmed])
                await MainActor.run {
                    luxeHeroTagline = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "bladeHeroTagline":
                guard fam == .blade else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["bladeHeroTagline": trimmed])
                await MainActor.run {
                    bladeHeroTagline = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "bladeHeroDescription":
                guard fam == .blade else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["bladeHeroDescription": trimmed])
                await MainActor.run {
                    bladeHeroDescription = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicAboutEyebrow":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicAboutEyebrow": trimmed])
                await MainActor.run {
                    classicAboutEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicAboutHeading":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicAboutHeading": trimmed])
                await MainActor.run {
                    classicAboutHeading = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatYearsValue":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatYearsValue": trimmed])
                await MainActor.run {
                    classicStatYearsValue = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatYearsLabel":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatYearsLabel": trimmed])
                await MainActor.run {
                    classicStatYearsLabel = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatClientsValue":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatClientsValue": trimmed])
                await MainActor.run {
                    classicStatClientsValue = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatClientsLabel":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatClientsLabel": trimmed])
                await MainActor.run {
                    classicStatClientsLabel = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatRatedValue":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatRatedValue": trimmed])
                await MainActor.run {
                    classicStatRatedValue = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicStatRatedLabel":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicStatRatedLabel": trimmed])
                await MainActor.run {
                    classicStatRatedLabel = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicFeaturedWorkEyebrow":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicFeaturedWorkEyebrow": trimmed])
                await MainActor.run {
                    classicFeaturedWorkEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicFeaturedWorkHeading":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicFeaturedWorkHeading": trimmed])
                await MainActor.run {
                    classicFeaturedWorkHeading = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicFeaturedWorkSub":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicFeaturedWorkSub": trimmed])
                await MainActor.run {
                    classicFeaturedWorkSub = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicFeaturedWorkEmpty":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicFeaturedWorkEmpty": trimmed])
                await MainActor.run {
                    classicFeaturedWorkEmpty = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicServicesEyebrow":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicServicesEyebrow": trimmed])
                await MainActor.run {
                    classicServicesEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "classicServicesHeading":
                guard fam == .classic else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["classicServicesHeading": trimmed])
                await MainActor.run {
                    classicServicesHeading = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxePromoHeadline":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxePromoHeadline": trimmed])
                await MainActor.run {
                    luxePromoHeadline = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxeFeaturedWorkEyebrow":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxeFeaturedWorkEyebrow": trimmed])
                await MainActor.run {
                    luxeFeaturedWorkEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxeFeaturedWorkHeading":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxeFeaturedWorkHeading": trimmed])
                await MainActor.run {
                    luxeFeaturedWorkHeading = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxeHomeServicesEyebrow":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxeHomeServicesEyebrow": trimmed])
                await MainActor.run {
                    luxeHomeServicesEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "luxeHomeServicesHeading":
                guard fam == .luxe else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["luxeHomeServicesHeading": trimmed])
                await MainActor.run {
                    luxeHomeServicesHeading = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "heroTagline":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["heroTagline": trimmed])
                await MainActor.run {
                    heroTagline = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "studio12HeroEyebrow":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["studio12HeroEyebrow": trimmed])
                await MainActor.run {
                    studio12HeroEyebrow = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "studio12HeroLine1":
                guard fam == .studio12 else { return }
                guard let doc = try await firebaseService.fetchTenant(tenantId: tid) else { return }
                let mergedHero = Self.trimmedFirestoreString(doc, key: "studio12HeroHeadline")
                let line2: String
                if !mergedHero.isEmpty {
                    line2 = Self.splitStudio12HeroHeadline(mergedHero).line2
                } else {
                    line2 = Self.trimmedFirestoreString(doc, key: "studio12HeroLine2")
                }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12HeroLine1": trimmed,
                    "studio12HeroLine2": line2,
                    "studio12HeroHeadline": "",
                ])
                await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
            case "studio12HeroLine2":
                guard fam == .studio12 else { return }
                guard let doc = try await firebaseService.fetchTenant(tenantId: tid) else { return }
                let mergedHero = Self.trimmedFirestoreString(doc, key: "studio12HeroHeadline")
                let line1: String
                if !mergedHero.isEmpty {
                    line1 = Self.splitStudio12HeroHeadline(mergedHero).line1
                } else {
                    line1 = Self.trimmedFirestoreString(doc, key: "studio12HeroLine1")
                }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12HeroLine1": line1,
                    "studio12HeroLine2": trimmed,
                    "studio12HeroHeadline": "",
                ])
                await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
            case "studio12BookCtaLine1":
                guard fam == .studio12 else { return }
                guard let doc = try await firebaseService.fetchTenant(tenantId: tid) else { return }
                let mergedBook = Self.trimmedFirestoreString(doc, key: "studio12BookCtaHeadline")
                let italic: String
                if !mergedBook.isEmpty {
                    let parts = Self.studio12SplitMiddleDotParts(mergedBook, count: 2)
                    italic = parts.count > 1 ? parts[1] : ""
                } else {
                    italic = Self.trimmedFirestoreString(doc, key: "studio12BookCtaItalic")
                }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12BookCtaLine1": trimmed,
                    "studio12BookCtaItalic": italic,
                    "studio12BookCtaHeadline": "",
                ])
                await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
            case "studio12BookCtaItalic":
                guard fam == .studio12 else { return }
                guard let doc = try await firebaseService.fetchTenant(tenantId: tid) else { return }
                let mergedBook = Self.trimmedFirestoreString(doc, key: "studio12BookCtaHeadline")
                let bookLine1: String
                if !mergedBook.isEmpty {
                    let parts = Self.studio12SplitMiddleDotParts(mergedBook, count: 2)
                    bookLine1 = parts.first ?? ""
                } else {
                    bookLine1 = Self.trimmedFirestoreString(doc, key: "studio12BookCtaLine1")
                }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12BookCtaLine1": bookLine1,
                    "studio12BookCtaItalic": trimmed,
                    "studio12BookCtaHeadline": "",
                ])
                await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
            case "studio12BookCtaBody":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: ["studio12BookCtaBody": trimmed])
                await MainActor.run {
                    studio12BookCtaBody = trimmed
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "studio12PhilosophyHeadLine1":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12PhilosophyHeadLine1": trimmed,
                    "studio12PhilosophyHeadline": "",
                ])
                await MainActor.run {
                    studio12PhilosophyHeadline = ""
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "studio12PhilosophyHeadLine2":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12PhilosophyHeadLine2": trimmed,
                    "studio12PhilosophyHeadline": "",
                ])
                await MainActor.run {
                    studio12PhilosophyHeadline = ""
                    if invalidatePreview { invalidateWebPreview() }
                }
            case "studio12PhilosophyHeadItalic":
                guard fam == .studio12 else { return }
                try await firebaseService.updateTenant(tenantId: tid, updates: [
                    "studio12PhilosophyHeadItalic": trimmed,
                    "studio12PhilosophyHeadline": "",
                ])
                await MainActor.run {
                    studio12PhilosophyHeadline = ""
                    if invalidatePreview { invalidateWebPreview() }
                }
            default:
                if fieldKey.hasPrefix("svc:") {
                    try await persistQuickEditServiceField(fieldKey: fieldKey, trimmed: trimmed)
                    await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
                } else if fieldKey.hasPrefix("s12Process:") {
                    try await persistQuickEditStudio12ProcessField(fieldKey: fieldKey, trimmed: trimmed)
                    await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
                } else if fieldKey.hasPrefix("wc.") {
                    let rest = String(fieldKey.dropFirst(3))
                    guard !rest.isEmpty,
                          rest.range(of: "^[a-zA-Z0-9_.-]+$", options: .regularExpression) != nil else { break }
                    try await persistWebCopyOverride(tenantId: tid, key: fieldKey, value: trimmed)
                    await MainActor.run { if invalidatePreview { invalidateWebPreview() } }
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    /// Applies many WKWebView preview edits. Pass `reloadPreview: false` during Quick edit (reload is deferred until the session ends).
    func saveQuickEditBatch(_ pairs: [(fieldKey: String, value: String)], reloadPreview: Bool = true) async {
        guard !pairs.isEmpty else { return }
        for pair in pairs {
            await saveQuickEdit(fieldKey: pair.fieldKey, value: pair.value, invalidatePreview: false)
        }
        await MainActor.run {
            if reloadPreview {
                pendingWebPreviewReload = false
                invalidateWebPreview()
            } else {
                deferWebPreviewReload()
            }
        }
    }

    func applyFeaturedWorkPreset(_ preset: FeaturedWorkColorPreset) {
        featuredWorkBackgroundColorHex = preset.backgroundHex
        featuredWorkTextColorHex = preset.textHex
        if usesPortfolioStyleWebChrome {
            galleryPageBackgroundColorHex = preset.backgroundHex
            galleryPageTextColorHex = preset.textHex
        }
    }

    /// Maps legacy custom colors to the nearest curated preset (background drives the match; text follows).
    func snapFeaturedWorkColorsToNearestPreset() {
        guard let preset = FeaturedWorkColorPresets.nearest(toBackgroundHex: featuredWorkBackgroundColorHex) else { return }
        applyFeaturedWorkPreset(preset)
    }

    /// Layout slot count for the home featured strip (web uses first this many URLs from `featuredWorkImages`).
    var featuredWorkImageSlotCount: Int {
        if usesPortfolioStyleWebChrome { return 3 }
        /// Luxe home featured card row is always up to 4 cells (`web/index.html` `luxeHomePage`); must match Quick edit `featuredWork:0…3`.
        if (WebTheme(rawValue: webThemeId)?.family ?? .classic) == .luxe { return 4 }
        let normalized = galleryGridLayout
            .lowercased()
            .replacingOccurrences(of: "×", with: "x")
        let parts = normalized.split(separator: "x").map {
            String($0).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard parts.count == 2,
              let cols = Int(parts[0]),
              let rows = Int(parts[1]),
              cols > 0, rows > 0 else {
            return 3
        }
        return cols * rows
    }

    /// Maps stored layouts onto horizontal strips `2x1` / `3x1` (columns × one row). Legacy `4x1` maps to `3x1`.
    func normalizeFeaturedGridLayoutPresets() {
        if usesPortfolioStyleWebChrome {
            galleryGridLayout = "3x1"
            return
        }
        let presets: Set<String> = ["2x1", "3x1"]
        let key = galleryGridLayout.lowercased().replacingOccurrences(of: "×", with: "x")
        if key == "4x1" {
            galleryGridLayout = "3x1"
            return
        }
        if presets.contains(key) { return }
        let slots = featuredWorkImageSlotCount
        if slots <= 2 {
            galleryGridLayout = "2x1"
        } else {
            galleryGridLayout = "3x1"
        }
    }

    func loadData(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            if let sessionStore, sessionStore.isDemoSession {
                let tenant = sessionStore.tenant ?? [:]
                let slug = sessionStore.profile?.tenantSlug ?? sessionStore.demoPersona?.slug ?? ""
                await MainActor.run {
                    tenantId = sessionStore.tenantId
                    tenantSlug = slug.isEmpty ? nil : slug
                    bookingUrl = slug.isEmpty ? "" : PublicBookingSite.urlString(forSlug: slug)
                    industry = tenant["industry"] as? String
                    webThemeId = tenant["webThemeId"] as? String ?? ""
                    serviceArea = tenant["serviceArea"] as? String ?? ""
                    serviceCity = tenant["serviceCity"] as? String ?? ""
                    serviceStateAbbr = tenant["serviceStateAbbr"] as? String ?? ""
                    formFields = FormField.defaultFields
                    services = []
                    galleryImages = tenant["galleryImages"] as? [String] ?? []
                    featuredWorkImages = tenant["featuredWorkImages"] as? [String] ?? []
                    showGalleryPage = tenant["showGalleryPage"] as? Bool ?? true
                    galleryLayoutStyle = GalleryLayoutStyle.fromStored(tenant["galleryLayoutStyle"] as? String)
                    let parsedAddress = Self.parsedStreetAndSuite(from: tenant)
                    contactAddress = parsedAddress.street
                    contactAddressSuite = parsedAddress.suite
                    contactPhone = tenant["contactPhone"] as? String ?? ""
                    contactEmail = tenant["contactEmail"] as? String ?? ""
                    instagramHandle = tenant["instagramHandle"] as? String ?? ""
                    isDemoReadOnly = true
                    isLoading = false
                }
                return
            }
            await MainActor.run {
                tenantId = nil
                tenantSlug = nil
                bookingUrl = ""
                formFields = FormField.defaultFields
                services = []
                industry = nil
                webThemeId = ""
                serviceArea = ""
                serviceCity = ""
                serviceStateAbbr = ""
                isDemoReadOnly = false
                isLoading = false
            }
            return
        }
        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId, let slug = profile?.tenantSlug ?? profile?.tenantId else {
                await MainActor.run {
                    tenantId = nil
                    tenantSlug = nil
                    bookingUrl = ""
                    formFields = FormField.defaultFields
                    services = []
                    industry = nil
                    webThemeId = ""
                    serviceArea = ""
                    serviceCity = ""
                    serviceStateAbbr = ""
                    isLoading = false
                }
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let svc = try await firebaseService.fetchTenantServices(tenantId: tid)
            var persistSplit: (featured: [String], gallery: [String])?
            await MainActor.run {
                isDemoReadOnly = false
                tenantId = tid
                tenantSlug = slug
                bookingUrl = PublicBookingSite.urlString(forSlug: slug)
                appBusinessName = (tenant?["businessName"] as? String ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if appBusinessName.isEmpty {
                    appBusinessName = (profile?.business ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                }
                displayName = (tenant?["displayName"] as? String ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                logoUrl = tenant?["logoUrl"] as? String ?? ""
                heroImageUrl = tenant?["heroImageUrl"] as? String ?? ""
                if let w = Self.intFromFirestore(tenant?["heroImagePixelWidth"]),
                   let h = Self.intFromFirestore(tenant?["heroImagePixelHeight"]),
                   w > 0, h > 0 {
                    heroImagePixelWidth = w
                    heroImagePixelHeight = h
                } else {
                    heroImagePixelWidth = 16
                    heroImagePixelHeight = 9
                }
                galleryGridLayout = tenant?["galleryGridLayout"] as? String ?? "3x1"
                galleryLayoutStyle = GalleryLayoutStyle.fromStored(tenant?["galleryLayoutStyle"] as? String)
                let rawGallery = tenant?["galleryImages"] as? [String] ?? []
                if tenant?["featuredWorkImages"] == nil {
                    /// Legacy: one list served home (prefix) + full gallery page; split into two fields.
                    let maxSlots = featuredWorkImageSlotCount
                    featuredWorkImages = Array(rawGallery.prefix(maxSlots))
                    galleryImages = Array(rawGallery.dropFirst(maxSlots))
                    if !rawGallery.isEmpty {
                        persistSplit = (featured: featuredWorkImages, gallery: galleryImages)
                    }
                } else {
                    featuredWorkImages = tenant?["featuredWorkImages"] as? [String] ?? []
                    galleryImages = rawGallery
                }
                backgroundColorHex = tenant?["backgroundColor"] as? String ?? "#FFFFFF"
                cardSurfaceColorHex = tenant?["cardSurfaceColor"] as? String ?? "#F5F5F5"
                textColorHex = tenant?["textColor"] as? String ?? "#333333"
                primaryColorHex = tenant?["primaryColor"] as? String ?? "#000000"
                primaryColorHoverHex = tenant?["primaryColorHover"] as? String ?? "#333333"
                syncPreviewHeroSlotColorFromTokens()
                successColorHex = tenant?["successColor"] as? String ?? "#22C55E"
                cardBorderRadius = (tenant?["cardBorderRadius"] as? Double) ?? 12
                tagline = tenant?["tagline"] as? String ?? ""
                luxeHeroTagline = tenant?["luxeHeroTagline"] as? String ?? ""
                luxePromoHeadline = tenant?["luxePromoHeadline"] as? String ?? ""
                luxeFeaturedWorkEyebrow = tenant?["luxeFeaturedWorkEyebrow"] as? String ?? ""
                luxeFeaturedWorkHeading = tenant?["luxeFeaturedWorkHeading"] as? String ?? ""
                luxeShowFeaturedWorkStrip = tenant?["luxeShowFeaturedWorkStrip"] as? Bool ?? true
                luxeHomeServicesEyebrow = tenant?["luxeHomeServicesEyebrow"] as? String ?? ""
                luxeHomeServicesHeading = tenant?["luxeHomeServicesHeading"] as? String ?? ""
                luxeShowHomeServicesSection = tenant?["luxeShowHomeServicesSection"] as? Bool ?? false
                luxeHomeServicesExpandableCard = tenant?["luxeHomeServicesExpandableCard"] as? Bool ?? false
                bladeHeroTagline = tenant?["bladeHeroTagline"] as? String ?? ""
                bladeHeroDescription = tenant?["bladeHeroDescription"] as? String ?? ""
                let ht = tenant?["heroTagline"] as? String ?? ""
                let hs = tenant?["heroSubtitle"] as? String ?? ""
                heroTagline = ht.isEmpty ? hs : ht
                studio12HeroEyebrow = tenant?["studio12HeroEyebrow"] as? String ?? ""
                let heroHeadNew = (tenant?["studio12HeroHeadline"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !heroHeadNew.isEmpty {
                    studio12HeroHeadline = tenant?["studio12HeroHeadline"] as? String ?? ""
                } else {
                    let l1 = (tenant?["studio12HeroLine1"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let l2 = (tenant?["studio12HeroLine2"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    studio12HeroHeadline = [l1, l2].filter { !$0.isEmpty }.joined(separator: " ")
                }
                studio12PhilosophyImageUrl = tenant?["studio12PhilosophyImageUrl"] as? String ?? ""
                if let w = Self.intFromFirestore(tenant?["studio12PhilosophyImagePixelWidth"]),
                   let h = Self.intFromFirestore(tenant?["studio12PhilosophyImagePixelHeight"]),
                   w > 0, h > 0 {
                    studio12PhilosophyImagePixelWidth = w
                    studio12PhilosophyImagePixelHeight = h
                } else {
                    studio12PhilosophyImagePixelWidth = 16
                    studio12PhilosophyImagePixelHeight = 9
                }
                let philHeadNew = (tenant?["studio12PhilosophyHeadline"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !philHeadNew.isEmpty {
                    studio12PhilosophyHeadline = tenant?["studio12PhilosophyHeadline"] as? String ?? ""
                } else {
                    studio12PhilosophyHeadline = Studio12IndustryCopy.joinPhilosophyHeadline(
                        line1: tenant?["studio12PhilosophyHeadLine1"] as? String ?? "",
                        line2: tenant?["studio12PhilosophyHeadLine2"] as? String ?? "",
                        italic: tenant?["studio12PhilosophyHeadItalic"] as? String ?? ""
                    )
                }
                let bookHeadNew = (tenant?["studio12BookCtaHeadline"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !bookHeadNew.isEmpty {
                    studio12BookCtaHeadline = tenant?["studio12BookCtaHeadline"] as? String ?? ""
                } else {
                    studio12BookCtaHeadline = Studio12IndustryCopy.joinBookCtaHeadline(
                        line1: tenant?["studio12BookCtaLine1"] as? String ?? "",
                        italic: tenant?["studio12BookCtaItalic"] as? String ?? ""
                    )
                }
                studio12BookCtaBody = tenant?["studio12BookCtaBody"] as? String ?? ""
                studio12BookCtaImageUrl = tenant?["studio12BookCtaImageUrl"] as? String ?? ""
                if let w = Self.intFromFirestore(tenant?["studio12BookCtaImagePixelWidth"]),
                   let h = Self.intFromFirestore(tenant?["studio12BookCtaImagePixelHeight"]),
                   w > 0, h > 0 {
                    studio12BookCtaImagePixelWidth = w
                    studio12BookCtaImagePixelHeight = h
                } else {
                    studio12BookCtaImagePixelWidth = 16
                    studio12BookCtaImagePixelHeight = 9
                }
                studio12ShowServicesSection = tenant?["studio12ShowServicesSection"] as? Bool ?? true
                studio12ShowProcessSection = tenant?["studio12ShowProcessSection"] as? Bool ?? true
                classicShowServiceDuration = tenant?["classicShowServiceDuration"] as? Bool ?? true
                classicFeaturedWorkEyebrow = tenant?["classicFeaturedWorkEyebrow"] as? String ?? ""
                classicFeaturedWorkHeading = tenant?["classicFeaturedWorkHeading"] as? String ?? ""
                classicFeaturedWorkSub = tenant?["classicFeaturedWorkSub"] as? String ?? ""
                classicFeaturedWorkEmpty = tenant?["classicFeaturedWorkEmpty"] as? String ?? ""
                classicServicesEyebrow = tenant?["classicServicesEyebrow"] as? String ?? ""
                classicServicesHeading = tenant?["classicServicesHeading"] as? String ?? ""
                classicServicesExpandableCard = tenant?["classicServicesExpandableCard"] as? Bool ?? false
                classicShowAboutStats = tenant?["classicShowAboutStats"] as? Bool ?? true
                classicStatYearsValue = (tenant?["classicStatYearsValue"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "8+"
                classicStatYearsLabel = (tenant?["classicStatYearsLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Years exp."
                classicStatClientsValue = (tenant?["classicStatClientsValue"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "500+"
                classicStatClientsLabel = (tenant?["classicStatClientsLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Clients"
                classicStatRatedValue = (tenant?["classicStatRatedValue"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "5★"
                classicStatRatedLabel = (tenant?["classicStatRatedLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Rated"
                classicAboutEyebrow = tenant?["classicAboutEyebrow"] as? String ?? ""
                classicAboutHeading = tenant?["classicAboutHeading"] as? String ?? ""
                featuredWorkBackgroundColorHex = tenant?["featuredWorkBackgroundColor"] as? String ?? "#FAF8F5"
                featuredWorkTextColorHex = tenant?["featuredWorkTextColor"] as? String ?? "#1C1917"
                bookingFormCardBackgroundColorHex = tenant?["bookingFormCardBackgroundColor"] as? String ?? "#FFFFFF"
                galleryPageBackgroundColorHex = tenant?["galleryPageBackgroundColor"] as? String ?? "#FAF8F5"
                galleryPageTextColorHex = tenant?["galleryPageTextColor"] as? String ?? "#1C1917"
                aboutSectionBackgroundColorHex = tenant?["aboutSectionBackgroundColor"] as? String ?? "#111111"
                aboutSectionTextColorHex = tenant?["aboutSectionTextColor"] as? String ?? "#FFFFFF"
                bookingFormStyleId = BookingFormStyle.resolved(stored: tenant?["bookingFormStyleId"] as? String).rawValue
                if let schema = tenant?["formSchema"] as? [[String: Any]] {
                    formFields = schema.compactMap { FormField.fromFirestore($0) }
                    if formFields.isEmpty { formFields = FormField.defaultFields }
                } else {
                    formFields = FormField.defaultFields
                }
                services = svc
                aboutText = tenant?["aboutText"] as? String ?? ""
                contactPhone = tenant?["contactPhone"] as? String ?? ""
                contactEmail = tenant?["contactEmail"] as? String ?? ""
                let parsedAddress = Self.parsedStreetAndSuite(from: tenant)
                contactAddress = parsedAddress.street
                contactAddressSuite = parsedAddress.suite
                serviceArea = (tenant?["serviceArea"] as? String) ?? ""
                let parsedServiceArea = USStateServiceAreaFormatting.parseStoredServiceArea(serviceArea)
                serviceCity = parsedServiceArea.city
                serviceStateAbbr = parsedServiceArea.stateAbbr
                businessHours = tenant?["businessHours"] as? String ?? ""
                businessHoursExceptions = BusinessHoursException.parseList(tenant?["businessHoursExceptions"])
                let weeklyRaw = tenant?["businessHoursWeekly"] as? [String: Any]
                let hasWeekly = weeklyRaw.map { !$0.isEmpty } ?? false
                if hasWeekly, let parsed = BusinessHoursWeekly.fromFirestore(weeklyRaw) {
                    businessHoursWeekly = parsed
                    businessHours = Self.businessHoursDisplayString(weekly: parsed, exceptions: businessHoursExceptions)
                } else {
                    businessHoursWeekly = .defaultOfficeHours
                    businessHours = Self.businessHoursDisplayString(
                        weekly: businessHoursWeekly,
                        exceptions: businessHoursExceptions
                    )
                }
                instagramHandle = tenant?["instagramHandle"] as? String ?? ""
                showContactOnPage = tenant?["showContactOnPage"] as? Bool ?? true
                showBusinessHoursOnPage = tenant?["showBusinessHoursOnPage"] as? Bool ?? true
                shopEnabled = tenant?["shopEnabled"] as? Bool ?? false
                showGalleryPage = tenant?["showGalleryPage"] as? Bool ?? true
                showBookPage = tenant?["showBookPage"] as? Bool ?? true
                showAboutPage = tenant?["showAboutPage"] as? Bool ?? true
                showTeamPage = tenant?["showTeamPage"] as? Bool ?? true
                showMeetTheTeamOnHome = tenant?["showMeetTheTeamOnHome"] as? Bool ?? true
                industry = tenant?["industry"] as? String
                industryCustomLabel = (tenant?["industryCustomLabel"] as? String ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                studio12ProcessSteps = Self.mergedStudio12ProcessSteps(
                    from: tenant?["studio12ProcessSteps"],
                    industry: tenant?["industry"] as? String
                )
                let resolvedTheme = WebTheme.resolvedThemeId(
                    stored: tenant?["webThemeId"] as? String,
                    industry: tenant?["industry"] as? String
                )
                webThemeId = resolvedTheme
                let paletteFamily = WebTheme(rawValue: resolvedTheme)?.family ?? .classic
                let storedPaletteId = tenant?["webColorPaletteId"] as? String
                webColorPaletteId = WebColorPalettes.resolvedPaletteId(stored: storedPaletteId, family: paletteFamily)
                if (storedPaletteId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    snapFeaturedWorkColorsToNearestPreset()
                }
                sidebarIconColorHome = tenant?["sidebarIconColorHome"] as? String ?? ""
                sidebarIconColorBooking = tenant?["sidebarIconColorBooking"] as? String ?? ""
                normalizeFeaturedGridLayoutPresets()
                syncTattooSectionThemeFromFeaturedIfNeeded()
                isLoading = false
            }
            let fetchedProducts = try await firebaseService.fetchTenantProducts(tenantId: tid)
            await MainActor.run { products = fetchedProducts }
            do {
                let fetchedShopOrders = try await firebaseService.fetchTenantShopOrders(tenantId: tid)
                await MainActor.run { shopOrders = fetchedShopOrders }
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
            }
            if tenant?["webThemeId"] == nil {
                let def = WebTheme.resolvedThemeId(stored: nil, industry: tenant?["industry"] as? String)
                try? await firebaseService.updateTenant(tenantId: tid, updates: ["webThemeId": def])
            }
            if let split = persistSplit {
                do {
                    try await firebaseService.updateTenant(tenantId: tid, updates: [
                        "featuredWorkImages": split.featured,
                        "galleryImages": split.gallery
                    ])
                    await MainActor.run { invalidateWebPreview() }
                } catch {
                    await MainActor.run { errorMessage = error.localizedDescription }
                }
            }
            let plan = SubscriptionPlan.normalized(fromFirestore: tenant?["subscriptionPlan"] as? String)
            if plan.allowsTeamInvites {
                await loadTeamMemberVisibility(ownerUid: tenant?["ownerUid"] as? String)
            } else {
                await MainActor.run { teamMemberVisibility = [] }
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func saveHome() async {
        guard let tid = tenantId else { return }
        if usesPortfolioStyleWebChrome {
            galleryPageBackgroundColorHex = featuredWorkBackgroundColorHex
            galleryPageTextColorHex = featuredWorkTextColorHex
        }
        let fam = WebTheme(rawValue: webThemeId)?.family ?? .classic
        let isClassicOrStudio12 = fam == .classic || fam == .studio12
        if isClassicOrStudio12 {
            sidebarIconColorHome = ""
            sidebarIconColorBooking = ""
        }
        var updates: [String: Any] = [
            "displayName": displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            "logoUrl": logoUrl,
            "heroImageUrl": heroImageUrl,
            "heroImagePixelWidth": heroImagePixelWidth,
            "heroImagePixelHeight": heroImagePixelHeight,
            "featuredWorkImages": featuredWorkImages,
            "galleryImages": galleryImages,
            "galleryGridLayout": galleryGridLayout,
            "galleryLayoutStyle": galleryLayoutStyle.rawValue,
            "backgroundColor": backgroundColorHex,
            "cardSurfaceColor": cardSurfaceColorHex,
            "textColor": textColorHex,
            "primaryColor": primaryColorHex,
            "primaryColorHover": primaryColorHoverHex,
            "successColor": successColorHex,
            "cardBorderRadius": cardBorderRadius,
            "tagline": tagline,
            "luxeHeroTagline": luxeHeroTagline,
            "luxePromoHeadline": luxePromoHeadline,
            "sidebarIconColorHome": sidebarIconColorHome,
            "sidebarIconColorBooking": sidebarIconColorBooking,
            "featuredWorkBackgroundColor": featuredWorkBackgroundColorHex,
            "featuredWorkTextColor": featuredWorkTextColorHex
        ]
        if !isClassicOrStudio12 {
            updates["bookingFormCardBackgroundColor"] = bookingFormCardBackgroundColorHex
        }
        if usesPortfolioStyleWebChrome {
            updates["galleryPageBackgroundColor"] = featuredWorkBackgroundColorHex
            updates["galleryPageTextColor"] = featuredWorkTextColorHex
        }
        if fam == .blade || fam == .stonecut {
            updates["bladeHeroTagline"] = bladeHeroTagline
            updates["bladeHeroDescription"] = bladeHeroDescription
        }
        if fam == .classic {
            updates["classicShowServiceDuration"] = classicShowServiceDuration
            updates["classicFeaturedWorkEyebrow"] = classicFeaturedWorkEyebrow
            updates["classicFeaturedWorkHeading"] = classicFeaturedWorkHeading
            updates["classicFeaturedWorkSub"] = classicFeaturedWorkSub
            updates["classicFeaturedWorkEmpty"] = classicFeaturedWorkEmpty
            updates["classicServicesEyebrow"] = classicServicesEyebrow
            updates["classicServicesHeading"] = classicServicesHeading
            updates["classicServicesExpandableCard"] = classicServicesExpandableCard
            updates["classicAboutEyebrow"] = classicAboutEyebrow
            updates["classicAboutHeading"] = classicAboutHeading
        }
        if fam == .luxe {
            updates["luxeFeaturedWorkEyebrow"] = luxeFeaturedWorkEyebrow
            updates["luxeFeaturedWorkHeading"] = luxeFeaturedWorkHeading
            updates["luxeShowFeaturedWorkStrip"] = luxeShowFeaturedWorkStrip
            updates["luxeHomeServicesEyebrow"] = luxeHomeServicesEyebrow
            updates["luxeHomeServicesHeading"] = luxeHomeServicesHeading
            updates["luxeShowHomeServicesSection"] = luxeShowHomeServicesSection
            updates["luxeHomeServicesExpandableCard"] = luxeHomeServicesExpandableCard
        }
        if fam == .studio12 {
            updates["heroTagline"] = heroTagline
            updates["studio12HeroEyebrow"] = studio12HeroEyebrow
            updates["studio12HeroHeadline"] = studio12HeroHeadline
            updates["studio12HeroLine1"] = ""
            updates["studio12HeroLine2"] = ""
            updates["aboutText"] = aboutText
            updates["studio12PhilosophyImageUrl"] = studio12PhilosophyImageUrl
            updates["studio12PhilosophyImagePixelWidth"] = studio12PhilosophyImagePixelWidth
            updates["studio12PhilosophyImagePixelHeight"] = studio12PhilosophyImagePixelHeight
            updates["studio12PhilosophyHeadline"] = studio12PhilosophyHeadline
            updates["studio12PhilosophyHeadLine1"] = ""
            updates["studio12PhilosophyHeadLine2"] = ""
            updates["studio12PhilosophyHeadItalic"] = ""
            updates["studio12BookCtaHeadline"] = studio12BookCtaHeadline
            updates["studio12BookCtaLine1"] = ""
            updates["studio12BookCtaItalic"] = ""
            updates["studio12BookCtaBody"] = studio12BookCtaBody
            updates["studio12BookCtaImageUrl"] = studio12BookCtaImageUrl
            updates["studio12BookCtaImagePixelWidth"] = studio12BookCtaImagePixelWidth
            updates["studio12BookCtaImagePixelHeight"] = studio12BookCtaImagePixelHeight
            updates["studio12ShowServicesSection"] = studio12ShowServicesSection
            updates["studio12ShowProcessSection"] = studio12ShowProcessSection
            updates["studio12ProcessSteps"] = studio12ProcessSteps
                .sorted { $0.id < $1.id }
                .map { ["title": $0.title, "body": $0.body] }
        }
        await saveTenantUpdates(tid, updates)
    }

    /// Keeps Gallery page colors in sync with Featured work for portfolio-style web themes.
    private func syncTattooSectionThemeFromFeaturedIfNeeded() {
        guard usesPortfolioStyleWebChrome else { return }
        galleryPageBackgroundColorHex = featuredWorkBackgroundColorHex
        galleryPageTextColorHex = featuredWorkTextColorHex
    }

    func saveGalleryPageColors() async {
        guard let tid = tenantId else { return }
        if usesPortfolioStyleWebChrome {
            syncTattooSectionThemeFromFeaturedIfNeeded()
        }
        await saveTenantUpdates(tid, [
            "galleryPageBackgroundColor": galleryPageBackgroundColorHex,
            "galleryPageTextColor": galleryPageTextColorHex
        ])
    }

    /// Persists `/gallery` layout choice (any template).
    func saveGalleryLayoutStyle() async {
        guard let tid = tenantId else { return }
        await saveTenantUpdates(tid, ["galleryLayoutStyle": galleryLayoutStyle.rawValue])
        await MainActor.run { invalidateWebPreview() }
    }

    /// Removes stale Quick-edit hours copy so the live site uses `businessHours` from the weekly editor.
    private static func webCopyOverridesWithoutContactHours(_ doc: [String: Any]?) -> [String: String]? {
        var map = coercedStringMap(doc?["webCopyOverrides"])
        guard map.removeValue(forKey: "wc.contact.hours") != nil else { return nil }
        return map
    }

    func saveBusinessHours() async {
        guard let tid = tenantId else { return }
        let hoursString = Self.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
        var updates: [String: Any] = [
            "businessHours": hoursString,
            "showBusinessHoursOnPage": showBusinessHoursOnPage,
            "businessHoursWeekly": businessHoursWeekly.firestoreDayMap(),
            "businessHoursExceptions": businessHoursExceptions.map { $0.toFirestore() },
        ]
        if let doc = try? await firebaseService.fetchTenant(tenantId: tid),
           let clearedOverrides = Self.webCopyOverridesWithoutContactHours(doc) {
            updates["webCopyOverrides"] = clearedOverrides
        }
        await saveTenantUpdates(tid, updates)
        await MainActor.run {
            businessHours = hoursString
        }
    }

    func saveAbout() async {
        guard let tid = tenantId else { return }
        normalizeServiceCityTitleCase()
        composeServiceAreaForPersistence()
        let hoursString = Self.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
        var updates: [String: Any] = [
            "aboutText": aboutText,
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "serviceArea": serviceArea,
            "businessHours": hoursString,
            "instagramHandle": Self.normalizedInstagramHandle(instagramHandle),
            "showContactOnPage": showContactOnPage,
            "showBusinessHoursOnPage": showBusinessHoursOnPage,
            "aboutSectionBackgroundColor": aboutSectionBackgroundColorHex,
            "aboutSectionTextColor": aboutSectionTextColorHex,
            "businessHoursWeekly": businessHoursWeekly.firestoreDayMap(),
            "businessHoursExceptions": businessHoursExceptions.map { $0.toFirestore() }
        ]
        updates.merge(contactAddressFirestoreUpdates()) { _, new in new }
        if (WebTheme(rawValue: webThemeId)?.family ?? .classic) == .classic {
            updates["classicShowAboutStats"] = classicShowAboutStats
            updates["classicStatYearsValue"] = classicStatYearsValue
            updates["classicStatYearsLabel"] = classicStatYearsLabel
            updates["classicStatClientsValue"] = classicStatClientsValue
            updates["classicStatClientsLabel"] = classicStatClientsLabel
            updates["classicStatRatedValue"] = classicStatRatedValue
            updates["classicStatRatedLabel"] = classicStatRatedLabel
            updates["classicAboutEyebrow"] = classicAboutEyebrow
            updates["classicAboutHeading"] = classicAboutHeading
        }
        if let doc = try? await firebaseService.fetchTenant(tenantId: tid),
           let clearedOverrides = Self.webCopyOverridesWithoutContactHours(doc) {
            updates["webCopyOverrides"] = clearedOverrides
        }
        await saveTenantUpdates(tid, updates)
        await MainActor.run {
            businessHours = hoursString
        }
    }

    /// Weekly summary plus optional special dates for the public site.
    static func businessHoursDisplayString(weekly: BusinessHoursWeekly, exceptions: [BusinessHoursException]) -> String {
        var parts: [String] = [weekly.formattedDisplayString()]
        let exLines = exceptions.sorted { $0.dateYmd < $1.dateYmd }.map { $0.formattedDisplayLine() }
        if !exLines.isEmpty {
            parts.append("— Special dates —")
            parts.append(contentsOf: exLines)
        }
        return parts.joined(separator: "\n")
    }

    func syncBusinessHoursStringFromWeekly() {
        businessHours = Self.businessHoursDisplayString(weekly: businessHoursWeekly, exceptions: businessHoursExceptions)
    }

    func replaceBusinessHoursDay(index: Int, schedule: DaySchedule) {
        guard businessHoursWeekly.days.indices.contains(index) else { return }
        var w = businessHoursWeekly
        w.days[index] = schedule
        w.normalizeDay(at: index)
        businessHoursWeekly = w
        syncBusinessHoursStringFromWeekly()
    }

    func setBusinessHoursExceptions(_ items: [BusinessHoursException]) {
        businessHoursExceptions = items
        syncBusinessHoursStringFromWeekly()
    }

    func upsertBusinessHoursException(_ item: BusinessHoursException) {
        var list = businessHoursExceptions
        if let i = list.firstIndex(where: { $0.id == item.id }) {
            list[i] = item
        } else {
            list.append(item)
        }
        businessHoursExceptions = list.sorted { $0.dateYmd < $1.dateYmd }
        syncBusinessHoursStringFromWeekly()
    }

    func removeBusinessHoursException(id: String) {
        businessHoursExceptions.removeAll { $0.id == id }
        syncBusinessHoursStringFromWeekly()
    }

    /// Copies `schedule` to each index in `indices` (0 = Mon … 6 = Sun).
    func applySchedule(_ schedule: DaySchedule, toIndices indices: Set<Int>) {
        var w = businessHoursWeekly
        for i in indices where w.days.indices.contains(i) {
            w.days[i] = schedule
            w.normalizeDay(at: i)
        }
        businessHoursWeekly = w
        syncBusinessHoursStringFromWeekly()
    }

    /// Keeps builder in sync when logo is changed in Settings.
    func syncLogoUrlFromExternal(_ url: String) {
        logoUrl = url.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func uploadHeroImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingHero = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantHeroImage(tenantId: tid, imageData: imageData)
            let dims = Self.pixelDimensionsOfJPEGData(imageData) ?? (w: 16, h: 9)
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "heroImageUrl": url,
                "heroImagePixelWidth": dims.w,
                "heroImagePixelHeight": dims.h
            ])
            await MainActor.run {
                heroImageUrl = url
                heroImagePixelWidth = dims.w
                heroImagePixelHeight = dims.h
                isUploadingHero = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingHero = false
            }
        }
    }

    private static func intFromFirestore(_ value: Any?) -> Int? {
        switch value {
        case let i as Int: return i
        case let n as NSNumber: return n.intValue
        default: return nil
        }
    }

    private static func pixelDimensionsOfJPEGData(_ data: Data) -> (w: Int, h: Int)? {
        guard let img = UIImage(data: data) else { return nil }
        let w = Int(round(img.size.width * img.scale))
        let h = Int(round(img.size.height * img.scale))
        guard w > 0, h > 0 else { return nil }
        return (w, h)
    }

    func uploadStudio12PhilosophyImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingStudio12Philosophy = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            let dims = Self.pixelDimensionsOfJPEGData(imageData) ?? (w: 16, h: 9)
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "studio12PhilosophyImageUrl": url,
                "studio12PhilosophyImagePixelWidth": dims.w,
                "studio12PhilosophyImagePixelHeight": dims.h
            ])
            await MainActor.run {
                studio12PhilosophyImageUrl = url
                studio12PhilosophyImagePixelWidth = dims.w
                studio12PhilosophyImagePixelHeight = dims.h
                isUploadingStudio12Philosophy = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingStudio12Philosophy = false
            }
        }
    }

    func uploadStudio12BookCtaImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingStudio12BookCta = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            let dims = Self.pixelDimensionsOfJPEGData(imageData) ?? (w: 16, h: 9)
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "studio12BookCtaImageUrl": url,
                "studio12BookCtaImagePixelWidth": dims.w,
                "studio12BookCtaImagePixelHeight": dims.h
            ])
            await MainActor.run {
                studio12BookCtaImageUrl = url
                studio12BookCtaImagePixelWidth = dims.w
                studio12BookCtaImagePixelHeight = dims.h
                isUploadingStudio12BookCta = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingStudio12BookCta = false
            }
        }
    }

    /// Parallel gallery uploads (bounded concurrency); returned URLs match `items` order.
    private func uploadGalleryBatch(tenantId: String, items: [Data], concurrency: Int = 4) async throws -> [String] {
        guard !items.isEmpty else { return [] }
        var result: [String] = []
        result.reserveCapacity(items.count)
        var i = 0
        while i < items.count {
            let upper = min(i + concurrency, items.count)
            let slice = Array(items[i..<upper])
            let base = i
            let part: [(Int, String)] = try await withThrowingTaskGroup(of: (Int, String).self) { group in
                for (offset, data) in slice.enumerated() {
                    let idx = base + offset
                    group.addTask {
                        let url = try await self.firebaseService.uploadTenantGalleryImage(tenantId: tenantId, imageData: data)
                        return (idx, url)
                    }
                }
                var acc: [(Int, String)] = []
                for try await x in group {
                    acc.append(x)
                }
                return acc.sorted { $0.0 < $1.0 }
            }
            result.append(contentsOf: part.map { $0.1 })
            i = upper
        }
        return result
    }

    func addGalleryImages(imageDataList: [Data]) async {
        guard let tid = tenantId, !imageDataList.isEmpty else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingGallery = true; errorMessage = nil }
        do {
            let urls = try await uploadGalleryBatch(tenantId: tid, items: imageDataList)
            var updated = galleryImages
            updated.append(contentsOf: urls)
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "galleryImages": updated,
                "featuredWorkImages": featuredWorkImages
            ])
            await MainActor.run {
                galleryImages = updated
                isUploadingGallery = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingGallery = false
            }
        }
    }

    func addGalleryImage(imageData: Data) async {
        await addGalleryImages(imageDataList: [imageData])
    }

    /// Replaces the image at `index`, or appends when uploading beyond the end. Used by Quick edit taps on `galleryImage:<n>`.
    func replaceOrAppendGalleryImage(at index: Int, imageData: Data) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        guard index >= 0, index < 256 else {
            await MainActor.run {
                errorMessage = "That gallery slot is not available."
            }
            return
        }
        await MainActor.run { isUploadingGallery = true; errorMessage = nil }
        do {
            let urls = try await uploadGalleryBatch(tenantId: tid, items: [imageData])
            guard let newURL = urls.first else {
                await MainActor.run { isUploadingGallery = false }
                return
            }
            var updated = await MainActor.run { galleryImages }
            while updated.count < index {
                updated.append("")
            }
            if index < updated.count {
                updated[index] = newURL
            } else {
                updated.append(newURL)
            }
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "galleryImages": updated,
                "featuredWorkImages": featuredWorkImages,
            ])
            await MainActor.run {
                galleryImages = updated
                isUploadingGallery = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingGallery = false
            }
        }
    }

    func removeGalleryImage(at index: Int) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        guard index >= 0, index < galleryImages.count else { return }
        var updated = galleryImages
        updated.remove(at: index)
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "galleryImages": updated,
                "featuredWorkImages": featuredWorkImages
            ])
            await MainActor.run {
                galleryImages = updated
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func addFeaturedWorkImages(imageDataList: [Data]) async {
        guard let tid = tenantId, !imageDataList.isEmpty else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingFeaturedWork = true; errorMessage = nil }
        do {
            let urls = try await uploadGalleryBatch(tenantId: tid, items: imageDataList)
            var updated = featuredWorkImages
            updated.append(contentsOf: urls)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["featuredWorkImages": updated])
            await MainActor.run {
                featuredWorkImages = updated
                isUploadingFeaturedWork = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingFeaturedWork = false
            }
        }
    }

    func addFeaturedWorkImage(imageData: Data) async {
        await addFeaturedWorkImages(imageDataList: [imageData])
    }

    /// Replaces the image at `index`, or pads sparse slots when uploading out of order. Used by Quick edit taps on `featuredWork:<n>`.
    func replaceOrAppendFeaturedWorkImage(at index: Int, imageData: Data) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        let slots = featuredWorkImageSlotCount
        guard index >= 0, index < slots else {
            await MainActor.run {
                errorMessage = "That featured slot is not available for this layout."
            }
            return
        }
        await MainActor.run { isUploadingFeaturedWork = true; errorMessage = nil }
        do {
            let urls = try await uploadGalleryBatch(tenantId: tid, items: [imageData])
            guard let newURL = urls.first else {
                await MainActor.run { isUploadingFeaturedWork = false }
                return
            }
            var updated = await MainActor.run { featuredWorkImages }
            while updated.count < index {
                updated.append("")
            }
            if index < updated.count {
                updated[index] = newURL
            } else {
                updated.append(newURL)
            }
            if updated.count > slots {
                updated = Array(updated.prefix(slots))
            }
            try await firebaseService.updateTenant(tenantId: tid, updates: ["featuredWorkImages": updated])
            await MainActor.run {
                featuredWorkImages = updated
                isUploadingFeaturedWork = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingFeaturedWork = false
            }
        }
    }

    func removeFeaturedWorkImage(at index: Int) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        guard index >= 0, index < featuredWorkImages.count else { return }
        var updated = featuredWorkImages
        updated.remove(at: index)
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: ["featuredWorkImages": updated])
            await MainActor.run {
                featuredWorkImages = updated
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func saveFormFields() async {
        guard let tid = tenantId else { return }
        let schema = formFields.map { $0.toFirestore() }
        await saveTenantUpdates(tid, [
            "formSchema": schema,
            "bookingFormStyleId": BookingFormStyle.resolved(stored: bookingFormStyleId).rawValue,
        ])
    }

    func saveBookingFormStyle() async {
        guard let tid = tenantId else { return }
        await saveTenantUpdates(tid, [
            "bookingFormStyleId": BookingFormStyle.resolved(stored: bookingFormStyleId).rawValue,
        ])
    }

    func saveContact() async {
        guard let tid = tenantId else { return }
        normalizeServiceCityTitleCase()
        composeServiceAreaForPersistence()
        let updates: [String: Any] = [
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "serviceArea": serviceArea,
            "showContactOnPage": showContactOnPage
        ].merging(contactAddressFirestoreUpdates()) { _, new in new }
        await saveTenantUpdates(tid, updates)
    }

    private func saveTenantUpdates(
        _ tid: String,
        _ updates: [String: Any],
        invalidatePreview: Bool = true
    ) async {
        if blockIfDemoReadOnly() { return }
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: updates)
            if let logo = updates["logoUrl"] as? String {
                NotificationCenter.default.post(
                    name: .tenantLogoDidChange,
                    object: nil,
                    userInfo: ["logoUrl": logo]
                )
            }
            await MainActor.run {
                if invalidatePreview {
                    invalidateWebPreview()
                }
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func addService(
        name: String,
        durationMinutes: Int?,
        description: String? = nil,
        startingPrice: Double? = nil
    ) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        let nextOrder = (services.map(\.sortOrder).max() ?? -1) + 1
        do {
            _ = try await firebaseService.createTenantService(
                tenantId: tid,
                name: name,
                durationMinutes: durationMinutes,
                description: description,
                sortOrder: nextOrder,
                startingPrice: startingPrice
            )
            await loadData()
            await MainActor.run { invalidateWebPreview() }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    @discardableResult
    func updateService(
        serviceId: String,
        name: String,
        description: String?,
        durationMinutes: Int?,
        startingPrice: Double?
    ) async -> Bool {
        guard let tid = tenantId else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        await MainActor.run { isSavingBladeServices = true; errorMessage = nil }
        do {
            let slug = firebaseService.slug(from: trimmed)
            let updates = firebaseService.tenantServiceDisplayUpdates(
                name: trimmed,
                slug: slug,
                durationMinutes: durationMinutes,
                description: description,
                startingPrice: startingPrice
            )
            try await firebaseService.updateTenantService(tenantId: tid, serviceId: serviceId, updates: updates)
            let descStored = description?.trimmingCharacters(in: .whitespacesAndNewlines)
            let finalDesc: String? = (descStored?.isEmpty == false) ? descStored : nil
            let finalPrice: Double? = {
                guard let p = startingPrice, p > 0 else { return nil }
                return p
            }()
            await MainActor.run {
                if let idx = services.firstIndex(where: { $0.id == serviceId }) {
                    var s = services[idx]
                    s.name = trimmed
                    s.slug = slug
                    s.durationMinutes = durationMinutes
                    s.description = finalDesc
                    s.price = finalPrice
                    services[idx] = s
                }
                isSavingBladeServices = false
                invalidateWebPreview()
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
            return true
        } catch {
            await MainActor.run {
                isSavingBladeServices = false
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    func moveService(from index: Int, direction: Int) async {
        let j = index + direction
        guard services.indices.contains(index), services.indices.contains(j) else { return }
        await MainActor.run { services.swapAt(index, j) }
        await persistServiceSortOrders()
    }

    private func persistServiceSortOrders() async {
        guard let tid = tenantId else { return }
        await MainActor.run { isSavingBladeServices = true; errorMessage = nil }
        do {
            for (i, svc) in services.enumerated() {
                try await firebaseService.updateTenantService(
                    tenantId: tid,
                    serviceId: svc.id,
                    updates: ["sortOrder": i]
                )
            }
            await MainActor.run {
                services = services.enumerated().map { i, s in
                    var t = s
                    t.sortOrder = i
                    return t
                }
                isSavingBladeServices = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run {
                isSavingBladeServices = false
                errorMessage = error.localizedDescription
            }
            await loadData()
        }
    }

    func deleteService(_ service: TenantService) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        do {
            try await firebaseService.deleteTenantService(tenantId: tid, serviceId: service.id)
            await MainActor.run {
                services.removeAll { $0.id == service.id }
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    /// Replaces all tenant services with four industry starter services (Blade, Studio 12, and Classic home use the same list).
    func applyBladeStarterServices(isDemoMode: Bool = false) async {
        guard let tid = tenantId else { return }
        let fam = WebTheme(rawValue: webThemeId)?.family ?? .classic
        guard fam == .blade || fam == .studio12 || fam == .classic else { return }
        let rawIndustry = industry?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let tmpl = BookingTemplate(rawValue: rawIndustry) ?? .custom
        await MainActor.run {
            isApplyingBladeStarters = true
            errorMessage = nil
            saveSuccess = false
        }
        do {
            let existing = try await firebaseService.fetchTenantServices(tenantId: tid)
            for svc in existing {
                try await firebaseService.deleteTenantService(tenantId: tid, serviceId: svc.id)
            }
            for (index, item) in tmpl.bladeStarterServices.enumerated() {
                _ = try await firebaseService.createTenantService(
                    tenantId: tid,
                    name: item.name,
                    durationMinutes: item.durationMinutes,
                    description: item.description,
                    sortOrder: index
                )
            }
            await loadData(isDemoMode: isDemoMode)
            await MainActor.run {
                isApplyingBladeStarters = false
                invalidateWebPreview()
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run {
                isApplyingBladeStarters = false
                errorMessage = error.localizedDescription
            }
        }
    }

    func addFormField() {
        formFields.append(FormField(key: "field_\(formFields.count + 1)", label: "New field", type: .text, required: false))
    }

    func removeFormField(_ field: FormField) {
        formFields.removeAll { $0.id == field.id }
    }

    func updateFormField(_ updatedField: FormField) {
        guard let index = formFields.firstIndex(where: { $0.id == updatedField.id }) else { return }
        formFields[index] = updatedField
    }



    var activeTemplateFamily: TemplateFamily {
        WebTheme(rawValue: webThemeId)?.family ?? .classic
    }

    /// Persists color fields touched from preview quick-edit chrome.
    /// Skips WKWebView reload by default — preview already has live CSS patches.
    func savePreviewQuickEditColors(invalidatePreview: Bool = false) async -> Bool {
        guard let tid = tenantId else { return false }
        await MainActor.run { errorMessage = nil }
        let updates = WebColorPalettes.firestoreUpdates(paletteId: webColorPaletteId, tokens: currentColorTokens())
        await saveTenantUpdates(tid, updates, invalidatePreview: invalidatePreview)
        return await MainActor.run { errorMessage == nil }
    }

    func applyColorTokensLocally(_ tokens: WebColorPaletteTokens) {
        backgroundColorHex = tokens.backgroundColor
        cardSurfaceColorHex = tokens.cardSurfaceColor
        textColorHex = tokens.textColor
        primaryColorHex = tokens.primaryColor
        primaryColorHoverHex = tokens.primaryColorHover
        featuredWorkBackgroundColorHex = tokens.featuredWorkBackgroundColor
        featuredWorkTextColorHex = tokens.featuredWorkTextColor
        bookingFormCardBackgroundColorHex = tokens.bookingFormCardBackgroundColor
        galleryPageBackgroundColorHex = tokens.galleryPageBackgroundColor
        galleryPageTextColorHex = tokens.galleryPageTextColor
        aboutSectionBackgroundColorHex = tokens.aboutSectionBackgroundColor
        aboutSectionTextColorHex = tokens.aboutSectionTextColor
        syncPreviewHeroSlotColorFromTokens()
        syncTattooSectionThemeFromFeaturedIfNeeded()
    }

    func syncPreviewHeroSlotColorFromTokens() {
        previewHeroSlotColorHex = DesignViewModel.mixedHeroSlotHex(
            background: backgroundColorHex,
            accent: primaryColorHex
        )
    }

    /// Approximates web `tenantHeroPlaceholderSlotStyle` mix for the hero empty slot.
    static func mixedHeroSlotHex(background: String, accent: String) -> String {
        let bg = Color(hex: background)
        let ac = Color(hex: accent)
        guard let bgC = UIColor(bg).cgColor.components,
              let acC = UIColor(ac).cgColor.components else { return background }
        let br = bgC.count >= 3 ? bgC[0] : 0
        let bgG = bgC.count >= 3 ? bgC[1] : 0
        let bb = bgC.count >= 3 ? bgC[2] : 0
        let ar = acC.count >= 3 ? acC[0] : 0
        let ag = acC.count >= 3 ? acC[1] : 0
        let ab = acC.count >= 3 ? acC[2] : 0
        let lum = (0.299 * ar + 0.587 * ag + 0.114 * ab)
        let baseR = lum > 0.62 ? br : (bgC.count >= 3 ? bgC[0] : br)
        let baseG = lum > 0.62 ? bgG : (bgC.count >= 3 ? bgC[1] : bgG)
        let baseB = lum > 0.62 ? bb : (bgC.count >= 3 ? bgC[2] : bb)
        let mixA: CGFloat = 0.48
        let mixB: CGFloat = 0.52
        func clamp(_ v: CGFloat) -> CGFloat { min(1, max(0, v)) }
        return String(
            format: "#%02X%02X%02X",
            Int(clamp(ar * mixA + baseR * mixB) * 255),
            Int(clamp(ag * mixA + baseG * mixB) * 255),
            Int(clamp(ab * mixA + baseB * mixB) * 255)
        )
    }

    func previewColorPatchPayload(heroSlotOverride: String? = nil) -> [String: String] {
        let tokens = currentColorTokens()
        var payload: [String: String] = [
            "webThemeId": webThemeId,
            "backgroundColor": tokens.backgroundColor,
            "textColor": tokens.textColor,
            "cardSurfaceColor": tokens.cardSurfaceColor,
            "primaryColor": tokens.primaryColor,
            "primaryColorHover": tokens.primaryColorHover,
            "featuredWorkBackgroundColor": tokens.featuredWorkBackgroundColor,
            "featuredWorkTextColor": tokens.featuredWorkTextColor,
            "galleryPageBackgroundColor": tokens.galleryPageBackgroundColor,
            "galleryPageTextColor": tokens.galleryPageTextColor,
            "aboutSectionBackgroundColor": tokens.aboutSectionBackgroundColor,
            "aboutSectionTextColor": tokens.aboutSectionTextColor,
        ]
        let heroSlot = heroSlotOverride ?? previewHeroSlotColorHex
        if !heroSlot.isEmpty {
            payload["heroSlotBg"] = heroSlot
        }
        return payload
    }

    func currentColorTokens() -> WebColorPaletteTokens {
        let basePalette = WebColorPalettes.palette(family: activeTemplateFamily, id: webColorPaletteId)
        var strip = basePalette?.tokens.stripColors ?? [
            backgroundColorHex, cardSurfaceColorHex, primaryColorHex,
        ]
        if strip.count >= 3 { strip[2] = primaryColorHex }
        return WebColorPaletteTokens(
            backgroundColor: backgroundColorHex,
            cardSurfaceColor: cardSurfaceColorHex,
            textColor: textColorHex,
            primaryColor: primaryColorHex,
            primaryColorHover: primaryColorHoverHex,
            featuredWorkBackgroundColor: featuredWorkBackgroundColorHex,
            featuredWorkTextColor: featuredWorkTextColorHex,
            bookingFormCardBackgroundColor: bookingFormCardBackgroundColorHex,
            galleryPageBackgroundColor: galleryPageBackgroundColorHex,
            galleryPageTextColor: galleryPageTextColorHex,
            aboutSectionBackgroundColor: aboutSectionBackgroundColorHex,
            aboutSectionTextColor: aboutSectionTextColorHex,
            stripColors: strip
        )
    }

    /// Swaps accent on dark templates; applies full v3 palette on Classic / Luxe / Studio 12 when applicable.
    func applyWebColorAccent(_ accent: WebColorAccentOption) async {
        guard let tid = tenantId else { return }
        guard WebColorPalettes.usesAccentPicker(family: activeTemplateFamily) else { return }
        let baseId = webColorPaletteId
        let tokens: WebColorPaletteTokens
        if WebColorPalettes.appliesFullPaletteForAccent(family: activeTemplateFamily, accentId: accent.id),
           let full = WebColorPalettes.palette(family: activeTemplateFamily, id: accent.id) {
            tokens = full.tokens
        } else {
            tokens = WebColorPalettes.tokensReplacingAccent(currentColorTokens(), accent: accent)
        }
        await MainActor.run {
            errorMessage = nil
            applyColorTokensLocally(tokens)
        }
        await saveTenantUpdates(tid, WebColorPalettes.firestoreUpdates(paletteId: baseId, tokens: tokens))
    }

    /// Applies a curated palette for the current template family and persists tenant colors.
    func applyWebColorPalette(_ palette: WebColorPalette) async {
        guard let tid = tenantId else { return }
        guard palette.family == activeTemplateFamily else {
            await MainActor.run {
                errorMessage = "This palette doesn’t match your active template."
            }
            return
        }
        await MainActor.run {
            errorMessage = nil
            webColorPaletteId = palette.id
            applyColorTokensLocally(palette.tokens)
            bumpWebPreviewColorPatch()
        }
        await saveTenantUpdates(
            tid,
            WebColorPalettes.firestoreUpdates(paletteId: palette.id, tokens: palette.tokens),
            invalidatePreview: false
        )
    }

    /// Applies a **web layout** only. Business type stays in Settings (`industry` unchanged).
    func applyWebTheme(_ theme: WebTheme) async {
        guard let tid = tenantId else { return }
        guard theme.isUniversal || (industry != nil && theme.bookingIndustry.rawValue == industry) else {
            await MainActor.run { errorMessage = "This layout doesn’t match your business type. Change it in Settings if needed." }
            return
        }
        await MainActor.run { errorMessage = nil }
        let family = theme.family
        let originalPalette = WebColorPalettes.original(for: family)
        var updates: [String: Any] = ["webThemeId": theme.rawValue]
        for (key, value) in WebColorPalettes.firestoreUpdates(paletteId: originalPalette.id, tokens: originalPalette.tokens) {
            updates[key] = value
        }
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: updates)
            await MainActor.run {
                webThemeId = theme.rawValue
                webColorPaletteId = originalPalette.id
                applyColorTokensLocally(originalPalette.tokens)
                invalidateWebPreview()
                saveSuccess = true
            }
            Task { @MainActor in try? await Task.sleep(nanoseconds: 2_000_000_000); saveSuccess = false }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Shop / Products
    /// Persists gallery, book, about, team, and shop visibility for the public site (nav + direct URLs).
    func savePublicPageVisibility() async {
        guard let tid = tenantId else { return }
        await saveTenantUpdates(tid, [
            "showGalleryPage": showGalleryPage,
            "showBookPage": showBookPage,
            "showAboutPage": showAboutPage,
            "showTeamPage": showTeamPage,
            "showMeetTheTeamOnHome": showMeetTheTeamOnHome,
            "shopEnabled": shopEnabled
        ])
    }

    func saveShopEnabled() async {
        await savePublicPageVisibility()
    }

    /// Persists team page visibility toggles and per-member roster fields.
    func saveTeamPageSettings() async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await saveTenantUpdates(tid, [
            "showTeamPage": showTeamPage,
            "showMeetTheTeamOnHome": showMeetTheTeamOnHome,
        ])
        await saveTeamMemberVisibility()
        await MainActor.run { invalidateWebPreview() }
    }

    func uploadTeamMemberProfilePhoto(memberUid: String, imageData: Data) async -> String? {
        guard let tid = tenantId else { return nil }
        if blockIfDemoReadOnly() { return nil }
        await MainActor.run {
            uploadingTeamMemberPhotoUid = memberUid
            errorMessage = nil
        }
        do {
            let url = try await firebaseService.uploadTeamMemberProfilePhoto(
                tenantId: tid,
                memberUid: memberUid,
                imageData: imageData
            )
            await MainActor.run {
                if let idx = teamMemberVisibility.firstIndex(where: { $0.uid == memberUid }) {
                    teamMemberVisibility[idx].profilePhotoUrl = url
                }
            }
            _ = try await functions.httpsCallable("updateTenantMember").call([
                "memberUid": memberUid,
                "profilePhotoUrl": url,
            ])
            await MainActor.run {
                uploadingTeamMemberPhotoUid = nil
                invalidateWebPreview()
            }
            return url
        } catch {
            await MainActor.run {
                uploadingTeamMemberPhotoUid = nil
                errorMessage = error.localizedDescription
            }
            return nil
        }
    }

    private func loadTeamMemberVisibility(ownerUid: String?) async {
        do {
            let result = try await functions.httpsCallable("listTenantMembers").call([:])
            let data = result.data as? [String: Any]
            let raw = data?["members"] as? [[String: Any]]
            let members = TenantSessionStore.parseTeamMembers(raw, ownerUid: ownerUid)
            await MainActor.run {
                teamMemberVisibility = members.map(TeamMemberVisibilityDraft.init(member:))
            }
        } catch {
            await MainActor.run {
                teamMemberVisibility = []
                errorMessage = error.localizedDescription
            }
        }
    }

    private func saveTeamMemberVisibility() async {
        for member in teamMemberVisibility {
            let payload: [String: Any] = [
                "memberUid": member.uid,
                "showOnTeamPage": member.showOnTeamPage,
                "showOnTeamHome": member.showOnTeamHome,
                "isBookable": member.isBookable,
                "providerAboutText": member.providerAboutText.trimmingCharacters(in: .whitespacesAndNewlines),
                "profilePhotoUrl": member.profilePhotoUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                "memberSettings": [
                    "canEditPortfolio": member.canEditPortfolio,
                    "canEditPublicBio": member.canEditPublicBio,
                ],
            ]
            do {
                _ = try await functions.httpsCallable("updateTenantMember").call(payload)
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
                return
            }
        }
    }

    func addProduct(
        name: String,
        category: String,
        description: String,
        price: Double,
        salePrice: Double?,
        imageData: Data?,
        isActive: Bool
    ) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingProduct = true }
        do {
            var imageUrl = ""
            if let data = imageData {
                imageUrl = try await firebaseService.uploadProductImage(tenantId: tid, imageData: data)
            }
            let docId = try await firebaseService.createTenantProduct(
                tenantId: tid,
                name: name,
                category: category,
                description: description,
                price: price,
                salePrice: salePrice,
                imageUrl: imageUrl,
                isActive: isActive
            )
            let descTrim = description.trimmingCharacters(in: .whitespacesAndNewlines)
            let product = Product(
                id: docId,
                name: name,
                category: category,
                description: descTrim,
                price: price,
                salePrice: salePrice,
                imageUrl: imageUrl,
                isActive: isActive
            )
            await MainActor.run { products.append(product); isUploadingProduct = false; invalidateWebPreview() }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription; isUploadingProduct = false }
        }
    }

    func updateProduct(
        _ product: Product,
        name: String,
        category: String,
        description: String,
        price: Double,
        salePrice: Double?,
        imageData: Data?,
        isActive: Bool
    ) async {
        guard let tid = tenantId else { return }
        if blockIfDemoReadOnly() { return }
        await MainActor.run { isUploadingProduct = true }
        do {
            var imageUrl: String? = nil
            if let data = imageData {
                imageUrl = try await firebaseService.uploadProductImage(tenantId: tid, imageData: data)
            }
            try await firebaseService.updateTenantProduct(
                tenantId: tid,
                productId: product.id,
                name: name,
                category: category,
                description: description,
                price: price,
                salePrice: salePrice,
                imageUrl: imageUrl,
                isActive: isActive
            )
            let descTrim = description.trimmingCharacters(in: .whitespacesAndNewlines)
            let updated = Product(
                id: product.id,
                name: name,
                category: category,
                description: descTrim,
                price: price,
                salePrice: salePrice,
                imageUrl: imageUrl ?? product.imageUrl,
                isActive: isActive
            )
            await MainActor.run {
                if let idx = products.firstIndex(where: { $0.id == product.id }) {
                    products[idx] = updated
                }
                isUploadingProduct = false
                invalidateWebPreview()
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription; isUploadingProduct = false }
        }
    }

    func deleteProduct(_ product: Product) async {
        guard let tid = tenantId else { return }
        do {
            try await firebaseService.deleteTenantProduct(tenantId: tid, productId: product.id)
            await MainActor.run { products.removeAll { $0.id == product.id }; invalidateWebPreview() }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    var shopOrdersRevenueCents: Int {
        shopOrders
            .filter { $0.statusLower != ShopOrderStatus.cancelled }
            .reduce(0) { $0 + $1.subtotalCents }
    }

    var shopPendingOrderCount: Int {
        shopOrders.filter { $0.statusLower == ShopOrderStatus.pending }.count
    }

    var shopUnreadOrderCount: Int {
        shopOrders.filter {
            $0.statusLower == ShopOrderStatus.pending && $0.readAt == nil
        }.count
    }

    static func shopOrderCustomerDocumentId(_ order: ShopOrder) -> String? {
        let email = (order.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(order.customerPhone)
        let digits = PhoneFormatting.digits(from: phone ?? "")
        if digits.count >= 10 { return String(digits.suffix(10)) }
        if !email.isEmpty {
            let safe = email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            return String(safe.prefix(120))
        }
        return nil
    }

    func addShopOrderCustomerToContacts(_ order: ShopOrder) async -> Bool {
        guard let tid = tenantId else { return false }
        let name = (order.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (order.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(order.customerPhone)
        guard !name.isEmpty else {
            await MainActor.run { errorMessage = "Customer name is required to save contact." }
            return false
        }
        guard !email.isEmpty || (phone != nil && !(phone ?? "").isEmpty) else {
            await MainActor.run { errorMessage = "Add an email or phone number to save contact." }
            return false
        }
        do {
            let customerId = Self.shopOrderCustomerDocumentId(order) ?? UUID().uuidString
            try await firebaseService.upsertTenantCustomer(
                tenantId: tid,
                customerId: customerId,
                name: name,
                email: email,
                phone: phone
            )
            return true
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
            return false
        }
    }

    func isShopOrderCustomerInContacts(_ order: ShopOrder) async -> Bool {
        guard let tid = tenantId else { return false }
        let email = (order.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(order.customerPhone) ?? ""
        let digits = PhoneFormatting.digits(from: phone)
        let targetPhoneId = digits.count >= 10 ? String(digits.suffix(10)) : ""
        let targetEmailId = email.isEmpty
            ? ""
            : String(email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression).prefix(120))
        do {
            let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
            return customers.contains { customer in
                let existingPhoneDigits = PhoneFormatting.digits(from: customer.phone ?? "")
                let existingPhoneId = existingPhoneDigits.count >= 10 ? String(existingPhoneDigits.suffix(10)) : ""
                let existingEmailId = customer.email
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                    .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
                if !targetPhoneId.isEmpty && existingPhoneId == targetPhoneId { return true }
                if !targetEmailId.isEmpty && String(existingEmailId.prefix(120)) == targetEmailId { return true }
                return false
            }
        } catch {
            return false
        }
    }

    func updateShopOrderStatus(_ order: ShopOrder, status: String) async {
        guard let tid = tenantId else { return }
        do {
            try await firebaseService.updateTenantShopOrder(
                tenantId: tid,
                orderId: order.id,
                updates: ["status": status]
            )
            await MainActor.run {
                if let idx = shopOrders.firstIndex(where: { $0.id == order.id }) {
                    shopOrders[idx].status = status
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func markShopOrderRead(_ order: ShopOrder) async {
        guard order.readAt == nil, let tid = tenantId else { return }
        let readAt = Date()
        do {
            try await firebaseService.updateTenantShopOrder(
                tenantId: tid,
                orderId: order.id,
                updates: ["readAt": readAt]
            )
            await MainActor.run {
                if let idx = shopOrders.firstIndex(where: { $0.id == order.id }) {
                    shopOrders[idx].readAt = readAt
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    /// Studio 12 “How it works” — max steps stored and rendered on web.
    static let studio12ProcessStepsLimit = 12

    func moveStudio12ProcessStep(from index: Int, direction: Int) {
        let j = index + direction
        guard studio12ProcessSteps.indices.contains(index), studio12ProcessSteps.indices.contains(j) else { return }
        studio12ProcessSteps.swapAt(index, j)
        normalizeStudio12ProcessStepIds()
    }

    func deleteStudio12ProcessStep(at index: Int) {
        guard studio12ProcessSteps.indices.contains(index) else { return }
        studio12ProcessSteps.remove(at: index)
        normalizeStudio12ProcessStepIds()
        if studio12ProcessSteps.isEmpty {
            studio12ProcessSteps = Studio12IndustryCopy.processSteps(for: Studio12IndustryCopy.template(from: industry))
        }
    }

    func addStudio12ProcessStep() {
        guard studio12ProcessSteps.count < Self.studio12ProcessStepsLimit else { return }
        studio12ProcessSteps.append(Studio12ProcessStep(id: studio12ProcessSteps.count, title: "New step", body: ""))
        normalizeStudio12ProcessStepIds()
    }

    func resetStudio12ProcessStepsToIndustryDefaults() {
        studio12ProcessSteps = Studio12IndustryCopy.processSteps(for: Studio12IndustryCopy.template(from: industry))
    }

    func updateStudio12ProcessStep(at index: Int, title: String, body: String) {
        guard studio12ProcessSteps.indices.contains(index) else { return }
        var steps = studio12ProcessSteps
        steps[index].title = title
        steps[index].body = body
        studio12ProcessSteps = steps
    }

    /// Writes current `studio12ProcessSteps` to Firestore (preview step sheet and inline quick edit).
    func persistStudio12ProcessSteps(invalidatePreview: Bool = true) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        do {
            try await firebaseService.updateTenant(
                tenantId: tid,
                updates: ["studio12ProcessSteps": studio12ProcessStepsFirestorePayload()]
            )
            await MainActor.run {
                if invalidatePreview { invalidateWebPreview() }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    private func normalizeStudio12ProcessStepIds() {
        studio12ProcessSteps = studio12ProcessSteps.enumerated().map {
            Studio12ProcessStep(id: $0.offset, title: $0.element.title, body: $0.element.body)
        }
    }

    private static func mergedStudio12ProcessSteps(from raw: Any?, industry: String?) -> [Studio12ProcessStep] {
        let base = Studio12IndustryCopy.processSteps(for: Studio12IndustryCopy.template(from: industry))
        guard let arr = raw as? [[String: Any]], !arr.isEmpty else { return base }
        return Array(arr.prefix(Self.studio12ProcessStepsLimit)).enumerated().map { i, d in
            let tRaw = (d["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let bRaw = (d["body"] as? String ?? d["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = i < base.count ? base[i] : base[base.count - 1]
            return Studio12ProcessStep(
                id: i,
                title: tRaw.isEmpty ? fallback.title : tRaw,
                body: bRaw.isEmpty ? fallback.body : bRaw
            )
        }
    }
}

extension FormField {
    static let defaultFields: [FormField] = [
        FormField(id: "name", key: "name", label: "Full Name", type: .text, required: true),
        FormField(id: "email", key: "email", label: "Email", type: .email, required: true),
        FormField(id: "phone", key: "phone", label: "Phone", type: .phone, required: true),
        FormField(id: "referenceImages", key: "referenceImages", label: "Reference photos (optional)", type: .file, required: false),
        FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false)
    ]
}

extension DesignViewModel {
    var activePaletteDisplayName: String {
        let family = activeTemplateFamily
        let resolvedId = WebColorPalettes.resolvedPaletteId(stored: webColorPaletteId, family: family)
        let hintTone: WebColorPalettePickerTone = WebColorPalettes.isPaletteLight(
            backgroundHex: backgroundColorHex
        ) ? .light : .dark
        if let palette = WebColorPalettes.palette(family: family, id: resolvedId, pickerTone: hintTone) {
            return palette.name
        }
        if let match = WebColorPalettes.palettes(for: family, tone: hintTone).first(where: {
            WebColorPalettes.pickerPaletteIsActive(
                storedPaletteId: webColorPaletteId,
                storedPrimaryHex: primaryColorHex,
                storedBackgroundHex: backgroundColorHex,
                palette: $0
            )
        }) {
            return match.name
        }
        return WebColorPalettes.original(for: family).name
    }
}
