//
//  ProviderPortfolioView.swift
//
//  Per-member gallery for bookable team members (Studio/Shop).
//

import SwiftUI
import Combine
import PhotosUI
import UIKit

private let providerPortfolioMaxImages = 24

final class ProviderPortfolioViewModel: ObservableObject {
    static let maxImages = providerPortfolioMaxImages

    @Published var imageURLs: [String] = []
    @Published var isUploading = false
    @Published var errorMessage: String?

    let providerUid: String
    let providerName: String
    private let tenantId: String?
    /// When an owner edits another member's gallery.
    private let memberUidForSave: String?
    private let isDemoMode: Bool
    private let firebaseService = FirebaseService()

    init(
        member: TenantTeamMember,
        tenantId: String?,
        isDemoMode: Bool,
        ownerEditingMember: Bool
    ) {
        providerUid = member.uid
        providerName = member.displayName
        self.tenantId = tenantId
        self.isDemoMode = isDemoMode
        memberUidForSave = ownerEditingMember ? member.uid : nil
        imageURLs = member.providerGalleryImages
    }

    var remainingSlots: Int {
        max(0, Self.maxImages - imageURLs.count)
    }

    var canAddPhotos: Bool {
        !isDemoMode && remainingSlots > 0 && !isUploading
    }

    func addImageDataBatch(_ items: [Data]) async {
        guard !items.isEmpty else { return }
        if isDemoMode {
            errorMessage = "Gallery editing is preview-only in demo mode."
            return
        }
        guard let tenantId, !tenantId.isEmpty else {
            errorMessage = "Business profile is still loading."
            return
        }
        let batch = Array(items.prefix(remainingSlots))
        guard !batch.isEmpty else {
            errorMessage = "Portfolio is full (\(Self.maxImages) photos max)."
            return
        }

        isUploading = true
        errorMessage = nil
        defer { isUploading = false }

        do {
            var uploaded: [String] = []
            for data in batch {
                let url = try await firebaseService.uploadProviderGalleryImage(
                    tenantId: tenantId,
                    providerUid: providerUid,
                    imageData: data
                )
                uploaded.append(url)
            }
            guard !uploaded.isEmpty else {
                await MainActor.run { errorMessage = "Couldn't prepare the selected photos." }
                return
            }
            var next = imageURLs
            next.append(contentsOf: uploaded)
            next = Array(next.prefix(providerPortfolioMaxImages))
            let saved = try await firebaseService.updateProviderGallery(
                memberUid: memberUidForSave,
                imageURLs: next
            )
            await MainActor.run { imageURLs = saved }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func removeImage(at index: Int) async {
        guard index >= 0, index < imageURLs.count else { return }
        if isDemoMode {
            errorMessage = "Gallery editing is preview-only in demo mode."
            return
        }
        isUploading = true
        errorMessage = nil
        defer { isUploading = false }

        var next = imageURLs
        next.remove(at: index)
        do {
            let saved = try await firebaseService.updateProviderGallery(
                memberUid: memberUidForSave,
                imageURLs: next
            )
            await MainActor.run { imageURLs = saved }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
}

struct ProviderPortfolioView: View {
    @ObservedObject var teamViewModel: ManagerSettingsViewModel
    @StateObject private var viewModel: ProviderPortfolioViewModel
    @EnvironmentObject var authViewModel: AuthViewModel

    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var batchCropItem: MultiImageCropSheetItem?
    @State private var showGalleryError = false

    init(
        teamViewModel: ManagerSettingsViewModel,
        member: TenantTeamMember,
        tenantId: String?,
        isDemoMode: Bool,
        ownerEditingMember: Bool
    ) {
        self.teamViewModel = teamViewModel
        _viewModel = StateObject(wrappedValue: ProviderPortfolioViewModel(
            member: member,
            tenantId: tenantId,
            isDemoMode: isDemoMode,
            ownerEditingMember: ownerEditingMember
        ))
    }

    var body: some View {
        ScrollView {
            ProviderPortfolioEditorContent(
                teamViewModel: teamViewModel,
                viewModel: viewModel,
                selectedItems: $selectedItems,
                batchCropItem: $batchCropItem,
                showGalleryError: $showGalleryError,
                manageStyle: false
            )
            .padding(16)
        }
        .appScreenBackground()
        .navigationTitle("Portfolio")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Inline portfolio editor for Website profile (Gallery tab) and standalone Portfolio screen.
struct ProviderPortfolioEditorContent: View {
    @ObservedObject var teamViewModel: ManagerSettingsViewModel
    @ObservedObject var viewModel: ProviderPortfolioViewModel
    @EnvironmentObject var authViewModel: AuthViewModel
    @Binding var selectedItems: [PhotosPickerItem]
    @Binding var batchCropItem: MultiImageCropSheetItem?
    @Binding var showGalleryError: Bool
    var manageStyle: Bool = false

    private let gridColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        let pickerLimit = max(0, providerPortfolioMaxImages - viewModel.imageURLs.count)
        VStack(alignment: .leading, spacing: manageStyle ? 20 : 16) {
            if manageStyle {
                ManageSectionHeader("Gallery photos")
            }
            uploadSection(pickerLimit: pickerLimit, photoCount: viewModel.imageURLs.count)
            if viewModel.isUploading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(manageStyle ? "Uploading…" : "Saving portfolio…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            galleryGrid
            if manageStyle {
                Text("Photos appear on your profile and the studio gallery.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onChange(of: selectedItems) { _, newItems in
            Task { await processPickerItems(newItems) }
        }
        .onChange(of: viewModel.imageURLs) { _, urls in
            teamViewModel.patchMemberGallery(uid: viewModel.providerUid, imageURLs: urls)
        }
        .onChange(of: viewModel.errorMessage) { _, message in
            showGalleryError = message != nil
        }
        .sheet(item: $batchCropItem, onDismiss: { batchCropItem = nil }) { item in
            UploadImagePreparationSheet(
                images: item.images,
                advice: UploadImageAdvice.gallery,
                navigationTitle: "Portfolio photos",
                allowedChoices: UploadCropPresetMenu.gallery,
                defaultChoice: .portrait4_5,
                onUseJPEGData: { dataList in
                    batchCropItem = nil
                    guard !dataList.isEmpty else { return }
                    Task { await viewModel.addImageDataBatch(dataList) }
                }
            )
        }
        .alert("Couldn't add photos", isPresented: $showGalleryError) {
            Button("OK", role: .cancel) {
                viewModel.errorMessage = nil
            }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    @ViewBuilder
    private func uploadSection(pickerLimit: Int, photoCount: Int) -> some View {
        if authViewModel.isDemoMode {
            if manageStyle {
                ManageCard {
                    Text("Preview only in demo mode.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(14)
                }
            } else {
                Text("Preview only in demo mode.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if pickerLimit > 0 {
            PhotosPicker(
                selection: $selectedItems,
                maxSelectionCount: pickerLimit,
                matching: .images,
                photoLibrary: .shared()
            ) {
                uploadZoneChrome(photoCount: photoCount)
            }
            .buttonStyle(.plain)
            .disabled(!viewModel.canAddPhotos)
            .appCard()
            if !manageStyle {
                Text("Shown on \(viewModel.providerName)'s team profile and the studio gallery. Square or portrait shots work best.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text("Portfolio is full (\(providerPortfolioMaxImages) photos). Remove one to add another.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func uploadZoneChrome(photoCount: Int) -> some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(
                Color(.systemGray3),
                style: StrokeStyle(lineWidth: 1.5, dash: [8, 6])
            )
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .frame(height: manageStyle ? 132 : 120)
            .overlay {
                VStack(spacing: manageStyle ? 10 : 8) {
                    Image(systemName: authViewModel.isDemoMode ? "eye" : "photo.on.rectangle.angled")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(manageStyle ? "Add photos" : "Add portfolio photos")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                    if !manageStyle {
                        Text("\(photoCount)/\(providerPortfolioMaxImages)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private var galleryGrid: some View {
        if viewModel.imageURLs.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "photo.stack")
                    .font(.system(size: 34))
                    .foregroundStyle(.secondary)
                Text("No portfolio photos yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else {
            LazyVGrid(columns: gridColumns, spacing: 10) {
                ForEach(Array(viewModel.imageURLs.enumerated()), id: \.offset) { index, urlString in
                    ProviderPortfolioCell(urlString: urlString) {
                        Task { await viewModel.removeImage(at: index) }
                    }
                }
            }
        }
    }

    private func processPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
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
                viewModel.errorMessage = "Couldn't load the selected photos."
                return
            }
            batchCropItem = MultiImageCropSheetItem(images: images)
        }
    }
}

private struct ProviderPortfolioCell: View {
    let urlString: String
    let onDelete: () -> Void

    var body: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(.systemGray5))
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let url = URL(string: urlString) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color(.systemGray5)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
