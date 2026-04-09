//
//  DesignViewModel.swift
//
//  Web page design: branding, form fields, services, contact.
//

import Foundation
import Combine
import FirebaseAuth

enum DesignTab: String, CaseIterable {
    case template
    case home
    case gallery
    case book
    case about
    case shop
}

/// Editable “Your experience” steps on Studio 12 home (`studio12ProcessSteps` in Firestore).
struct Studio12ProcessStep: Identifiable, Equatable {
    var id: Int
    var title: String
    var body: String
}

class DesignViewModel: ObservableObject {
    @Published var tenantId: String?
    @Published var tenantSlug: String?
    @Published var bookingUrl: String = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false
    @Published private(set) var isApplyingBladeStarters = false
    @Published private(set) var isSavingBladeServices = false
    /// Bumped when Firestore content affecting the public site changes so the in-app WKWebView reloads (same path would otherwise stay stale).
    @Published private(set) var webPreviewReloadToken: UInt64 = 0

    // Home: appearance + hero + featured work
    @Published var displayName: String = ""
    @Published var logoUrl: String = ""
    @Published var heroImageUrl: String = ""
    @Published var isUploadingHero = false
    /// Shown only on `/gallery` (not on home featured strip).
    @Published var galleryImages: [String] = []
    @Published var isUploadingGallery = false
    /// Home featured strip only; order matters. Independent from `galleryImages`.
    @Published var featuredWorkImages: [String] = []
    @Published var isUploadingFeaturedWork = false
    @Published var galleryGridLayout: String = "3x1"
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
    @Published var isUploadingStudio12Philosophy = false
    /// Three parts separated by ` · ` (space–middle dot–space); site renders as three lines with the last in italics.
    @Published var studio12PhilosophyHeadline: String = ""
    @Published var studio12ProcessSteps: [Studio12ProcessStep] = Studio12IndustryCopy.processSteps(for: .custom)
    /// Two parts separated by ` · `; site renders first line + italic second line.
    @Published var studio12BookCtaHeadline: String = ""
    @Published var studio12BookCtaBody: String = ""
    @Published var studio12BookCtaImageUrl: String = ""
    @Published var isUploadingStudio12BookCta = false
    /// When false, the “What we offer” grid is hidden on the public home page (default on).
    @Published var studio12ShowServicesSection: Bool = true
    /// When false, the “How it works / Your experience” block is hidden (default on).
    @Published var studio12ShowProcessSection: Bool = true

    // Section surfaces (Design tabs: Home / Gallery / About)
    /// Tattoo template default: warm paper — Featured, Gallery, and Book share this theme on the web.
    @Published var featuredWorkBackgroundColorHex: String = "#FAF8F5"
    @Published var featuredWorkTextColorHex: String = "#1C1917"
    @Published var bookingFormCardBackgroundColorHex: String = "#FFFFFF"
    @Published var galleryPageBackgroundColorHex: String = "#FAF8F5"
    @Published var galleryPageTextColorHex: String = "#1C1917"
    @Published var aboutSectionBackgroundColorHex: String = "#111111"
    @Published var aboutSectionTextColorHex: String = "#FFFFFF"

    // Form fields
    @Published var formFields: [FormField] = []

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
    @Published var products: [Product] = []
    @Published var isUploadingProduct = false

    // Template / industry (business type — set in Settings)
    @Published var industry: String?
    /// Public site layout variant; see `WebTheme`. Scoped to current `industry`.
    @Published var webThemeId: String = ""

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
    /// Short line for marketing (e.g. city, state) — Blade hero eyebrow; full street stays in `contactAddress`.
    @Published var serviceArea: String = ""
    @Published var businessHours: String = ""
    @Published var instagramHandle: String = ""
    @Published var showContactOnPage: Bool = true

    private let firebaseService = FirebaseService()

    var hasTenant: Bool { tenantId != nil }

    func invalidateWebPreview() {
        webPreviewReloadToken &+= 1
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

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run {
                tenantId = nil
                tenantSlug = nil
                bookingUrl = ""
                formFields = FormField.defaultFields
                services = []
                industry = nil
                webThemeId = ""
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
                    isLoading = false
                }
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let svc = try await firebaseService.fetchTenantServices(tenantId: tid)
            var persistSplit: (featured: [String], gallery: [String])?
            await MainActor.run {
                tenantId = tid
                tenantSlug = slug
                bookingUrl = PublicBookingSite.urlString(forSlug: slug)
                displayName = tenant?["displayName"] as? String ?? ""
                logoUrl = tenant?["logoUrl"] as? String ?? ""
                heroImageUrl = tenant?["heroImageUrl"] as? String ?? ""
                galleryGridLayout = tenant?["galleryGridLayout"] as? String ?? "3x1"
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
                successColorHex = tenant?["successColor"] as? String ?? "#22C55E"
                cardBorderRadius = (tenant?["cardBorderRadius"] as? Double) ?? 12
                tagline = tenant?["tagline"] as? String ?? ""
                luxeHeroTagline = tenant?["luxeHeroTagline"] as? String ?? ""
                luxePromoHeadline = tenant?["luxePromoHeadline"] as? String ?? ""
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
                studio12ShowServicesSection = tenant?["studio12ShowServicesSection"] as? Bool ?? true
                studio12ShowProcessSection = tenant?["studio12ShowProcessSection"] as? Bool ?? true
                featuredWorkBackgroundColorHex = tenant?["featuredWorkBackgroundColor"] as? String ?? "#FAF8F5"
                featuredWorkTextColorHex = tenant?["featuredWorkTextColor"] as? String ?? "#1C1917"
                snapFeaturedWorkColorsToNearestPreset()
                bookingFormCardBackgroundColorHex = tenant?["bookingFormCardBackgroundColor"] as? String ?? "#FFFFFF"
                galleryPageBackgroundColorHex = tenant?["galleryPageBackgroundColor"] as? String ?? "#FAF8F5"
                galleryPageTextColorHex = tenant?["galleryPageTextColor"] as? String ?? "#1C1917"
                aboutSectionBackgroundColorHex = tenant?["aboutSectionBackgroundColor"] as? String ?? "#111111"
                aboutSectionTextColorHex = tenant?["aboutSectionTextColor"] as? String ?? "#FFFFFF"
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
                contactAddress = (tenant?["address"] as? String) ?? (tenant?["contactAddress"] as? String) ?? ""
                serviceArea = (tenant?["serviceArea"] as? String) ?? ""
                businessHours = tenant?["businessHours"] as? String ?? ""
                instagramHandle = tenant?["instagramHandle"] as? String ?? ""
                showContactOnPage = tenant?["showContactOnPage"] as? Bool ?? true
                shopEnabled = tenant?["shopEnabled"] as? Bool ?? false
                showGalleryPage = tenant?["showGalleryPage"] as? Bool ?? true
                showBookPage = tenant?["showBookPage"] as? Bool ?? true
                showAboutPage = tenant?["showAboutPage"] as? Bool ?? true
                industry = tenant?["industry"] as? String
                studio12ProcessSteps = Self.mergedStudio12ProcessSteps(
                    from: tenant?["studio12ProcessSteps"],
                    industry: tenant?["industry"] as? String
                )
                let resolvedTheme = WebTheme.resolvedThemeId(
                    stored: tenant?["webThemeId"] as? String,
                    industry: tenant?["industry"] as? String
                )
                webThemeId = resolvedTheme
                sidebarIconColorHome = tenant?["sidebarIconColorHome"] as? String ?? ""
                sidebarIconColorBooking = tenant?["sidebarIconColorBooking"] as? String ?? ""
                normalizeFeaturedGridLayoutPresets()
                syncTattooSectionThemeFromFeaturedIfNeeded()
                isLoading = false
            }
            let fetchedProducts = try await firebaseService.fetchTenantProducts(tenantId: tid)
            await MainActor.run { products = fetchedProducts }
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
            "displayName": displayName,
            "logoUrl": logoUrl,
            "heroImageUrl": heroImageUrl,
            "featuredWorkImages": featuredWorkImages,
            "galleryImages": galleryImages,
            "galleryGridLayout": galleryGridLayout,
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
        if fam == .studio12 {
            updates["heroTagline"] = heroTagline
            updates["studio12HeroEyebrow"] = studio12HeroEyebrow
            updates["studio12HeroHeadline"] = studio12HeroHeadline
            updates["studio12HeroLine1"] = ""
            updates["studio12HeroLine2"] = ""
            updates["aboutText"] = aboutText
            updates["studio12PhilosophyImageUrl"] = studio12PhilosophyImageUrl
            updates["studio12PhilosophyHeadline"] = studio12PhilosophyHeadline
            updates["studio12PhilosophyHeadLine1"] = ""
            updates["studio12PhilosophyHeadLine2"] = ""
            updates["studio12PhilosophyHeadItalic"] = ""
            updates["studio12BookCtaHeadline"] = studio12BookCtaHeadline
            updates["studio12BookCtaLine1"] = ""
            updates["studio12BookCtaItalic"] = ""
            updates["studio12BookCtaBody"] = studio12BookCtaBody
            updates["studio12BookCtaImageUrl"] = studio12BookCtaImageUrl
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

    func saveAbout() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "aboutText": aboutText,
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "contactAddress": contactAddress,
            "address": contactAddress,
            "serviceArea": serviceArea,
            "businessHours": businessHours,
            "instagramHandle": instagramHandle,
            "showContactOnPage": showContactOnPage,
            "aboutSectionBackgroundColor": aboutSectionBackgroundColorHex,
            "aboutSectionTextColor": aboutSectionTextColorHex
        ]
        await saveTenantUpdates(tid, updates)
    }

    /// Keeps builder in sync when logo is changed in Settings.
    func syncLogoUrlFromExternal(_ url: String) {
        logoUrl = url.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func uploadHeroImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingHero = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantHeroImage(tenantId: tid, imageData: imageData)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["heroImageUrl": url])
            await MainActor.run {
                heroImageUrl = url
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

    func uploadStudio12PhilosophyImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingStudio12Philosophy = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["studio12PhilosophyImageUrl": url])
            await MainActor.run {
                studio12PhilosophyImageUrl = url
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
        await MainActor.run { isUploadingStudio12BookCta = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["studio12BookCtaImageUrl": url])
            await MainActor.run {
                studio12BookCtaImageUrl = url
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

    func removeGalleryImage(at index: Int) async {
        guard let tid = tenantId else { return }
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

    func removeFeaturedWorkImage(at index: Int) async {
        guard let tid = tenantId else { return }
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
        await saveTenantUpdates(tid, ["formSchema": schema])
    }

    func saveContact() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "contactAddress": contactAddress,
            "address": contactAddress,
            "serviceArea": serviceArea,
            "showContactOnPage": showContactOnPage
        ]
        await saveTenantUpdates(tid, updates)
    }

    private func saveTenantUpdates(_ tid: String, _ updates: [String: Any]) async {
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
                invalidateWebPreview()
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
        durationMinutes: Int,
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
        durationMinutes: Int,
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

    /// Replaces all tenant services with four industry starter services (Blade + Studio 12 home grids use the same list).
    func applyBladeStarterServices(isDemoMode: Bool = false) async {
        guard let tid = tenantId else { return }
        let fam = WebTheme(rawValue: webThemeId)?.family ?? .classic
        guard fam == .blade || fam == .studio12 else { return }
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


    /// Applies a **web layout** only. Business type stays in Settings (`industry` unchanged).
    func applyWebTheme(_ theme: WebTheme) async {
        guard let tid = tenantId else { return }
        guard theme.isUniversal || (industry != nil && theme.bookingIndustry.rawValue == industry) else {
            await MainActor.run { errorMessage = "This layout doesn’t match your business type. Change it in Settings if needed." }
            return
        }
        await MainActor.run { errorMessage = nil }
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "webThemeId": theme.rawValue
            ])
            await MainActor.run { webThemeId = theme.rawValue }
            await MainActor.run {
                invalidateWebPreview()
                saveSuccess = true
            }
            Task { @MainActor in try? await Task.sleep(nanoseconds: 2_000_000_000); saveSuccess = false }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Shop / Products
    /// Persists gallery, book, about, and shop visibility for the public site (nav + direct URLs).
    func savePublicPageVisibility() async {
        guard let tid = tenantId else { return }
        await saveTenantUpdates(tid, [
            "showGalleryPage": showGalleryPage,
            "showBookPage": showBookPage,
            "showAboutPage": showAboutPage,
            "shopEnabled": shopEnabled
        ])
    }

    func saveShopEnabled() async {
        await savePublicPageVisibility()
    }

    func addProduct(name: String, category: String, price: Double, salePrice: Double?, imageData: Data?) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingProduct = true }
        do {
            var imageUrl = ""
            if let data = imageData {
                imageUrl = try await firebaseService.uploadProductImage(tenantId: tid, imageData: data)
            }
            let docId = try await firebaseService.createTenantProduct(tenantId: tid, name: name, category: category, price: price, salePrice: salePrice, imageUrl: imageUrl)
            let product = Product(id: docId, name: name, category: category, price: price, salePrice: salePrice, imageUrl: imageUrl, isActive: true)
            await MainActor.run { products.append(product); isUploadingProduct = false; invalidateWebPreview() }
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
        FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false)
    ]
}
