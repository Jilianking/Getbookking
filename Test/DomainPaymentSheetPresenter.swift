//
//  DomainPaymentSheetPresenter.swift
//  Platform Stripe PaymentSheet for domain buy / transfer-in (Get Bookking account).
//

import Foundation
import StripePaymentSheet
import UIKit

enum DomainPaymentSheetResult {
    case completed
    case canceled
    case failed(String)
}

enum DomainPaymentSheetPresenter {
    @MainActor
    private final class PresentationState {
        var paymentSheet: PaymentSheet?
    }

    @MainActor
    static func present(
        clientSecret: String,
        publishableKey: String?,
        merchantDisplayName: String = "Get Bookking"
    ) async -> DomainPaymentSheetResult {
        var pk = (publishableKey ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if pk.isEmpty {
            pk = SecretsManager.shared.stripePublishableKey
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !pk.isEmpty else {
            return .failed("Stripe is not configured.")
        }
        guard let topViewController = UIApplication.manualPaymentTopViewController else {
            return .failed("Could not open payment sheet.")
        }

        STPAPIClient.shared.publishableKey = pk
        STPAPIClient.shared.stripeAccount = nil

        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = merchantDisplayName
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
