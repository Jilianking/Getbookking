//
//  DesignView.swift
//
//  Web page design: preview on top, tabbed Branding / Form / Services / Contact.
//

import SwiftUI
import PhotosUI

struct DesignView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DesignViewModel()
    @State private var selectedTab: DesignTab = .template
    var drawerState: DrawerState
    let sectionTitle: String

    private let previewHeight: CGFloat = 180

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                previewSection
                tabPicker
                tabContent
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Live preview")
                .font(.caption)
                .foregroundColor(.secondary)
            if viewModel.hasTenant {
                WebViewPreview(url: URL(string: viewModel.bookingUrl), height: previewHeight)
                Button(action: openInSafari) {
                    HStack {
                        Image(systemName: "safari")
                        Text("Open in Safari")
                    }
                    .font(.subheadline)
                }
                .padding(.top, 4)
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.gray.opacity(0.2))
                    .frame(height: previewHeight)
                    .overlay(
                        Text("Connect your business to see preview")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding()
                    )
            }
        }
        .padding()
        .background(Color(.systemBackground))
    }

    private var tabPicker: some View {
        Picker("Section", selection: $selectedTab) {
            ForEach(DesignTab.allCases, id: \.self) { tab in
                Text(tab.rawValue.capitalized).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .padding()
        .background(Color(.systemBackground))
    }

    @ViewBuilder
    private var tabContent: some View {
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
                    case .branding: brandingContent
                    case .form: formContent
                    case .services: servicesContent
                    case .contact: contactContent
                    }
                }
            }
            .padding()
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

    private var templateContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose a template to get started")
                .font(.headline)
            Text("Form fields and services will be pre-filled. You can edit everything in the Form and Services tabs.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(BookingTemplate.allCases) { template in
                    Button(action: {
                        Task { await viewModel.applyTemplate(template) }
                        selectedTab = .form
                    }) {
                        VStack(spacing: 12) {
                            Image(systemName: template.icon)
                                .font(.system(size: 28))
                                .foregroundColor(viewModel.industry == template.rawValue ? .white : .primary)
                            Text(template.displayName)
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(viewModel.industry == template.rawValue ? .white : .primary)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                        .background(viewModel.industry == template.rawValue ? Color.black : Color(.secondarySystemGroupedBackground))
                        .cornerRadius(12)
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isLoading)
                }
            }

            if let industry = viewModel.industry, let template = BookingTemplate(rawValue: industry) {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                    Text("Using \(template.displayName) template — edit in Form & Services tabs")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    private var brandingContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Logo
            Section {
                LogoUploadSection(viewModel: viewModel)
            }

            // Colors
            Text("Colors")
                .font(.headline)
            Group {
                HexColorRow(label: "Background", hex: $viewModel.backgroundColorHex)
                HexColorRow(label: "Card surface (inside)", hex: $viewModel.cardSurfaceColorHex)
                HexColorRow(label: "Text", hex: $viewModel.textColorHex)
                HexColorRow(label: "Accent (buttons)", hex: $viewModel.primaryColorHex)
                HexColorRow(label: "Accent hover", hex: $viewModel.primaryColorHoverHex)
                HexColorRow(label: "Success", hex: $viewModel.successColorHex)
            }

            // Typography
            Text("Typography")
                .font(.headline)
            Group {
                Picker("Font", selection: $viewModel.fontFamily) {
                    Text("System").tag("system")
                    Text("Serif").tag("serif")
                    Text("Sans-serif").tag("sans-serif")
                }
                .pickerStyle(.menu)
                Picker("Font size", selection: $viewModel.fontBodySize) {
                    Text("Small").tag("small")
                    Text("Medium").tag("medium")
                    Text("Large").tag("large")
                }
                .pickerStyle(.menu)
            }

            // Appearance
            Text("Card style")
                .font(.headline)
            VStack(alignment: .leading, spacing: 8) {
                Text("Corner radius: \(Int(viewModel.cardBorderRadius))")
                    .font(.subheadline)
                Slider(value: $viewModel.cardBorderRadius, in: 0...24, step: 2)
            }

            // Tagline
            Text("Tagline")
                .font(.headline)
            TextField("Short tagline for your page", text: $viewModel.tagline)
                .textFieldStyle(.roundedBorder)

            Button("Save branding") {
                Task { await viewModel.saveBranding() }
            }
            .buttonStyle(.borderedProminent)
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
