//
//  CharterBoatsSettingsView.swift
//
//  Charter plan: fleet boats (type, capacity, photo) in Business settings.
//

import SwiftUI
import PhotosUI
import UIKit

struct CharterBoatsSettingsView: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var editing: CharterBoat?
    @State private var showAdd = false

    var body: some View {
        List {
            Section {
                Text("Type, how many people fit, and a photo. Search uses capacity so a group only sees boats that fit.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                if viewModel.charterBoats.isEmpty {
                    Text("No boats yet. Add one so guests can search by party size.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach(viewModel.charterBoats) { boat in
                    Button {
                        editing = boat
                    } label: {
                        HStack(spacing: 12) {
                            boatThumb(url: boat.imageUrl)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(boat.displayName)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Text(boat.capacityLabel)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { offsets in
                    let ids = offsets.map { viewModel.charterBoats[$0].id }
                    Task {
                        for id in ids { await viewModel.deleteCharterBoat(id: id) }
                    }
                }

                Button {
                    showAdd = true
                } label: {
                    Label("Add boat", systemImage: "plus")
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
            }

            if let err = viewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle("Boats")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAdd) {
            CharterBoatEditorSheet(existing: nil, viewModel: viewModel)
        }
        .sheet(item: $editing) { boat in
            CharterBoatEditorSheet(existing: boat, viewModel: viewModel)
        }
    }

    @ViewBuilder
    private func boatThumb(url: String) -> some View {
        Group {
            if let u = URL(string: url), !url.isEmpty {
                AsyncImage(url: u) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        Color(.secondarySystemFill)
                    }
                }
            } else {
                Color(.secondarySystemFill)
                    .overlay(Image(systemName: "sailboat.fill").foregroundStyle(.secondary))
            }
        }
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct CharterBoatEditorSheet: View {
    let existing: CharterBoat?
    @ObservedObject var viewModel: SettingsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var boatType = ""
    @State private var maxPeople = 6
    @State private var imageUrl = ""
    @State private var pickerItem: PhotosPickerItem?
    @State private var cropItem: SingleImageCropSheetItem?
    @State private var isUploading = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Boat") {
                    TextField("Type (center console, sportfisher…)", text: $boatType)
                    Stepper(value: $maxPeople, in: 1...50) {
                        Text("Fits \(maxPeople) \(maxPeople == 1 ? "person" : "people")")
                    }
                }
                Section("Photo") {
                    if let u = URL(string: imageUrl), !imageUrl.isEmpty {
                        AsyncImage(url: u) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFill()
                            } else {
                                Color(.secondarySystemFill)
                            }
                        }
                        .aspectRatio(4 / 3, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        Label(imageUrl.isEmpty ? "Add photo" : "Replace photo", systemImage: "photo")
                    }
                    .disabled(isUploading || viewModel.tenantId == nil)
                    if !imageUrl.isEmpty {
                        Button("Adjust framing") {
                            Task {
                                guard let image = await UploadRemoteImageLoader.image(from: imageUrl) else { return }
                                cropItem = SingleImageCropSheetItem(image: image)
                            }
                        }
                        .disabled(isUploading)
                    }
                    if isUploading {
                        ProgressView()
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add boat" : "Edit boat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            let boat = CharterBoat(
                                id: existing?.id ?? UUID().uuidString,
                                boatType: boatType.trimmingCharacters(in: .whitespacesAndNewlines),
                                maxPeople: maxPeople,
                                imageUrl: imageUrl
                            )
                            await viewModel.upsertCharterBoat(boat)
                            dismiss()
                        }
                    }
                    .disabled(isUploading)
                }
            }
            .onAppear {
                if let existing {
                    boatType = existing.boatType
                    maxPeople = existing.maxPeople
                    imageUrl = existing.imageUrl
                }
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self),
                          let image = UIImage(data: data) else {
                        pickerItem = nil
                        return
                    }
                    cropItem = SingleImageCropSheetItem(image: image)
                    pickerItem = nil
                }
            }
            .sheet(item: $cropItem, onDismiss: { cropItem = nil }) { item in
                UploadImagePreparationSheet(
                    images: [item.image],
                    advice: "Boat cards use a landscape 4:3 photo.",
                    navigationTitle: "Boat photo",
                    allowedChoices: [.landscape4_3],
                    defaultChoice: .landscape4_3,
                    onUseJPEGData: { dataList in
                        guard let data = dataList.first else { return }
                        cropItem = nil
                        Task {
                            isUploading = true
                            if let url = await viewModel.uploadCharterBoatImage(imageData: data) {
                                imageUrl = url
                            }
                            isUploading = false
                        }
                    }
                )
            }
        }
    }
}
