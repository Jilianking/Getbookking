//
//  BusinessServicesSettingsView.swift
//
//  Business settings → Services (same tenant catalogue as Design).
//

import SwiftUI

struct BusinessServicesSettingsView: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var serviceToEdit: TenantService?
    @State private var showAdd = false

    private var isCharter: Bool { viewModel.tenantSubscriptionPlan.isCharterPlan }

    var body: some View {
        List {
            Section {
                Text(isCharter
                     ? "These trips appear on Charters and Book now. Add an itinerary on each trip — clock times follow the guest’s departure."
                     : "These appear on your book page. Same services as Design.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                if viewModel.services.isEmpty {
                    Text(isCharter ? "No trips yet. Add one so guests can book." : "No services yet. Add one so clients can book.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach(viewModel.services) { service in
                    Button {
                        serviceToEdit = service
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(service.name)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                HStack(spacing: 8) {
                                    if let d = service.durationMinutes, d > 0 {
                                        Text("\(d) min")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    if let p = service.price, p > 0 {
                                        Text(service.bladePriceCaption)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    if isCharter, !service.boatIds.isEmpty {
                                        let names = service.boatIds.compactMap { id in
                                            viewModel.charterBoats.first(where: { $0.id == id })?.displayName
                                        }
                                        Text(names.isEmpty ? "\(service.boatIds.count) boats" : names.joined(separator: ", "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
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
                .onDelete(perform: deleteServices)

                Button {
                    showAdd = true
                } label: {
                    Label(isCharter ? "Add trip" : "Add service", systemImage: "plus")
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
        .navigationTitle(isCharter ? "Trips" : "Services")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.reloadServices()
        }
        .sheet(isPresented: $showAdd) {
            BusinessServiceEditorSheet(mode: .add, isCharter: isCharter, boats: viewModel.charterBoats) { name, duration, desc, price, itinerary, boatIds in
                await viewModel.addService(
                    name: name,
                    durationMinutes: duration,
                    description: desc,
                    startingPrice: price,
                    itinerary: itinerary,
                    boatIds: boatIds
                )
            }
        }
        .sheet(item: $serviceToEdit) { service in
            BusinessServiceEditorSheet(
                mode: .edit(service),
                isCharter: isCharter,
                boats: viewModel.charterBoats,
                onDelete: {
                    Task { await viewModel.deleteService(service) }
                }
            ) { name, duration, desc, price, itinerary, boatIds in
                _ = await viewModel.updateService(
                    serviceId: service.id,
                    name: name,
                    description: desc,
                    durationMinutes: duration,
                    startingPrice: price,
                    itinerary: itinerary,
                    boatIds: boatIds
                )
            }
        }
    }

    private func deleteServices(at offsets: IndexSet) {
        let toDelete = offsets.map { viewModel.services[$0] }
        Task {
            for s in toDelete {
                await viewModel.deleteService(s)
            }
        }
    }
}

private struct BusinessServiceEditorSheet: View {
    enum Mode {
        case add
        case edit(TenantService)
    }

    let mode: Mode
    var isCharter: Bool = false
    var boats: [CharterBoat] = []
    var onDelete: (() -> Void)?
    var onSave: (String, Int?, String?, Double?, [CharterItineraryStep]?, [String]?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var includeDuration = false
    @State private var duration = 30
    @State private var descriptionText = ""
    @State private var showStartingPrice = false
    @State private var priceText = ""
    @State private var isSaving = false
    @State private var itinerary: [CharterItineraryStep] = []
    @State private var boatIds: [String] = []

    var body: some View {
        NavigationStack {
            Form {
                TextField(isCharter ? "Trip name" : "Service name", text: $name)
                TextField("Description (optional)", text: $descriptionText, axis: .vertical)
                    .lineLimit(2...6)
                Toggle("Include duration", isOn: $includeDuration)
                if includeDuration {
                    Stepper(
                        isCharter
                            ? (duration % 60 == 0 ? "Duration: \(duration / 60) hrs" : "Duration: \(duration) min")
                            : "Duration: \(duration) min",
                        value: $duration,
                        in: isCharter ? 30...720 : 15...240,
                        step: isCharter ? 30 : 15
                    )
                }
                Toggle("Show starting price", isOn: $showStartingPrice)
                if showStartingPrice {
                    TextField("Amount (USD)", text: $priceText)
                        .keyboardType(.decimalPad)
                }

                if isCharter {
                    CharterBoatPicker(boats: boats, boatIds: $boatIds, disabled: isSaving)
                    CharterItineraryEditor(
                        steps: $itinerary,
                        durationMinutes: includeDuration ? duration : 240,
                        disabled: isSaving
                    )
                }

                if case .edit = mode, onDelete != nil {
                    Section {
                        Button(isCharter ? "Delete trip" : "Delete service", role: .destructive) {
                            onDelete?()
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            isSaving = true
                            let desc = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
                            let price = parsePrice()
                            await onSave(
                                name.trimmingCharacters(in: .whitespacesAndNewlines),
                                includeDuration ? duration : nil,
                                desc.isEmpty ? nil : desc,
                                price,
                                isCharter ? itinerary : nil,
                                isCharter ? boatIds : nil
                            )
                            isSaving = false
                            dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
            }
            .onAppear { seedFromMode() }
        }
    }

    private var title: String {
        switch mode {
        case .add: return isCharter ? "New trip" : "New service"
        case .edit: return isCharter ? "Edit trip" : "Edit service"
        }
    }

    private func seedFromMode() {
        if isCharter, case .add = mode {
            includeDuration = true
            duration = 240
            itinerary = CharterItineraryStep.defaults(durationMinutes: 240)
            boatIds = boats.map(\.id)
            return
        }
        guard case .edit(let s) = mode else { return }
        name = s.name
        descriptionText = s.description ?? ""
        if let d = s.durationMinutes, d > 0 {
            includeDuration = true
            duration = d
        }
        if let p = s.price, p > 0 {
            showStartingPrice = true
            priceText = p.rounded() == p ? "\(Int(p))" : String(format: "%.2f", p)
        }
        if isCharter {
            itinerary = s.itinerary.isEmpty
                ? CharterItineraryStep.defaults(durationMinutes: s.durationMinutes ?? 240)
                : s.itinerary
            boatIds = s.boatIds
        }
    }

    private func parsePrice() -> Double? {
        guard showStartingPrice else { return nil }
        let t = priceText.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        guard let v = Double(t), v > 0 else { return nil }
        return v
    }
}
