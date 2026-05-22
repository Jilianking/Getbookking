//
//  DesignView.swift
//
//  Web page design: Preview mode (default) + Builder mode with tabs.
//

import SwiftUI
import PhotosUI
import UIKit

struct DesignView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DesignViewModel()
    @State private var selectedTab: DesignTab = .template
    @State private var isShowingBuilder = false
    @State private var businessHoursDaySheet: BusinessHoursDaySheetToken?
    @State private var businessHoursExceptionSheet: BusinessHoursException?
    @State private var showBladeStarterConfirm = false
    @State private var showStudio12ProcessStartersConfirm = false
    @State private var bladeServiceToEdit: TenantService?
    @State private var isEditingStudio12ProcessStep = false
    @State private var studio12ProcessStepEditIndex = 0
    @State private var isQuickEditEnabled = false
    @State private var quickEditSheet: QuickEditSheetPayload?
    @State private var quickEditHeroImageSheet = false
    @State private var quickEditFeaturedSlot: QuickEditFeaturedSlotPayload?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            Group {
                if isShowingBuilder {
                    builderContent
                } else {
                    previewContent
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Group {
                        if isShowingBuilder {
                            Button("Preview") {
                                isShowingBuilder = false
                            }
                        } else {
                            Button(action: { drawerState.isOpen = true }) {
                                Image(systemName: "line.3.horizontal")
                            }
                        }
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Group {
                        if !isShowingBuilder {
                            HStack(spacing: 12) {
                                if viewModel.hasTenant, !authViewModel.isDemoMode {
                                    Text("Preview")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(isQuickEditEnabled ? Color.secondary : Color.primary)
                                    Toggle("", isOn: $isQuickEditEnabled)
                                        .labelsHidden()
                                        .toggleStyle(.switch)
                                        .accessibilityLabel("Quick edit")
                                }
                                Button("Builder") {
                                    isQuickEditEnabled = false
                                    isShowingBuilder = true
                                }
                                if viewModel.hasTenant, URL(string: viewModel.bookingUrl) != nil {
                                    Button(action: openInSafari) {
                                        Image(systemName: "safari")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await authViewModel.refreshTeamAccess()
            }
            .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
                if let url = note.userInfo?["logoUrl"] as? String {
                    viewModel.syncLogoUrlFromExternal(url)
                }
            }
            .sheet(item: $quickEditSheet) { payload in
                PreviewQuickEditSheet(
                    fieldKey: payload.fieldKey,
                    title: Self.quickEditFieldTitle(payload.fieldKey),
                    initialText: payload.currentText,
                    viewModel: viewModel,
                    onDismiss: { quickEditSheet = nil }
                )
            }
            .sheet(isPresented: $quickEditHeroImageSheet) {
                NavigationStack {
                    Form {
                        HeroImageUploadSection(viewModel: viewModel)
                    }
                    .navigationTitle("Hero image")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { quickEditHeroImageSheet = false }
                        }
                    }
                }
            }
            .sheet(item: $quickEditFeaturedSlot) { payload in
                QuickEditFeaturedWorkSlotSheet(
                    slotIndex: payload.slotIndex,
                    viewModel: viewModel,
                    onDone: { quickEditFeaturedSlot = nil }
                )
            }
            .sheet(item: $bladeServiceToEdit) { service in
                EditTenantServiceSheet(service: service, viewModel: viewModel) {
                    bladeServiceToEdit = nil
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private struct QuickEditSheetPayload: Identifiable {
        let id = UUID()
        let fieldKey: String
        let currentText: String
    }

    private struct QuickEditFeaturedSlotPayload: Identifiable {
        let slotIndex: Int
        var id: Int { slotIndex }
    }

    private struct QuickEditFeaturedWorkSlotSheet: View {
        let slotIndex: Int
        @ObservedObject var viewModel: DesignViewModel
        var onDone: () -> Void
        @State private var selectedItem: PhotosPickerItem?
        @State private var cropSheetItem: SingleImageCropSheetItem?

        private var hasImageAtSlot: Bool {
            viewModel.featuredWorkImages.indices.contains(slotIndex)
        }

        private var slotImageURL: URL? {
            guard hasImageAtSlot else { return nil }
            let s = viewModel.featuredWorkImages[slotIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !s.isEmpty, let url = URL(string: s) else { return nil }
            return url
        }

        /// Matches home featured strip (4:5); compact like hero thumbnail but portrait.
        private let previewThumbSize = CGSize(width: 64, height: 80)

        var body: some View {
            NavigationStack {
                Form {
                    Section {
                        Text("Featured photo")
                            .font(.subheadline.weight(.medium))
                        HStack(alignment: .center, spacing: 16) {
                            Group {
                                if let url = slotImageURL {
                                    AsyncImage(url: url) { image in
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    } placeholder: {
                                        Color.gray.opacity(0.2)
                                    }
                                    .frame(width: previewThumbSize.width, height: previewThumbSize.height)
                                    .clipped()
                                    .cornerRadius(8)
                                } else {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color.gray.opacity(0.2))
                                        .frame(width: previewThumbSize.width, height: previewThumbSize.height)
                                        .overlay(Image(systemName: "photo").foregroundColor(.gray))
                                }
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                PhotosPicker(
                                    selection: $selectedItem,
                                    matching: .images,
                                    photoLibrary: .shared()
                                ) {
                                    HStack {
                                        Image(systemName: "photo.badge.plus")
                                        Text(hasImageAtSlot ? "Replace photo" : "Add photo")
                                    }
                                    .font(.subheadline)
                                }
                                .onChange(of: selectedItem) { _, newItem in
                                    Task {
                                        guard let newItem else { return }
                                        if let data = try? await newItem.loadTransferable(type: Data.self),
                                           !data.isEmpty,
                                           let uiImage = UIImage(data: data) {
                                            await MainActor.run {
                                                cropSheetItem = SingleImageCropSheetItem(image: uiImage)
                                                selectedItem = nil
                                            }
                                        } else {
                                            await MainActor.run { selectedItem = nil }
                                        }
                                    }
                                }
                                if viewModel.isUploadingFeaturedWork {
                                    HStack(spacing: 8) {
                                        ProgressView()
                                            .scaleEffect(0.85)
                                        Text("Uploading…")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .navigationTitle("Photo")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onDone)
                    }
                }
                .sheet(item: $cropSheetItem, onDismiss: { cropSheetItem = nil }) { item in
                    UploadImagePreparationSheet(
                        images: [item.image],
                        advice: "",
                        navigationTitle: "Photo",
                        allowedChoices: [.portrait4_5],
                        defaultChoice: .portrait4_5,
                        showsInstructionalCopy: false,
                        onUseJPEGData: { dataList in
                            guard let data = dataList.first else { return }
                            cropSheetItem = nil
                            Task { await viewModel.replaceOrAppendFeaturedWorkImage(at: slotIndex, imageData: data) }
                        }
                    )
                }
            }
        }
    }

    private static func quickEditFieldTitle(_ key: String) -> String {
        switch key {
        case "displayName": return "Business name"
        case "tagline": return "Tagline"
        case "luxeHeroTagline": return "Hero line"
        case "bladeHeroTagline": return "Hero headline"
        case "bladeHeroDescription": return "Hero description"
        case "serviceArea": return "City / area"
        case "contactAddress": return "Street address"
        case "contactPhone": return "Phone"
        case "contactEmail": return "Email"
        case "aboutText": return "About text"
        case "classicAboutEyebrow": return "About section label"
        case "classicAboutHeading": return "About headline"
        case "classicStatYearsValue": return "Stat — years value"
        case "classicStatYearsLabel": return "Stat — years label"
        case "classicStatClientsValue": return "Stat — clients value"
        case "classicStatClientsLabel": return "Stat — clients label"
        case "classicStatRatedValue": return "Stat — rating value"
        case "classicStatRatedLabel": return "Stat — rating label"
        case "classicFeaturedWorkEyebrow": return "Featured section label"
        case "classicFeaturedWorkHeading": return "Featured section title"
        case "classicFeaturedWorkSub": return "Featured section subtext"
        case "classicFeaturedWorkEmpty": return "Featured empty-state text"
        case "classicServicesEyebrow": return "Services section label"
        case "classicServicesHeading": return "Services section title"
        case "luxePromoHeadline": return "Promo headline"
        case "luxeFeaturedWorkEyebrow": return "Gallery section label"
        case "luxeFeaturedWorkHeading": return "Gallery section title"
        case "luxeHomeServicesEyebrow": return "Services section label"
        case "luxeHomeServicesHeading": return "Services section title"
        case "heroTagline": return "Hero accent line"
        case "studio12HeroEyebrow": return "Hero eyebrow"
        case "studio12HeroLine1": return "Hero headline (line 1)"
        case "studio12HeroLine2": return "Hero headline (line 2)"
        case "studio12BookCtaLine1": return "Booking headline"
        case "studio12BookCtaItalic": return "Booking headline accent"
        case "studio12BookCtaBody": return "Booking section text"
        case "businessHours": return "Business hours"
        case "instagramHandle": return "Instagram handle"
        case "studio12PhilosophyHeadLine1": return "Philosophy headline (line 1)"
        case "studio12PhilosophyHeadLine2": return "Philosophy headline (line 2)"
        case "studio12PhilosophyHeadItalic": return "Philosophy headline (accent)"
        case "heroImage": return "Hero image"
        default:
            if key.hasPrefix("featuredWork:") {
                return "Featured work"
            }
            if key.hasPrefix("svc:") {
                let parts = key.split(separator: ":").map(String.init)
                if parts.count == 3, parts[2] == "edit" { return "Edit service" }
                if parts.count == 3, parts[2] == "name" { return "Service name" }
                if parts.count == 3, parts[2] == "description" { return "Service description" }
                return "Service"
            }
            if key.hasPrefix("wc.") {
                let tail = String(key.dropFirst(3)).replacingOccurrences(of: ".", with: " → ")
                return "Site text: \(tail)"
            }
            return "Edit text"
        }
    }

    /// Same path as `bookingUrl` with a cache-busting query so WKWebView reloads after Firestore updates (token bumps in `DesignViewModel`).
    private var sitePreviewURL: URL? {
        guard viewModel.hasTenant, !viewModel.bookingUrl.isEmpty,
              var components = URLComponents(string: viewModel.bookingUrl) else { return nil }
        var q = components.queryItems ?? []
        q.append(URLQueryItem(name: "_cb", value: String(viewModel.webPreviewReloadToken)))
        components.queryItems = q
        return components.url
    }

    private var previewContent: some View {
        WebViewPreview(
            url: sitePreviewURL,
            height: nil,
            quickEditEnabled: isQuickEditEnabled && viewModel.hasTenant && !authViewModel.isDemoMode,
            onQuickEdit: { event in
                switch event {
                case let .inlineSaveBatch(changes):
                    guard !changes.isEmpty else { return }
                    Task {
                        let pairs = changes.map { (fieldKey: $0.key, value: $0.value) }
                        await viewModel.saveQuickEditBatch(pairs)
                    }
                case let .openSheet(key, text):
                    if key == "heroImage" {
                        quickEditHeroImageSheet = true
                        return
                    }
                    if key.hasPrefix("featuredWork:") {
                        let tail = String(key.dropFirst("featuredWork:".count))
                        if let idx = Int(tail), idx >= 0, idx < viewModel.featuredWorkImageSlotCount {
                            quickEditFeaturedSlot = QuickEditFeaturedSlotPayload(slotIndex: idx)
                            return
                        }
                    }
                    guard key.hasPrefix("svc:") else {
                        quickEditSheet = QuickEditSheetPayload(fieldKey: key, currentText: text)
                        return
                    }
                    let parts = key.split(separator: ":").map(String.init)
                    guard parts.count == 3,
                          parts[0] == "svc",
                          ["edit", "name", "description"].contains(parts[2]) else {
                        quickEditSheet = QuickEditSheetPayload(fieldKey: key, currentText: text)
                        return
                    }
                    let serviceId = parts[1]
                    if let service = viewModel.services.first(where: { $0.id == serviceId }) {
                        bladeServiceToEdit = service
                        return
                    }
                    Task {
                        await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                        await MainActor.run {
                            if let service = viewModel.services.first(where: { $0.id == serviceId }) {
                                bladeServiceToEdit = service
                            } else {
                                viewModel.errorMessage = "Could not open that service. Pull to refresh in Builder or reopen Design."
                            }
                        }
                    }
                }
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    private var builderContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(visibleDesignTabs, id: \.self) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Text(tab.rawValue.capitalized)
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(selectedTab == tab ? Color.accentColor : Color.clear)
                            .foregroundColor(selectedTab == tab ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(Color(.systemGray5))
            .cornerRadius(8)
            .padding()
            .background(Color(.systemBackground))
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let msg = viewModel.errorMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding()
                    }
                    if viewModel.saveSuccess {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                            Text("Saved")
                                .font(.subheadline)
                                .foregroundColor(.green)
                        }
                        .padding()
                    }
                    if !viewModel.hasTenant && !authViewModel.isDemoMode {
                        contentUnavailable
                    } else {
                        switch selectedTab {
                        case .template: templateContent
                        case .home: homeContent
                        case .gallery: galleryContent
                        case .book: bookContent
                        case .about: aboutContent
                        case .shop: shopContent
                        }
                    }
                }
                .padding()
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .alert("Replace all services?", isPresented: $showBladeStarterConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Replace", role: .destructive) {
                Task { await viewModel.applyBladeStarterServices(isDemoMode: authViewModel.isDemoMode) }
            }
        } message: {
            Text(
                "Your current services will be removed and replaced with four starter services for \(BookingTemplate(rawValue: viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")?.displayName ?? "your business type"). You can edit order and details below."
            )
        }
        .alert("Replace experience steps?", isPresented: $showStudio12ProcessStartersConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Replace", role: .destructive) {
                viewModel.resetStudio12ProcessStepsToIndustryDefaults()
            }
        } message: {
            Text("Your current steps will be replaced with the default “How it works” steps for your business type. Tap Save Home to publish.")
        }
        .sheet(isPresented: $isEditingStudio12ProcessStep) {
            Group {
                if viewModel.studio12ProcessSteps.indices.contains(studio12ProcessStepEditIndex) {
                    EditStudio12ProcessStepSheet(
                        stepIndex: studio12ProcessStepEditIndex,
                        viewModel: viewModel,
                        onDismiss: { isEditingStudio12ProcessStep = false }
                    )
                }
            }
        }
    }

    private var contentUnavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No business connected")
                .font(.headline)
            Text("Sign up or link your business to customize your booking page.")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .padding()
    }

    private var activeTemplateDisplayName: String {
        WebTheme(rawValue: viewModel.webThemeId)?.displayName ?? "Classic"
    }

    private var activeTemplateFamily: TemplateFamily {
        WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
    }

    private var isClassicTemplate: Bool { activeTemplateFamily == .classic }
    private var isLuxeTemplate: Bool { activeTemplateFamily == .luxe }
    private var isBladeTemplate: Bool { activeTemplateFamily == .blade || activeTemplateFamily == .stonecut }
    private var isStudio12Template: Bool { activeTemplateFamily == .studio12 }

    private var studio12BookingTemplate: BookingTemplate {
        Studio12IndustryCopy.template(from: viewModel.industry)
    }

    private var visibleDesignTabs: [DesignTab] {
        DesignTab.allCases
    }

    /// Matches `defaultLuxeHeroTaglineForIndustry` in `web/index.html` for empty saved hero tagline.
    private var luxeHeroTaglinePlaceholder: String {
        let raw = viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let template = BookingTemplate(rawValue: raw) ?? .custom
        switch template {
        case .hair: return "Elevated hair, tailored to you."
        case .barber: return "Sharp cuts. Clean results. Every time."
        case .tattoos: return "Turn your idea into something permanent."
        case .nails: return "Clean, polished, and done right."
        case .custom: return "Designed to deliver better results."
        }
    }

    /// Matches `defaultLuxePromoHeadlineForIndustry` in `web/index.html`.
    private var luxePromoHeadlinePlaceholder: String {
        let raw = viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let template = BookingTemplate(rawValue: raw) ?? .custom
        switch template {
        case .hair: return "Ready for Your Next Look?"
        case .barber: return "Ready for Your Next Cut?"
        case .tattoos: return "Ready for Your Next Piece?"
        case .nails: return "Ready for Your Next Set?"
        case .custom: return "Ready to Book Your Next Appointment?"
        }
    }

    /// Matches `defaultBladeHeroTaglineForIndustry` in `web/index.html`.
    private var bladeHeroTaglinePlaceholder: String {
        let raw = viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let template = BookingTemplate(rawValue: raw) ?? .custom
        switch template {
        case .hair: return "Designed around you"
        case .barber: return "Defined by detail"
        case .tattoos: return "Designed to last"
        case .nails: return "Polished to perfection"
        case .custom: return "Focused on results"
        }
    }

    /// Matches `defaultBladeHeroDescriptionForIndustry` in `web/index.html`.
    private var bladeHeroDescriptionPlaceholder: String {
        let raw = viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let template = BookingTemplate(rawValue: raw) ?? .custom
        switch template {
        case .hair:
            return "From color to cut, every service is tailored to your look. We focus on results that feel natural, polished, and long-lasting."
        case .barber:
            return "Modern cuts, clean fades, and consistent results. Every appointment is focused on precision, from consultation to final detail."
        case .tattoos:
            return "Every piece starts with your vision. We focus on clean execution, strong design, and results you’ll carry with confidence."
        case .nails:
            return "Every set is crafted with care, delivering clean finishes and consistent results you can rely on."
        case .custom:
            return "Every service is delivered with attention to detail and a focus on consistent, high-quality results."
        }
    }

    private var templateContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Template")
                    .font(.title2.bold())
                Text("Choose a template first. Your business type then fills in that template with industry-specific defaults.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            ForEach(TemplateFamily.allCases) { family in
                TemplateFamilyCard(
                    family: family,
                    isActive: activeTemplateFamily == family,
                    isBusy: viewModel.isLoading
                ) {
                    let theme = WebTheme.theme(for: family, industry: viewModel.industry)
                    Task { await viewModel.applyWebTheme(theme) }
                }
            }

            Text("Pages on your site")
                .font(.headline)
                .padding(.top, 12)
            Text("Gallery, Book, About, and Shop each have an Enable … page toggle at the bottom of that tab. Add and edit products from Shop in the main menu.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Site template")
                    .font(.headline)
                Text("You’re using \(activeTemplateDisplayName). Switch designs anytime in the Template tab.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }

            if isStudio12Template {
                studio12HomeSections
            } else {
            // Hero
            Text("Hero")
                .font(.headline)
            TextField("Business name", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
            HeroImageUploadSection(viewModel: viewModel)

            if isBladeTemplate {
                Text("Blade hero")
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 4)
                Text("Italic line before your name and the short intro under it on Blade home. Leave blank to use industry defaults; the web can still fall back to your About story for the paragraph if this is empty.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                TextField(
                    "Hero tagline (italic)",
                    text: $viewModel.bladeHeroTagline,
                    prompt: Text(bladeHeroTaglinePlaceholder)
                )
                .textFieldStyle(.roundedBorder)
                TextField(
                    "Hero introduction",
                    text: $viewModel.bladeHeroDescription,
                    prompt: Text(bladeHeroDescriptionPlaceholder),
                    axis: .vertical
                )
                .lineLimit(4...10)
                .textFieldStyle(.roundedBorder)
                Text("The gold line above the hero uses city/area from the About tab when set. Phone, email, address, hours, and city/area are only on About—use Save changes there.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                BladeServicesHomeSection(
                    viewModel: viewModel,
                    serviceToEdit: $bladeServiceToEdit,
                    onRequestReplaceStarters: { showBladeStarterConfirm = true }
                )
            }

            if isLuxeTemplate {
                Text("Hero tagline")
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 4)
                Text("Shown under your name on the Luxe home hero only—not the same as booking or other pages.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                TextField(
                    "Line under your name",
                    text: $viewModel.luxeHeroTagline,
                    prompt: Text(luxeHeroTaglinePlaceholder),
                    axis: .vertical
                )
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
            }

            if isClassicTemplate || isLuxeTemplate {
                // Featured work (same order as Luxe web: hero → featured → promo → about)
                Text("Featured work")
                    .font(.headline)
                FeaturedWorkHomeGallerySection(
                    viewModel: viewModel,
                    showFeaturedWorkExplanation: isClassicTemplate
                )
            }

            if isLuxeTemplate {
                Toggle("Show featured strip on live site", isOn: $viewModel.luxeShowFeaturedWorkStrip)
                    .padding(.top, 8)
            }

            if isClassicTemplate || isLuxeTemplate {
                BladeServicesHomeSection(
                    viewModel: viewModel,
                    serviceToEdit: $bladeServiceToEdit,
                    onRequestReplaceStarters: { showBladeStarterConfirm = true },
                    cardSectionTitle: "What I offer",
                    cardCaption: isClassicTemplate
                        ? "Your Classic site lists these as a menu: title, optional duration, and description on the left; price on the right. Reorder with the arrows; tap Edit for name, duration, description, and price. Changes save immediately."
                        : "The first four services match your featured cards in order. Use Show featured strip (above) and Show services section (toggle below) on the live site. Reorder with the arrows; tap Edit for name, duration, description, and price. Changes save immediately.",
                    showOrderIndex: false,
                    luxeShowHomeServicesSection: isLuxeTemplate ? $viewModel.luxeShowHomeServicesSection : nil
                )
                .padding(.top, 8)
            }

            if isLuxeTemplate {
                Text("Promo headline")
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 8)
                Text("Large title in the cream Book Now section on Luxe home. The line below still uses your site tagline.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                TextField(
                    "Promo section headline",
                    text: $viewModel.luxePromoHeadline,
                    prompt: Text(luxePromoHeadlinePlaceholder)
                )
                .textFieldStyle(.roundedBorder)

                Text("About story and contact (Meet block, footer, /about) are edited on the About tab—Save changes there.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)
            }

            }

            Button("Save Home") {
                Task { await viewModel.saveHome() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    /// Studio 12 only: home fields editable here; marquee uses services automatically; gallery strip is edited on the Gallery tab.
    @ViewBuilder
    private var studio12HomeSections: some View {
        Group {
            Text("Studio 12 home")
                .font(.title3.weight(.bold))
            Text("Sections follow your live site. Use Save Home at the bottom.")
                .font(.caption)
                .foregroundColor(.secondary)

            Text("Hero")
                .font(.headline)
                .padding(.top, 4)
            TextField("Business name", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
            HeroImageUploadSection(viewModel: viewModel)

            Text("Hero headline")
                .font(.headline)
            Text("Eyebrow matches your business type when left blank. Enter the main headline and the italic ending on one line, separated by space · middle dot · space (e.g. Hair that reflects · story.). The site shows the first part on two lines, then the last part in italics.")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField("Eyebrow", text: $viewModel.studio12HeroEyebrow, prompt: Text(Studio12IndustryCopy.heroEyebrow(for: studio12BookingTemplate)))
                .textFieldStyle(.roundedBorder)
            TextField(
                "Headline · italic ending",
                text: Binding(
                    get: {
                        Studio12IndustryCopy.joinHeroTitleEditorLine(
                            headline: viewModel.studio12HeroHeadline,
                            italic: viewModel.heroTagline
                        )
                    },
                    set: {
                        let parts = Studio12IndustryCopy.splitHeroTitleEditorLine($0)
                        viewModel.studio12HeroHeadline = parts.headline
                        viewModel.heroTagline = parts.italic
                    }
                ),
                prompt: Text(Studio12IndustryCopy.heroTitleEditorPlaceholder(for: studio12BookingTemplate))
            )
            .textFieldStyle(.roundedBorder)

            Text("Intro under headline")
                .font(.headline)
            Text("Short paragraph under the hero title.")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(
                "Hero intro",
                text: $viewModel.tagline,
                prompt: Text(Studio12IndustryCopy.heroIntroPlaceholder(for: studio12BookingTemplate)),
                axis: .vertical
            )
            .lineLimit(2...6)
            .textFieldStyle(.roundedBorder)

            Text("Our approach")
                .font(.headline)
            Text("Section headline: three parts separated by space · middle dot · space (matches industry defaults when blank). Body: two paragraphs — blank line between for two columns.")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(
                "Headline (part 1 · part 2 · italic)",
                text: $viewModel.studio12PhilosophyHeadline,
                prompt: Text(Studio12IndustryCopy.philosophyHeadlinePlaceholder(for: studio12BookingTemplate))
            )
            .textFieldStyle(.roundedBorder)
            TextField("Philosophy / story", text: $viewModel.aboutText, axis: .vertical)
                .lineLimit(4...12)
                .textFieldStyle(.roundedBorder)

            Text("Philosophy image")
                .font(.headline)
            Text("Large image beside the philosophy copy.")
                .font(.caption)
                .foregroundColor(.secondary)
            Studio12AuxImageUploadSection(
                label: "Philosophy image",
                advice: UploadImageAdvice.studioAux,
                allowedCropChoices: [.portrait4_5],
                defaultCropChoice: .portrait4_5,
                imageUrl: $viewModel.studio12PhilosophyImageUrl,
                isUploading: viewModel.isUploadingStudio12Philosophy,
                upload: { data in await viewModel.uploadStudio12PhilosophyImage(imageData: data) }
            )

            Text("Services grid")
                .font(.headline)
            Toggle("Show “What we offer” on live site", isOn: $viewModel.studio12ShowServicesSection)
            Text("When off, that section is hidden on the home page; the hero’s second button goes to Book instead. Services isn’t a separate page—there is no Services item in the top bar.")
                .font(.caption)
                .foregroundColor(.secondary)
            BladeServicesHomeSection(
                viewModel: viewModel,
                serviceToEdit: $bladeServiceToEdit,
                onRequestReplaceStarters: { showBladeStarterConfirm = true },
                cardSectionTitle: "What we offer",
                cardCaption: "Cards in the “What we offer” section use list order, names, descriptions, and pricing. Use arrows to reorder; changes save to your booking page.",
                showOrderIndex: false
            )

            Text("Your experience")
                .font(.headline)
            Toggle("Show “How it works” on live site", isOn: $viewModel.studio12ShowProcessSection)
            Text("When off, the step-by-step block above the booking call-to-action is hidden on your site.")
                .font(.caption)
                .foregroundColor(.secondary)
            Studio12ProcessStepsHomeSection(
                viewModel: viewModel,
                onEditStep: { index in
                    studio12ProcessStepEditIndex = index
                    isEditingStudio12ProcessStep = true
                },
                onRequestReplaceDefaults: { showStudio12ProcessStartersConfirm = true }
            )

            Text("Booking call-to-action")
                .font(.headline)
            Text("Above testimonials. Headline: two parts separated by space · middle dot · space (industry defaults when blank).")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(
                "Headline (line before italic · italic)",
                text: $viewModel.studio12BookCtaHeadline,
                prompt: Text(Studio12IndustryCopy.bookCtaHeadlinePlaceholder(for: studio12BookingTemplate))
            )
            .textFieldStyle(.roundedBorder)
            TextField(
                "Supporting line",
                text: $viewModel.studio12BookCtaBody,
                prompt: Text(Studio12IndustryCopy.bookCtaBodyPlaceholder(for: studio12BookingTemplate)),
                axis: .vertical
            )
            .lineLimit(2...5)
            .textFieldStyle(.roundedBorder)
            Studio12AuxImageUploadSection(
                label: "CTA side image",
                advice: UploadImageAdvice.studioAux,
                allowedCropChoices: [.landscape4_3],
                defaultCropChoice: .landscape4_3,
                imageUrl: $viewModel.studio12BookCtaImageUrl,
                isUploading: viewModel.isUploadingStudio12BookCta,
                upload: { data in await viewModel.uploadStudio12BookCtaImage(imageData: data) }
            )

            Text("Client testimonials")
                .font(.headline)
            Text("If you add reviews to your business profile, they can appear below the booking section on the site. Hours, address, and phone are edited on the About tab.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var galleryContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Gallery")
                .font(.headline)
            Text(
                isBladeTemplate
                    ? "These photos power the Blade gallery strip and full /gallery page."
                    : isStudio12Template
                        ? "Studio 12 uses these on your home page horizontal gallery and on /gallery."
                        : "These photos appear on your /gallery page."
            )
                .font(.caption)
                .foregroundColor(.secondary)

            GalleryImagesSection(viewModel: viewModel, isStudio12Site: isStudio12Template)

            Text("Full-page gallery layout")
                .font(.subheadline.weight(.semibold))
            Text("Choose how `/gallery` looks. This is separate from your site template (Classic, Luxe, Blade, Stonecut, or Studio 12).")
                .font(.caption)
                .foregroundColor(.secondary)
            Picker("Full-page gallery layout", selection: $viewModel.galleryLayoutStyle) {
                ForEach(GalleryLayoutStyle.allCases) { style in
                    Text(style.menuTitle).tag(style)
                }
            }
            .pickerStyle(.menu)
            .disabled(!viewModel.hasTenant || viewModel.isLoading)
            .onChange(of: viewModel.galleryLayoutStyle) { _, _ in
                Task { await viewModel.saveGalleryLayoutStyle() }
            }
            Text(viewModel.galleryLayoutStyle.detail)
                .font(.caption)
                .foregroundColor(.secondary)

            Text("Tip: Upload your best healed work here.")
                .font(.caption)
                .foregroundColor(.secondary)

            if isStudio12Template {
                Text("Studio 12 lays images out in a wide scrolling row on the home page.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)
            } else if !isClassicTemplate {
                Text("Gallery styling is built into the selected template. Manage images here.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)
            }

            Divider()
            Toggle("Enable Gallery page", isOn: $viewModel.showGalleryPage)
                .disabled(!viewModel.hasTenant || viewModel.isLoading)
                .onChange(of: viewModel.showGalleryPage) { _, _ in
                    Task { await viewModel.savePublicPageVisibility() }
                }
            Text("When off, /gallery and gallery links are hidden on your public site.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var bookContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Booking form style")
                .font(.headline)
            Text("Layout for your /book page. Colors follow your site theme (Template tab).")
                .font(.caption)
                .foregroundColor(.secondary)
            if authViewModel.teamAccess.canManageBookingFormStyle {
                Picker("Booking form style", selection: $viewModel.bookingFormStyleId) {
                    ForEach(BookingFormStyle.allCases) { style in
                        Text(style.displayName).tag(style.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(!viewModel.hasTenant || viewModel.isLoading)
                .onChange(of: viewModel.bookingFormStyleId) { _, _ in
                    Task { await viewModel.saveBookingFormStyle() }
                }
                if let style = BookingFormStyle(rawValue: viewModel.bookingFormStyleId) {
                    Text(style.subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            } else {
                HStack {
                    Text(BookingFormStyle.resolved(stored: viewModel.bookingFormStyleId).displayName)
                        .font(.subheadline.weight(.medium))
                    Spacer()
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
                Text("Only the owner or a manager with “Manage booking form style” can change Standard vs Guided.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            Text("Services")
                .font(.headline)
            if authViewModel.teamAccess.canEditServicesPricing {
                ForEach(viewModel.services) { service in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(service.name)
                                .font(.subheadline.weight(.medium))
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { await viewModel.deleteService(service) }
                        } label: {
                            Image(systemName: "trash")
                        }
                    }
                    .padding()
                    .background(Color(.secondarySystemGroupedBackground))
                    .cornerRadius(8)
                }
                AddServiceSheet(viewModel: viewModel)
            } else {
                ForEach(viewModel.services) { service in
                    Text(service.name)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(Color(.secondarySystemGroupedBackground))
                        .cornerRadius(8)
                }
                Text("You don’t have permission to edit services. Ask the owner or enable “Edit services & pricing” for managers.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if viewModel.services.isEmpty {
                Text("Add your first service so clients can book.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Divider()

            Text("Booking form fields")
                .font(.headline)
            ForEach(viewModel.formFields) { field in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(field.label)
                            .font(.subheadline.weight(.medium))
                        Text("\(field.type.displayName) • \(field.required ? "Required" : "Optional")")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        viewModel.removeFormField(field)
                    } label: {
                        Image(systemName: "trash")
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
            }
            Button(action: { viewModel.addFormField() }) {
                HStack {
                    Image(systemName: "plus")
                    Text("Add field")
                }
            }

            HStack(spacing: 12) {
                Button("Save form") {
                    Task { await viewModel.saveFormFields() }
                }
                .buttonStyle(.borderedProminent)
            }

            Divider()
            Toggle("Enable Book page", isOn: $viewModel.showBookPage)
                .disabled(!viewModel.hasTenant || viewModel.isLoading)
                .onChange(of: viewModel.showBookPage) { _, _ in
                    Task { await viewModel.savePublicPageVisibility() }
                }
            Text("When off, /book and booking links are hidden on your public site.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    @ViewBuilder
    private func contactFieldsSection() -> some View {
        VStack(spacing: 12) {
            IconFieldRow(icon: "phone", placeholder: "(555) 123-4567", text: Binding(
                get: { viewModel.contactPhone },
                set: { viewModel.contactPhone = PhoneFormatting.formatAsYouType($0) }
            ))
            .keyboardType(.phonePad)

            IconFieldRow(icon: "envelope", placeholder: "example@example.com", text: $viewModel.contactEmail)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)

            IconFieldRow(icon: "mappin.circle", placeholder: "Street address", text: $viewModel.contactAddress)

            ServiceAreaCityStateFields(viewModel: viewModel)

            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "clock")
                        .foregroundColor(.secondary)
                        .frame(width: 24)
                    Text("Hours")
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 0)
                }
                Text("Tap a day to set hours (including split shifts). Your site shows a short summary.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ForEach(0..<7, id: \.self) { dayIndex in
                    Button {
                        businessHoursDaySheet = BusinessHoursDaySheetToken(dayIndex: dayIndex)
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            Text(BusinessHoursWeekly.dayLabels[dayIndex])
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.primary)
                                .frame(width: 40, alignment: .leading)
                            Spacer(minLength: 8)
                            Text(
                                viewModel.businessHoursWeekly.days[dayIndex].summaryFormatted {
                                    BusinessHoursWeekly.formatTime(minutes: $0)
                                }
                            )
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.trailing)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(.secondary)
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                }

                Divider()
                    .padding(.vertical, 4)

                Text("Special dates")
                    .font(.subheadline.weight(.semibold))
                Text("Holidays or one-off hours. Listed after your weekly hours on the site.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                if viewModel.businessHoursExceptions.isEmpty {
                    Text("None yet")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                } else {
                    ForEach(viewModel.businessHoursExceptions) { ex in
                        HStack(alignment: .center, spacing: 8) {
                            Button {
                                businessHoursExceptionSheet = ex
                            } label: {
                                HStack {
                                    Text(ex.formattedDisplayLine())
                                        .font(.subheadline)
                                        .foregroundColor(.primary)
                                        .multilineTextAlignment(.leading)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundColor(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                            Button(role: .destructive) {
                                viewModel.removeBusinessHoursException(id: ex.id)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.body)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Delete special date")
                        }
                        .padding(.vertical, 4)
                    }
                }

                Button {
                    businessHoursExceptionSheet = .newDefault()
                } label: {
                    Label("Add special date", systemImage: "plus.circle")
                        .font(.subheadline)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)
            .sheet(item: $businessHoursDaySheet) { token in
                BusinessHoursDayEditSheet(dayIndex: token.dayIndex, viewModel: viewModel)
            }
            .sheet(item: $businessHoursExceptionSheet) { ex in
                BusinessHoursExceptionEditSheet(exception: ex, viewModel: viewModel)
            }

            Toggle(isOn: $viewModel.showBusinessHoursOnPage) {
                HStack(spacing: 10) {
                    Image(systemName: "clock.badge.checkmark")
                        .foregroundColor(.secondary)
                        .frame(width: 24)
                    Text("Show hours on site")
                        .font(.subheadline)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)

            IconFieldRow(icon: "camera", placeholder: "@yourstudio", text: $viewModel.instagramHandle)
                .textInputAutocapitalization(.never)

            Toggle(isOn: $viewModel.showContactOnPage) {
                HStack(spacing: 10) {
                    Image(systemName: "eye")
                        .foregroundColor(.secondary)
                        .frame(width: 24)
                    Text("Show contact on page")
                        .font(.subheadline)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)
        }
    }

    private var aboutContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("ABOUT")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .tracking(1)
            Group {
                if isClassicTemplate {
                    Text("This appears in the Meet section on your site.")
                } else if isLuxeTemplate {
                    Text("Story and contact appear on your About page and on Luxe home (Meet section and footer).")
                } else if isBladeTemplate {
                    Text("Story appears on About. Contact, hours, city & state (below), and street address power your Blade or Stonecut live site.")
                } else if isStudio12Template {
                    Text("This appears on your About page and feeds the Our approach section on Studio 12 home.")
                } else {
                    Text("This appears in the About section on your site.")
                }
            }
            .font(.caption)
            .foregroundColor(.secondary)
            TextField("Tell clients about you and your business", text: $viewModel.aboutText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...8)

            if isClassicTemplate {
                Divider()
                    .padding(.top, 4)
                Text("ABOUT STATS")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                    .tracking(1)
                Text("The three headline figures under your story on the dark About section (Classic home and /about).")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Toggle("Show stats row on live site", isOn: $viewModel.classicShowAboutStats)
                Text("When off, that row is hidden; your story and contact lines stay.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Group {
                    Text("First stat")
                        .font(.caption.weight(.medium))
                    TextField("Value (e.g. 8+)", text: $viewModel.classicStatYearsValue)
                        .textFieldStyle(.roundedBorder)
                    TextField("Caption (e.g. Years exp.)", text: $viewModel.classicStatYearsLabel)
                        .textFieldStyle(.roundedBorder)
                    Text("Second stat")
                        .font(.caption.weight(.medium))
                        .padding(.top, 6)
                    TextField("Value (e.g. 500+)", text: $viewModel.classicStatClientsValue)
                        .textFieldStyle(.roundedBorder)
                    TextField("Caption (e.g. Clients)", text: $viewModel.classicStatClientsLabel)
                        .textFieldStyle(.roundedBorder)
                    Text("Third stat")
                        .font(.caption.weight(.medium))
                        .padding(.top, 6)
                    TextField("Value (e.g. 5★)", text: $viewModel.classicStatRatedValue)
                        .textFieldStyle(.roundedBorder)
                    TextField("Caption (e.g. Rated)", text: $viewModel.classicStatRatedLabel)
                        .textFieldStyle(.roundedBorder)
                }
            }

            Text("CONTACT")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .tracking(1)
                .padding(.top, 8)

            contactFieldsSection()

            HStack(spacing: 12) {
                Button("Discard") {
                    Task { await viewModel.loadData() }
                }
                .buttonStyle(.bordered)
                Button("Save changes") {
                    Task { await viewModel.saveAbout() }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.top, 4)

            Divider()
            Toggle("Enable About page (/about)", isOn: $viewModel.showAboutPage)
                .disabled(!viewModel.hasTenant || viewModel.isLoading)
                .onChange(of: viewModel.showAboutPage) { _, _ in
                    Task { await viewModel.savePublicPageVisibility() }
                }
            Text("When off, /about and About links are hidden on your public site.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var shopContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Shop")
                .font(.headline)
            Text("When the shop page is on, /shop and shop links appear on your public site. Add and edit products from Shop in the main menu.")
                .font(.caption)
                .foregroundColor(.secondary)

            Divider()
            Toggle("Enable Shop page", isOn: $viewModel.shopEnabled)
                .disabled(!viewModel.hasTenant || viewModel.isLoading)
                .onChange(of: viewModel.shopEnabled) { _, _ in
                    Task { await viewModel.savePublicPageVisibility() }
                }
            Text("When off, /shop and shop links are hidden. You can also turn this on or off under Shop in the menu.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var formContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Form fields")
                .font(.headline)
            ForEach(viewModel.formFields) { field in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(field.label)
                            .font(.subheadline.weight(.medium))
                        Text("\(field.type.displayName) • \(field.required ? "Required" : "Optional")")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        viewModel.removeFormField(field)
                    } label: {
                        Image(systemName: "trash")
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
            }
            Button(action: { viewModel.addFormField() }) {
                HStack {
                    Image(systemName: "plus")
                    Text("Add field")
                }
            }
            Button("Save form") {
                Task { await viewModel.saveFormFields() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var servicesContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Services")
                .font(.headline)
            ForEach(viewModel.services) { service in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(service.name)
                            .font(.subheadline.weight(.medium))
                    }
                    Spacer()
                    Button(role: .destructive) {
                        Task { await viewModel.deleteService(service) }
                    } label: {
                        Image(systemName: "trash")
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
            }
            AddServiceSheet(viewModel: viewModel)
            if viewModel.services.isEmpty {
                Text("Add your first service so clients can book.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var contactContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Group {
                Text("Phone")
                TextField("(555) 123-4567", text: $viewModel.contactPhone)
                    .textFieldStyle(.roundedBorder)
                Text("Email")
                TextField("hello@business.com", text: $viewModel.contactEmail)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                Text("Address")
                TextField("123 Main St", text: $viewModel.contactAddress)
                    .textFieldStyle(.roundedBorder)
                ServiceAreaCityStateFields(viewModel: viewModel)
                Toggle("Show contact on page", isOn: $viewModel.showContactOnPage)
            }
            Button("Save contact") {
                Task { await viewModel.saveContact() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func openInSafari() {
        guard let url = URL(string: viewModel.bookingUrl) else { return }
        UIApplication.shared.open(url)
    }

}

// MARK: - City & state (serviceArea)

struct ServiceAreaCityStateFields: View {
    @ObservedObject var viewModel: DesignViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            IconFieldRow(
                icon: "mappin.circle",
                placeholder: "City",
                text: $viewModel.serviceCity,
                textInputAutocapitalization: .words
            )
            HStack(spacing: 10) {
                Image(systemName: "map")
                    .foregroundColor(.secondary)
                    .frame(width: 24)
                Picker("State", selection: $viewModel.serviceStateAbbr) {
                    Text("State").tag("")
                    ForEach(USStateServiceAreaFormatting.statesSortedByName) { row in
                        Text(row.name).tag(row.abbr)
                    }
                }
                .pickerStyle(.menu)
                .tint(.primary)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)
            Text("Short city and state for your public site (Classic, Luxe, Blade, Stonecut, or Studio 12). Use the field above for street address.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

// MARK: - Hero image upload
struct HeroImageUploadSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItem: PhotosPickerItem?
    @State private var cropSheetItem: SingleImageCropSheetItem?

    private var heroTemplateFamily: TemplateFamily {
        WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
    }

    private var isLuxeTemplate: Bool { heroTemplateFamily == .luxe }
    private var isStudio12Template: Bool { heroTemplateFamily == .studio12 }

    /// Hero image frame is fixed per template; the crop sheet locks to this single aspect.
    /// Classic / Luxe / Blade / Stonecut → 16:9. Studio 12 → 4:5 portrait.
    private var heroLockedCropChoice: UploadCropAspectChoice {
        isStudio12Template ? .portrait4_5 : .landscape16_9
    }

    private var heroCropChoices: [UploadCropAspectChoice] { [heroLockedCropChoice] }

    private var heroDefaultCropChoice: UploadCropAspectChoice { heroLockedCropChoice }

    private var heroAdvice: String {
        isLuxeTemplate ? UploadImageAdvice.heroLuxe : UploadImageAdvice.hero
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hero background image")
                .font(.subheadline.weight(.medium))
            Text(heroAdvice)
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(spacing: 16) {
                if let urlString = viewModel.heroImageUrl.isEmpty ? nil : viewModel.heroImageUrl,
                   let url = URL(string: urlString) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Color.gray.opacity(0.2)
                    }
                    .frame(width: 80, height: 56)
                    .clipped()
                    .cornerRadius(8)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 80, height: 56)
                        .overlay(Image(systemName: "photo").foregroundColor(.gray))
                }
                VStack(alignment: .leading, spacing: 8) {
                    PhotosPicker(
                        selection: $selectedItem,
                        matching: .images,
                        photoLibrary: .shared()
                    ) {
                        HStack {
                            Image(systemName: "photo.badge.plus")
                            Text(viewModel.heroImageUrl.isEmpty ? "Choose image" : "Change image")
                        }
                        .font(.subheadline)
                    }
                    .onChange(of: selectedItem) { _, newItem in
                        Task {
                            guard let newItem else {
                                return
                            }
                            if let data = try? await newItem.loadTransferable(type: Data.self),
                               !data.isEmpty,
                               let uiImage = UIImage(data: data) {
                                await MainActor.run {
                                    cropSheetItem = SingleImageCropSheetItem(image: uiImage)
                                    selectedItem = nil
                                }
                            } else {
                                await MainActor.run { selectedItem = nil }
                            }
                        }
                    }
                    if viewModel.isUploadingHero {
                        ProgressView()
                            .scaleEffect(0.8)
                    }
                }
                Spacer()
            }
        }
        .sheet(item: $cropSheetItem, onDismiss: { cropSheetItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: heroAdvice,
                navigationTitle: "Hero image",
                allowedChoices: heroCropChoices,
                defaultChoice: heroDefaultCropChoice,
                onUseJPEGData: { dataList in
                    guard let data = dataList.first else { return }
                    cropSheetItem = nil
                    Task { await viewModel.uploadHeroImage(imageData: data) }
                }
            )
        }
    }
}

// MARK: - Studio 12 auxiliary images (philosophy column, book CTA column)
struct Studio12AuxImageUploadSection: View {
    let label: String
    let advice: String
    let allowedCropChoices: [UploadCropAspectChoice]
    let defaultCropChoice: UploadCropAspectChoice
    @Binding var imageUrl: String
    let isUploading: Bool
    let upload: (Data) async -> Void
    @State private var selectedItem: PhotosPickerItem?
    @State private var cropSheetItem: SingleImageCropSheetItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(label)
                .font(.subheadline.weight(.medium))
            Text(advice)
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(spacing: 16) {
                if let urlString = imageUrl.isEmpty ? nil : imageUrl, let url = URL(string: urlString) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Color.gray.opacity(0.2)
                    }
                    .frame(width: 80, height: 56)
                    .clipped()
                    .cornerRadius(8)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 80, height: 56)
                        .overlay(Image(systemName: "photo").foregroundColor(.gray))
                }
                VStack(alignment: .leading, spacing: 8) {
                    PhotosPicker(
                        selection: $selectedItem,
                        matching: .images,
                        photoLibrary: .shared()
                    ) {
                        HStack {
                            Image(systemName: "photo.badge.plus")
                            Text(imageUrl.isEmpty ? "Choose image" : "Change image")
                        }
                        .font(.subheadline)
                    }
                    .onChange(of: selectedItem) { _, newItem in
                        Task {
                            guard let newItem else { return }
                            if let data = try? await newItem.loadTransferable(type: Data.self),
                               !data.isEmpty,
                               let uiImage = UIImage(data: data) {
                                await MainActor.run {
                                    cropSheetItem = SingleImageCropSheetItem(image: uiImage)
                                    selectedItem = nil
                                }
                            } else {
                                await MainActor.run { selectedItem = nil }
                            }
                        }
                    }
                    if isUploading {
                        ProgressView()
                            .scaleEffect(0.8)
                    }
                }
                Spacer()
            }
        }
        .sheet(item: $cropSheetItem, onDismiss: { cropSheetItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: advice,
                navigationTitle: label,
                allowedChoices: allowedCropChoices,
                defaultChoice: defaultCropChoice,
                onUseJPEGData: { dataList in
                    guard let data = dataList.first else { return }
                    cropSheetItem = nil
                    Task { await upload(data) }
                }
            )
        }
    }
}

// MARK: - Gallery page images only
struct GalleryImagesSection: View {
    @ObservedObject var viewModel: DesignViewModel
    /// When the live site template is Studio 12, gallery presets and copy match the home strip + /gallery tiles.
    var isStudio12Site: Bool = false
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var galleryBatchCrop: MultiImageCropSheetItem?

    /// Wraps thumbnails in rows; parent `ScrollView` handles vertical scrolling.
    private let thumbGridColumns = [GridItem(.adaptive(minimum: 72), spacing: 12)]

    private var galleryAdvice: String {
        isStudio12Site ? UploadImageAdvice.galleryStudio12 : UploadImageAdvice.gallery
    }

    /// Gallery cells are a fixed shape per layout style; the crop sheet locks to that shape.
    /// Classic grid → 4:3 (matches `.gallery-grid img` cell). Horizontal strip → 4:5 (matches strip cell).
    /// Masonry keeps the native aspect (no crop) so the column layout reads like Pinterest.
    private var galleryLockedCropChoice: UploadCropAspectChoice {
        switch viewModel.galleryLayoutStyle {
        case .masonry: return .original
        case .horizontalStrip: return .portrait4_5
        case .classicGrid: return isStudio12Site ? .portrait4_5 : .landscape4_3
        }
    }

    private var galleryAllowedCropChoices: [UploadCropAspectChoice] { [galleryLockedCropChoice] }

    private var galleryDefaultCropChoice: UploadCropAspectChoice { galleryLockedCropChoice }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gallery page photos")
                .font(.subheadline.weight(.medium))
            Text(galleryAdvice)
                .font(.caption)
                .foregroundColor(.secondary)
            LazyVGrid(columns: thumbGridColumns, alignment: .leading, spacing: 12) {
                ForEach(Array(viewModel.galleryImages.enumerated()), id: \.offset) { index, urlString in
                    if let url = URL(string: urlString) {
                        ZStack(alignment: .topTrailing) {
                            AsyncImage(url: url) { image in
                                image.resizable().aspectRatio(contentMode: .fill)
                            } placeholder: {
                                Color.gray.opacity(0.2)
                            }
                            .frame(width: 72, height: 72)
                            .clipped()
                            .cornerRadius(8)
                            Button(action: {
                                Task { await viewModel.removeGalleryImage(at: index) }
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .foregroundStyle(.white, .red)
                            }
                            .offset(x: 4, y: -4)
                        }
                    }
                }
                PhotosPicker(
                    selection: $selectedItems,
                    matching: .images,
                    photoLibrary: .shared()
                ) {
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                        .frame(width: 72, height: 72)
                        .overlay(
                            Image(systemName: "plus")
                                .font(.title2)
                                .foregroundColor(.secondary)
                        )
                }
                .onChange(of: selectedItems) { _, newItems in
                    Task {
                        let itemsToUpload = newItems
                        guard !itemsToUpload.isEmpty else { return }

                        let indexedPairs: [(Int, Data)] = await withTaskGroup(of: (Int, Data?).self, returning: [(Int, Data)].self) { group in
                            for (i, item) in itemsToUpload.enumerated() {
                                group.addTask {
                                    guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty else {
                                        return (i, nil)
                                    }
                                    return (i, data)
                                }
                            }
                            var collected: [(Int, Data)] = []
                            for await (i, opt) in group {
                                if let d = opt { collected.append((i, d)) }
                            }
                            return collected.sorted { $0.0 < $1.0 }
                        }
                        let orderedData = indexedPairs.map { $0.1 }
                        let images: [UIImage] = orderedData.compactMap { UIImage(data: $0) }
                        await MainActor.run {
                            selectedItems.removeAll()
                            if images.isEmpty {
                                return
                            }
                            galleryBatchCrop = MultiImageCropSheetItem(images: images)
                        }
                    }
                }
            }
            if viewModel.isUploadingGallery {
                HStack {
                    ProgressView()
                    Text("Uploading…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
        .sheet(item: $galleryBatchCrop, onDismiss: { galleryBatchCrop = nil }) { batch in
            UploadImagePreparationSheet(
                images: batch.images,
                advice: galleryAdvice,
                navigationTitle: "Gallery photos",
                allowedChoices: galleryAllowedCropChoices,
                defaultChoice: galleryDefaultCropChoice,
                onUseJPEGData: { dataList in
                    galleryBatchCrop = nil
                    guard !dataList.isEmpty else { return }
                    Task { await viewModel.addGalleryImages(imageDataList: dataList) }
                }
            )
        }
    }
}

// MARK: - Featured work on Home tab (separate from gallery page photos)
struct FeaturedWorkHomeGallerySection: View {
    @ObservedObject var viewModel: DesignViewModel
    /// Classic shows slot/gallery explainer; Luxe omits redundant copy.
    var showFeaturedWorkExplanation: Bool = true
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var featuredBatchCrop: MultiImageCropSheetItem?

    private let thumbGridColumns = [GridItem(.adaptive(minimum: 72), spacing: 12)]

    private var slots: Int { viewModel.featuredWorkImageSlotCount }

    private var layoutCaptionLabel: String {
        switch viewModel.galleryGridLayout {
        case "2x1": return "2 wide"
        case "3x1": return "3 wide"
        default: return viewModel.galleryGridLayout
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showFeaturedWorkExplanation {
                Text("Featured work photos")
                    .font(.subheadline.weight(.medium))
                Text("These appear only on your home featured strip (first \(slots) slots for \(layoutCaptionLabel)). Add your full portfolio under the Gallery tab—they won’t show here.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Text(UploadImageAdvice.featured)
                .font(.caption)
                .foregroundColor(.secondary)

            Text("Featured on home")
                .font(.caption.weight(.semibold))

            LazyVGrid(columns: thumbGridColumns, alignment: .leading, spacing: 12) {
                ForEach(Array(viewModel.featuredWorkImages.enumerated()), id: \.offset) { index, urlString in
                    galleryThumbnail(urlString: urlString, removeAt: index)
                }
                ForEach(0..<max(0, slots - viewModel.featuredWorkImages.count), id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                        .frame(width: 72, height: 72)
                        .foregroundColor(.secondary.opacity(0.35))
                }
                addPhotosPickerCell
            }

            if viewModel.featuredWorkImages.count > slots {
                Text("\(viewModel.featuredWorkImages.count - slots) extra in list (wider layout would show more).")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if viewModel.isUploadingFeaturedWork {
                HStack {
                    ProgressView()
                    Text("Uploading…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
        .sheet(item: $featuredBatchCrop, onDismiss: { featuredBatchCrop = nil }) { batch in
            UploadImagePreparationSheet(
                images: batch.images,
                advice: UploadImageAdvice.featured,
                navigationTitle: "Featured photos",
                allowedChoices: [.portrait4_5],
                defaultChoice: .portrait4_5,
                onUseJPEGData: { dataList in
                    featuredBatchCrop = nil
                    guard !dataList.isEmpty else { return }
                    Task { await viewModel.addFeaturedWorkImages(imageDataList: dataList) }
                }
            )
        }
    }

    @ViewBuilder
    private func galleryThumbnail(urlString: String, removeAt index: Int) -> some View {
        if let url = URL(string: urlString) {
            ZStack(alignment: .topTrailing) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Color.gray.opacity(0.2)
                }
                .frame(width: 72, height: 72)
                .clipped()
                .cornerRadius(8)
                Button(action: {
                    Task { await viewModel.removeFeaturedWorkImage(at: index) }
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.white, .red)
                }
                .offset(x: 4, y: -4)
            }
        }
    }

    private var addPhotosPickerCell: some View {
        PhotosPicker(
            selection: $selectedItems,
            matching: .images,
            photoLibrary: .shared()
        ) {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                .frame(width: 72, height: 72)
                .overlay(
                    Image(systemName: "plus")
                        .font(.title2)
                        .foregroundColor(.secondary)
                )
        }
        .onChange(of: selectedItems) { _, newItems in
            Task {
                let itemsToUpload = newItems
                guard !itemsToUpload.isEmpty else { return }
                let indexedPairs: [(Int, Data)] = await withTaskGroup(of: (Int, Data?).self, returning: [(Int, Data)].self) { group in
                    for (i, item) in itemsToUpload.enumerated() {
                        group.addTask {
                            guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty else {
                                return (i, nil)
                            }
                            return (i, data)
                        }
                    }
                    var collected: [(Int, Data)] = []
                    for await (i, opt) in group {
                        if let d = opt { collected.append((i, d)) }
                    }
                    return collected.sorted { $0.0 < $1.0 }
                }
                let orderedData = indexedPairs.map { $0.1 }
                let images: [UIImage] = orderedData.compactMap { UIImage(data: $0) }
                await MainActor.run {
                    selectedItems.removeAll()
                    if images.isEmpty {
                        return
                    }
                    featuredBatchCrop = MultiImageCropSheetItem(images: images)
                }
            }
        }
    }
}

// MARK: - Color row with picker
struct HexColorRow: View {
    let label: String
    @Binding var hex: String

    private var colorBinding: Binding<Color> {
        Binding(
            get: { Color(hex: hex) },
            set: { hex = $0.toHex() }
        )
    }

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
            Spacer()
            ColorPicker("", selection: colorBinding)
                .labelsHidden()
        }
    }
}

struct AddServiceSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    var disabled: Bool = false
    @State private var name = ""
    @State private var includeDuration = false
    @State private var duration = 30
    @State private var descriptionText = ""
    @State private var showStartingPrice = false
    @State private var priceText = ""
    @State private var showingSheet = false

    var body: some View {
        Button(action: { showingSheet = true }) {
            HStack {
                Image(systemName: "plus")
                Text("Add service")
            }
        }
        .disabled(disabled)
        .sheet(isPresented: $showingSheet) {
            NavigationStack {
                Form {
                    TextField("Service name", text: $name)
                    TextField("Description (optional, Blade card)", text: $descriptionText, axis: .vertical)
                        .lineLimit(2...6)
                    Toggle("Include duration", isOn: $includeDuration)
                    if includeDuration {
                        Stepper("Duration: \(duration) min", value: $duration, in: 15...240, step: 15)
                    }
                    Toggle("Show starting price", isOn: $showStartingPrice)
                    if showStartingPrice {
                        TextField("Amount (USD)", text: $priceText)
                            .keyboardType(.decimalPad)
                    } else {
                        Text("Your site shows “Book for pricing” when this is off.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .navigationTitle("New service")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showingSheet = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") {
                            let desc = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
                            let price = Self.parseStartingPriceHelper(enabled: showStartingPrice, text: priceText)
                            Task {
                                await viewModel.addService(
                                    name: name,
                                    durationMinutes: includeDuration ? duration : nil,
                                    description: desc.isEmpty ? nil : desc,
                                    startingPrice: price
                                )
                                name = ""
                                includeDuration = false
                                duration = 30
                                descriptionText = ""
                                showStartingPrice = false
                                priceText = ""
                                showingSheet = false
                            }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    fileprivate static func parseStartingPriceHelper(enabled: Bool, text: String) -> Double? {
        guard enabled else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        guard let v = Double(t), v > 0 else { return nil }
        return v
    }
}

private struct BladeServicesHomeSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @Binding var serviceToEdit: TenantService?
    let onRequestReplaceStarters: () -> Void
    var cardSectionTitle: String = "Blade services"
    var cardCaption: String = "Cards under OUR SERVICES use this order (01, 02…), names, descriptions, and pricing. Use arrows to reorder; changes save to your booking page."
    /// When false (Studio 12 “What we offer”), row index labels are hidden.
    var showOrderIndex: Bool = true
    /// Luxe only: optional home menu under featured cards (`luxeShowHomeServicesSection` in Firestore).
    var luxeShowHomeServicesSection: Binding<Bool>? = nil

    private var controlsDisabled: Bool {
        viewModel.isApplyingBladeStarters || viewModel.isSavingBladeServices || viewModel.isLoading || !viewModel.hasTenant
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !cardSectionTitle.isEmpty {
                Text(cardSectionTitle)
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 12)
            }
            Text(cardCaption)
                .font(.caption)
                .foregroundColor(.secondary)
            if let luxeHomeSvcToggle = luxeShowHomeServicesSection {
                Toggle("Show services section on live site", isOn: luxeHomeSvcToggle)
                    .padding(.top, 4)
            }
            if viewModel.services.isEmpty {
                Text("No services yet—add one or replace with industry starters.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            ForEach(Array(viewModel.services.enumerated()), id: \.element.id) { index, service in
                HStack(alignment: .top, spacing: 10) {
                    if showOrderIndex {
                        Text(String(format: "%02d", index + 1))
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundColor(.secondary)
                            .frame(width: 28, alignment: .leading)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(service.name)
                            .font(.subheadline.weight(.medium))
                        Text(service.bladePriceCaption)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        if let d = service.description, !d.isEmpty {
                            Text(d)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    VStack(spacing: 2) {
                        Button {
                            Task { await viewModel.moveService(from: index, direction: -1) }
                        } label: {
                            Image(systemName: "chevron.up")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(controlsDisabled || index == 0)
                        Button {
                            Task { await viewModel.moveService(from: index, direction: 1) }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(controlsDisabled || index >= viewModel.services.count - 1)
                    }
                    .buttonStyle(.borderless)
                    Button("Edit") {
                        serviceToEdit = service
                    }
                    .font(.caption.weight(.semibold))
                    .disabled(controlsDisabled)
                    Button(role: .destructive) {
                        Task { await viewModel.deleteService(service) }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(controlsDisabled)
                }
                .padding(10)
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
            }
            AddServiceSheet(viewModel: viewModel, disabled: controlsDisabled)
            Button {
                onRequestReplaceStarters()
            } label: {
                Text("Replace with industry starter services")
            }
            .buttonStyle(.bordered)
            .disabled(controlsDisabled)
        }
    }
}

private struct Studio12ProcessStepsHomeSection: View {
    @ObservedObject var viewModel: DesignViewModel
    let onEditStep: (Int) -> Void
    let onRequestReplaceDefaults: () -> Void

    private var controlsDisabled: Bool {
        viewModel.isLoading || !viewModel.hasTenant
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("How it works (steps)")
                .font(.subheadline.weight(.medium))
                .padding(.top, 4)
            Text("Shown above the booking call-to-action. Use arrows to reorder, Edit for title and description, or add and remove steps (up to \(DesignViewModel.studio12ProcessStepsLimit)). Tap Save Home to publish.")
                .font(.caption)
                .foregroundColor(.secondary)
            if viewModel.studio12ProcessSteps.isEmpty {
                Text("No steps—tap Replace to load industry defaults.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            ForEach(Array(viewModel.studio12ProcessSteps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.title.isEmpty ? "Untitled step" : step.title)
                            .font(.subheadline.weight(.medium))
                        if !step.body.isEmpty {
                            Text(step.body)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(3)
                        } else {
                            Text("No description")
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    VStack(spacing: 2) {
                        Button {
                            viewModel.moveStudio12ProcessStep(from: index, direction: -1)
                        } label: {
                            Image(systemName: "chevron.up")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(controlsDisabled || index == 0)
                        Button {
                            viewModel.moveStudio12ProcessStep(from: index, direction: 1)
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.caption.weight(.semibold))
                        }
                        .disabled(controlsDisabled || index >= viewModel.studio12ProcessSteps.count - 1)
                    }
                    .buttonStyle(.borderless)
                    Button("Edit") {
                        onEditStep(index)
                    }
                    .font(.caption.weight(.semibold))
                    .disabled(controlsDisabled)
                    Button(role: .destructive) {
                        viewModel.deleteStudio12ProcessStep(at: index)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(controlsDisabled)
                }
                .padding(10)
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(8)
            }
            Button {
                viewModel.addStudio12ProcessStep()
            } label: {
                HStack {
                    Image(systemName: "plus")
                    Text("Add step")
                }
            }
            .disabled(controlsDisabled || viewModel.studio12ProcessSteps.count >= DesignViewModel.studio12ProcessStepsLimit)
            Button(action: onRequestReplaceDefaults) {
                Text("Replace with industry default steps")
            }
            .buttonStyle(.bordered)
            .disabled(controlsDisabled)
        }
    }
}

private struct EditStudio12ProcessStepSheet: View {
    let stepIndex: Int
    @ObservedObject var viewModel: DesignViewModel
    let onDismiss: () -> Void
    @State private var titleText = ""
    @State private var bodyText = ""

    private var placeholderPair: (String, String) {
        let base = Studio12IndustryCopy.processSteps(for: Studio12IndustryCopy.template(from: viewModel.industry))
        guard stepIndex >= 0, stepIndex < base.count else {
            return ("Step title", "Description for guests")
        }
        let s = base[stepIndex]
        return (s.title, s.body)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $titleText, prompt: Text(placeholderPair.0))
                TextField("Description", text: $bodyText, prompt: Text(placeholderPair.1), axis: .vertical)
                    .lineLimit(3...10)
            }
            .navigationTitle("Edit step")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let t = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
                        let b = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
                        viewModel.updateStudio12ProcessStep(at: stepIndex, title: t, body: b)
                        onDismiss()
                    }
                }
            }
        }
        .onAppear {
            guard viewModel.studio12ProcessSteps.indices.contains(stepIndex) else { return }
            let s = viewModel.studio12ProcessSteps[stepIndex]
            titleText = s.title
            bodyText = s.body
        }
    }
}

private struct EditTenantServiceSheet: View {
    let service: TenantService
    @ObservedObject var viewModel: DesignViewModel
    let onDismiss: () -> Void
    @State private var name = ""
    @State private var descriptionText = ""
    @State private var includeDuration = false
    @State private var duration = 30
    @State private var showStartingPrice = false
    @State private var priceText = ""

    private var descriptionFieldTitle: String {
        let fam = WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
        if fam == .blade || fam == .stonecut { return "Description (Blade card)" }
        return "Description"
    }

    private var startingPriceHelp: String {
        let fam = WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
        if fam == .blade || fam == .stonecut {
            return "Guests see “Book for pricing” on Blade when this is off."
        }
        return "When off, starting price is hidden on your site where supported."
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Service name", text: $name)
                TextField(descriptionFieldTitle, text: $descriptionText, axis: .vertical)
                    .lineLimit(3...8)
                Toggle("Include duration", isOn: $includeDuration)
                if includeDuration {
                    Stepper("Duration: \(duration) min", value: $duration, in: 15...240, step: 15)
                }
                Toggle("Show starting price", isOn: $showStartingPrice)
                if showStartingPrice {
                    TextField("Amount (USD)", text: $priceText)
                        .keyboardType(.decimalPad)
                } else {
                    Text(startingPriceHelp)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Edit service")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let desc = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
                        let price = AddServiceSheet.parseStartingPriceHelper(enabled: showStartingPrice, text: priceText)
                        Task {
                            let ok = await viewModel.updateService(
                                serviceId: service.id,
                                name: name,
                                description: desc.isEmpty ? nil : desc,
                                durationMinutes: includeDuration ? duration : nil,
                                startingPrice: price
                            )
                            if ok { onDismiss() }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.isSavingBladeServices)
                }
            }
        }
        .onAppear {
            name = service.name
            descriptionText = service.description ?? ""
            if let dm = service.durationMinutes, dm > 0 {
                includeDuration = true
                duration = dm
            } else {
                includeDuration = false
                duration = 30
            }
            if let p = service.price, p > 0 {
                showStartingPrice = true
                priceText = p.rounded() == p ? String(format: "%.0f", p) : String(format: "%.2f", p)
            } else {
                showStartingPrice = false
                priceText = ""
            }
        }
    }
}


// MARK: - Template gallery (mini SwiftUI previews)

private struct TemplateFamilyCard: View {
    let family: TemplateFamily
    let isActive: Bool
    let isBusy: Bool
    let select: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TemplateMiniPreview(family: family)
                .padding(10)
                .frame(maxWidth: .infinity)
                .background(Color(.secondarySystemGroupedBackground))

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(family.displayName)
                        .font(.headline)
                    Spacer()
                    if isActive {
                        Text("Active")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundColor(.accentColor)
                    } else {
                        Button(action: select) {
                            Text("Select")
                                .font(.subheadline.weight(.semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.accentColor)
                        .disabled(isBusy)
                    }
                }
                Text(family.previewSubtitle)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(family.sectionTags, id: \.self) { tag in
                            Text(tag)
                                .font(.caption2.weight(.medium))
                                .foregroundColor(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Capsule().fill(Color(.systemGray5)))
                        }
                    }
                }
            }
            .padding(14)
        }
        .background(Color(.systemBackground))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(.separator).opacity(0.45), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.04), radius: 6, x: 0, y: 2)
    }
}

private struct TemplateMiniPreview: View {
    let family: TemplateFamily

    var body: some View {
        Group {
            switch family {
            case .blade:
                BladeTemplatePreview()
            case .stonecut:
                StonecutTemplatePreview()
            case .luxe:
                LuxeTemplatePreview()
            case .classic:
                ClassicTemplatePreview(accentSymbol: family.icon)
            case .studio12:
                Studio12TemplatePreview()
            }
        }
        .frame(height: 128)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct StonecutTemplatePreview: View {
    private let ember = Color(red: 0.75, green: 0.13, blue: 0.10)
    private let bone = Color(red: 0.91, green: 0.88, blue: 0.82)

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [
                    Color(red: 0.03, green: 0.03, blue: 0.02),
                    Color(red: 0.09, green: 0.08, blue: 0.06)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(alignment: .leading, spacing: 5) {
                Text("STONECUT")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundColor(ember)
                    .tracking(1.1)
                Text("EDITORIAL")
                    .font(.system(size: 11, weight: .black))
                    .foregroundColor(bone)
                    .tracking(0.4)
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(ember)
                        .frame(width: 24, height: 2)
                    RoundedRectangle(cornerRadius: 1)
                        .fill(bone.opacity(0.35))
                        .frame(width: 16, height: 2)
                }
            }
            .padding(10)
        }
    }
}

private struct BladeTemplatePreview: View {
    private let gold = Color(red: 0.79, green: 0.66, blue: 0.30)
    private let cream = Color(red: 0.96, green: 0.94, blue: 0.91)

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [
                    Color(red: 0.05, green: 0.05, blue: 0.04),
                    Color(red: 0.11, green: 0.10, blue: 0.08)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            VStack(alignment: .leading, spacing: 5) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(gold)
                    .frame(width: 32, height: 2)
                Text("CRAFTED FOR YOU")
                    .font(.system(size: 7, weight: .semibold))
                    .foregroundColor(gold)
                    .tracking(0.6)
                Text("YOUR STUDIO")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(cream)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(gold)
                        .frame(width: 52, height: 13)
                    RoundedRectangle(cornerRadius: 2)
                        .stroke(cream.opacity(0.35), lineWidth: 1)
                        .frame(width: 48, height: 13)
                }
            }
            .padding(12)
            RoundedRectangle(cornerRadius: 2)
                .fill(gold.opacity(0.3))
                .frame(width: 3, height: 40)
                .padding(.trailing, 14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
    }
}

private struct Studio12TemplatePreview: View {
    private let ivory = Color(red: 0.98, green: 0.97, blue: 0.95)
    private let ink = Color(red: 0.16, green: 0.12, blue: 0.09)

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            ivory
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 8) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color(.systemGray4))
                        .frame(width: 44, height: 52)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("STUDIO")
                            .font(.system(size: 6, weight: .semibold))
                            .foregroundColor(ink.opacity(0.45))
                            .tracking(0.8)
                        Text("Twelve")
                            .font(.system(size: 11, weight: .medium, design: .serif))
                            .foregroundColor(ink)
                            .italic()
                        RoundedRectangle(cornerRadius: 1)
                            .fill(ink.opacity(0.15))
                            .frame(width: 72, height: 6)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                Rectangle()
                    .fill(ink)
                    .frame(height: 14)
                    .overlay(
                        HStack(spacing: 10) {
                            ForEach(0..<4, id: \.self) { _ in
                                Capsule()
                                    .fill(ivory.opacity(0.25))
                                    .frame(width: 28, height: 3)
                            }
                        }
                        .padding(.horizontal, 8)
                    )
            }
        }
    }
}

private struct LuxeTemplatePreview: View {
    private let cream = Color(red: 1.0, green: 0.99, blue: 0.98)
    private let ink = Color(red: 0.11, green: 0.11, blue: 0.11)
    private let accent = Color(red: 0.79, green: 0.66, blue: 0.43)

    var body: some View {
        ZStack(alignment: .bottom) {
            cream
            VStack(spacing: 0) {
                ZStack {
                    LinearGradient(
                        colors: [
                            Color(red: 0.2, green: 0.17, blue: 0.14),
                            Color(red: 0.12, green: 0.10, blue: 0.08)
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    VStack(spacing: 4) {
                        Text("STUDIO")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(.white.opacity(0.9))
                        RoundedRectangle(cornerRadius: 2)
                            .fill(accent)
                            .frame(width: 56, height: 12)
                    }
                    .padding(.vertical, 10)
                }
                .frame(height: 72)
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color(.systemGray5))
                            .frame(width: 36, height: 44)
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(ink.opacity(0.06), lineWidth: 0.5)
                            )
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity)
                .background(cream)
            }
        }
    }
}

private struct ClassicTemplatePreview: View {
    let accentSymbol: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(.systemGray6)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Image(systemName: accentSymbol)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                    Spacer()
                    Circle()
                        .fill(Color(.systemGray4))
                        .frame(width: 14, height: 14)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Color(.systemBackground))
                ZStack(alignment: .bottom) {
                    Rectangle()
                        .fill(
                            LinearGradient(
                                colors: [Color(.systemGray3), Color(.systemGray4)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    VStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.white.opacity(0.85))
                            .frame(width: 70, height: 10)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.accentColor.opacity(0.9))
                            .frame(width: 50, height: 12)
                    }
                    .padding(.bottom, 12)
                }
                .frame(height: 68)
                .padding(.horizontal, 10)
                .padding(.top, 8)
            }
        }
    }
}

// MARK: - Business hours weekly editor sheets

private struct BusinessHoursDaySheetToken: Identifiable {
    var id: Int { dayIndex }
    let dayIndex: Int
}

private struct BusinessHoursDayEditSheet: View {
    let dayIndex: Int
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DaySchedule

    init(dayIndex: Int, viewModel: DesignViewModel) {
        self.dayIndex = dayIndex
        self.viewModel = viewModel
        _draft = State(initialValue: viewModel.businessHoursWeekly.days[dayIndex])
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    Toggle("Open", isOn: Binding(
                        get: { !draft.isClosed },
                        set: { open in
                            draft.isClosed = !open
                            if open && draft.ranges.isEmpty {
                                draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
                            }
                            draft.normalize()
                        }
                    ))
                }
                if !draft.isClosed {
                    Section {
                        ForEach(draft.ranges.indices, id: \.self) { i in
                            HStack(spacing: 8) {
                                DatePicker(
                                    "From",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].startMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].startMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                DatePicker(
                                    "To",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].endMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].endMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                if draft.ranges.count > 1 {
                                    Button {
                                        draft.ranges.remove(at: i)
                                        draft.normalize()
                                    } label: {
                                        Image(systemName: "minus.circle.fill")
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        Button {
                            draft.ranges.append(BusinessHourTimeRange(startMinutes: 12 * 60, endMinutes: 17 * 60))
                            draft.normalize()
                        } label: {
                            Label("Add hours", systemImage: "plus.circle")
                        }
                    }
                }
                Section {
                    Button("Apply to all weekdays") {
                        draft.normalize()
                        viewModel.applySchedule(draft, toIndices: Set(0..<5))
                        dismiss()
                    }
                } header: {
                    Text("Copy these hours")
                } footer: {
                    Text("Done saves only \(BusinessHoursWeekly.dayLabels[dayIndex]). Apply copies this schedule to Mon–Fri.")
                }
            }
            .navigationTitle(BusinessHoursWeekly.dayLabels[dayIndex])
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        draft.normalize()
                        viewModel.replaceBusinessHoursDay(index: dayIndex, schedule: draft)
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct BusinessHoursExceptionEditSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: BusinessHoursException

    init(exception: BusinessHoursException, viewModel: DesignViewModel) {
        self.viewModel = viewModel
        _draft = State(initialValue: exception)
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                    DatePicker(
                        "Date",
                        selection: Binding(
                            get: { Self.localDate(fromYmd: draft.dateYmd) },
                            set: { draft.dateYmd = Self.ymd(from: $0) }
                        ),
                        displayedComponents: [.date]
                    )
                    Toggle("Closed all day", isOn: $draft.closedAllDay)
                }
                if !draft.closedAllDay {
                    Section {
                        ForEach(draft.ranges.indices, id: \.self) { i in
                            HStack(spacing: 8) {
                                DatePicker(
                                    "From",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].startMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].startMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                DatePicker(
                                    "To",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].endMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].endMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                if draft.ranges.count > 1 {
                                    Button {
                                        draft.ranges.remove(at: i)
                                        draft.normalize()
                                    } label: {
                                        Image(systemName: "minus.circle.fill")
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        Button {
                            draft.ranges.append(BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60))
                            draft.normalize()
                        } label: {
                            Label("Add hours", systemImage: "plus.circle")
                        }
                    }
                }
            }
            .navigationTitle("Special date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if !draft.closedAllDay && draft.ranges.isEmpty {
                            draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
                        }
                        draft.normalize()
                        viewModel.upsertBusinessHoursException(draft)
                        dismiss()
                    }
                }
            }
        }
        .onChange(of: draft.closedAllDay) { _, closed in
            if !closed && draft.ranges.isEmpty {
                draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
            }
            draft.normalize()
        }
    }

    private static let ymdFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar.current
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = Calendar.current.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func localDate(fromYmd ymd: String) -> Date {
        ymdFormatter.date(from: ymd) ?? Date()
    }

    private static func ymd(from date: Date) -> String {
        ymdFormatter.string(from: date)
    }
}

// MARK: - Preview quick edit (WKWebView `data-edit-key`)
private struct PreviewQuickEditSheet: View {
    let fieldKey: String
    let title: String
    let initialText: String
    @ObservedObject var viewModel: DesignViewModel
    let onDismiss: () -> Void

    @State private var draft: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(title, text: $draft)
                        .textInputAutocapitalization(.sentences)
                }
                if let err = viewModel.errorMessage, !err.isEmpty {
                    Section {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await viewModel.saveQuickEdit(fieldKey: fieldKey, value: draft)
                            await MainActor.run {
                                guard viewModel.errorMessage == nil else { return }
                                onDismiss()
                            }
                        }
                    }
                }
            }
            .onAppear { draft = initialText }
        }
    }
}

// MARK: - Icon + text field row
struct IconFieldRow: View {
    let icon: String
    let placeholder: String
    @Binding var text: String
    var textInputAutocapitalization: TextInputAutocapitalization = .never

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundColor(.secondary)
                .frame(width: 24)
            TextField(placeholder, text: $text)
                .font(.subheadline)
                .textInputAutocapitalization(textInputAutocapitalization)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(10)
    }
}
