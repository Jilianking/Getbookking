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

    var body: some View {
        List {
            Section {
                Text("These appear on your book page. Same services as Design.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                if viewModel.services.isEmpty {
                    Text("No services yet. Add one so clients can book.")
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
                    Label("Add service", systemImage: "plus")
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
        .navigationTitle("Services")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.reloadServices()
        }
        .sheet(isPresented: $showAdd) {
            BusinessServiceEditorSheet(mode: .add) { name, duration, desc, price in
                await viewModel.addService(
                    name: name,
                    durationMinutes: duration,
                    description: desc,
                    startingPrice: price
                )
            }
        }
        .sheet(item: $serviceToEdit) { service in
            BusinessServiceEditorSheet(
                mode: .edit(service),
                onDelete: {
                    Task { await viewModel.deleteService(service) }
                }
            ) { name, duration, desc, price in
                _ = await viewModel.updateService(
                    serviceId: service.id,
                    name: name,
                    description: desc,
                    durationMinutes: duration,
                    startingPrice: price
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
    var onDelete: (() -> Void)?
    var onSave: (String, Int?, String?, Double?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var includeDuration = false
    @State private var duration = 30
    @State private var descriptionText = ""
    @State private var showStartingPrice = false
    @State private var priceText = ""
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Service name", text: $name)
                TextField("Description (optional)", text: $descriptionText, axis: .vertical)
                    .lineLimit(2...6)
                Toggle("Include duration", isOn: $includeDuration)
                if includeDuration {
                    Stepper("Duration: \(duration) min", value: $duration, in: 15...240, step: 15)
                }
                Toggle("Show starting price", isOn: $showStartingPrice)
                if showStartingPrice {
                    TextField("Amount (USD)", text: $priceText)
                        .keyboardType(.decimalPad)
                }

                if case .edit = mode, onDelete != nil {
                    Section {
                        Button("Delete service", role: .destructive) {
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
                                price
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
        case .add: return "New service"
        case .edit: return "Edit service"
        }
    }

    private func seedFromMode() {
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
    }

    private func parsePrice() -> Double? {
        guard showStartingPrice else { return nil }
        let t = priceText.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "")
        guard let v = Double(t), v > 0 else { return nil }
        return v
    }
}
