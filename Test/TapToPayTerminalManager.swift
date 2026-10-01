//
//  TapToPayTerminalManager.swift
//  Stripe Terminal Tap to Pay: warm-up at launch, collect, confirm.
//

#if TAP_TO_PAY_ENABLED

import Foundation
import StripeTerminal

/// Serializes Stripe Terminal reader operations (discover, connect, disconnect, pay).
actor TapToPayReaderOperationCoordinator {
    static let shared = TapToPayReaderOperationCoordinator()

    private var isRunning = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func withLock<T>(_ body: () async throws -> T) async rethrows -> T {
        await acquire()
        defer { release() }
        return try await body()
    }

    private func acquire() async {
        if !isRunning {
            isRunning = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    private func release() {
        if waiters.isEmpty {
            isRunning = false
            return
        }
        waiters.removeFirst().resume()
    }
}

final class TapToPayTerminalManager {
    static let shared = TapToPayTerminalManager()

    private var isInitialized = false
    private let initLock = NSLock()

    private var activeDiscoveryDelegate: TapToPayDiscoveryDelegate?
    private var activeReaderDelegate: TapToPayReaderDelegateAnnouncer?
    private var connectedReader: Reader?
    private var connectedLocationId: String = ""
    private var connectedMerchantDisplayName: String = ""

    private init() {}

    private func ensureInitialized() {
        initLock.lock()
        defer { initLock.unlock() }
        guard !isInitialized else { return }
        Terminal.setTokenProvider(TapToPayConnectionTokenProvider.shared)
        _ = Terminal.shared
        isInitialized = true
    }

    /// Initializes Stripe Terminal SDK without connecting (speeds up first tap connect).
    func prepareTerminalSDK() {
        ensureInitialized()
    }

    /// True when the reader is connected for the given location and display name.
    func shouldSkipWarmUp(locationId: String, merchantDisplayName: String?) async -> Bool {
        await TapToPayReaderOperationCoordinator.shared.withLock {
            guard !locationId.isEmpty else { return false }
            let resolvedName = normalizedMerchantDisplayName(merchantDisplayName)
            let termsAlreadyAccepted = await MainActor.run {
                TapToPayReaderSession.shared.termsAcceptedOnDevice
            }
            return isConnectedForConfiguration(
                locationId: locationId,
                merchantDisplayName: resolvedName,
                termsAlreadyAccepted: termsAlreadyAccepted
            )
        }
    }

    /// Discover + connect reader (launch / foreground / before checkout).
    /// - Parameter silent: When true, never presents Apple T&C (`tosAcceptancePermitted = false`)
    ///   and suppresses failure UI. Used for background prewarm on cold start.
    func warmUpReader(
        locationId: String,
        merchantDisplayName: String? = nil,
        silent: Bool = false
    ) async {
        await TapToPayReaderOperationCoordinator.shared.withLock {
            await warmUpReaderUnlocked(
                locationId: locationId,
                merchantDisplayName: merchantDisplayName,
                silent: silent
            )
        }
    }

    /// Drops an active reader session (e.g. merchant dismissed Apple T&C without accepting).
    func releaseReaderConnection() async {
        await TapToPayReaderOperationCoordinator.shared.withLock {
            await disconnectReaderIfConnected()
        }
    }

    /// Disconnect and reconnect so Stripe Terminal picks up a new merchant display name.
    func reconnectReader(locationId: String, merchantDisplayName: String) async {
        await TapToPayReaderOperationCoordinator.shared.withLock {
            await disconnectReaderIfConnected()
            await warmUpReaderUnlocked(
                locationId: locationId,
                merchantDisplayName: merchantDisplayName,
                silent: false
            )
        }
    }

    /// Connect Tap to Pay reader (shows Apple T&C on first use). Used before Stripe Connect onboarding.
    func connectReaderForTermsAcceptance(
        locationId: String,
        merchantDisplayName: String? = nil
    ) async throws {
        try await TapToPayReaderOperationCoordinator.shared.withLock {
            try await connectReaderForTermsAcceptanceUnlocked(
                locationId: locationId,
                merchantDisplayName: merchantDisplayName
            )
        }
    }

    func processPayment(clientSecret: String, locationId: String, merchantDisplayName: String? = nil) async throws {
        try await TapToPayReaderOperationCoordinator.shared.withLock {
            try await processPaymentUnlocked(
                clientSecret: clientSecret,
                locationId: locationId,
                merchantDisplayName: merchantDisplayName
            )
        }
    }

    // MARK: - Unlocked operations (caller must hold TapToPayReaderOperationCoordinator lock)

    private func warmUpReaderUnlocked(
        locationId: String,
        merchantDisplayName: String?,
        silent: Bool
    ) async {
        guard !locationId.isEmpty else {
            if !silent {
                await MainActor.run {
                    TapToPayReaderSession.shared.markFailed("Tap to Pay on iPhone location is not configured.")
                }
            }
            return
        }
        if let blocking = TapToPayEligibility.blockingMessage() {
            if !silent {
                await MainActor.run { TapToPayReaderSession.shared.markFailed(blocking) }
            }
            return
        }

        ensureInitialized()

        if let deviceBlock = TapToPayEligibility.deviceSupportsTapToPay() {
            if !silent {
                await MainActor.run { TapToPayReaderSession.shared.markFailed(deviceBlock) }
            }
            return
        }

        let resolvedName = normalizedMerchantDisplayName(merchantDisplayName)
        // Silent cold-start warm-up may prove Apple T&C via a successful connect.
        // Treat an already-connected reader as ready even before the in-memory flag is set.
        let termsAlreadyAccepted = silent || await MainActor.run {
            TapToPayReaderSession.shared.termsAcceptedOnDevice
        }

        if isConnectedForConfiguration(
            locationId: locationId,
            merchantDisplayName: resolvedName,
            termsAlreadyAccepted: termsAlreadyAccepted
        ) {
            await MainActor.run {
                TapToPayReaderSession.shared.markTermsConfirmedByPSPConnection()
                TapToPayReaderSession.shared.markReady()
            }
            return
        }

        if terminalHasConnectedReader() {
            await disconnectReaderIfConnected()
        }

        if !silent {
            await MainActor.run { TapToPayReaderSession.shared.resetForWarmUp() }
        }

        do {
            let reader = try await discoverTapToPayReader()
            // Background / checkout warm-up never presents Apple T&C. Enablement
            // flows use `connectReaderForTermsAcceptance` with tos permitted.
            try await connectTapToPayReader(
                reader: reader,
                locationId: locationId,
                merchantDisplayName: resolvedName,
                tosAcceptancePermitted: false
            )
            recordConnectedReader(reader, locationId: locationId, merchantDisplayName: resolvedName)
            await MainActor.run {
                TapToPayReaderSession.shared.markTermsConfirmedByPSPConnection()
                TapToPayReaderSession.shared.markReady()
            }
        } catch {
            clearConnectedReaderState()
            if !silent {
                await MainActor.run {
                    TapToPayReaderSession.shared.markFailed(TapToPayErrorMapper.userMessage(for: error))
                }
            }
        }
    }

    private func connectReaderForTermsAcceptanceUnlocked(
        locationId: String,
        merchantDisplayName: String?
    ) async throws {
        if let blocking = TapToPayEligibility.blockingMessage() { throw TapToPayError.message(blocking) }
        if let deviceBlock = TapToPayEligibility.deviceSupportsTapToPay() { throw TapToPayError.message(deviceBlock) }

        ensureInitialized()

        let resolvedName = normalizedMerchantDisplayName(merchantDisplayName)
        guard !locationId.isEmpty else { throw TapToPayError.missingLocationId }

        if terminalHasConnectedReader() {
            await disconnectReaderIfConnected()
        }

        await MainActor.run {
            TapToPayReaderSession.shared.resetForWarmUp()
        }

        let reader = try await discoverTapToPayReader()
        try await connectTapToPayReader(
            reader: reader,
            locationId: locationId,
            merchantDisplayName: resolvedName,
            tosAcceptancePermitted: true
        )
        recordConnectedReader(reader, locationId: locationId, merchantDisplayName: resolvedName)
        await MainActor.run { TapToPayReaderSession.shared.markReady() }

        // `tapToPayReaderDidAcceptTermsOfService` fires when terms are newly
        // accepted. A successful Stripe Terminal connection without that callback
        // means Stripe/Apple already has acceptance for this device. Keep this
        // result in memory only; never restore it from app-local storage.
        await MainActor.run {
            if !TapToPayReaderSession.shared.termsAcceptedOnDevice {
                TapToPayReaderSession.shared.markTermsConfirmedByPSPConnection()
            }
        }
    }

    private func processPaymentUnlocked(
        clientSecret: String,
        locationId: String,
        merchantDisplayName: String?
    ) async throws {
        ensureInitialized()
        guard !locationId.isEmpty else { throw TapToPayError.missingLocationId }

        let resolvedName = normalizedMerchantDisplayName(merchantDisplayName)
        if !isConnectedForConfiguration(
            locationId: locationId,
            merchantDisplayName: resolvedName,
            termsAlreadyAccepted: true
        ) {
            try await warmUpReaderThrowing(locationId: locationId, merchantDisplayName: resolvedName)
        }

        let paymentIntent = try await Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret)
        let collectedIntent = try await collectPaymentMethod(paymentIntent: paymentIntent)
        _ = try await confirmPaymentIntent(paymentIntent: collectedIntent)
    }

    private func warmUpReaderThrowing(locationId: String, merchantDisplayName: String) async throws {
        if let blocking = TapToPayEligibility.blockingMessage() { throw TapToPayError.message(blocking) }
        if let deviceBlock = TapToPayEligibility.deviceSupportsTapToPay() { throw TapToPayError.message(deviceBlock) }
        if terminalHasConnectedReader() {
            await disconnectReaderIfConnected()
        }
        let reader = try await discoverTapToPayReader()
        try await connectTapToPayReader(
            reader: reader,
            locationId: locationId,
            merchantDisplayName: merchantDisplayName,
            tosAcceptancePermitted: false
        )
        recordConnectedReader(reader, locationId: locationId, merchantDisplayName: merchantDisplayName)
        await MainActor.run {
            TapToPayReaderSession.shared.markTermsConfirmedByPSPConnection()
            TapToPayReaderSession.shared.markReady()
        }
    }

    private func normalizedMerchantDisplayName(_ override: String?) -> String {
        let raw = (override ?? TapToPayLocationStore.shared.merchantDisplayName)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return raw
    }

    private func terminalHasConnectedReader() -> Bool {
        Terminal.shared.connectedReader != nil || connectedReader != nil
    }

    private func syncConnectedReaderFromTerminalIfNeeded() {
        if connectedReader == nil, let sdkReader = Terminal.shared.connectedReader {
            connectedReader = sdkReader
        }
    }

    private func isConnectedForConfiguration(
        locationId: String,
        merchantDisplayName: String,
        termsAlreadyAccepted: Bool
    ) -> Bool {
        guard termsAlreadyAccepted else { return false }
        guard terminalHasConnectedReader() else { return false }
        syncConnectedReaderFromTerminalIfNeeded()
        return connectedLocationId == locationId
            && connectedMerchantDisplayName == merchantDisplayName
    }

    private func recordConnectedReader(_ reader: Reader, locationId: String, merchantDisplayName: String) {
        connectedReader = reader
        connectedLocationId = locationId
        connectedMerchantDisplayName = merchantDisplayName
    }

    private func clearConnectedReaderState() {
        connectedReader = nil
        connectedLocationId = ""
        connectedMerchantDisplayName = ""
    }

    private func disconnectReaderIfConnected() async {
        syncConnectedReaderFromTerminalIfNeeded()
        guard terminalHasConnectedReader() else {
            clearConnectedReaderState()
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Terminal.shared.disconnectReader { _ in
                continuation.resume()
            }
        }
        clearConnectedReaderState()
        await MainActor.run { TapToPayReaderSession.shared.markDisconnected() }
    }

    private final class TapToPayDiscoveryDelegate: NSObject, DiscoveryDelegate {
        private let onReaders: ([Reader]) -> Void

        init(onReaders: @escaping ([Reader]) -> Void) {
            self.onReaders = onReaders
        }

        func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
            onReaders(readers)
        }
    }

    private final class TapToPayReaderDelegateAnnouncer: NSObject, TapToPayReaderDelegate {
        func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
            Task { @MainActor in
                TapToPayReaderSession.shared.updateProgress(0)
            }
        }

        func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
            Task { @MainActor in
                TapToPayReaderSession.shared.updateProgress(progress)
            }
        }

        func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
            Task { @MainActor in
                if let error {
                    TapToPayReaderSession.shared.markFailed(TapToPayErrorMapper.userMessage(for: error))
                }
            }
        }

        func tapToPayReaderDidAcceptTermsOfService(_ reader: Reader) {
            Task { @MainActor in
                TapToPayReaderSession.shared.markTermsAcceptedFromApple()
            }
        }

        func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
            Task { @MainActor in
                TapToPayReaderSession.shared.updateReaderInput(inputOptions)
            }
        }

        func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
            Task { @MainActor in
                TapToPayReaderSession.shared.updateDisplayMessage(displayMessage)
            }
        }

        func reader(_ reader: Reader, didDisconnect reason: DisconnectReason) {
            TapToPayTerminalManager.shared.clearConnectedReaderState()
            Task { @MainActor in
                TapToPayReaderSession.shared.markDisconnected()
            }
        }

        func reader(_ reader: Reader, didStartReconnect cancelable: Cancelable, disconnectReason: DisconnectReason) {}

        func readerDidSucceedReconnect(_ reader: Reader) {
            Task { @MainActor in TapToPayReaderSession.shared.markReady() }
        }

        func readerDidFailReconnect(_ reader: Reader) {}
    }

    enum TapToPayError: LocalizedError {
        case missingLocationId
        case noReadersFound
        case terminalConnectionFailed
        case message(String)

        var errorDescription: String? {
            switch self {
            case .missingLocationId:
                return "Tap to Pay on iPhone is not configured. Add a Terminal location in Stripe Dashboard."
            case .noReadersFound:
                return "No Tap to Pay on iPhone reader is available on this device."
            case .terminalConnectionFailed:
                return "Could not connect to Tap to Pay on iPhone."
            case .message(let text):
                return text
            }
        }
    }

    private func discoverTapToPayReader() async throws -> Reader {
        let config = try TapToPayDiscoveryConfigurationBuilder().build()

        return try await withCheckedThrowingContinuation { continuation in
            var didResume = false

            let delegate = TapToPayDiscoveryDelegate { readers in
                if didResume { return }
                if let first = readers.first {
                    didResume = true
                    continuation.resume(returning: first)
                }
            }
            activeDiscoveryDelegate = delegate

            Terminal.shared.discoverReaders(config, delegate: delegate) { error in
                if didResume { return }
                didResume = true
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(throwing: TapToPayError.noReadersFound)
                }
            }
        }
    }

    private func connectTapToPayReader(
        reader: Reader,
        locationId: String,
        merchantDisplayName: String,
        tosAcceptancePermitted: Bool
    ) async throws {
        do {
            try await connectTapToPayReaderOnce(
                reader: reader,
                locationId: locationId,
                merchantDisplayName: merchantDisplayName,
                tosAcceptancePermitted: tosAcceptancePermitted
            )
        } catch {
            guard TapToPayErrorMapper.isAlreadyConnectedToReader(error) else { throw error }
            await disconnectReaderIfConnected()
            try await connectTapToPayReaderOnce(
                reader: reader,
                locationId: locationId,
                merchantDisplayName: merchantDisplayName,
                tosAcceptancePermitted: tosAcceptancePermitted
            )
        }
    }

    private func connectTapToPayReaderOnce(
        reader: Reader,
        locationId: String,
        merchantDisplayName: String,
        tosAcceptancePermitted: Bool
    ) async throws {
        let readerDelegate = TapToPayReaderDelegateAnnouncer()
        activeReaderDelegate = readerDelegate
        var builder = TapToPayConnectionConfigurationBuilder(
            delegate: readerDelegate,
            locationId: locationId
        )
        // Enablement flows pass true so Apple T&C can appear. Background warm-up
        // passes false so cold start never pops terms unexpectedly.
        .setTosAcceptancePermitted(tosAcceptancePermitted)
        .setAutoReconnectOnUnexpectedDisconnect(true)
        if !merchantDisplayName.isEmpty {
            builder = builder.setMerchantDisplayName(merchantDisplayName)
        }
        let connectionConfig = try builder.build()

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            Terminal.shared.connectReader(reader, connectionConfig: connectionConfig) { connectedReader, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard connectedReader != nil else {
                    continuation.resume(throwing: TapToPayError.terminalConnectionFailed)
                    return
                }
                continuation.resume(returning: ())
            }
        }
    }

    private func collectPaymentMethod(paymentIntent: PaymentIntent) async throws -> PaymentIntent {
        try await withCheckedThrowingContinuation { continuation in
            Terminal.shared.collectPaymentMethod(paymentIntent) { collectedIntent, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let collectedIntent {
                    continuation.resume(returning: collectedIntent)
                } else {
                    continuation.resume(throwing: TapToPayError.message("Could not read the card."))
                }
            }
        }
    }

    private func confirmPaymentIntent(paymentIntent: PaymentIntent) async throws -> PaymentIntent {
        try await withCheckedThrowingContinuation { continuation in
            Terminal.shared.confirmPaymentIntent(paymentIntent) { confirmedIntent, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let confirmedIntent {
                    continuation.resume(returning: confirmedIntent)
                } else {
                    continuation.resume(throwing: TapToPayError.message("Payment confirmation failed."))
                }
            }
        }
    }
}

#endif
