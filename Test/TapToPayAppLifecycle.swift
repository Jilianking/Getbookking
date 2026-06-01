//
//  TapToPayAppLifecycle.swift
//  Reader warm-up when app becomes active (Apple 4.1).
//

import Foundation

#if TAP_TO_PAY_ENABLED
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
        let locationId = TapToPayLocationStore.shared.resolvedLocationId
        guard !locationId.isEmpty else { return }
        Task {
            await TapToPayTerminalManager.shared.warmUpReader(locationId: locationId)
        }
        #endif
    }
}
