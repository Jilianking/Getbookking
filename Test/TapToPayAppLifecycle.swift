//
//  TapToPayAppLifecycle.swift
//  Reader warm-up when app becomes active (Apple 4.1).
//

import Foundation

#if TAP_TO_PAY_ENABLED
import FirebaseAuth
import FirebaseFunctions
import StripeTerminal
#endif

enum TapToPayAppLifecycle {
    static func configureTerminalAtLaunch() {
        #if TAP_TO_PAY_ENABLED
        Terminal.setTokenProvider(TapToPayConnectionTokenProvider.shared)
        #endif
    }

    static func warmUpReaderIfConfigured() {
        #if TAP_TO_PAY_ENABLED
        Task {
            await syncConnectStatusForTapToPay()
            let store = TapToPayLocationStore.shared
            let locationId = store.resolvedLocationId
            guard !locationId.isEmpty else { return }
            await TapToPayTerminalManager.shared.warmUpReader(
                locationId: locationId,
                merchantDisplayName: store.merchantDisplayName
            )
        }
        #endif
    }

    #if TAP_TO_PAY_ENABLED
    /// Loads Terminal location + customer-facing name before reader connect (avoids stale “Pay ___” labels).
    private static func syncConnectStatusForTapToPay() async {
        guard Auth.auth().currentUser != nil else { return }
        do {
            let result = try await Functions.functions().httpsCallable("getConnectAccountStatus").call()
            let data = result.data as? [String: Any]
            TapToPayLocationStore.shared.applyConnectStatus(
                terminalLocationId: data?["terminalLocationId"] as? String,
                paymentScope: data?["paymentScope"] as? String
            )
            if let tapName = data?["tapToPayDisplayName"] as? String, !tapName.isEmpty {
                TapToPayLocationStore.shared.updateMerchantDisplayName(tapName)
            }
        } catch {
            // Warm-up still runs with cached store values.
        }
    }
    #endif
}
