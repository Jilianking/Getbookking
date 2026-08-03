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
}

struct TapToPaySheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @ObservedObject private var readerSession = TapToPayReaderSession.shared
    @EnvironmentObject private var sessionStore: TenantSessionStore
    var drawerState: DrawerState
    var onDismiss: () -> Void

    @State private var amountCentsInput = 0
    @State private var noteText = ""
    @State private var selectedClient: Client?
    @State private var showClientPicker = false
    @State private var showNoteEditor = false
    @State private var clientSearchText = ""
    @State private var phase: TapToPayCheckoutPhase = .entry
    @State private var signatureLines: [[CGPoint]] = []
    @State private var currentSignatureLine: [CGPoint] = []
    @State private var manualCheckoutError: String?
    @State private var showTapToPayReceiptSheet = false
    @State private var receiptDetail: PaymentReceiptDetail?
    @State private var lastPaymentIntentId: String?
    @State private var lastCheckout: CardCheckoutBreakdown?
    @State private var lastPaidAt = Date()

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
        return "Charge \(CardCheckoutPricing.formatUSD(cents: checkout.totalCents))"
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
                    approvedOutcomeContent
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
                if phase == .entry {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                showClientPicker = true
                            } label: {
                                Label(
                                    selectedClient == nil ? "Select client" : "Change client",
                                    systemImage: "person.crop.circle"
                                )
                            }
                            if selectedClient != nil {
                                Button(role: .destructive) {
                                    selectedClient = nil
                                } label: {
                                    Label("Clear client", systemImage: "person.crop.circle.badge.minus")
                                }
                            }
                            Divider()
                            Button {
                                showNoteEditor = true
                            } label: {
                                Label(
                                    noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? "Add note"
                                        : "Edit note",
                                    systemImage: "pencil"
                                )
                            }
                            if !noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Button(role: .destructive) {
                                    noteText = ""
                                } label: {
                                    Label("Clear note", systemImage: "trash")
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .font(.body.weight(.medium))
                        }
                        .accessibilityLabel("More options")
                    }
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
            .sheet(isPresented: $showNoteEditor) {
                TapToPayNoteEditorSheet(noteText: $noteText)
            }
            .sheet(isPresented: $showTapToPayReceiptSheet) {
                tapToPayReceiptSheet
            }
            .onChange(of: amountCentsInput) { _, _ in
                Task { await viewModel.refreshInPersonTaxPreview(serviceCents: serviceAmountCents) }
            }
            .task {
                await sessionStore.loadCustomersIfNeeded(isDemoMode: false)
                await sessionStore.loadBookingsIfNeeded(isDemoMode: false)
                await viewModel.refreshInPersonTaxPreview(serviceCents: serviceAmountCents)
                let displayName = TapToPayLocationStore.shared.merchantDisplayName
                let skipWarmUp = await TapToPayTerminalManager.shared.shouldSkipWarmUp(
                    locationId: locationId,
                    merchantDisplayName: displayName
                )
                if !skipWarmUp {
                    await TapToPayTerminalManager.shared.warmUpReader(
                        locationId: locationId,
                        merchantDisplayName: displayName
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var tapToPayReceiptSheet: some View {
        if let receiptDetail {
            if receiptDetail.isUnpaidAttempt {
                PaymentReceiptSheet(
                    detail: receiptDetail,
                    drawerState: drawerState,
                    onDismissAll: onDismiss,
                    onTryAgain: { manualCheckoutError = nil },
                    onManualPayment: {
                        showTapToPayReceiptSheet = false
                        Task { await openManualCheckout() }
                    },
                    manualPaymentInProgress: viewModel.isCreatingManualCheckoutLink
                )
            } else {
                PaymentReceiptSheet(
                    detail: receiptDetail,
                    drawerState: drawerState,
                    onDismissAll: onDismiss
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
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: amountCentsInput)
                    .frame(maxWidth: .infinity)

                CardCheckoutBreakdownView(
                    breakdown: checkout,
                    alwaysShowFeeLines: true
                )
                .padding(.horizontal, 20)

                if selectedClient != nil || !trimmedNote.isEmpty {
                    optionalDetailsSummary
                        .padding(.horizontal, 20)
                }

                if let manualCheckoutError, !manualCheckoutError.isEmpty {
                    Text(manualCheckoutError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20)
                }

                readerStatusBlock
                    .padding(.horizontal, 20)
            }
            .padding(.top, 12)
            .padding(.bottom, 12)

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

    private var trimmedNote: String {
        noteText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Compact reminder when client/note were set via the ⋯ menu.
    private var optionalDetailsSummary: some View {
        HStack(spacing: 8) {
            if let selectedClient {
                Button {
                    showClientPicker = true
                } label: {
                    Label(selectedClient.name, systemImage: "person.crop.circle.fill")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
            }
            if !trimmedNote.isEmpty {
                Button {
                    showNoteEditor = true
                } label: {
                    Label(trimmedNote, systemImage: "pencil")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(AppDesign.textSecondary)
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
        presentOnScreenReceipt()
    }

    private func presentOnScreenReceipt(paymentMethodLabel: String = "Tap to Pay on iPhone") {
        let checkout = lastCheckout ?? viewModel.checkoutBreakdown(
            serviceCents: serviceAmountCents,
            channel: .tapToPay
        )
        let detail = PaymentReceiptDetail.fromTapToPay(
            checkout: checkout,
            businessName: viewModel.effectiveTapToPayDisplayName,
            customerName: selectedClient?.name,
            note: noteText,
            paymentIntentId: lastPaymentIntentId,
            includesSignature: !signatureLines.isEmpty,
            paidAt: lastPaidAt,
            paymentMethodLabel: paymentMethodLabel
        )
        receiptDetail = detail
        showTapToPayReceiptSheet = true
    }

    private var approvedOutcomeContent: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.green)
            Text("Payment approved")
                .font(.headline)
            if case .approved(let cents) = phase {
                Text(formatCurrency(Double(cents) / 100))
                    .font(.title2.weight(.semibold))
                if !signatureLines.isEmpty {
                    Text("Signature captured")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Button("View receipt") {
                    presentOnScreenReceipt()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(.top, 48)
        .padding(.horizontal, 20)
    }

    private func presentPaymentNotice(
        reason: PaymentReceiptDocumentKind.UnpaidAttemptReason,
        detailMessage: String
    ) {
        let checkout = lastCheckout ?? viewModel.checkoutBreakdown(
            serviceCents: serviceAmountCents,
            channel: .tapToPay
        )
        receiptDetail = PaymentReceiptDetail.fromTapToPayUnsuccessful(
            checkout: checkout,
            businessName: viewModel.effectiveTapToPayDisplayName,
            customerName: selectedClient?.name,
            note: noteText,
            reason: reason,
            detailMessage: detailMessage
        )
        showTapToPayReceiptSheet = true
    }

    private func unpaidAttemptReason(for message: String) -> PaymentReceiptDocumentKind.UnpaidAttemptReason {
        if message.localizedCaseInsensitiveContains("declin") {
            return .declined
        }
        if message.localizedCaseInsensitiveContains("timed out")
            || message.localizedCaseInsensitiveContains("time out") {
            return .timedOut
        }
        return .notCompleted
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
            lastPaymentIntentId = intent.paymentIntentId
            lastCheckout = intent.checkout
            lastPaidAt = Date()
            signatureLines = []
            currentSignatureLine = []
            let totalCents = intent.checkout.totalCents
            if viewModel.tapToPayRequireSignature {
                phase = .collectSignature(amountCents: totalCents)
            } else {
                phase = .approved(amountCents: totalCents)
                presentOnScreenReceipt()
            }
        } catch {
            let text = TapToPayErrorMapper.userMessage(for: error)
            manualCheckoutError = nil
            phase = .entry
            presentPaymentNotice(
                reason: unpaidAttemptReason(for: text),
                detailMessage: text
            )
        }
    }

    private func openManualCheckout() async {
        manualCheckoutError = nil
        guard serviceAmountCents >= 50 else {
            manualCheckoutError = "Enter an amount of at least $0.50."
            return
        }
        let result = await viewModel.chargeManualCheckoutInApp(
            serviceAmountCents: serviceAmountCents,
            bookingRequestId: linkedBookingRequestId
        )
        switch result {
        case .success(let intent):
            lastPaymentIntentId = intent.paymentIntentId
            lastCheckout = intent.checkout
            lastPaidAt = Date()
            phase = .approved(amountCents: intent.checkout.totalCents)
            presentOnScreenReceipt(paymentMethodLabel: "Manual payment")
        case .canceled:
            break
        case .failed(let message):
            manualCheckoutError = message
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
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

private struct TapToPayNoteEditorSheet: View {
    @Binding var noteText: String
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Optional note for this payment (shown on the receipt).")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                TextField("Add a note", text: $noteText, axis: .vertical)
                    .lineLimit(3...6)
                    .textFieldStyle(.roundedBorder)
                    .focused($isFocused)
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium])
    }
}

#endif
