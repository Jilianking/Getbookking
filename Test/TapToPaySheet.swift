//
//  TapToPaySheet.swift
//  In-person Tap to Pay checkout (Apple 4.5 — amount, processing, outcome, receipt).
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

private enum TapToPayCheckoutPhase: Equatable {
    case entry
    case processing
    case approved(amountCents: Int)
    case declined(message: String)
    case failed(message: String)
}

struct TapToPaySheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @ObservedObject private var readerSession = TapToPayReaderSession.shared
    @EnvironmentObject private var sessionStore: TenantSessionStore
    var onDismiss: () -> Void

    @State private var amountCentsInput = 0
    @State private var noteText = ""
    @State private var selectedClient: Client?
    @State private var showClientPicker = false
    @State private var clientSearchText = ""
    @State private var phase: TapToPayCheckoutPhase = .entry
    @State private var showShareReceipt = false
    @State private var receiptText = ""

    private var serviceAmountCents: Int { amountCentsInput }

    private var checkout: CardCheckoutBreakdown {
        viewModel.checkoutBreakdown(serviceCents: serviceAmountCents, channel: .tapToPay)
    }

    private var canPay: Bool {
        serviceAmountCents >= 50 && phase == .entry
    }

    private var locationId: String {
        viewModel.resolvedTapToPayLocationId
    }

    private var displayAmount: String {
        formatCurrency(Double(serviceAmountCents) / 100)
    }

    private var chargeButtonTitle: String {
        if serviceAmountCents <= 0 {
            return "Charge $0.00"
        }
        if checkout.hasPassThroughFees {
            return "Charge \(CardCheckoutPricing.formatUSD(cents: checkout.totalCents))"
        }
        return "Charge \(displayAmount)"
    }

    private var linkedBookingRequestId: String? {
        guard let phone = selectedClient?.phone else { return nil }
        return BookingRequestPaymentLookup.bookingRequestId(
            forClientPhone: phone,
            in: sessionStore.bookingRequests
        )
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                switch phase {
                case .entry:
                    entryContent
                case .processing:
                    processingContent
                    Spacer(minLength: 0)
                case .approved:
                    outcomeContent(success: true)
                    Spacer(minLength: 0)
                case .declined(let message):
                    outcomeContent(success: false, message: message)
                    Spacer(minLength: 0)
                case .failed(let message):
                    outcomeContent(success: false, message: message)
                    Spacer(minLength: 0)
                }
            }
            .appScreenBackground()
            .navigationTitle("Tap to Pay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
            }
            .sheet(isPresented: $showShareReceipt) {
                if let url = shareReceiptURL() {
                    ActivityShareSheet(items: [receiptText, url])
                } else {
                    ActivityShareSheet(items: [receiptText])
                }
            }
            .sheet(isPresented: $showClientPicker) {
                TapToPayClientPickerSheet(
                    clients: sessionStore.customers,
                    searchText: $clientSearchText,
                    onPick: { client in
                        selectedClient = client
                    }
                )
            }
            .task {
                await sessionStore.loadCustomersIfNeeded(isDemoMode: false)
                await sessionStore.loadBookingsIfNeeded(isDemoMode: false)
                await TapToPayTerminalManager.shared.warmUpReader(locationId: locationId)
            }
        }
    }

    private var entryContent: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Text(displayAmount)
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                    .foregroundStyle(AppDesign.textPrimary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .animation(.snappy, value: amountCentsInput)

                Text("Processing fee paid by client")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.top, 12)
            .padding(.bottom, 20)

            clientChip
                .padding(.bottom, 16)

            noteField
                .padding(.horizontal, 20)
                .padding(.bottom, 12)

            readerStatusBlock
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

            Spacer(minLength: 8)

            TapToPayKeypad(
                onDigit: { appendDigit($0) },
                onDoubleZero: { appendDoubleZero() },
                onDelete: { deleteDigit() }
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 16)

            Button {
                Task { await pay() }
            } label: {
                Text(chargeButtonTitle)
                    .font(.headline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(canPay ? Color.white : AppDesign.textSecondary)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(canPay ? AppDesign.brandDark : Color(.systemGray5))
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canPay)
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
    }

    private var clientChip: some View {
        HStack(spacing: 10) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: nil,
                displayNameFallback: selectedClient?.name ?? "?",
                size: 36
            )
            Text(selectedClient?.name ?? "Select client")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.textPrimary)
            Button("Change") {
                showClientPicker = true
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(AppDesign.accentBlue)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            Capsule()
                .fill(AppDesign.cardBackground)
        )
        .overlay(
            Capsule()
                .stroke(Color.black.opacity(0.06), lineWidth: 1)
        )
    }

    private var noteField: some View {
        HStack(spacing: 10) {
            Image(systemName: "pencil")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            TextField("Add a note (optional)", text: $noteText)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textPrimary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(AppDesign.cardBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.black.opacity(0.06), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var readerStatusBlock: some View {
        if let progress = readerSession.preparationProgress, progress < 1 {
            VStack(spacing: 6) {
                ProgressView(value: progress)
                Text(readerSession.statusMessage ?? "Preparing reader…")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .multilineTextAlignment(.center)
            }
        } else if let status = readerSession.statusMessage, !status.isEmpty {
            Text(status)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var processingContent: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Processing…")
                .font(.headline)
            Text(readerSession.statusMessage ?? "Hold the customer's card near the top of your iPhone.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 48)
        .padding(.horizontal, 20)
    }

    @ViewBuilder
    private func outcomeContent(success: Bool, message: String? = nil) -> some View {
        VStack(spacing: 16) {
            Image(systemName: success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(success ? .green : .red)
            Text(success ? "Payment approved" : "Payment not completed")
                .font(.headline)
            if let message, !success {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .multilineTextAlignment(.center)
            }
            if success, case .approved(let cents) = phase {
                Text(formatCurrency(Double(cents) / 100))
                    .font(.title2.weight(.semibold))
                Button("Send receipt") {
                    receiptText = receiptBody(amountCents: cents)
                    showShareReceipt = true
                }
                .buttonStyle(.borderedProminent)
            }
            if !success {
                Button("Try again") {
                    phase = .entry
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.top, 48)
        .padding(.horizontal, 20)
    }

    private func appendDigit(_ digit: Int) {
        let next = amountCentsInput * 10 + digit
        amountCentsInput = min(next, 99_999_999)
    }

    private func appendDoubleZero() {
        amountCentsInput = min(amountCentsInput * 100, 99_999_999)
    }

    private func deleteDigit() {
        amountCentsInput /= 10
    }

    private func pay() async {
        phase = .processing
        do {
            guard !locationId.isEmpty else {
                throw TapToPayTerminalManager.TapToPayError.missingLocationId
            }
            let intent = try await viewModel.createPaymentIntentForTapToPay(
                serviceAmountCents: serviceAmountCents,
                bookingRequestId: linkedBookingRequestId
            )
            try await TapToPayTerminalManager.shared.processPayment(
                clientSecret: intent.clientSecret,
                locationId: locationId
            )
            if !intent.paymentIntentId.isEmpty {
                await viewModel.recordTenantPayment(paymentIntentId: intent.paymentIntentId)
            }
            await viewModel.loadData(isDemoMode: false)
            phase = .approved(amountCents: intent.checkout.totalCents)
        } catch {
            let text = TapToPayErrorMapper.userMessage(for: error)
            if text.localizedCaseInsensitiveContains("declin") {
                phase = .declined(message: text)
            } else {
                phase = .failed(message: text)
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }

    private func receiptBody(amountCents: Int) -> String {
        let amount = formatCurrency(Double(amountCents) / 100)
        var lines = ["Payment receipt — \(amount)", "Paid via Tap to Pay on iPhone."]
        if let client = selectedClient?.name, !client.isEmpty {
            lines.append("Client: \(client)")
        }
        let trimmedNote = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedNote.isEmpty {
            lines.append(trimmedNote)
        }
        lines.append("Thank you for your business.")
        return lines.joined(separator: "\n")
    }

    private func shareReceiptURL() -> URL? {
        URL(string: "https://getbookking.com")
    }
}

private struct TapToPayClientPickerSheet: View {
    let clients: [Client]
    @Binding var searchText: String
    let onPick: (Client?) -> Void
    @Environment(\.dismiss) private var dismiss

    private var filtered: [Client] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return clients }
        let qLower = query.lowercased()
        let qDigits = PhoneFormatting.digits(from: query)
        return clients.filter { client in
            client.name.lowercased().contains(qLower)
                || (!qDigits.isEmpty && PhoneFormatting.digits(from: client.phone ?? "").contains(qDigits))
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Button("No client") {
                    onPick(nil)
                    dismiss()
                }
                ForEach(Array(filtered.enumerated()), id: \.offset) { _, client in
                    Button {
                        onPick(client)
                        dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(client.name)
                                    .foregroundStyle(AppDesign.textPrimary)
                                if let phone = client.phone, !phone.isEmpty {
                                    Text(PhoneFormatting.displayUS(phone))
                                        .font(.caption)
                                        .foregroundStyle(AppDesign.textSecondary)
                                }
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .appListSurface()
            .searchable(text: $searchText, prompt: "Search name or number")
            .navigationTitle("Choose client")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

#endif
