//
//  BookingDetailActions.swift
//  Booking details on iPhone, matching the web calendar: cancel with an optional client text,
//  delete for good (unpaid, non-charter), and edit the service + notes.
//

import SwiftUI
import FirebaseFirestore
import FirebaseFunctions

extension RequestsViewModel {
    /// Texts the client from the shop's number (same callable as Messages and the web calendar).
    func sendBookingText(to phone: String?, clientName: String?, body: String, preview: String) async -> Bool {
        let digits = PhoneFormatting.digits(from: phone ?? "")
        let ten = String(digits.suffix(10))
        guard ten.count == 10 else { return false }
        let e164 = "+1" + ten
        do {
            _ = try await Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
                .httpsCallable("sendClientSms")
                .call([
                    "to": e164,
                    "body": body,
                    "clientName": clientName ?? "",
                    "threadId": e164,
                    "threadPreview": preview,
                ])
            return true
        } catch {
            return false
        }
    }

    /// Removes the booking completely (no client text). The web calendar does the same.
    func deleteBookingPermanently(requestId: String) async -> Bool {
        guard let tid = tenantId, !requestId.isEmpty else { return false }
        await MainActor.run { isUpdatingStatus = true; actionError = nil }
        defer { Task { @MainActor in self.isUpdatingStatus = false } }
        do {
            try await Firestore.firestore().collection("tenants").document(tid)
                .collection("bookingRequests").document(requestId).delete()
            await MainActor.run {
                bookingRequests.removeAll { $0.documentId == requestId }
            }
            return true
        } catch {
            await MainActor.run { actionError = error.localizedDescription }
            return false
        }
    }

    /// Changes the service (and its length) and the notes on an existing booking.
    func updateServiceAndNotes(requestId: String, service: TenantService?, notes: String) async -> Bool {
        guard let tid = tenantId, !requestId.isEmpty else { return false }
        await MainActor.run { isUpdatingStatus = true; actionError = nil }
        defer { Task { @MainActor in self.isUpdatingStatus = false } }
        var updates: [String: Any] = [
            "notes": notes,
            "updatedAt": FieldValue.serverTimestamp(),
        ]
        if let service {
            updates["serviceId"] = service.id
            updates["serviceSlug"] = service.slug
            updates["serviceName"] = service.name
            if let minutes = service.durationMinutes, minutes > 0 { updates["durationMinutes"] = minutes }
        }
        do {
            try await Firestore.firestore().collection("tenants").document(tid)
                .collection("bookingRequests").document(requestId).setData(updates, merge: true)
            await loadRequests(isDemoMode: false, sessionStore: sessionStore)
            return true
        } catch {
            await MainActor.run { actionError = error.localizedDescription }
            return false
        }
    }
}

enum BookingTextCopy {
    static func firstName(_ name: String?) -> String {
        let first = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ").first.map(String.init) ?? ""
        return first.lowercased() == "client" ? "" : first
    }

    static func whenPhrase(_ start: Date?) -> String {
        guard let start else { return "" }
        let day = start.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        let time = start.formatted(date: .omitted, time: .shortened)
        return " on \(day) at \(time)"
    }
}

/// "Cancel appointment?" with an optional "Text … that it's cancelled".
struct CancelAppointmentSheet: View {
    let request: BookingRequest
    let canText: Bool
    let isCharter: Bool
    let shopName: String
    @ObservedObject var viewModel: RequestsViewModel
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var textClient = true
    @State private var isWorking = false
    @State private var note: String?

    private var first: String { BookingTextCopy.firstName(request.customerName) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(request.cancelConfirmMessage)
                        .font(.subheadline)
                    if isCharter {
                        Text("The client gets your usual cancellation text.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if canText {
                        Toggle(isOn: $textClient) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(first.isEmpty ? "Text the client that it's cancelled" : "Text \(first) that it's cancelled")
                                Text("Sent from your shop's texting number.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .tint(AppDesign.brandWarm)
                    }
                }
                if let msg = note ?? viewModel.actionError {
                    Section { Text(msg).font(.footnote).foregroundStyle(.red) }
                }
                Section {
                    Button(role: .destructive) {
                        guard !isWorking else { return }
                        isWorking = true
                        Task { await run() }
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking { ProgressView() } else {
                                Text(request.refundablePaidCents > 0 ? "Cancel and refund" : "Cancel appointment")
                            }
                            Spacer()
                        }
                    }
                    .disabled(isWorking)
                }
            }
            .navigationTitle("Cancel appointment")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isWorking)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Keep it") { dismiss() }.disabled(isWorking)
                }
            }
            .onAppear {
                textClient = BookingRequestStatus.normalized(request.status) == BookingRequestStatus.confirmed
            }
        }
    }

    private func run() async {
        let docId = (request.documentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !docId.isEmpty else { isWorking = false; return }
        await viewModel.setBookingRequestStatus(
            requestId: docId,
            status: BookingRequestStatus.cancelled,
            notes: request.notes
        )
        guard viewModel.actionError == nil else { isWorking = false; return }
        if canText && !isCharter && textClient {
            let hi = first.isEmpty ? "Hi" : "Hi \(first)"
            let svc = (request.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let when = BookingTextCopy.whenPhrase(request.departureStart)
            let body = "\(hi), your \(svc.isEmpty ? "appointment" : svc) with \(shopName)\(when) has been cancelled. Reply here if you'd like to rebook."
            let ok = await viewModel.sendBookingText(
                to: request.customerPhone,
                clientName: request.customerName,
                body: body,
                preview: "Cancelled\(when)"
            )
            if !ok {
                note = "Cancelled, but the text to the client didn't send. You can message them from Messages."
                isWorking = false
                return
            }
        }
        isWorking = false
        dismiss()
        onDone()
    }
}

/// Change the service and notes on an existing appointment (time & staff stay in "Change time").
struct EditAppointmentDetailsSheet: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var services: [TenantService] = []
    @State private var selectedServiceId: String = ""
    @State private var notes: String = ""
    @State private var isLoading = true
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section(viewModel.isCharterPlan ? "Trip" : "Service") {
                    if isLoading {
                        ProgressView()
                    } else {
                        Picker(viewModel.isCharterPlan ? "Trip" : "Service", selection: $selectedServiceId) {
                            if !services.contains(where: { $0.id == request.serviceId }) {
                                Text(request.serviceName ?? "Current service").tag("")
                            }
                            ForEach(services) { s in
                                Text(s.name).tag(s.id)
                            }
                        }
                        .disabled(viewModel.isCharterPlan)
                    }
                }
                Section("Notes") {
                    TextField("Notes (optional)", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                }
                if let err = viewModel.actionError {
                    Section { Text(err).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Edit details")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") {
                            guard !isSaving else { return }
                            isSaving = true
                            Task {
                                let service = services.first(where: { $0.id == selectedServiceId && $0.id != request.serviceId })
                                let ok = await viewModel.updateServiceAndNotes(
                                    requestId: request.documentId ?? "",
                                    service: service,
                                    notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
                                )
                                isSaving = false
                                if ok { dismiss() }
                            }
                        }
                    }
                }
            }
            .task {
                notes = request.notes ?? ""
                selectedServiceId = request.serviceId ?? ""
                if let tid = viewModel.tenantId,
                   let fetched = try? await FirebaseService().fetchTenantServices(tenantId: tid) {
                    services = fetched.filter(\.isActive)
                }
                if !services.contains(where: { $0.id == selectedServiceId }) { selectedServiceId = "" }
                isLoading = false
            }
        }
    }
}
