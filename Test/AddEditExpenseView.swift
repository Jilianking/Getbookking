//
//  AddEditExpenseView.swift
//
//  Add/edit form for a manually-logged expense. Attaching a receipt photo is
//  free; auto-fill (OCR via extractReceiptData, a paid OpenAI call) only runs
//  when the user explicitly taps "Auto-fill from photo". Either way, nothing
//  saves until the user reviews and taps Save.
//

import SwiftUI
import PhotosUI

struct AddEditExpenseView: View {
    @ObservedObject var viewModel: ExpensesViewModel
    let expense: Expense?
    /// Called with the saved expense's date so the caller can widen its visible
    /// date range if the expense would otherwise fall outside it and vanish from view.
    var onSaved: (Date) -> Void

    @EnvironmentObject var sessionStore: TenantSessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var amountText: String = ""
    @State private var category: ExpenseCategory = .other
    @State private var vendor: String = ""
    @State private var date: Date = Date()
    @State private var note: String = ""
    @State private var receiptImageUrl: String?
    @State private var receiptStoragePath: String?
    @State private var localReceiptData: Data?
    @State private var source: String = "manual"

    @State private var imagePickerItem: PhotosPickerItem?
    @State private var isRunningOcr = false
    @State private var ocrStatusMessage: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let firebaseService = FirebaseService()

    var body: some View {
        NavigationStack {
            Form {
                Section("Receipt") {
                    if let localReceiptData, let uiImage = UIImage(data: localReceiptData) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 200)
                    } else if let receiptImageUrl, let url = URL(string: receiptImageUrl) {
                        AsyncImage(url: url) { image in
                            image.resizable().scaledToFit()
                        } placeholder: {
                            Color(.secondarySystemFill)
                        }
                        .frame(maxHeight: 200)
                    }
                    PhotosPicker(selection: $imagePickerItem, matching: .images) {
                        Label(localReceiptData == nil && receiptImageUrl == nil ? "Add receipt photo" : "Replace photo", systemImage: "photo.badge.plus")
                    }
                    .onChange(of: imagePickerItem) { _, item in
                        Task { await handlePickedItem(item) }
                    }
                    if localReceiptData != nil {
                        Button {
                            Task { await runAutoFill() }
                        } label: {
                            Label("Auto-fill from photo", systemImage: "wand.and.stars")
                        }
                        .disabled(isRunningOcr)
                    }
                    if isRunningOcr {
                        HStack {
                            ProgressView()
                            Text("Reading receipt…").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let ocrStatusMessage {
                        Text(ocrStatusMessage).font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("Details") {
                    HStack {
                        Text("$")
                        TextField("0.00", text: $amountText)
                            .keyboardType(.decimalPad)
                    }
                    Picker("Category", selection: $category) {
                        ForEach(ExpenseCategory.allCases) { cat in
                            Text(cat.displayName).tag(cat)
                        }
                    }
                    TextField("Vendor", text: $vendor)
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    TextField("Note (optional)", text: $note, axis: .vertical)
                }

                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(.red)
                }
            }
            .navigationTitle(expense == nil ? "Add Expense" : "Edit Expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await save() }
                    }
                    .disabled(isSaving || !isValid)
                }
            }
            .onAppear(perform: populateFromExpenseIfNeeded)
        }
    }

    private var isValid: Bool {
        guard let amount = Double(amountText), amount > 0 else { return false }
        return true
    }

    private func populateFromExpenseIfNeeded() {
        guard let expense else { return }
        amountText = String(format: "%.2f", expense.amount)
        category = expense.category
        vendor = expense.vendor
        date = expense.date
        note = expense.note ?? ""
        receiptImageUrl = expense.receiptImageUrl
        receiptStoragePath = expense.receiptStoragePath
        source = expense.source
    }

    /// Attaches the photo only — does not call the (paid) OCR function. The user
    /// can type the expense in by hand, or tap "Auto-fill from photo" separately
    /// to trigger a scan on demand.
    private func handlePickedItem(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(data, maxLongEdge: 2000, compressionQuality: 0.85)
        localReceiptData = payload
        imagePickerItem = nil
    }

    private func runAutoFill() async {
        guard let localReceiptData else { return }
        isRunningOcr = true
        ocrStatusMessage = nil
        let ocr = await viewModel.runReceiptOcr(imageData: localReceiptData)
        isRunningOcr = false

        guard ocr.callSucceeded else {
            ocrStatusMessage = "Couldn't reach the scanner. Check your connection and try again, or enter the details manually."
            return
        }

        var filledAny = false
        if let amountCents = ocr.amountCents {
            amountText = String(format: "%.2f", Double(amountCents) / 100)
            filledAny = true
        }
        if let ocrDate = ocr.date {
            date = ocrDate
            filledAny = true
        }
        if let ocrVendor = ocr.vendor, vendor.isEmpty {
            vendor = ocrVendor
            filledAny = true
        }
        source = "ocr"

        ocrStatusMessage = filledAny ? nil : "Couldn't read this receipt clearly — enter the details manually."
    }

    private func save() async {
        guard let amountValue = Double(amountText) else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let expenseId = expense?.id ?? UUID().uuidString
            let isNew = expense == nil
            var uploadedUrl = receiptImageUrl
            var uploadedPath = receiptStoragePath
            if let localReceiptData {
                guard let tenantId = sessionStore.tenantId else {
                    throw NSError(domain: "AddEditExpenseView", code: -1, userInfo: [NSLocalizedDescriptionKey: "No tenant"])
                }
                let uploaded = try await firebaseService.uploadExpenseReceiptImage(
                    tenantId: tenantId, expenseId: expenseId, imageData: localReceiptData
                )
                uploadedUrl = uploaded.url
                uploadedPath = uploaded.path
            }

            try await viewModel.saveExpense(
                expenseId: expenseId,
                isNew: isNew,
                amountCents: Int((amountValue * 100).rounded()),
                category: category,
                vendor: vendor,
                date: date,
                note: note.isEmpty ? nil : note,
                receiptImageUrl: uploadedUrl,
                receiptStoragePath: uploadedPath,
                source: source
            )
            onSaved(date)
            dismiss()
        } catch {
            errorMessage = "Couldn't save expense. Please try again."
        }
    }
}
