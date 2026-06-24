//
//  DesignView.swift
//
//  Web page design: Preview mode (default) + Manage mode with tabs.
//

import SwiftUI
import PhotosUI
import UIKit

struct DesignView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = DesignViewModel()
    @State private var selectedTab: DesignTab = .gallery
    @State private var isShowingManage = false
    @State private var showBladeStarterConfirm = false
    @State private var showStudio12ProcessStartersConfirm = false
    @State private var bladeServiceToEdit: TenantService?
    @State private var isEditingStudio12ProcessStep = false
    @State private var studio12ProcessStepEditIndex = 0
    @State private var isQuickEditEnabled = false
    @State private var quickEditBridge = WebViewQuickEditBridge()
    @State private var quickEditInlineFocus: QuickEditInlineFocus?
    @State private var previewColorsDirty = false
    @State private var selectedColorSurface: PreviewColorSurface?
    @State private var isQuickEditChromeCollapsed = false
    @State private var quickEditSheet: QuickEditSheetPayload?
    @State private var quickEditHeroImageSheet = false
    @State private var quickEditFeaturedSlot: QuickEditFeaturedSlotPayload?
    @State private var quickEditGallerySlot: QuickEditGallerySlotPayload?
    @State private var quickEditStudio12PhilosophySheet = false
    @State private var quickEditStudio12BookCtaSheet = false
    @State private var formFieldToEdit: FormField?
    @State private var manageGalleryBatchCrop: MultiImageCropSheetItem?
    @State private var showGalleryPickerLoadError = false
    @State private var isColorPickerPresented = false
    @State private var isTemplatePickerPresented = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            Group {
                if isShowingManage {
                    manageContent
                } else {
                    previewContent
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(isShowingManage ? "Manage" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Group {
                        if isShowingManage {
                            Button("Preview") {
                                isShowingManage = false
                            }
                            .foregroundStyle(AppDesign.textPrimary)
                        } else {
                            Button(action: { drawerState.isOpen = true }) {
                                Image(systemName: "line.3.horizontal")
                                    .foregroundStyle(AppDesign.textPrimary)
                            }
                        }
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Group {
                        if !isShowingManage {
                            HStack(spacing: 12) {
                                if viewModel.hasTenant, !authViewModel.isDemoMode {
                                    Text("Preview")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(
                                            isQuickEditEnabled ? AppDesign.textSecondary : AppDesign.textPrimary
                                        )
                                    Toggle("", isOn: $isQuickEditEnabled)
                                        .labelsHidden()
                                        .toggleStyle(AppTwoToneSwitchToggleStyle())
                                        .accessibilityLabel("Quick edit")
                                }
                                Button("Manage") {
                                    isQuickEditEnabled = false
                                    selectedTab = .gallery
                                    isShowingManage = true
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
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
                await viewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await authViewModel.refreshTeamAccess()
            }
            .onDisappear {
                if isQuickEditEnabled {
                    isQuickEditEnabled = false
                } else {
                    viewModel.flushDeferredWebPreviewReloadIfNeeded()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
                if let url = note.userInfo?["logoUrl"] as? String {
                    viewModel.syncLogoUrlFromExternal(url)
                }
            }
            .sheet(item: $quickEditSheet) { payload in
                PreviewQuickEditSheet(
                    fieldKey: payload.fieldKey,
                    title: QuickEditFieldTitles.title(for: payload.fieldKey),
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
            .sheet(item: $quickEditGallerySlot) { payload in
                QuickEditGallerySlotSheet(
                    slotIndex: payload.slotIndex,
                    viewModel: viewModel,
                    onDone: { quickEditGallerySlot = nil }
                )
            }
            .sheet(isPresented: $quickEditStudio12PhilosophySheet) {
                NavigationStack {
                    Form {
                        Studio12AuxImageUploadSection(
                            label: "Philosophy image",
                            advice: "",
                            allowedCropChoices: [.landscape16_9, .portrait4_5, .square],
                            defaultCropChoice: .landscape16_9,
                            imageUrl: $viewModel.studio12PhilosophyImageUrl,
                            isUploading: viewModel.isUploadingStudio12Philosophy,
                            upload: { data in await viewModel.uploadStudio12PhilosophyImage(imageData: data) }
                        )
                    }
                    .navigationTitle("Philosophy image")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { quickEditStudio12PhilosophySheet = false }
                        }
                    }
                }
            }
            .sheet(isPresented: $quickEditStudio12BookCtaSheet) {
                NavigationStack {
                    Form {
                        Studio12AuxImageUploadSection(
                            label: "Booking section image",
                            advice: "",
                            allowedCropChoices: [.landscape16_9, .portrait4_5, .square],
                            defaultCropChoice: .landscape16_9,
                            imageUrl: $viewModel.studio12BookCtaImageUrl,
                            isUploading: viewModel.isUploadingStudio12BookCta,
                            upload: { data in await viewModel.uploadStudio12BookCtaImage(imageData: data) }
                        )
                    }
                    .navigationTitle("Booking image")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { quickEditStudio12BookCtaSheet = false }
                        }
                    }
                }
            }
            .sheet(item: $bladeServiceToEdit) { service in
                EditTenantServiceSheet(service: service, viewModel: viewModel) {
                    bladeServiceToEdit = nil
                }
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
            .sheet(item: $formFieldToEdit) { field in
                EditFormFieldSheet(
                    field: field,
                    existingKeys: viewModel.formFields
                        .filter { $0.id != field.id }
                        .map { $0.key.lowercased() },
                    onCancel: { formFieldToEdit = nil },
                    onSave: { updatedField in
                        viewModel.updateFormField(updatedField)
                        formFieldToEdit = nil
                    }
                )
            }
            .sheet(item: $manageGalleryBatchCrop, onDismiss: { manageGalleryBatchCrop = nil }) { batch in
                UploadImagePreparationSheet(
                    images: batch.images,
                    advice: isStudio12Template ? UploadImageAdvice.galleryStudio12 : UploadImageAdvice.gallery,
                    navigationTitle: "Gallery photos",
                    allowedChoices: [manageGalleryLockedCropChoice],
                    defaultChoice: manageGalleryLockedCropChoice,
                    onUseJPEGData: { dataList in
                        manageGalleryBatchCrop = nil
                        guard !dataList.isEmpty else { return }
                        Task { await viewModel.addGalleryImages(imageDataList: dataList) }
                    }
                )
            }
            .alert("Couldn't load photos", isPresented: $showGalleryPickerLoadError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Try again or choose different images from your library.")
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

    private struct QuickEditGallerySlotPayload: Identifiable {
        let slotIndex: Int
        var id: Int { slotIndex }
    }

    private struct QuickEditGallerySlotSheet: View {
        let slotIndex: Int
        @ObservedObject var viewModel: DesignViewModel
        var onDone: () -> Void
        @State private var selectedItem: PhotosPickerItem?
        @State private var cropSheetItem: SingleImageCropSheetItem?

        private var hasImageAtSlot: Bool {
            guard viewModel.galleryImages.indices.contains(slotIndex) else { return false }
            return !viewModel.galleryImages[slotIndex].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        private var slotImageURL: URL? {
            guard viewModel.galleryImages.indices.contains(slotIndex) else { return nil }
            let s = viewModel.galleryImages[slotIndex].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !s.isEmpty, let url = URL(string: s) else { return nil }
            return url
        }

        private let previewThumbSize = CGSize(width: 72, height: 72)

        var body: some View {
            NavigationStack {
                Form {
                    Section {
                        Text("Gallery photo")
                            .font(.subheadline.weight(.medium))
                        HStack(alignment: .center, spacing: 16) {
                            Group {
                                if let url = slotImageURL {
                                    AsyncImage(url: url) { image in
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    } placeholder: {
                                        AppDesign.searchBackground
                                    }
                                    .frame(width: previewThumbSize.width, height: previewThumbSize.height)
                                    .clipped()
                                    .cornerRadius(8)
                                } else {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(AppDesign.searchBackground)
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
                                if viewModel.isUploadingGallery {
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
                        allowedChoices: [.portrait4_5, .square, .landscape16_9],
                        defaultChoice: .portrait4_5,
                        showsInstructionalCopy: false,
                        onUseJPEGData: { dataList in
                            guard let data = dataList.first else { return }
                            cropSheetItem = nil
                            Task { await viewModel.replaceOrAppendGalleryImage(at: slotIndex, imageData: data) }
                        }
                    )
                }
            }
        }
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
                                        AppDesign.searchBackground
                                    }
                                    .frame(width: previewThumbSize.width, height: previewThumbSize.height)
                                    .clipped()
                                    .cornerRadius(8)
                                } else {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(AppDesign.searchBackground)
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

    /// Same path as `bookingUrl` with a cache-busting query so WKWebView reloads after Firestore updates (token bumps in `DesignViewModel`).
    private var sitePreviewURL: URL? {
        guard viewModel.hasTenant, !viewModel.bookingUrl.isEmpty,
              var components = URLComponents(string: viewModel.bookingUrl) else { return nil }
        var q = components.queryItems ?? []
        q.append(URLQueryItem(name: "_cb", value: String(viewModel.webPreviewReloadToken)))
        components.queryItems = q
        return components.url
    }

    private var activePaletteDisplayName: String {
        let family = activeTemplateFamily
        let resolvedId = WebColorPalettes.resolvedPaletteId(stored: viewModel.webColorPaletteId, family: family)
        let hintTone: WebColorPalettePickerTone = WebColorPalettes.isPaletteLight(
            backgroundHex: viewModel.backgroundColorHex
        ) ? .light : .dark
        if let palette = WebColorPalettes.palette(family: family, id: resolvedId, pickerTone: hintTone) {
            return palette.name
        }
        if let match = WebColorPalettes.palettes(for: family, tone: hintTone).first(where: {
            WebColorPalettes.pickerPaletteIsActive(
                storedPaletteId: viewModel.webColorPaletteId,
                storedPrimaryHex: viewModel.primaryColorHex,
                storedBackgroundHex: viewModel.backgroundColorHex,
                palette: $0
            )
        }) {
            return match.name
        }
        return WebColorPalettes.original(for: family).name
    }

    private var previewContent: some View {
        VStack(spacing: 0) {
            if viewModel.hasTenant, !authViewModel.isDemoMode {
                DesignThemePickerBar(
                    viewModel: viewModel,
                    paletteName: activePaletteDisplayName,
                    templateFamily: activeTemplateFamily,
                    accentHex: viewModel.primaryColorHex,
                    industry: viewModel.industry,
                    isColorPickerPresented: $isColorPickerPresented,
                    isTemplatePickerPresented: $isTemplatePickerPresented
                )
            }
            ZStack(alignment: .bottom) {
            WebViewPreview(
            url: sitePreviewURL,
            height: nil,
            quickEditEnabled: isQuickEditEnabled && viewModel.hasTenant && !authViewModel.isDemoMode,
            bridge: quickEditBridge,
            onQuickEdit: { event in
                switch event {
                case let .inlineSaveBatch(changes):
                    guard !changes.isEmpty else { return }
                    Task {
                        let pairs = changes.map { (fieldKey: $0.key, value: $0.value) }
                        await viewModel.saveQuickEditBatch(pairs, reloadPreview: false)
                        await MainActor.run {
                            if !isQuickEditEnabled {
                                viewModel.flushDeferredWebPreviewReloadIfNeeded()
                            }
                        }
                    }
                case let .inlineFocus(focus):
                    quickEditInlineFocus = focus
                    isQuickEditChromeCollapsed = true
                case .inlineBlur:
                    quickEditInlineFocus = nil
                case let .openColorSurface(surfaceId):
                    if let surface = PreviewColorSurface(surfaceId: surfaceId) {
                        selectedColorSurface = surface
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
                    if key == "studio12PhilosophyImage" {
                        quickEditStudio12PhilosophySheet = true
                        return
                    }
                    if key == "studio12BookCtaImage" {
                        quickEditStudio12BookCtaSheet = true
                        return
                    }
                    if key.hasPrefix("galleryImage:") {
                        let tail = String(key.dropFirst("galleryImage:".count))
                        if let idx = Int(tail), idx >= 0 {
                            quickEditGallerySlot = QuickEditGallerySlotPayload(slotIndex: idx)
                            return
                        }
                    }
                    if key.hasPrefix("s12Process:") {
                        let parts = key.split(separator: ":").map(String.init)
                        if parts.count == 3,
                           parts[0] == "s12Process",
                           ["edit", "title", "body"].contains(parts[2]),
                           let idx = Int(parts[1]),
                           viewModel.studio12ProcessSteps.indices.contains(idx) {
                            studio12ProcessStepEditIndex = idx
                            isEditingStudio12ProcessStep = true
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
                        await viewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
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

                if isQuickEditEnabled && viewModel.hasTenant && !authViewModel.isDemoMode {
                    PreviewQuickEditChrome(
                        viewModel: viewModel,
                        bridge: quickEditBridge,
                        inlineFocus: $quickEditInlineFocus,
                        colorsDirty: $previewColorsDirty,
                        selectedColorSurface: $selectedColorSurface,
                        isChromeCollapsed: $isQuickEditChromeCollapsed
                    )
                }
            }
        }
        .appCard()
        .onChange(of: isQuickEditEnabled) { _, enabled in
            if !enabled {
                quickEditInlineFocus = nil
                previewColorsDirty = false
                selectedColorSurface = nil
                isQuickEditChromeCollapsed = false
            }
        }
    }

    private var manageContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(DesignTab.manageTabs, id: \.self) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Text(tab.manageSegmentTitle)
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
            .appCard()
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
                        case .gallery:
                            ManageGalleryTabContent(
                                viewModel: viewModel,
                                isStudio12Template: isStudio12Template,
                                galleryBatchCrop: $manageGalleryBatchCrop,
                                showGalleryPickerLoadError: $showGalleryPickerLoadError
                            )
                        case .book:
                            ManageBookTabContent(
                                viewModel: viewModel,
                                teamAccess: authViewModel.teamAccess,
                                serviceToEdit: $bladeServiceToEdit,
                                formFieldToEdit: $formFieldToEdit
                            )
                        case .about:
                            ManageAboutTabContent(
                                viewModel: viewModel,
                                isClassicTemplate: isClassicTemplate,
                                isLuxeTemplate: isLuxeTemplate,
                                isBladeTemplate: isBladeTemplate,
                                isStudio12Template: isStudio12Template
                            )
                        case .shop:
                            ManageShopTabContent(viewModel: viewModel)
                        default:
                            EmptyView()
                        }
                    }
                }
                .padding()
            }
            .refreshable {
                await viewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
        }
        .alert("Replace all services?", isPresented: $showBladeStarterConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Replace", role: .destructive) {
                Task { await viewModel.applyBladeStarterServices(isDemoMode: authViewModel.isDemoMode) }
            }
        } message: {
            Text(
                "Your current services will be removed and replaced with four starter services for \(BookingTemplate.displayLabel(forIndustryRaw: viewModel.industry?.trimmingCharacters(in: .whitespacesAndNewlines), customLabel: viewModel.industryCustomLabel)). You can edit order and details below."
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

    private var manageGalleryLockedCropChoice: UploadCropAspectChoice {
        switch viewModel.galleryLayoutStyle {
        case .masonry: return .original
        case .horizontalStrip: return .portrait4_5
        case .classicGrid: return isStudio12Template ? .portrait4_5 : .landscape4_3
        }
    }

    private var studio12BookingTemplate: BookingTemplate {
        Studio12IndustryCopy.template(from: viewModel.industry)
    }

    private var visibleDesignTabs: [DesignTab] {
        DesignTab.manageTabs
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

    private var colorPaletteSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Color palette")
                    .font(.headline)
                if WebColorPalettes.showsAccentChipRowInPicker(for: activeTemplateFamily) {
                    Text("Pick a background style, then choose your button & highlight color. Switching layout above resets to Original.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("Pick a color preset. Switching layout above resets to Original.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            DesignColorPalettePickerSection(
                viewModel: viewModel,
                family: activeTemplateFamily,
                gridSpacing: 12,
                usePresetCards: true
            )
        }
        .padding(.top, 8)
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

            colorPaletteSection

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
            Text("Name on website")
                .font(.subheadline.weight(.medium))
            Text("Shown on your public site. Leave blank to use your app business name from Settings.")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(
                "Name on website",
                text: $viewModel.displayName,
                prompt: Text(viewModel.appBusinessName.isEmpty ? "Studio" : viewModel.appBusinessName)
            )
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
            Text("Name on website")
                .font(.subheadline.weight(.medium))
            Text("Shown on your public site. Leave blank to use your app business name from Settings.")
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(
                "Name on website",
                text: $viewModel.displayName,
                prompt: Text(viewModel.appBusinessName.isEmpty ? "Studio" : viewModel.appBusinessName)
            )
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
            Text("Layout for your /book page. Colors follow your Template tab preset.")
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
                .contentShape(Rectangle())
                .onTapGesture { formFieldToEdit = field }
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
                        AppDesign.searchBackground
                    }
                    .frame(width: 80, height: 56)
                    .clipped()
                    .cornerRadius(8)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(AppDesign.searchBackground)
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
                        AppDesign.searchBackground
                    }
                    .frame(width: 80, height: 56)
                    .clipped()
                    .cornerRadius(8)
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(AppDesign.searchBackground)
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
private struct GalleryThumbFrame: ViewModifier {
    let large: Bool

    func body(content: Content) -> some View {
        if large {
            content
                .aspectRatio(4 / 5, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .clipped()
        } else {
            content
                .frame(width: 72, height: 72)
                .clipped()
                .cornerRadius(8)
        }
    }
}

struct GalleryImagesSection: View {
    @ObservedObject var viewModel: DesignViewModel
    /// When the live site template is Studio 12, gallery presets and copy match the home strip + /gallery tiles.
    var isStudio12Site: Bool = false
    /// Minimum thumbnail width; use ~140 in Manage mode for a two-column grid.
    var thumbMinimum: CGFloat = 72
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var galleryBatchCrop: MultiImageCropSheetItem?

    /// Wraps thumbnails in rows; parent `ScrollView` handles vertical scrolling.
    private var thumbGridColumns: [GridItem] {
        if thumbMinimum >= 100 {
            return [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
            ]
        }
        return [GridItem(.adaptive(minimum: thumbMinimum), spacing: 12)]
    }

    private var usesLargeManageCells: Bool { thumbMinimum >= 100 }

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
            if !usesLargeManageCells {
                Text("Gallery page photos")
                    .font(.subheadline.weight(.medium))
                Text(galleryAdvice)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            LazyVGrid(columns: thumbGridColumns, alignment: .leading, spacing: 12) {
                ForEach(Array(viewModel.galleryImages.enumerated()), id: \.offset) { index, urlString in
                    if let url = URL(string: urlString) {
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if usesLargeManageCells {
                                    AsyncImage(url: url) { image in
                                        image
                                            .resizable()
                                            .scaledToFill()
                                    } placeholder: {
                                        AppDesign.searchBackground
                                    }
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                                } else {
                                    AsyncImage(url: url) { image in
                                        image
                                            .resizable()
                                            .scaledToFill()
                                    } placeholder: {
                                        AppDesign.searchBackground
                                    }
                                    .frame(width: 72, height: 72)
                                }
                            }

                            Button(action: {
                                Task { await viewModel.removeGalleryImage(at: index) }
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: usesLargeManageCells ? 24 : 20))
                                    .foregroundStyle(.white, .red)
                            }
                            .offset(x: 4, y: -4)
                        }
                        .modifier(GalleryThumbFrame(large: usesLargeManageCells))
                    }
                }
                PhotosPicker(
                    selection: $selectedItems,
                    matching: .images,
                    photoLibrary: .shared()
                ) {
                    Group {
                        if usesLargeManageCells {
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                                .aspectRatio(4 / 5, contentMode: .fit)
                                .overlay(
                                    Image(systemName: "plus")
                                        .font(.title2)
                                        .foregroundColor(.secondary)
                                )
                        } else {
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                                .frame(width: 72, height: 72)
                                .overlay(
                                    Image(systemName: "plus")
                                        .font(.title2)
                                        .foregroundColor(.secondary)
                                )
                        }
                    }
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
                    AppDesign.searchBackground
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

private struct EditFormFieldSheet: View {
    let field: FormField
    let existingKeys: [String]
    let onCancel: () -> Void
    let onSave: (FormField) -> Void

    @State private var label: String
    @State private var key: String
    @State private var type: FormFieldType
    @State private var required: Bool
    @State private var optionsText: String
    @State private var placeholder: String
    @State private var validationError: String?

    init(
        field: FormField,
        existingKeys: [String],
        onCancel: @escaping () -> Void,
        onSave: @escaping (FormField) -> Void
    ) {
        self.field = field
        self.existingKeys = existingKeys
        self.onCancel = onCancel
        self.onSave = onSave
        _label = State(initialValue: field.label)
        _key = State(initialValue: field.key)
        _type = State(initialValue: field.type)
        _required = State(initialValue: field.required)
        _optionsText = State(initialValue: (field.options ?? []).joined(separator: ", "))
        _placeholder = State(initialValue: field.placeholder ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Field") {
                    TextField("Label", text: $label)
                    TextField("Key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Type", selection: $type) {
                        ForEach(FormFieldType.allCases, id: \.self) { item in
                            Text(item.displayName).tag(item)
                        }
                    }
                    Toggle("Required", isOn: $required)
                }
                Section("Display") {
                    TextField("Placeholder (optional)", text: $placeholder)
                }
                if type == .select {
                    Section("Dropdown options") {
                        TextField("Comma-separated options", text: $optionsText, axis: .vertical)
                            .lineLimit(2...6)
                        Text("Example: Morning, Afternoon, Evening")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                if let validationError {
                    Section {
                        Text(validationError)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("Edit field")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveField() }
                }
            }
        }
    }

    private func saveField() {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKey = sanitizeKey(key)
        guard !trimmedLabel.isEmpty else {
            validationError = "Label is required."
            return
        }
        guard !normalizedKey.isEmpty else {
            validationError = "Key is required."
            return
        }
        guard !existingKeys.contains(normalizedKey.lowercased()) else {
            validationError = "That key is already used by another field."
            return
        }
        let parsedOptions = optionsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if type == .select && parsedOptions.isEmpty {
            validationError = "Add at least one option for a dropdown field."
            return
        }
        validationError = nil
        onSave(
            FormField(
                id: field.id,
                key: normalizedKey,
                label: trimmedLabel,
                type: type,
                required: required,
                options: type == .select ? parsedOptions : nil,
                placeholder: placeholder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? nil
                    : placeholder.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        )
    }

    private func sanitizeKey(_ raw: String) -> String {
        let lowered = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let collapsed = lowered.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
        return collapsed.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
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
                        Task { await viewModel.persistStudio12ProcessSteps() }
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


// MARK: - Preview design picker (separate color + template dropdowns)

private struct DesignThemePickerBar: View {
    @ObservedObject var viewModel: DesignViewModel
    let paletteName: String
    let templateFamily: TemplateFamily
    let accentHex: String
    let industry: String?
    @Binding var isColorPickerPresented: Bool
    @Binding var isTemplatePickerPresented: Bool

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            DesignPickerPill(
                title: paletteName,
                isPresented: $isColorPickerPresented,
                isDisabled: viewModel.isLoading
            ) {
                Circle()
                    .fill(Color(hex: accentHex))
                    .frame(width: 10, height: 10)
                    .overlay(
                        Circle()
                            .stroke(Color(.separator).opacity(0.4), lineWidth: 0.5)
                    )
            } popover: {
                DesignColorPickerPopover(
                    viewModel: viewModel,
                    onDismiss: { isColorPickerPresented = false }
                )
                .frame(width: 340)
                .presentationCompactAdaptation(.popover)
            }
            .onChange(of: isColorPickerPresented) { _, isOpen in
                if isOpen { isTemplatePickerPresented = false }
            }

            DesignPickerPill(
                title: templateFamily.displayName,
                isPresented: $isTemplatePickerPresented,
                isDisabled: viewModel.isLoading
            ) {
                Image(systemName: templateFamily.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, height: 14)
            } popover: {
                DesignTemplatePickerPopover(
                    viewModel: viewModel,
                    industry: industry,
                    onDismiss: { isTemplatePickerPresented = false }
                )
                .frame(width: 340)
                .presentationCompactAdaptation(.popover)
            }
            .onChange(of: isTemplatePickerPresented) { _, isOpen in
                if isOpen { isColorPickerPresented = false }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .appCard()
        .overlay(alignment: .bottom) {
            Divider()
        }
    }
}

private struct DesignPickerPill<Leading: View, Popover: View>: View {
    let title: String
    @Binding var isPresented: Bool
    let isDisabled: Bool
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let popover: () -> Popover

    var body: some View {
        Button {
            isPresented = true
        } label: {
            HStack(spacing: 8) {
                leading()
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                Capsule()
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                Capsule()
                    .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            popover()
        }
    }
}

private struct DesignColorPickerPopover: View {
    @ObservedObject var viewModel: DesignViewModel
    let onDismiss: () -> Void

    private var activeFamily: TemplateFamily {
        WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("SITE COLORS")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .tracking(0.6)
                DesignColorPalettePickerSection(
                    viewModel: viewModel,
                    family: activeFamily,
                    onSelected: onDismiss
                )
            }
            .padding(18)
        }
        .frame(maxHeight: 560)
    }
}

private struct DesignTemplatePickerPopover: View {
    @ObservedObject var viewModel: DesignViewModel
    let industry: String?
    let onDismiss: () -> Void

    private var activeFamily: TemplateFamily {
        WebTheme(rawValue: viewModel.webThemeId)?.family ?? .classic
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("TEMPLATE")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .tracking(0.6)
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(TemplateFamily.allCases) { family in
                        DesignThemeTemplatePickerCell(
                            family: family,
                            isActive: activeFamily == family,
                            isBusy: viewModel.isLoading
                        ) {
                            let theme = WebTheme.theme(for: family, industry: industry)
                            Task {
                                await viewModel.applyWebTheme(theme)
                                onDismiss()
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(maxHeight: 400)
            Text("Switching template resets colors to that layout’s Original preset.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(18)
    }
}

// MARK: - Color palette grid (tone filter + presets)

private struct DesignColorPalettePickerSection: View {
    @ObservedObject var viewModel: DesignViewModel
    let family: TemplateFamily
    var gridSpacing: CGFloat = 10
    var usePresetCards: Bool = false
    var onSelected: (() -> Void)? = nil

    @State private var toneFilter: WebColorPalettePickerTone

    init(
        viewModel: DesignViewModel,
        family: TemplateFamily,
        gridSpacing: CGFloat = 10,
        usePresetCards: Bool = false,
        onSelected: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.family = family
        self.gridSpacing = gridSpacing
        self.usePresetCards = usePresetCards
        self.onSelected = onSelected
        _toneFilter = State(initialValue: WebColorPalettes.defaultPickerTone(for: family))
    }

    private var columns: [GridItem] {
        [GridItem(.flexible(), spacing: gridSpacing), GridItem(.flexible(), spacing: gridSpacing)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Palette tone", selection: $toneFilter) {
                ForEach(WebColorPalettePickerTone.allCases) { tone in
                    Text(tone.segmentedTitle).tag(tone)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: family) { _, newFamily in
                toneFilter = WebColorPalettes.defaultPickerTone(for: newFamily)
            }

            LazyVGrid(columns: columns, spacing: gridSpacing) {
                ForEach(WebColorPalettes.pickerItems(for: family, tone: toneFilter)) { item in
                    if usePresetCards {
                        WebColorPalettePresetCard(
                            palette: item.palette,
                            toneSubtitle: item.toneSubtitle,
                            isActive: isActive(item.palette),
                            isBusy: viewModel.isLoading
                        ) {
                            Task {
                                await viewModel.applyWebColorPalette(item.palette)
                                onSelected?()
                            }
                        }
                    } else {
                        DesignThemePalettePickerCell(
                            palette: item.palette,
                            toneSubtitle: item.toneSubtitle,
                            isActive: isActive(item.palette),
                            isBusy: viewModel.isLoading
                        ) {
                            Task {
                                await viewModel.applyWebColorPalette(item.palette)
                                onSelected?()
                            }
                        }
                    }
                }
            }

            if WebColorPalettes.showsAccentChipRowInPicker(for: family) {
                WebColorAccentChipSection(
                    accents: WebColorPalettes.accentOptions(for: family),
                    activePrimaryHex: viewModel.primaryColorHex,
                    isBusy: viewModel.isLoading
                ) { accent in
                    Task {
                        await viewModel.applyWebColorAccent(accent)
                        onSelected?()
                    }
                }
            }
        }
    }

    private func isActive(_ palette: WebColorPalette) -> Bool {
        WebColorPalettes.pickerPaletteIsActive(
            storedPaletteId: viewModel.webColorPaletteId,
            storedPrimaryHex: viewModel.primaryColorHex,
            storedBackgroundHex: viewModel.backgroundColorHex,
            palette: palette
        )
    }
}

private struct DesignThemePalettePickerCell: View {
    let palette: WebColorPalette
    var toneSubtitle: String? = nil
    let isActive: Bool
    let isBusy: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
                    Color(hex: palette.tokens.backgroundColor)
                    Color(hex: palette.tokens.cardSurfaceColor)
                    Color(hex: palette.tokens.primaryColor)
                }
                .frame(width: 36, height: 32)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(palette.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                        .multilineTextAlignment(.leading)
                    if let toneSubtitle {
                        Text(toneSubtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isActive ? Color.accentColor : Color(.separator).opacity(0.35), lineWidth: isActive ? 2 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }
}

private struct DesignThemeTemplatePickerCell: View {
    private static let previewWidth: CGFloat = 104
    private static let previewHeight: CGFloat = 68

    let family: TemplateFamily
    let isActive: Bool
    let isBusy: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 12) {
                TemplateMiniPreview(family: family)
                    .frame(width: Self.previewWidth, height: Self.previewHeight)
                    .clipped()
                Text(family.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isActive {
                    Text("Active")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isActive ? Color.accentColor : Color(.separator).opacity(0.35), lineWidth: isActive ? 2 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }
}

// MARK: - Color palette presets (Template tab)

private struct WebColorAccentChipSection: View {
    let accents: [WebColorAccentOption]
    let activePrimaryHex: String
    let isBusy: Bool
    let select: (WebColorAccentOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Button & highlight color")
                .font(.subheadline.weight(.semibold))
            Text("Updates BOOK NOW, links, and highlighted text. Background stays the same.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(accents) { accent in
                        WebColorAccentChip(
                            accent: accent,
                            isActive: WebColorPalettes.matchesAccent(storedPrimary: activePrimaryHex, option: accent),
                            isBusy: isBusy,
                            select: { select(accent) }
                        )
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

private struct WebColorAccentChip: View {
    let accent: WebColorAccentOption
    let isActive: Bool
    let isBusy: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color(hex: accent.primaryColor))
                    .frame(width: 18, height: 18)
                    .overlay(
                        Circle()
                            .stroke(Color(.separator).opacity(0.45), lineWidth: 0.5)
                    )
                Text(accent.name)
                    .font(.caption.weight(isActive ? .semibold : .regular))
                    .foregroundColor(isActive ? .primary : .secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(isActive ? Color.accentColor.opacity(0.14) : Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                Capsule()
                    .stroke(isActive ? Color.accentColor : Color(.separator).opacity(0.35), lineWidth: isActive ? 1.5 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }
}

private struct WebColorPalettePresetCard: View {
    let palette: WebColorPalette
    var toneSubtitle: String? = nil
    let isActive: Bool
    let isBusy: Bool
    let select: () -> Void

    private var previewStripColors: [String] {
        if WebColorPalettes.usesAccentPicker(family: palette.family) {
            let t = palette.tokens
            return [t.backgroundColor, t.cardSurfaceColor, t.primaryColor]
        }
        return palette.tokens.stripColors
    }

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(palette.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                        if let toneSubtitle {
                            Text(toneSubtitle)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    if isActive {
                        Text("Active")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
                            .foregroundColor(.accentColor)
                    }
                }
                HStack(spacing: 0) {
                    ForEach(Array(previewStripColors.enumerated()), id: \.offset) { _, hex in
                        Color(hex: hex)
                            .frame(height: 22)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
                )
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(isActive ? Color.accentColor : Color(.separator).opacity(0.35), lineWidth: isActive ? 2 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
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
        .appCard()
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
                    ForEach(0..<3, id: \.self) { _ in
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
                .appCard()
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
