//
//  DesignView.swift
//
//  Web page design: Preview mode (default) + Builder mode with tabs.
//

import SwiftUI
import PhotosUI

enum HeroPattern: String, CaseIterable {
    case none = ""
    case circles_and_squares = "circles_and_squares"
    case squares_in_squares = "squares_in_squares"
    case bubbles = "bubbles"
    case bamboo = "bamboo"
    case bathroom_floor = "bathroom_floor"
    case hexagons = "hexagons"
    case texture = "texture"
    case topography = "topography"
}

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
        }
        .navigationViewStyle(.stack)
    }

    private var previewContent: some View {
        WebViewPreview(
            url: viewModel.hasTenant ? URL(string: viewModel.bookingUrl) : nil,
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

            // Appearance
            Text("Appearance")
                .font(.headline)
            LogoUploadSection(viewModel: viewModel)
            Group {
                HexColorRow(label: "Background", hex: $viewModel.backgroundColorHex)
                HexColorRow(label: "Card surface", hex: $viewModel.cardSurfaceColorHex)
                HexColorRow(label: "Text", hex: $viewModel.textColorHex)
                HexColorRow(label: "Accent (buttons)", hex: $viewModel.primaryColorHex)
            }
            Text("Background pattern")
                .font(.subheadline.weight(.medium))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))], spacing: 8) {
                ForEach(HeroPattern.allCases, id: \.rawValue) { p in
                    Button(action: { viewModel.backgroundPattern = p.rawValue }) {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(p == .none ? Color(.systemGray5) : Color(hex: viewModel.backgroundPatternColorHex).opacity(viewModel.backgroundPatternOpacity))
                            .frame(width: 44, height: 44)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(viewModel.backgroundPattern == p.rawValue ? Color.accentColor : Color.clear, lineWidth: 2)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            HexColorRow(label: "Pattern color", hex: $viewModel.backgroundPatternColorHex)
            Text("Tagline")
                .font(.subheadline.weight(.medium))
            TextField("Short tagline for your page", text: $viewModel.tagline)
                .textFieldStyle(.roundedBorder)

            // Hero
            Text("Hero")
                .font(.headline)
            TextField("Business name", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
            HeroImageUploadSection(viewModel: viewModel)

            // Featured work
            Text("Featured work")
                .font(.headline)
            Text("Gallery layout")
                .font(.subheadline.weight(.medium))
            Picker("Layout", selection: $viewModel.galleryGridLayout) {
                Text("3 in a row").tag("3x1")
                Text("2×2 grid").tag("2x2")
                Text("3×6 grid").tag("3x6")
            }
            .pickerStyle(.segmented)
            GalleryImagesSection(viewModel: viewModel)

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
            Text("These photos appear on your Gallery page in a big grid.")
                .font(.caption)
                .foregroundColor(.secondary)

            GalleryImagesSection(viewModel: viewModel)

            Text("Tip: Upload your best healed work here.")
                .font(.caption)
                .foregroundColor(.secondary)
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

// MARK: - Logo upload
struct LogoUploadSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItem: PhotosPickerItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Logo")
                .font(.headline)
            HStack(spacing: 16) {
                if let urlString = viewModel.logoUrl.isEmpty ? nil : viewModel.logoUrl,
                   let url = URL(string: urlString) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fit)
                    } placeholder: {
                        Color.gray.opacity(0.2)
                    }
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 64, height: 64)
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
                            Text(viewModel.logoUrl.isEmpty ? "Choose photo" : "Change logo")
                        }
                        .font(.subheadline)
                    }
                    .onChange(of: selectedItem) { _, newItem in
                        Task {
                            guard let newItem = newItem else { return }
                            if let data = try? await newItem.loadTransferable(type: Data.self), !data.isEmpty {
                                await viewModel.uploadLogo(imageData: data)
                            }
                            await MainActor.run { selectedItem = nil }
                        }
                    }
                    if viewModel.isUploadingLogo {
                        ProgressView()
                            .scaleEffect(0.8)
                    }
                }
                Spacer()
            }
        }
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

// MARK: - Gallery images
struct GalleryImagesSection: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedItem: PhotosPickerItem?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Portfolio / gallery (Featured work)")
                .font(.subheadline.weight(.medium))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
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
                        selection: $selectedItem,
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
                    .onChange(of: selectedItem) { _, newItem in
                        Task {
                            guard let newItem = newItem else { return }
                            if let data = try? await newItem.loadTransferable(type: Data.self), !data.isEmpty {
                                await viewModel.addGalleryImage(imageData: data)
                            }
                            await MainActor.run { selectedItem = nil }
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
