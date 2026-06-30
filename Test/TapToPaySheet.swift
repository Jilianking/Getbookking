//
//  TapToPaySheet.swift
//  In-person Tap to Pay checkout (Apple 4.5 — amount, processing, outcome, receipt).
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

private enum TapToPayCheckoutPhase: Equatable {
    case entry
    case processing
    case collectSignature(amountCents: Int)
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
    @State private var signatureLines: [[CGPoint]] = []
    @State private var currentSignatureLine: [CGPoint] = []
    @State private var showReceiptPrompt = false
    @State private var receiptPhoneDraft = ""
    @State private var manualCheckoutError: String?

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
                case .collectSignature:
                    signatureContent
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
            .sheet(isPresented: $showReceiptPrompt) {
                TapToPayReceiptPromptSheet(
                    phoneText: $receiptPhoneDraft,
                    receiptText: receiptText,
                    onSend: { phone in
                        receiptPhoneDraft = phone
                        openReceiptViaText(preferredPhone: phone)
                        showReceiptPrompt = false
                    },
                    onSkip: {
                        showReceiptPrompt = false
                    }
                )
            }
            .task {
                await sessionStore.loadCustomersIfNeeded(isDemoMode: false)
                await sessionStore.loadBookingsIfNeeded(isDemoMode: false)
                await TapToPayTerminalManager.shared.warmUpReader(
                    locationId: locationId,
                    merchantDisplayName: TapToPayLocationStore.shared.merchantDisplayName
                )
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
    private var signatureContent: some View {
        let amountCents: Int = {
            if case .collectSignature(let cents) = phase { return cents }
            return 0
        }()

        VStack(alignment: .leading, spacing: 16) {
            Text("Customer signature")
                .font(.headline)
            Text("Have the customer sign below to confirm payment of \(formatCurrency(Double(amountCents) / 100)).")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)

            TapToPaySignaturePad(
                lines: $signatureLines,
                currentLine: $currentSignatureLine
            )
            .frame(height: 180)

            HStack(spacing: 12) {
                Button("Clear") {
                    signatureLines = []
                    currentSignatureLine = []
                }
                .buttonStyle(.bordered)

                Spacer()

                Button("Continue") {
                    finishSignatureStep(amountCents: amountCents)
                }
                .buttonStyle(.borderedProminent)
                .disabled(signatureLines.isEmpty && currentSignatureLine.isEmpty)
            }
        }
        .padding(.top, 32)
        .padding(.horizontal, 20)
    }

    private func finishSignatureStep(amountCents: Int) {
        if !currentSignatureLine.isEmpty {
            signatureLines.append(currentSignatureLine)
            currentSignatureLine = []
        }
        phase = .approved(amountCents: amountCents)
        offerReceiptIfConfigured(amountCents: amountCents)
    }

    private func offerReceiptIfConfigured(amountCents: Int) {
        let delivery = viewModel.tapToPayReceiptPreferences.delivery
        guard delivery != .none else { return }
        receiptText = viewModel.tapToPayReceiptBody(
            amountCents: amountCents,
            includesSignature: !signatureLines.isEmpty,
            clientName: selectedClient?.name,
            note: noteText
        )
        switch delivery {
        case .none:
            break
        case .text:
            receiptPhoneDraft = PhoneFormatting.digits(from: selectedClient?.phone ?? "")
            openReceiptViaText(preferredPhone: selectedClient?.phone)
        case .prompt:
            receiptPhoneDraft = PhoneFormatting.digits(from: selectedClient?.phone ?? "")
            showReceiptPrompt = true
        }
    }

    private func openReceiptViaText(preferredPhone: String?) {
        let digits = PhoneFormatting.digits(from: preferredPhone ?? receiptPhoneDraft)
        guard !digits.isEmpty else {
            showReceiptPrompt = true
            return
        }
        if let url = smsURL(phoneDigits: digits, body: receiptText) {
            UIApplication.shared.open(url)
        } else {
            showShareReceipt = true
        }
    }

    private func smsURL(phoneDigits: String, body: String) -> URL? {
        var components = URLComponents()
        components.scheme = "sms"
        components.path = phoneDigits
        components.queryItems = [URLQueryItem(name: "body", value: body)]
        return components.url
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
                if !signatureLines.isEmpty {
                    Text("Signature captured")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                if viewModel.tapToPayReceiptPreferences.delivery != .none {
                    Button("Send receipt") {
                        receiptText = viewModel.tapToPayReceiptBody(
                            amountCents: cents,
                            includesSignature: !signatureLines.isEmpty,
                            clientName: selectedClient?.name,
                            note: noteText
                        )
                        switch viewModel.tapToPayReceiptPreferences.delivery {
                        case .none:
                            break
                        case .text:
                            openReceiptViaText(preferredPhone: selectedClient?.phone)
                        case .prompt:
                            receiptPhoneDraft = PhoneFormatting.digits(from: selectedClient?.phone ?? "")
                            showReceiptPrompt = true
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            if !success {
                if let manualCheckoutError, !manualCheckoutError.isEmpty {
                    Text(manualCheckoutError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Button {
                    Task { await openManualCheckout() }
                } label: {
                    HStack {
                        if viewModel.isCreatingManualCheckoutLink {
                            ProgressView()
                        } else {
                            Text("Manual payment")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(serviceAmountCents < 50 || viewModel.isCreatingManualCheckoutLink)

                Button("Try tap again") {
                    manualCheckoutError = nil
                    signatureLines = []
                    currentSignatureLine = []
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
                locationId: locationId,
                merchantDisplayName: TapToPayLocationStore.shared.merchantDisplayName
            )
            if !intent.paymentIntentId.isEmpty {
                await viewModel.recordTenantPayment(paymentIntentId: intent.paymentIntentId)
            }
            await viewModel.loadData(isDemoMode: false)
            signatureLines = []
            currentSignatureLine = []
            let totalCents = intent.checkout.totalCents
            if viewModel.tapToPayRequireSignature {
                phase = .collectSignature(amountCents: totalCents)
            } else {
                phase = .approved(amountCents: totalCents)
                offerReceiptIfConfigured(amountCents: totalCents)
            }
        } catch {
            let text = TapToPayErrorMapper.userMessage(for: error)
            if text.localizedCaseInsensitiveContains("declin") {
                phase = .declined(message: text)
            } else {
                phase = .failed(message: text)
            }
        }
    }

    private func openManualCheckout() async {
        manualCheckoutError = nil
        guard serviceAmountCents >= 50 else {
            manualCheckoutError = "Enter an amount of at least $0.50."
            return
        }
        do {
            let url = try await viewModel.createManualCheckoutLink(
                serviceAmountCents: serviceAmountCents,
                bookingRequestId: linkedBookingRequestId
            )
            let opened = await UIApplication.shared.open(url)
            if !opened {
                manualCheckoutError = "Could not open checkout. Copy the link from Deposit link in Payments."
            }
        } catch {
            manualCheckoutError = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }

    private func receiptBody(amountCents: Int, includesSignature: Bool = false) -> String {
        viewModel.tapToPayReceiptBody(
            amountCents: amountCents,
            includesSignature: includesSignature,
            clientName: selectedClient?.name,
            note: noteText
        )
    }

    private func shareReceiptURL() -> URL? {
        URL(string: "https://getbookking.com")
    }
}

private struct TapToPaySignaturePad: View {
    @Binding var lines: [[CGPoint]]
    @Binding var currentLine: [CGPoint]

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                var path = Path()
                for line in lines {
                    guard let first = line.first else { continue }
                    path.move(to: first)
                    for point in line.dropFirst() {
                        path.addLine(to: point)
                    }
                }
                if !currentLine.isEmpty {
                    path.move(to: currentLine[0])
                    for point in currentLine.dropFirst() {
                        path.addLine(to: point)
                    }
                }
                context.stroke(path, with: .color(.primary), lineWidth: 2)
            }
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.black.opacity(0.08), lineWidth: 1)
            )
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        currentLine.append(value.location)
                    }
                    .onEnded { _ in
                        if !currentLine.isEmpty {
                            lines.append(currentLine)
                            currentLine = []
                        }
                    }
            )
        }
    }
}

private struct TapToPayReceiptPromptSheet: View {
    @Binding var phoneText: String
    let receiptText: String
    let onSend: (String) -> Void
    let onSkip: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text("Send receipt via text")
                    .font(.headline)
                Text("Enter the customer’s mobile number to open Messages with the receipt.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)

                TextField("Phone number", text: $phoneText)
                    .keyboardType(.phonePad)
                    .textFieldStyle(.roundedBorder)

                Button("Send via text") {
                    onSend(phoneText)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(PhoneFormatting.digits(from: phoneText).isEmpty)

                Button("Skip", role: .cancel) {
                    onSkip()
                    dismiss()
                }
                .frame(maxWidth: .infinity)

                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onSkip()
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
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
