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

    /// Foreground / launch warm-up: prepare location silently; connect reader without presenting T&C.
    static func warmUpReaderIfConfigured() {
        #if TAP_TO_PAY_ENABLED
        Task {
            _ = await prewarm()
        }
        #endif
    }

    #if TAP_TO_PAY_ENABLED
    /// Prepares Terminal location (new merchants). Silently reconnects when Apple already accepted T&C.
    /// Returns `prepareTapToPayTermsAcceptance` payload when that call ran successfully.
    static func prewarm() async -> [String: Any]? {
        await TapToPayPrewarmCoordinator.shared.prewarm()
    }

    static func performPrewarmWork() async -> [String: Any]? {
        guard Auth.auth().currentUser != nil else { return nil }
        if TapToPayEligibility.blockingMessage() != nil { return nil }

        TapToPayTerminalManager.shared.prepareTerminalSDK()

        let store = TapToPayLocationStore.shared
        let cached = await MainActor.run {
            (locationId: store.resolvedLocationId, displayName: store.merchantDisplayName)
        }

        // Status sync and early reader warm-up run together when we already have a location.
        async let statusSync: Void = syncConnectStatusForTapToPay()

        if !cached.locationId.isEmpty {
            async let earlyWarm: Void = TapToPayTerminalManager.shared.warmUpReader(
                locationId: cached.locationId,
                merchantDisplayName: cached.displayName.isEmpty ? nil : cached.displayName,
                silent: true
            )
            await statusSync
            await earlyWarm
        } else {
            await statusSync
        }

        var prepareData: [String: Any]?
        if await MainActor.run(body: { store.resolvedLocationId.isEmpty }) {
            prepareData = await callPrepareTapToPayTermsAcceptance()
            if let prepareData {
                await applyPrepareDataToStore(prepareData)
            }
        }

        let locationId = await MainActor.run { store.resolvedLocationId }
        guard !locationId.isEmpty else { return prepareData }

        let displayName = await MainActor.run { store.merchantDisplayName }
        let skipWarmUp = await TapToPayTerminalManager.shared.shouldSkipWarmUp(
            locationId: locationId,
            merchantDisplayName: displayName
        )
        if !skipWarmUp {
            // Silent: reconnects without T&C UI when Apple already accepted on this device.
            // First-time merchants still accept terms via the explicit enablement path.
            await TapToPayTerminalManager.shared.warmUpReader(
                locationId: locationId,
                merchantDisplayName: displayName.isEmpty ? nil : displayName,
                silent: true
            )
        }
        return prepareData
    }

    /// Loads Terminal location + customer-facing name before reader connect (avoids stale “Pay ___” labels).
    private static func syncConnectStatusForTapToPay() async {
        guard Auth.auth().currentUser != nil else { return }
        do {
            let result = try await Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
                .httpsCallable("getConnectAccountStatus")
                .call()
            let data = result.data as? [String: Any]
            await MainActor.run {
                TapToPayLocationStore.shared.applyConnectStatus(
                    terminalLocationId: data?["terminalLocationId"] as? String,
                    paymentScope: data?["paymentScope"] as? String
                )
                if let tapName = data?["tapToPayDisplayName"] as? String, !tapName.isEmpty {
                    TapToPayLocationStore.shared.updateMerchantDisplayName(tapName)
                }
            }
        } catch {
            // Warm-up still runs with cached store values.
        }
    }

    private static func callPrepareTapToPayTermsAcceptance() async -> [String: Any]? {
        do {
            let result = try await Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
                .httpsCallable("prepareTapToPayTermsAcceptance")
                .call([:])
            return result.data as? [String: Any]
        } catch {
            return nil
        }
    }

    @MainActor
    private static func applyPrepareDataToStore(_ data: [String: Any]) {
        let locationId = (data["locationId"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = (data["displayName"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !locationId.isEmpty else { return }
        TapToPayLocationStore.shared.applyConnectStatus(
            terminalLocationId: locationId,
            paymentScope: data["paymentScope"] as? String
        )
        if !displayName.isEmpty {
            TapToPayLocationStore.shared.updateMerchantDisplayName(displayName)
        }
    }
    #endif
}

#if TAP_TO_PAY_ENABLED
actor TapToPayPrewarmCoordinator {
    static let shared = TapToPayPrewarmCoordinator()

    private var inFlight: Task<[String: Any]?, Never>?

    func prewarm() async -> [String: Any]? {
        if let inFlight {
            return await inFlight.value
        }
        let task = Task<[String: Any]?, Never> {
            await TapToPayAppLifecycle.performPrewarmWork()
        }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }
}
#endif
