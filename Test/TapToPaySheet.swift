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
    var onDismiss: () -> Void

    @State private var amountText = ""
    @State private var phase: TapToPayCheckoutPhase = .entry
    @State private var showShareReceipt = false
    @State private var receiptText = ""

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var canPay: Bool {
        amountCents >= 50 && phase == .entry
    }

    private var locationId: String {
        viewModel.resolvedTapToPayLocationId
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                readerStatusBlock

                switch phase {
                case .entry:
                    entryContent
                case .processing:
                    processingContent
                case .approved:
                    outcomeContent(success: true)
                case .declined(let message):
                    outcomeContent(success: false, message: message)
                case .failed(let message):
                    outcomeContent(success: false, message: message)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 16)
            .padding(.horizontal, 20)
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
            .task {
                await TapToPayTerminalManager.shared.warmUpReader(locationId: locationId)
            }
        }
    }

    @ViewBuilder
    private var readerStatusBlock: some View {
        if let progress = readerSession.preparationProgress, progress < 1, phase == .entry {
            VStack(spacing: 8) {
                ProgressView(value: progress)
                Text(readerSession.statusMessage ?? "Preparing reader…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        } else if let status = readerSession.statusMessage, phase == .entry || phase == .processing {
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var entryContent: some View {
        VStack(spacing: 16) {
            Image(systemName: "wave.3.right.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(.blue)
                .accessibilityHidden(true)

            Text("Hold the customer's card near the top of your iPhone when prompted.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            TextField("0.00", text: $amountText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .font(.title2.monospacedDigit())
                .multilineTextAlignment(.center)
                .disabled(!readerSession.isReaderReady && locationId.isEmpty == false)

            Button(action: { Task { await pay() } }) {
                HStack {
                    Text("Charge")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(canPay ? Color.blue : Color.gray)
                .foregroundColor(.white)
                .cornerRadius(12)
            }
            .disabled(!canPay)
        }
    }

    private var processingContent: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Processing…")
                .font(.headline)
            Text(readerSession.statusMessage ?? "Keep the card on the reader until finished.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 24)
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
                    .foregroundStyle(.secondary)
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
        .padding(.top, 12)
    }

    private func pay() async {
        phase = .processing
        do {
            guard !locationId.isEmpty else {
                throw TapToPayTerminalManager.TapToPayError.missingLocationId
            }
            let clientSecret = try await viewModel.createPaymentIntentForTapToPay(amountCents: amountCents)
            try await TapToPayTerminalManager.shared.processPayment(clientSecret: clientSecret, locationId: locationId)
            await viewModel.loadData(isDemoMode: false)
            phase = .approved(amountCents: amountCents)
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
        return "Payment receipt — \(amount)\nPaid via Tap to Pay on iPhone.\nThank you for your business."
    }

    private func shareReceiptURL() -> URL? {
        URL(string: "https://getbookking.com")
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
