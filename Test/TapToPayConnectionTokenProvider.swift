//
//  TapToPayConnectionTokenProvider.swift
//  Test
//
//  Provides Stripe Terminal ConnectionTokens to the iOS SDK by calling our
//  authenticated Firebase callable function.
//

#if TAP_TO_PAY_ENABLED

import Foundation
import FirebaseAuth
import FirebaseFunctions
import StripeTerminal

final class TapToPayConnectionTokenProvider: ConnectionTokenProvider {
    static let shared = TapToPayConnectionTokenProvider()

    private init() {}

    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    func fetchConnectionToken() async throws -> String {
        guard Auth.auth().currentUser != nil else {
            throw NSError(
                domain: "TapToPayConnectionTokenProvider",
                code: 401,
                userInfo: [NSLocalizedDescriptionKey: "You must be signed in to accept Tap to Pay payments."]
            )
        }

        let result = try await functions.httpsCallable("createTerminalConnectionTokenForTapToPay").call()
        let data = result.data as? [String: Any]
        let secret = data?["secret"] as? String
        if let secret, !secret.isEmpty {
            return secret
        }

        throw NSError(
            domain: "TapToPayConnectionTokenProvider",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Invalid response from server (missing connection token secret)."]
        )
    }
}

#endif
