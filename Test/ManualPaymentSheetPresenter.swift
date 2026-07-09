//
//  ManualPaymentSheetPresenter.swift
//  In-app manual card entry via Stripe Payment Sheet (Connect direct charges).
//

import Foundation
import StripePaymentSheet
import UIKit

struct ManualCheckoutPaymentIntent {
    let clientSecret: String
    let paymentIntentId: String
    let stripeAccountId: String
    let checkout: CardCheckoutBreakdown
}

enum ManualCheckoutChargeOutcome {
    case success(ManualCheckoutPaymentIntent)
    case canceled
    case failed(String)
}

enum ManualCheckoutPaymentResult {
    case completed
    case canceled
    case failed(String)
}

enum ManualPaymentSheetPresenter {
    @MainActor
    private final class PresentationState {
        var paymentSheet: PaymentSheet?
    }

    @MainActor
    static func present(
        clientSecret: String,
        stripeAccountId: String,
        merchantDisplayName: String
    ) async -> ManualCheckoutPaymentResult {
        let publishableKey = SecretsManager.shared.stripePublishableKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !publishableKey.isEmpty else {
            return .failed("Stripe is not configured. Add STRIPE_PUBLISHABLE_KEY to Secrets.plist.")
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
        state.paymentSheet = PaymentSheet(
            paymentIntentClientSecret: clientSecret,
            configuration: configuration
        )

        return await withCheckedContinuation { continuation in
            state.paymentSheet?.present(from: topViewController) { result in
                Task { @MainActor in
                    state.paymentSheet = nil
                    STPAPIClient.shared.stripeAccount = nil
                    switch result {
                    case .completed:
                        continuation.resume(returning: .completed)
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

private extension UIApplication {
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
