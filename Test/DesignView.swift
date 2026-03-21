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
    @State private var selectedTab: DesignTab = .home
    @State private var isShowingBuilder = false
    @State private var hoursPickerChoice: String = "custom"
    private static let hoursPresets = ["Mon–Sat 11am–8pm", "Mon–Fri 9am–5pm", "Tue–Sat 10am–6pm", "By appointment"]
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
                            HStack(spacing: 16) {
                                Button("Edit") {
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
            }
            .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
                if let url = note.userInfo?["logoUrl"] as? String {
                    viewModel.syncLogoUrlFromExternal(url)
                }
            }
        }
        .navigationViewStyle(.stack)
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
            height: nil
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    private var builderContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(DesignTab.allCases, id: \.self) { tab in
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
                        case .home: homeContent
                        case .gallery: galleryContent
                        case .book: bookContent
                        case .about: aboutContent
                        }
                    }
                }
                .padding()
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
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

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Template
            Text("Template")
                .font(.headline)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(BookingTemplate.allCases) { template in
                    Button(action: {
                        Task { await viewModel.applyTemplate(template) }
                    }) {
                        VStack(spacing: 8) {
                            Image(systemName: template.icon)
                                .font(.system(size: 24))
                            Text(template.displayName)
                                .font(.caption.weight(.medium))
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(viewModel.industry == template.rawValue ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                        .foregroundColor(viewModel.industry == template.rawValue ? .white : .primary)
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isLoading)
                }
            }

            // Hero
            Text("Hero")
                .font(.headline)
            TextField("Business name", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
            HeroImageUploadSection(viewModel: viewModel)

            // Typography — hero, gallery, booking titles (Google Fonts on the public site)
            Text("Typography")
                .font(.headline)
                .padding(.top, 8)
            Text("Font for the large hero title on your public site. Body, sidebar, and other text use Inter. Save Home and deploy hosting.")
                .font(.caption)
                .foregroundColor(.secondary)
            Picker("Hero font", selection: $viewModel.heroFont) {
                ForEach(DisplayFontOption.allCases) { opt in
                    Text(opt.displayName).tag(opt.rawValue)
                }
            }

            // Featured work
            Text("Featured work")
                .font(.headline)
            Picker("Featured work layout", selection: $viewModel.galleryGridLayout) {
                Text("2 wide").tag("2x1")
                Text("3 wide").tag("3x1")
            }
            .pickerStyle(.segmented)
            FeaturedWorkHomeGallerySection(viewModel: viewModel)

            Text("Home & booking sections")
                .font(.headline)
                .padding(.top, 8)
            Group {
                if viewModel.industry == "tattoos" {
                    Text("Featured strip and /gallery page share one background. The booking page uses that behind a white card—pick a preset below.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("Featured strip on your home page and the booking form card.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            FeaturedWorkPresetPicker(viewModel: viewModel)
            if viewModel.industry == "tattoos" {
                Text("Booking form card sits on that background—default is white; override below if you want.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            HexColorRow(label: "Booking form card", hex: $viewModel.bookingFormCardBackgroundColorHex)

            // Sidebar
            Text("Sidebar")
                .font(.headline)
            Text("Icon color auto-detects: black on white backgrounds, white on colored backgrounds. Override per page if needed.")
                .font(.caption)
                .foregroundColor(.secondary)
            HexColorRow(label: "Home page icon color", hex: $viewModel.sidebarIconColorHome)
            HexColorRow(label: "Booking page icon color", hex: $viewModel.sidebarIconColorBooking)

            Button("Save Home") {
                Task { await viewModel.saveHome() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var galleryContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Gallery")
                .font(.headline)
            Text("These photos appear only on your /gallery page—not on the home featured strip.")
                .font(.caption)
                .foregroundColor(.secondary)

            GalleryImagesSection(viewModel: viewModel)

            Text("Tip: Upload your best healed work here.")
                .font(.caption)
                .foregroundColor(.secondary)

            Text("Gallery page")
                .font(.headline)
                .padding(.top, 8)
            if viewModel.industry == "tattoos" {
                Text("Background and text match Home → Featured section. Change colors on the Home tab (Featured work presets).")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else {
                Text("Full /gallery page background and text.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                HexColorRow(label: "Page background", hex: $viewModel.galleryPageBackgroundColorHex)
                HexColorRow(label: "Page text", hex: $viewModel.galleryPageTextColorHex)
                Button("Save gallery page colors") {
                    Task { await viewModel.saveGalleryPageColors() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var bookContent: some View {
        VStack(alignment: .leading, spacing: 24) {
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
        }
    }

    private var aboutContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("ABOUT")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .tracking(1)
            Text("This appears in the Meet section on your site.")
                .font(.caption)
                .foregroundColor(.secondary)
            Text("Meet section colors")
                .font(.subheadline.weight(.medium))
            HexColorRow(label: "Section background", hex: $viewModel.aboutSectionBackgroundColorHex)
            HexColorRow(label: "Section text", hex: $viewModel.aboutSectionTextColorHex)
            TextField("Tell clients about you and your business", text: $viewModel.aboutText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...8)

            Text("CONTACT")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .tracking(1)
                .padding(.top, 8)

            VStack(spacing: 12) {
                IconFieldRow(icon: "phone", placeholder: "(555) 123-4567", text: Binding(
                    get: { viewModel.contactPhone },
                    set: { viewModel.contactPhone = Self.formatPhone($0) }
                ))
                .keyboardType(.phonePad)

                IconFieldRow(icon: "envelope", placeholder: "example@example.com", text: $viewModel.contactEmail)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)

                IconFieldRow(icon: "mappin.circle", placeholder: "123 Main St, City, State", text: $viewModel.contactAddress)

                HStack(spacing: 10) {
                    Image(systemName: "clock")
                        .foregroundColor(.secondary)
                        .frame(width: 24)
                    Picker("Hours", selection: $hoursPickerChoice) {
                        ForEach(Self.hoursPresets, id: \.self) { preset in
                            Text(preset).tag(preset)
                        }
                        Text("Custom").tag("custom")
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .cornerRadius(10)
                .onChange(of: hoursPickerChoice) { _, new in
                    if new != "custom" { viewModel.businessHours = new }
                }
                .onAppear {
                    hoursPickerChoice = Self.hoursPresets.contains(viewModel.businessHours) ? viewModel.businessHours : "custom"
                }
                .onChange(of: viewModel.businessHours) { _, new in
                    if Self.hoursPresets.contains(new) { hoursPickerChoice = new }
                }

                if hoursPickerChoice == "custom" {
                    IconFieldRow(icon: "clock.badge", placeholder: "e.g. Sun 11am–5pm", text: $viewModel.businessHours)
                }

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
        }
    }

    private static func formatPhone(_ input: String) -> String {
        let digits = input.filter { $0.isNumber }
        let limited = String(digits.prefix(10))
        var result = ""
        for (i, d) in limited.enumerated() {
            if i == 0 { result += "(" }
            if i == 3 { result += ") " }
            if i == 6 { result += "-" }
            result.append(d)
        }
        return result
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

// MARK: - Hero image upload
struct HeroImageUploadSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItem: PhotosPickerItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hero background image")
                .font(.subheadline.weight(.medium))
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
                            guard let newItem = newItem else { return }
                            if let data = try? await newItem.loadTransferable(type: Data.self), !data.isEmpty {
                                await viewModel.uploadHeroImage(imageData: data)
                            }
                            await MainActor.run { selectedItem = nil }
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
    }
}

// MARK: - Gallery page images only
struct GalleryImagesSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItems: [PhotosPickerItem] = []

    /// Wraps thumbnails in rows; parent `ScrollView` handles vertical scrolling.
    private let thumbGridColumns = [GridItem(.adaptive(minimum: 72), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gallery page photos")
                .font(.subheadline.weight(.medium))
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

                        for item in itemsToUpload {
                            if let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty {
                                await viewModel.addGalleryImage(imageData: data)
                            }
                        }
                        await MainActor.run { selectedItems.removeAll() }
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
    }
}

// MARK: - Featured work on Home tab (separate from gallery page photos)
struct FeaturedWorkHomeGallerySection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItems: [PhotosPickerItem] = []

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
            Text("Featured work photos")
                .font(.subheadline.weight(.medium))
            Text("These appear only on your home featured strip (first \(slots) slots for \(layoutCaptionLabel)). Add your full portfolio under the Gallery tab—they won’t show here.")
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
                for item in itemsToUpload {
                    if let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty {
                        await viewModel.addFeaturedWorkImage(imageData: data)
                    }
                }
                await MainActor.run { selectedItems.removeAll() }
            }
        }
    }
}

// MARK: - Featured work color presets (paired bg + text)
struct FeaturedWorkPresetPicker: View {
    @ObservedObject var viewModel: DesignViewModel
    private let columns = [GridItem(.adaptive(minimum: 88), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Featured section colors")
                .font(.subheadline.weight(.medium))
            Text("Preset pairs—background and text stay readable together.")
                .font(.caption)
                .foregroundColor(.secondary)
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                ForEach(FeaturedWorkColorPresets.all) { preset in
                    Button {
                        viewModel.applyFeaturedWorkPreset(preset)
                    } label: {
                        VStack(spacing: 6) {
                            Circle()
                                .fill(Color(hex: preset.backgroundHex))
                                .frame(width: 40, height: 40)
                                .overlay(
                                    Circle()
                                        .strokeBorder(
                                            isSelected(preset) ? Color.accentColor : Color.primary.opacity(0.2),
                                            lineWidth: isSelected(preset) ? 3 : 1
                                        )
                                )
                            Text(preset.name)
                                .font(.caption2)
                                .foregroundColor(.primary)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                                .frame(minWidth: 72)
                        }
                        .padding(8)
                        .background(isSelected(preset) ? Color.accentColor.opacity(0.12) : Color(.secondarySystemGroupedBackground))
                        .cornerRadius(10)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func isSelected(_ preset: FeaturedWorkColorPreset) -> Bool {
        normalizeHex(preset.backgroundHex) == normalizeHex(viewModel.featuredWorkBackgroundColorHex)
    }

    private func normalizeHex(_ s: String) -> String {
        var x = s.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if x.hasPrefix("#") { x.removeFirst() }
        return x
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
    @State private var name = ""
    @State private var duration = 30
    @State private var showingSheet = false

    var body: some View {
        Button(action: { showingSheet = true }) {
            HStack {
                Image(systemName: "plus")
                Text("Add service")
            }
        }
        .sheet(isPresented: $showingSheet) {
            NavigationView {
                Form {
                    TextField("Service name", text: $name)
                    Stepper("Duration: \(duration) min", value: $duration, in: 15...240, step: 15)
                }
                .navigationTitle("New service")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showingSheet = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") {
                            Task {
                                await viewModel.addService(name: name, durationMinutes: duration)
                                name = ""
                                duration = 30
                                showingSheet = false
                            }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }
}

// MARK: - Icon + text field row
struct IconFieldRow: View {
    let icon: String
    let placeholder: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundColor(.secondary)
                .frame(width: 24)
            TextField(placeholder, text: $text)
                .font(.subheadline)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(10)
    }
}
