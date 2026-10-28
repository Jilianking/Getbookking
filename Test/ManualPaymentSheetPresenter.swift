//
//  ManualPaymentSheetPresenter.swift
//  In-app manual card entry via Stripe Payment Sheet (Connect direct charges).
//

import Foundation
import StripePaymentSheet
import UIKit

struct InAppCheckoutPrice {
    let method: String
    let checkout: CardCheckoutBreakdown

    var paymentMethodLabel: String {
        method == "instant_bank" ? "Bank" : "Manual payment"
    }
}

struct ManualCheckoutPaymentIntent {
    let clientSecret: String
    let paymentIntentId: String
    let stripeAccountId: String
    /// Stripe key sent by the server for this payment (test or live, matching the server).
    var publishableKey: String? = nil
    var checkout: CardCheckoutBreakdown
    var paymentMethodLabel: String = "Manual payment"
}

enum ManualCheckoutChargeOutcome {
    case success(ManualCheckoutPaymentIntent)
    case canceled
    case failed(String)
}

enum ManualCheckoutPaymentResult {
    case completed(InAppCheckoutPrice?)
    case canceled
    case failed(String)
}

enum ManualPaymentSheetPresenter {
    @MainActor
    private final class PresentationState {
        var paymentSheet: PaymentSheet?
        var settledPrice: InAppCheckoutPrice?
    }

    /// Presents the sheet at the card total. When the customer taps Pay, `reprice`
    /// sets the PaymentIntent to the method they actually used before Stripe confirms.
    @MainActor
    static func present(
        clientSecret: String,
        stripeAccountId: String,
        publishableKey serverPublishableKey: String? = nil,
        merchantDisplayName: String,
        amountCents: Int,
        reprice: @escaping (String) async throws -> InAppCheckoutPrice
    ) async -> ManualCheckoutPaymentResult {
        // Prefer the server's key so the app always matches the server's Stripe mode; the key
        // built into the app is only a fallback for an older server.
        let fromServer = (serverPublishableKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let publishableKey = fromServer.isEmpty
            ? SecretsManager.shared.stripePublishableKey.trimmingCharacters(in: .whitespacesAndNewlines)
            : fromServer
        guard !publishableKey.isEmpty else {
            return .failed("Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to Secrets.plist.")
        }
        guard amountCents >= 50 else {
            return .failed("Amount must be at least $0.50")
        }
        guard let topViewController = UIApplication.manualPaymentTopViewController else {
            return .failed("Could not open payment sheet.")
        }

        STPAPIClient.shared.publishableKey = publishableKey
        STPAPIClient.shared.stripeAccount = stripeAccountId

        var configuration = PaymentSheet.Configuration()
        let trimmedName = merchantDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        configuration.merchantDisplayName = trimmedName.isEmpty ? "Payment" : trimmedName
        configuration.allowsDelayedPaymentMethods = false

        let state = PresentationState()
        let intentConfiguration = PaymentSheet.IntentConfiguration(
            mode: .payment(amount: amountCents, currency: "USD"),
            paymentMethodTypes: ["card"]
        ) { paymentMethod, _, callback in
            let paymentMethodId = paymentMethod.stripeId
            Task {
                do {
                    guard paymentMethodId.hasPrefix("pm_") else {
                        throw NSError(
                            domain: "Payments",
                            code: 4,
                            userInfo: [NSLocalizedDescriptionKey: "Could not price this payment method."]
                        )
                    }
                    let priced = try await reprice(paymentMethodId)
                    await MainActor.run {
                        state.settledPrice = priced
                    }
                    callback(.success(clientSecret))
                } catch {
                    callback(.failure(error))
                }
            }
        }

        state.paymentSheet = PaymentSheet(
            intentConfiguration: intentConfiguration,
            configuration: configuration
        )

        return await withCheckedContinuation { continuation in
            state.paymentSheet?.present(from: topViewController) { result in
                Task { @MainActor in
                    let settledPrice = state.settledPrice
                    state.paymentSheet = nil
                    STPAPIClient.shared.stripeAccount = nil
                    switch result {
                    case .completed:
                        continuation.resume(returning: .completed(settledPrice))
                    case .canceled:
                        continuation.resume(returning: .canceled)
                    case .failed(let error):
                        continuation.resume(returning: .failed(error.localizedDescription))
                    }
                }
            }
        }
    }
}

extension UIApplication {
    @MainActor
    static var manualPaymentTopViewController: UIViewController? {
        let scenes = shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        guard var top = window?.rootViewController else { return nil }
        while let presented = top.presentedViewController {
            top = presented
        }
        return top
    }
}
