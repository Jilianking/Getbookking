//
//  TapToPaySheet.swift
//  Test
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

struct TapToPaySheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void

    @State private var amountText = ""
    @State private var isProcessing = false
    @State private var localErrorMessage: String?

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var canPay: Bool {
        amountCents >= 50
    }

    private var locationId: String {
        SecretsManager.shared.tapToPayLocationId
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text("Tap to Pay")
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                Text("Accept an in-person payment directly on this iPhone. Configure your Tap to Pay Location ID in `Secrets.plist` for Tap-to-Pay to connect.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                TextField("0.00", text: $amountText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)

                if let localErrorMessage {
                    Text(localErrorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                Button(action: {
                    Task { await pay() }
                }) {
                    HStack {
                        if isProcessing {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Charge")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(canPay && !isProcessing ? Color.blue : Color.gray)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
                .disabled(!canPay || isProcessing)

                Spacer(minLength: 0)
            }
            .padding(.top, 24)
            .navigationTitle("Tap to Pay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
            }
        }
    }

    private func pay() async {
        localErrorMessage = nil
        isProcessing = true

        do {
            guard !locationId.isEmpty else {
                throw TapToPayTerminalManager.TapToPayError.missingLocationId
            }

            let clientSecret = try await viewModel.createPaymentIntentForTapToPay(amountCents: amountCents)
            try await TapToPayTerminalManager.shared.processPayment(clientSecret: clientSecret, locationId: locationId)

            // Payment successful: refresh balances/transactions.
            await viewModel.loadData(isDemoMode: false)
            onDismiss()
        } catch {
            localErrorMessage = error.localizedDescription
            isProcessing = false
        }
        isProcessing = false
    }
}

#endif
