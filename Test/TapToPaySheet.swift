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
    @State private var manualCheckoutError: String?
    @State private var showTapToPayReceiptSheet = false
    @State private var receiptDetail: PaymentReceiptDetail?
    @State private var lastPaymentIntentId: String?
    @State private var lastCheckout: CardCheckoutBreakdown?
    @State private var lastPaidAt = Date()
    /// Which charge is waiting on the client's tip choice.
    @State private var tipTarget: TipTarget?
    /// Tip chosen for the charge in progress (shown on the processing card and on any receipt, paid or not).
    @State private var pendingTipCents = 0
    @State private var payTask: Task<Void, Never>?
    @State private var userCanceledPayment = false

    /// Fees + total including a tip (and the card fee on it, which the client pays) — mirrors the server.
    private func breakdown(_ base: CardCheckoutBreakdown, tip: Int) -> CardCheckoutBreakdown {
        guard tip > 0 else { return base }
        let tipFee = CardCheckoutPricing.tipCardFeeCents(tipCents: tip, channel: base.channel)
        return CardCheckoutBreakdown(
            serviceCents: base.serviceCents,
            taxCents: base.taxCents,
            passThroughFeeCents: base.passThroughFeeCents + tipFee,
            platformFeeCents: base.platformFeeCents,
            totalCents: base.totalCents + tip + tipFee,
            channel: base.channel,
            tipCents: tip
        )
    }

    /// Cancel on the processing screen: stop the card read and go back to the tip screen.
    private func cancelProcessing() {
        userCanceledPayment = true
        TapToPayTerminalManager.shared.cancelActivePayment()
        payTask?.cancel()
        payTask = nil
        phase = .entry
        tipTarget = tipsOn ? .tapToPay : nil
    }

    private enum TipTarget: String, Identifiable {
        case tapToPay, manual
        var id: String { rawValue }
    }

    private var tipsOn: Bool { ShopTipSettings.enabled(sessionStore.tenant) }

    /// Ask for a tip first (when tips are on), then charge.
    private func startCharge(_ target: TipTarget) {
        if tipsOn {
            tipTarget = target
        } else {
            if target == .tapToPay {
                payTask = Task { await pay(tipCents: 0) }
            } else {
                Task { await openManualCheckout(tipCents: 0) }
            }
        }
    }

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
                case .approved:
                    approvedOutcomeContent
                    Spacer(minLength: 0)
                }
            }
            .appScreenBackground()
            .navigationTitle("Tap to Pay on iPhone")
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
            .fullScreenCover(item: $tipTarget) { target in
                let preview = target == .tapToPay
                    ? checkout
                    : viewModel.checkoutBreakdown(serviceCents: serviceAmountCents, channel: .online)
                TipPickerSheet(
                    serviceCents: serviceAmountCents,
                    baseTotalCents: preview.totalCents,
                    feeCents: preview.passThroughFeeCents,
                    taxCents: preview.taxCents,
                    channel: target == .tapToPay ? .tapToPay : .online,
                    percents: ShopTipSettings.percents(sessionStore.tenant),
                    onChoose: { tip in
                        tipTarget = nil
                        Task {
                            // Let the cover close before the card reader / payment sheet opens.
                            try? await Task.sleep(nanoseconds: 350_000_000)
                            if target == .tapToPay {
                                payTask = Task { await pay(tipCents: tip) }
                            } else {
                                await openManualCheckout(tipCents: tip)
                            }
                        }
                    },
                    onCancel: { tipTarget = nil }
                )
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
                        startCharge(.manual)
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
                startCharge(.tapToPay)
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

    /// Tap to Pay only: the crown rises into place (like a sheet pulling up), "Processing…" under it.
    private var processingContent: some View {
        TapToPayProcessingView(
            amountText: processingAmountText,
            statusText: readerSession.statusMessage ?? "Hold the customer's card near the top of your iPhone.",
            breakdown: lastCheckout ?? breakdown(checkout, tip: pendingTipCents),
            onCancel: { cancelProcessing() }
        )
    }

    private var processingAmountText: String? {
        guard serviceAmountCents > 0 else { return nil }
        let shown = lastCheckout ?? breakdown(checkout, tip: pendingTipCents)
        return CardCheckoutPricing.formatUSD(cents: shown.totalCents)
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
            includesSignature: false,
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
                .foregroundStyle(AppDesign.accentGreen)
            Text("Payment approved")
                .font(.headline)
            if case .approved(let cents) = phase {
                Text(formatCurrency(Double(cents) / 100))
                    .font(.title2.weight(.semibold))
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
            detailMessage: detailMessage,
            paymentMethodLabel: "Tap to Pay on iPhone"
        )
        showTapToPayReceiptSheet = true
    }

    private func presentManualPaymentNotice(detailMessage: String) {
        let checkout = lastCheckout ?? viewModel.checkoutBreakdown(
            serviceCents: serviceAmountCents,
            channel: .online
        )
        receiptDetail = PaymentReceiptDetail.fromTapToPayUnsuccessful(
            checkout: checkout,
            businessName: viewModel.effectiveTapToPayDisplayName,
            customerName: selectedClient?.name,
            note: noteText,
            reason: unpaidAttemptReason(for: detailMessage),
            detailMessage: detailMessage,
            paymentMethodLabel: "Manual payment"
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

    private func pay(tipCents: Int = 0) async {
        userCanceledPayment = false
        TapToPayTerminalManager.shared.resetCancel()
        pendingTipCents = tipCents
        // Until the server answers, show (and keep for any receipt) the estimate with the tip.
        lastCheckout = breakdown(checkout, tip: tipCents)
        lastPaymentIntentId = nil
        phase = .processing
        do {
            guard !locationId.isEmpty else {
                throw TapToPayTerminalManager.TapToPayError.missingLocationId
            }
            let intent = try await viewModel.createPaymentIntentForTapToPay(
                serviceAmountCents: serviceAmountCents,
                bookingRequestId: linkedBookingRequestId,
                tipCents: tipCents
            )
            lastCheckout = intent.checkout
            lastPaymentIntentId = intent.paymentIntentId
            if userCanceledPayment { return }
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
            let totalCents = intent.checkout.totalCents
            phase = .approved(amountCents: totalCents)
            presentOnScreenReceipt()
        } catch {
            // Cancel on our screen: no "not completed" receipt, just back to the tip screen.
            if userCanceledPayment { return }
            let text = TapToPayErrorMapper.userMessage(for: error)
            manualCheckoutError = nil
            phase = .entry
            presentPaymentNotice(
                reason: unpaidAttemptReason(for: text),
                detailMessage: text
            )
        }
    }

    private func openManualCheckout(tipCents: Int = 0) async {
        manualCheckoutError = nil
        guard serviceAmountCents >= 50 else {
            manualCheckoutError = "Enter an amount of at least $0.50."
            return
        }
        let result = await viewModel.chargeManualCheckoutInApp(
            serviceAmountCents: serviceAmountCents,
            bookingRequestId: linkedBookingRequestId,
            tipCents: tipCents
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
            lastCheckout = breakdown(
                viewModel.checkoutBreakdown(serviceCents: serviceAmountCents, channel: .online),
                tip: tipCents
            )
            presentManualPaymentNotice(detailMessage: message)
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
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



/// Branded processing screen for Tap to Pay: the bronze crown slides up and settles, then a soft glow.
private struct TapToPayProcessingView: View {
    let amountText: String?
    let statusText: String
    let breakdown: CardCheckoutBreakdown
    let onCancel: () -> Void
    @State private var risen = false
    @State private var glow = false
    @State private var cardUp = false

    private func row(_ label: String, _ cents: Int, bold: Bool = false) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(CardCheckoutPricing.formatUSD(cents: cents))
        }
        .font(bold ? .subheadline.weight(.bold) : .subheadline)
        .foregroundStyle(bold ? AppDesign.textPrimary : AppDesign.textSecondary)
    }

    /// Slides up from the bottom with the same spring as the crown.
    private var breakdownCard: some View {
        VStack(spacing: 8) {
            row("Service", breakdown.serviceCents)
            if breakdown.taxCents > 0 { row("Sales tax", breakdown.taxCents) }
            if breakdown.passThroughFeeCents > 0 { row("Fees", breakdown.passThroughFeeCents) }
            if breakdown.tipCents > 0 { row("Tip", breakdown.tipCents) }
            Divider()
            row("Total", breakdown.totalCents, bold: true)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AppDesign.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AppDesign.chipBorder, lineWidth: 1))
        .offset(y: cardUp ? 0 : 320)
        .opacity(cardUp ? 1 : 0)
    }

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Image("BookkingCrownMark")
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .shadow(color: AppDesign.brandWarm.opacity(glow ? 0.35 : 0.08), radius: glow ? 18 : 6)
                .offset(y: risen ? 0 : 220)
                .opacity(risen ? 1 : 0)
            Text("Processing…")
                .font(.title3.weight(.semibold))
                .opacity(risen ? 1 : 0)
            if let amountText {
                Text(amountText)
                    .font(.title2.weight(.bold))
                    .opacity(risen ? 1 : 0)
            }
            Text(statusText)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .multilineTextAlignment(.center)
                .opacity(risen ? 1 : 0)
            ProgressView()
                .opacity(risen ? 1 : 0)
            Spacer(minLength: 0)
            breakdownCard
            Button("Cancel", action: onCancel)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.top, 4)
                .padding(.bottom, 8)
                .opacity(cardUp ? 1 : 0)
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.82)) { risen = true }
            withAnimation(.spring(response: 0.6, dampingFraction: 0.85).delay(0.15)) { cardUp = true }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true).delay(0.6)) { glow = true }
        }
    }
}

#endif
