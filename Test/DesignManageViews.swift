//
//  DesignManageViews.swift
//
//  Manage mode tabs in Design (Gallery, Book, About, Shop).
//

import SwiftUI
import PhotosUI
import UIKit
import FirebaseAuth

// MARK: - Shared chrome

struct ManageSectionHeader: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .tracking(0.6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }
}

struct ManageCard<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .appCard()
    }
}

/// Segmented tab bar matching Web design → Manage mode.
struct ManageSegmentTabs<Tab: Hashable>: View {
    let tabs: [Tab]
    @Binding var selectedTab: Tab
    let title: (Tab) -> String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.self) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    Text(title(tab))
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
    }
}

/// Read-only theme bar for team members (matches owner preview chrome; no editing).
struct DesignThemeDisplayBar: View {
    let paletteName: String
    let templateFamily: TemplateFamily
    let accentHex: String

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            displayPill(title: paletteName) {
                Circle()
                    .fill(Color(hex: accentHex))
                    .frame(width: 10, height: 10)
                    .overlay(
                        Circle()
                            .stroke(Color(.separator).opacity(0.4), lineWidth: 0.5)
                    )
            }
            displayPill(title: templateFamily.displayName) {
                Image(systemName: templateFamily.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, height: 14)
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

    private func displayPill<Leading: View>(title: String, @ViewBuilder leading: () -> Leading) -> some View {
        HStack(spacing: 8) {
            leading()
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
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
}

struct ManageNavigationRow: View {
    let title: String
    var subtitle: String? = nil
    let value: String
    var action: (() -> Void)? = nil

    var body: some View {
        Group {
            if let action {
                Button(action: action) {
                    rowContent
                }
                .buttonStyle(.plain)
            } else {
                rowContent
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    private var rowContent: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if action != nil {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct ManageToggleRow: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    @Binding var isOn: Bool
    var disabled: Bool = false
    var onChange: (() -> Void)? = nil

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .frame(width: 22, alignment: .center)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body.weight(.medium))
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .tint(.green)
        .disabled(disabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .onChange(of: isOn) { _, _ in
            onChange?()
        }
    }
}

struct ManageCardDivider: View {
    var leadingInset: CGFloat = 14

    var body: some View {
        Divider().padding(.leading, leadingInset)
    }
}

// MARK: - Gallery

/// Option C: upload zone + count row on the Manage tab; full square grid in a sheet.
struct ManageGalleryPhotosBlock: View {
    @ObservedObject var viewModel: DesignViewModel
    @Binding var galleryBatchCrop: MultiImageCropSheetItem?
    @Binding var showPickerLoadError: Bool

    @State private var showManageSheet = false
    @State private var selectedItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ManageGalleryUploadZone(
                selectedItems: $selectedItems,
                isDemoReadOnly: viewModel.isDemoReadOnly,
                onDemoBlocked: { viewModel.showDemoBlockedAlert = true }
            )
                .onChange(of: selectedItems) { _, newItems in
                    Task { await processPickerItems(newItems) }
                }

            Button {
                showManageSheet = true
            } label: {
                ManageGalleryPhotoSummaryRow(imageURLs: viewModel.galleryImages)
            }
            .buttonStyle(.plain)
            .appCard()

            Text("Photos open in a full manage sheet.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if viewModel.isUploadingGallery {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Uploading…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .sheet(isPresented: $showManageSheet) {
            ManageGalleryPhotosSheet(viewModel: viewModel)
        }
    }

    private func processPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }

        if viewModel.isDemoReadOnly {
            await MainActor.run {
                selectedItems.removeAll()
                viewModel.showDemoBlockedAlert = true
            }
            return
        }

        guard viewModel.hasTenant else {
            await MainActor.run {
                selectedItems.removeAll()
                viewModel.errorMessage = "Connect a business before uploading photos."
                showPickerLoadError = true
            }
            return
        }

        let indexedPairs: [(Int, Data)] = await withTaskGroup(of: (Int, Data?).self, returning: [(Int, Data)].self) { group in
            for (i, item) in items.enumerated() {
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
        let images: [UIImage] = indexedPairs.map(\.1).compactMap { UIImage(data: $0) }
        await MainActor.run {
            selectedItems.removeAll()
            guard !images.isEmpty else {
                if !items.isEmpty {
                    viewModel.errorMessage = "Couldn't load the selected photos."
                    showPickerLoadError = true
                }
                return
            }
            galleryBatchCrop = MultiImageCropSheetItem(images: images)
        }
    }
}

private struct ManageGalleryUploadZone: View {
    @Binding var selectedItems: [PhotosPickerItem]
    var isDemoReadOnly: Bool = false
    var onDemoBlocked: (() -> Void)? = nil

    var body: some View {
        Group {
            if isDemoReadOnly {
                Button {
                    onDemoBlocked?()
                } label: {
                    uploadZoneChrome
                }
                .buttonStyle(.plain)
            } else {
                PhotosPicker(
                    selection: $selectedItems,
                    matching: .images,
                    photoLibrary: .shared()
                ) {
                    uploadZoneChrome
                }
                .buttonStyle(.plain)
            }
        }
        .appCard()
    }

    private var uploadZoneChrome: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(
                Color(.systemGray3),
                style: StrokeStyle(lineWidth: 1.5, dash: [8, 6])
            )
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .frame(height: 132)
            .overlay {
                VStack(spacing: 10) {
                    Image(systemName: isDemoReadOnly ? "eye" : "photo.on.rectangle.angled")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(isDemoReadOnly ? "Preview only in demo" : "Add photos")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
    }
}

private struct ManageGalleryPhotoSummaryRow: View {
    let imageURLs: [String]

    private var photoCountLabel: String {
        let count = imageURLs.count
        return count == 1 ? "1 photo" : "\(count) photos"
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(spacing: 8) {
                if imageURLs.isEmpty {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.systemGray5))
                        .frame(width: 44, height: 44)
                        .overlay {
                            Image(systemName: "photo")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                } else {
                    ForEach(Array(imageURLs.prefix(3).enumerated()), id: \.offset) { _, urlString in
                        ManageGallerySquareThumb(urlString: urlString, side: 44, cornerRadius: 8)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(photoCountLabel)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(imageURLs.isEmpty ? "Add your first photo above" : "Tap to manage")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

private struct ManageGalleryPhotosSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss

    private let gridColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                if viewModel.galleryImages.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text("No gallery photos yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text("Use Add photos on the Gallery tab.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
                } else {
                    LazyVGrid(columns: gridColumns, spacing: 10) {
                        ForEach(Array(viewModel.galleryImages.enumerated()), id: \.offset) { index, urlString in
                            ManageGalleryEditableCell(
                                urlString: urlString,
                                onDelete: {
                                    Task { await viewModel.removeGalleryImage(at: index) }
                                }
                            )
                        }
                    }
                    .padding(16)
                }
            }
            .appScreenBackground()
            .navigationTitle("Gallery photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct ManageGalleryEditableCell: View {
    let urlString: String
    let onDelete: () -> Void

    private let cornerRadius: CGFloat = 12

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color(.systemGray5))
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                Group {
                    if let url = URL(string: urlString) {
                        AsyncImage(url: url) { image in
                            image
                                .resizable()
                                .scaledToFill()
                        } placeholder: {
                            Color(.systemGray5)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .frame(maxWidth: .infinity)
            .overlay(alignment: .topTrailing) {
                Button(action: onDelete) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.white, .red)
                }
                .padding(4)
            }
    }
}

private struct ManageGallerySquareThumb: View {
    let urlString: String
    /// When nil, fills the parent square cell.
    var side: CGFloat?
    var cornerRadius: CGFloat

    var body: some View {
        Group {
            if let url = URL(string: urlString) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    Color(.systemGray5)
                }
            } else {
                Color(.systemGray5)
            }
        }
        .modifier(ManageGallerySquareFrame(side: side, cornerRadius: cornerRadius))
    }
}

private struct ManageGallerySquareFrame: ViewModifier {
    let side: CGFloat?
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        if let side {
            content
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }
}

struct ManageGalleryTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    let isTeamPlan: Bool
    let isStudio12Template: Bool
    @Binding var galleryBatchCrop: MultiImageCropSheetItem?
    @Binding var showGalleryPickerLoadError: Bool
    @State private var showGalleryStylePicker = false

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ManageSectionHeader("Gallery photos")
            ManageGalleryPhotosBlock(
                viewModel: viewModel,
                galleryBatchCrop: $galleryBatchCrop,
                showPickerLoadError: $showGalleryPickerLoadError
            )
            if isTeamPlan {
                Text("Per-artist portfolios (team & booking pages) are managed under the Team tab. Photos here appear on /gallery alongside artist work.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ManageSectionHeader("Layout")
            ManageCard {
                ManageNavigationRow(
                    title: "Gallery style",
                    subtitle: "How /gallery looks on your site",
                    value: viewModel.galleryLayoutStyle.menuTitle
                ) {
                    showGalleryStylePicker = true
                }

                if isStudio12Template {
                    ManageCardDivider()
                    ManageNavigationRow(
                        title: "Home page scroll",
                        subtitle: "Wide scrolling row on your home page",
                        value: "Wide horizontal strip"
                    )
                }

                ManageCardDivider()
                ManageToggleRow(
                    title: "Gallery page enabled",
                    subtitle: "Visible at /gallery on your site",
                    isOn: $viewModel.showGalleryPage,
                    disabled: controlsDisabled
                ) {
                    Task { await viewModel.savePublicPageVisibility() }
                }
            }
        }
        .sheet(isPresented: $showGalleryStylePicker) {
            ManageGalleryStylePickerSheet(viewModel: viewModel)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct ManageGalleryStylePickerSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(GalleryLayoutStyle.allCases) { style in
                    Button {
                        viewModel.galleryLayoutStyle = style
                        Task {
                            await viewModel.saveGalleryLayoutStyle()
                            dismiss()
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(style.menuTitle)
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(Color.primary)
                                Text(style.detail)
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                            Spacer()
                            if viewModel.galleryLayoutStyle == style {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(controlsDisabled)
                }
            }
            .navigationTitle("Gallery style")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Book

struct ManageBusinessHoursBlock: View {
    @ObservedObject var viewModel: DesignViewModel

    @State private var showManageSheet = false

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    private var hoursSummary: String {
        let lines = viewModel.businessHoursWeekly.formattedDisplayString()
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
        guard let first = lines.first else { return "Set your weekly hours" }
        if lines.count == 1 { return first }
        return first + " · " + "\(lines.count) day groups"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ManageCard {
                ManageNavigationRow(
                    title: "Weekly hours",
                    subtitle: hoursSummary,
                    value: "Edit"
                ) {
                    showManageSheet = true
                }

                ManageCardDivider()

                ManageToggleRow(
                    title: "Show hours on site",
                    subtitle: "About, contact, and footer sections",
                    isOn: $viewModel.showBusinessHoursOnPage,
                    disabled: controlsDisabled
                ) {
                    Task { await viewModel.saveBusinessHours() }
                }
            }

            Text("Also editable in Settings → Scheduling & hours.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .sheet(isPresented: $showManageSheet) {
            ManageBusinessHoursSheet(viewModel: viewModel)
        }
    }
}

private struct ManageBusinessHoursSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                BusinessHoursWeeklyEditor(viewModel: viewModel) {
                    await viewModel.saveBusinessHours()
                }
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle("Business hours")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ManageAboutTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    let isClassicTemplate: Bool

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if isClassicTemplate {
                ManageSectionHeader("About stats")
                ManageCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Three headline figures under your story on Classic home and /about.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ManageToggleRow(
                            title: "Show stats row",
                            subtitle: "When off, stats hide but story and contact stay",
                            isOn: $viewModel.classicShowAboutStats,
                            disabled: controlsDisabled
                        )
                        ManageCardDivider()
                        classicStatFields(label: "First stat", value: $viewModel.classicStatYearsValue, caption: $viewModel.classicStatYearsLabel)
                        ManageCardDivider()
                        classicStatFields(label: "Second stat", value: $viewModel.classicStatClientsValue, caption: $viewModel.classicStatClientsLabel)
                        ManageCardDivider()
                        classicStatFields(label: "Third stat", value: $viewModel.classicStatRatedValue, caption: $viewModel.classicStatRatedLabel)
                    }
                    .padding(.vertical, 4)
                }
            }

            ManageSectionHeader("Contact")
            ManageCard {
                VStack(spacing: 12) {
                    IconFieldRow(icon: "phone", placeholder: "(555) 123-4567", text: Binding(
                        get: { viewModel.contactPhone },
                        set: { viewModel.contactPhone = PhoneFormatting.formatAsYouType($0) }
                    ))
                    .keyboardType(.phonePad)
                    .disabled(controlsDisabled)

                    IconFieldRow(icon: "envelope", placeholder: "example@example.com", text: $viewModel.contactEmail)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .disabled(controlsDisabled)

                    IconFieldRow(icon: "mappin.circle", placeholder: "Street address", text: $viewModel.contactAddress)
                        .disabled(controlsDisabled)

                    IconFieldRow(
                        icon: "number",
                        placeholder: "Suite / apt (optional)",
                        text: $viewModel.contactAddressSuite
                    )
                    .disabled(controlsDisabled)

                    ServiceAreaCityStateFields(viewModel: viewModel)

                    Text("Add your Instagram username to show a link on your site footer and contact sections.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)

                    IconFieldRow(
                        icon: "camera",
                        placeholder: "Instagram username",
                        text: $viewModel.instagramHandle
                    )
                        .textInputAutocapitalization(.never)
                        .disabled(controlsDisabled)
                }
                .padding(14)
            }

            ManageSectionHeader("Business hours")
            ManageBusinessHoursBlock(viewModel: viewModel)

            ManageSectionHeader("Visibility")
            ManageCard {
                ManageToggleRow(
                    title: "Show contact on site",
                    subtitle: "Phone, email, address, and Instagram",
                    isOn: $viewModel.showContactOnPage,
                    disabled: controlsDisabled
                )
                ManageCardDivider()
                ManageToggleRow(
                    title: "About page enabled",
                    subtitle: "Visible at /about on your site",
                    isOn: $viewModel.showAboutPage,
                    disabled: controlsDisabled
                ) {
                    Task { await viewModel.savePublicPageVisibility() }
                }
            }

            HStack(spacing: 12) {
                Button("Discard") {
                    Task { await viewModel.loadData() }
                }
                .buttonStyle(.bordered)
                .disabled(controlsDisabled)
                Button("Save changes") {
                    Task { await viewModel.saveAbout() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(controlsDisabled)
            }

            Text("Appointment availability is in Settings → Scheduling & hours.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func classicStatFields(label: String, value: Binding<String>, caption: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 14)
            TextField("Value", text: value)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 14)
                .disabled(controlsDisabled)
            TextField("Caption", text: caption)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 14)
                .disabled(controlsDisabled)
        }
        .padding(.vertical, 8)
    }
}

struct ManageBookTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    let teamAccess: EffectiveTeamAccess
    @Binding var serviceToEdit: TenantService?
    @Binding var formFieldToEdit: FormField?
    @State private var showFormStylePicker = false
    @State private var showFormFieldsSheet = false

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    private var resolvedFormStyle: BookingFormStyle {
        BookingFormStyle.resolved(stored: viewModel.bookingFormStyleId)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ManageSectionHeader("Booking form")
            ManageCard {
                if teamAccess.canManageBookingFormStyle {
                    ManageNavigationRow(
                        title: "Form style",
                        subtitle: resolvedFormStyle.subtitle,
                        value: resolvedFormStyle.displayName
                    ) {
                        showFormStylePicker = true
                    }
                } else {
                    ManageNavigationRow(
                        title: "Form style",
                        subtitle: "Only the owner or a manager can change this",
                        value: resolvedFormStyle.displayName
                    )
                }

                ManageCardDivider()
                ManageNavigationRow(
                    title: "Form fields",
                    subtitle: "\(viewModel.formFields.count) fields",
                    value: "Edit"
                ) {
                    showFormFieldsSheet = true
                }

                ManageCardDivider()
                ManageToggleRow(
                    title: "Book page enabled",
                    subtitle: "Visible at /book on your site",
                    isOn: $viewModel.showBookPage,
                    disabled: controlsDisabled
                ) {
                    Task { await viewModel.savePublicPageVisibility() }
                }
            }

            ManageSectionHeader("Services")
            ManageCard {
                if teamAccess.canEditServicesPricing {
                    if viewModel.services.isEmpty {
                        Text("No services yet—add one so clients can book.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(14)
                    } else {
                        ForEach(Array(viewModel.services.enumerated()), id: \.element.id) { index, service in
                            if index > 0 { ManageCardDivider() }
                            ManageServiceRow(
                                service: service,
                                controlsDisabled: controlsDisabled,
                                onEdit: { serviceToEdit = service },
                                onMoveUp: {
                                    Task { await viewModel.moveService(from: index, direction: -1) }
                                },
                                onMoveDown: {
                                    Task { await viewModel.moveService(from: index, direction: 1) }
                                },
                                canMoveUp: index > 0,
                                canMoveDown: index < viewModel.services.count - 1
                            )
                        }
                    }

                    ManageCardDivider()
                    AddServiceSheet(viewModel: viewModel, disabled: controlsDisabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                } else {
                    if viewModel.services.isEmpty {
                        Text("No services configured yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(14)
                    } else {
                        ForEach(viewModel.services) { service in
                            ManageNavigationRow(
                                title: service.name,
                                value: service.bladePriceCaption
                            )
                        }
                    }
                    Text("You don’t have permission to edit services.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 12)
                }
            }
        }
        .sheet(isPresented: $showFormStylePicker) {
            ManageBookingFormStylePickerSheet(viewModel: viewModel)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showFormFieldsSheet) {
            ManageFormFieldsSheet(viewModel: viewModel, formFieldToEdit: $formFieldToEdit)
        }
    }
}

private struct ManageServiceRow: View {
    let service: TenantService
    let controlsDisabled: Bool
    let onEdit: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let canMoveUp: Bool
    let canMoveDown: Bool

    private var subtitle: String {
        var parts: [String] = [service.bladePriceCaption]
        if let minutes = service.durationMinutes, minutes > 0 {
            parts.append("\(minutes) min")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        Button(action: onEdit) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "line.3.horizontal")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(controlsDisabled)
        .contextMenu {
            Button("Edit", action: onEdit)
            Button("Move up", action: onMoveUp).disabled(!canMoveUp || controlsDisabled)
            Button("Move down", action: onMoveDown).disabled(!canMoveDown || controlsDisabled)
        }
    }
}

private struct ManageBookingFormStylePickerSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Environment(\.dismiss) private var dismiss

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(BookingFormStyle.allCases) { style in
                    Button {
                        viewModel.bookingFormStyleId = style.rawValue
                        Task {
                            await viewModel.saveBookingFormStyle()
                            dismiss()
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(style.displayName)
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(Color.primary)
                                Text(style.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if BookingFormStyle.resolved(stored: viewModel.bookingFormStyleId) == style {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .disabled(controlsDisabled)
                }
            }
            .navigationTitle("Form style")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct ManageFormFieldsSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    @Binding var formFieldToEdit: FormField?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(viewModel.formFields) { field in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(field.label)
                                    .font(.subheadline.weight(.medium))
                                Text("\(field.type.displayName) • \(field.required ? "Required" : "Optional")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
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
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    Button(action: { viewModel.addFormField() }) {
                        Label("Add field", systemImage: "plus")
                    }

                    Button("Save form") {
                        Task { await viewModel.saveFormFields() }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(16)
            }
            .navigationTitle("Form fields")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Team (Studio / Shop)

struct ManageTeamTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    @EnvironmentObject private var authViewModel: AuthViewModel
    @StateObject private var portfolioTeamVM = ManagerSettingsViewModel()

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    private var teamPageURL: String? {
        let slug = viewModel.tenantSlug?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !slug.isEmpty else { return nil }
        return "\(slug).getbookking.com/team"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ManageSectionHeader("Visibility")
            ManageCard {
                ManageToggleRow(
                    title: "Team page enabled",
                    subtitle: "Full roster at /team",
                    isOn: $viewModel.showTeamPage,
                    disabled: controlsDisabled
                )
                ManageCardDivider()
                ManageToggleRow(
                    title: "Show on home",
                    subtitle: "Team strip above footer",
                    isOn: $viewModel.showMeetTheTeamOnHome,
                    disabled: controlsDisabled
                )
            }

            ManageSectionHeader("Team members")
            if viewModel.teamMemberVisibility.isEmpty {
                ManageCard {
                    Text(viewModel.isLoading ? "Loading team…" : "No team members yet. Invite people from Team in the main menu.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(14)
                }
            } else {
                ForEach($viewModel.teamMemberVisibility) { $member in
                    ManageTeamMemberVisibilityCard(
                        viewModel: viewModel,
                        portfolioTeamVM: portfolioTeamVM,
                        isDemoMode: authViewModel.isDemoMode,
                        member: $member,
                        disabled: controlsDisabled,
                        startsExpanded: member.id == viewModel.teamMemberVisibility.first?.id
                    )
                }
            }
            if let url = teamPageURL, viewModel.showTeamPage {
                Text(url)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            HStack(spacing: 12) {
                Button("Discard") {
                    Task { await viewModel.loadData() }
                }
                .buttonStyle(.bordered)
                .disabled(controlsDisabled)
                Button("Save changes") {
                    Task { await viewModel.saveTeamPageSettings() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(controlsDisabled)
            }
        }
        .task {
            await portfolioTeamVM.load(isDemoMode: authViewModel.isDemoMode)
        }
    }
}

private struct ManageTeamMemberVisibilityCard: View {
    @ObservedObject var viewModel: DesignViewModel
    @ObservedObject var portfolioTeamVM: ManagerSettingsViewModel
    @EnvironmentObject private var authViewModel: AuthViewModel
    let isDemoMode: Bool
    @Binding var member: TeamMemberVisibilityDraft
    var disabled: Bool
    var startsExpanded: Bool

    @State private var isExpanded: Bool
    @State private var photoPickerItem: PhotosPickerItem?
    @State private var cropItem: SingleImageCropSheetItem?

    init(
        viewModel: DesignViewModel,
        portfolioTeamVM: ManagerSettingsViewModel,
        isDemoMode: Bool,
        member: Binding<TeamMemberVisibilityDraft>,
        disabled: Bool,
        startsExpanded: Bool = false
    ) {
        self.viewModel = viewModel
        self.portfolioTeamVM = portfolioTeamVM
        self.isDemoMode = isDemoMode
        _member = member
        self.disabled = disabled
        self.startsExpanded = startsExpanded
        _isExpanded = State(initialValue: startsExpanded)
    }

    private var portfolioMember: TenantTeamMember? {
        portfolioTeamVM.member(byUid: member.uid)
    }

    /// Owner upload works even before roster finishes loading or when toggles are off.
    private var uploadablePortfolioMember: TenantTeamMember? {
        if let live = portfolioMember { return live }
        guard authViewModel.teamAccess.isOwner else { return nil }
        var settings = TeamMemberSettings()
        settings.canEditPortfolio = member.canEditPortfolio
        settings.canEditPublicBio = member.canEditPublicBio
        return TenantTeamMember(
            uid: member.uid,
            displayName: member.displayName,
            email: "",
            phone: "",
            profilePhotoUrl: member.profilePhotoUrl,
            accessRole: member.accessRole,
            jobTitle: member.jobTitle,
            memberSlug: member.memberSlug,
            isBookable: member.isBookable,
            showOnTeamPage: member.showOnTeamPage,
            showOnTeamHome: member.showOnTeamHome,
            providerAboutText: member.providerAboutText,
            providerGalleryImages: [],
            smsEnabled: false,
            smsStatus: "off",
            smsPhoneNumber: "",
            memberSettings: settings,
            personalConfirmationType: nil,
            effectiveConfirmationType: nil
        )
    }

    private var ownerEditingMemberPortfolio: Bool {
        guard let currentUid = Auth.auth().currentUser?.uid else { return false }
        let isOwner = portfolioTeamVM.isTenantOwner || authViewModel.teamAccess.isOwner
        return isOwner && member.uid != currentUid
    }

    private var isUploadingPhoto: Bool {
        viewModel.uploadingTeamMemberPhotoUid == member.uid
    }

    var body: some View {
        ManageCard {
            HStack(alignment: .top, spacing: 12) {
                photoPicker
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                            TeamMemberRoleBadge(label: member.badgeLabel, accessRole: member.accessRole)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)

            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    TeamMemberBioTextEditor(
                        placeholder: "Short bio (optional)...",
                        text: $member.providerAboutText
                    )
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .disabled(disabled)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)

                    ManageToggleRow(
                        title: "Show on team page",
                        systemImage: "person.fill",
                        isOn: $member.showOnTeamPage,
                        disabled: disabled
                    )
                    ManageCardDivider(leadingInset: 46)
                    ManageToggleRow(
                        title: "Show on home",
                        subtitle: "Team strip above footer",
                        systemImage: "house.fill",
                        isOn: $member.showOnTeamHome,
                        disabled: disabled
                    )
                    ManageCardDivider(leadingInset: 46)
                    ManageToggleRow(
                        title: "Bookable",
                        subtitle: "Clients can book this artist",
                        systemImage: "calendar",
                        isOn: $member.isBookable,
                        disabled: disabled
                    )
                    if member.isBookable, let linkDisplay = memberBookingLinkDisplay {
                        ManageCardDivider(leadingInset: 46)
                        ManageMemberBookingLinkRow(
                            displayURL: linkDisplay,
                            copyURL: memberBookingLinkCopyString ?? linkDisplay,
                            disabled: disabled
                        )
                        .padding(.bottom, 4)
                    }
                    if authViewModel.teamAccess.isOwner, let liveMember = uploadablePortfolioMember {
                        ManageCardDivider(leadingInset: 46)
                        NavigationLink {
                            ProviderPortfolioView(
                                teamViewModel: portfolioTeamVM,
                                member: liveMember,
                                tenantId: viewModel.tenantId,
                                isDemoMode: isDemoMode,
                                ownerEditingMember: ownerEditingMemberPortfolio
                            )
                            .environmentObject(authViewModel)
                        } label: {
                            HStack(alignment: .center, spacing: 10) {
                                Image(systemName: "photo.stack")
                                    .font(.body)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 22, alignment: .center)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Portfolio photos")
                                        .font(.body)
                                        .foregroundStyle(.primary)
                                    Text(ownerPortfolioSubtitle(for: liveMember))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)
                    }
                    if member.accessRole != .owner {
                        Text("Artist self-service")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                            .padding(.horizontal, 14)
                            .padding(.top, 14)
                            .padding(.bottom, 4)
                        ManageCardDivider(leadingInset: 46)
                        ManageToggleRow(
                            title: "Artist can edit portfolio",
                            subtitle: "They upload in Website profile — you can always upload above",
                            systemImage: "photo.stack",
                            isOn: $member.canEditPortfolio,
                            disabled: disabled
                        )
                        ManageCardDivider(leadingInset: 46)
                        ManageToggleRow(
                            title: "Artist can edit bio",
                            subtitle: "They edit bio in Website profile — you can always edit above",
                            systemImage: "text.quote",
                            isOn: $member.canEditPublicBio,
                            disabled: disabled
                        )
                    }
                }
            }
        }
        .onChange(of: photoPickerItem) { _, newItem in
            guard let newItem, !disabled else { return }
            Task {
                guard let data = try? await newItem.loadTransferable(type: Data.self),
                      let uiImage = UIImage(data: data) else {
                    await MainActor.run { photoPickerItem = nil }
                    return
                }
                await MainActor.run {
                    cropItem = SingleImageCropSheetItem(image: uiImage)
                    photoPickerItem = nil
                }
            }
        }
        .sheet(item: $cropItem, onDismiss: { cropItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: UploadImageAdvice.teamMember,
                navigationTitle: "Team photo",
                allowedChoices: UploadCropPresetMenu.teamMember,
                defaultChoice: .portrait4_5,
                onUseJPEGData: { dataList in
                    cropItem = nil
                    guard let data = dataList.first else { return }
                    let uid = member.uid
                    Task {
                        _ = await viewModel.uploadTeamMemberProfilePhoto(memberUid: uid, imageData: data)
                    }
                }
            )
        }
    }

    @ViewBuilder
    private var photoPicker: some View {
        PhotosPicker(
            selection: $photoPickerItem,
            matching: .images,
            photoLibrary: .shared()
        ) {
            ZStack {
                ManageTeamMemberAvatar(member: member)
                if isUploadingPhoto {
                    Circle()
                        .fill(Color.black.opacity(0.35))
                    ProgressView()
                        .tint(.white)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: "camera.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(5)
                    .background(Circle().fill(Color.accentColor))
                    .offset(x: 2, y: 2)
            }
        }
        .disabled(disabled || isUploadingPhoto)
    }

    private func ownerPortfolioSubtitle(for liveMember: TenantTeamMember) -> String {
        let count = liveMember.providerGalleryImages.count
        if count == 0 {
            return "Upload for this artist — shown on their page & /gallery"
        }
        return "\(count) photo\(count == 1 ? "" : "s") on site — tap to manage"
    }

    private func portfolioSubtitle(for liveMember: TenantTeamMember) -> String {
        let count = liveMember.providerGalleryImages.count
        if count == 0 { return "None yet — shown on their page & /gallery" }
        return "\(count) photo\(count == 1 ? "" : "s") on site"
    }

    private var memberBookingLinkDisplay: String? {
        let tenant = viewModel.tenantSlug?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        let memberSlug = member.memberSlug
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !tenant.isEmpty, !memberSlug.isEmpty else { return nil }
        let path = PublicBookingSite.memberBookPath(memberSlug: memberSlug)
        return "\(tenant).\(PublicBookingSite.host)\(path)"
    }

    private var memberBookingLinkCopyString: String? {
        let tenant = viewModel.tenantSlug?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        let url = PublicBookingSite.memberBookURLString(tenantSlug: tenant, memberSlug: member.memberSlug)
        return url.isEmpty ? nil : url
    }
}

struct ManageMemberBookingLinkRow: View {
    let displayURL: String
    let copyURL: String
    var disabled: Bool

    @State private var didCopy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "link")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 22, alignment: .center)

                HStack(spacing: 10) {
                    Text(displayURL)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textPrimary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                    Spacer(minLength: 0)
                    Button {
                        copyLink()
                    } label: {
                        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                            .font(.body)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(didCopy ? AppDesign.brandWarm : AppDesign.textSecondary)
                    .disabled(disabled)
                    .accessibilityLabel(didCopy ? "Copied" : "Copy link")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(AppDesign.searchBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(AppDesign.chipBorder.opacity(0.6), lineWidth: 1)
                )
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            if didCopy {
                HStack(spacing: 10) {
                    Color.clear.frame(width: 22, height: 1)
                    Text("Copied")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
            }
        }
    }

    private func copyLink() {
        let pasteboard = UIPasteboard.general
        pasteboard.items = []
        pasteboard.string = copyURL
        didCopy = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await MainActor.run { didCopy = false }
        }
    }
}

private struct TeamMemberRoleBadge: View {
    let label: String
    let accessRole: TeamAccessRole

    private var tint: Color {
        switch accessRole {
        case .owner: return .blue
        case .manager: return .orange
        case .member: return .purple
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.15))
            .foregroundStyle(tint)
            .clipShape(Capsule())
    }
}

private struct ManageTeamMemberAvatar: View {
    let member: TeamMemberVisibilityDraft

    var body: some View {
        Group {
            if let url = URL(string: member.profilePhotoUrl),
               !member.profilePhotoUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        avatarPlaceholder
                    }
                }
            } else {
                avatarPlaceholder
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(Circle())
    }

    private var avatarPlaceholder: some View {
        ZStack {
            Circle().fill(placeholderTint.opacity(0.22))
            Text(member.initials)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(placeholderTint)
        }
    }

    private var placeholderTint: Color {
        switch member.accessRole {
        case .owner: return .blue
        case .manager: return .orange
        case .member: return .purple
        }
    }
}

// MARK: - Shop

struct ManageShopTabContent: View {
    @ObservedObject var viewModel: DesignViewModel

    private var controlsDisabled: Bool {
        !viewModel.hasTenant || viewModel.isLoading || viewModel.isDemoReadOnly
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ManageSectionHeader("Products")
            ShopCatalogView(viewModel: viewModel, embeddedInDesignManage: true)

            ManageSectionHeader("Shop settings")
            ManageCard {
                ManageToggleRow(
                    title: "Shop page enabled",
                    subtitle: "Visible at /shop on your site",
                    isOn: $viewModel.shopEnabled,
                    disabled: controlsDisabled
                ) {
                    Task { await viewModel.savePublicPageVisibility() }
                }

                ManageCardDivider()
                NavigationLink {
                    ShopComingSoonView(
                        title: "Shipping",
                        tint: .gray,
                        bullets: [
                            "Shipping zones & rates",
                            "Flat rate and free shipping",
                            "Local delivery options",
                        ]
                    )
                } label: {
                    ManageNavigationRow(
                        title: "Shipping",
                        subtitle: "Zones, rates, and delivery",
                        value: "Set up"
                    )
                }
                .buttonStyle(.plain)

                ManageCardDivider()
                NavigationLink {
                    ShopComingSoonView(
                        title: "Local pickup",
                        tint: .gray,
                        bullets: [
                            "Pickup location & hours",
                            "Ready-for-pickup notifications",
                            "In-store handoff",
                        ]
                    )
                } label: {
                    ManageNavigationRow(
                        title: "Local pickup",
                        subtitle: "Let clients collect in person",
                        value: "Set up"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}
