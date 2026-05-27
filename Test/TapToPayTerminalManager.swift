//
//  TapToPayTerminalManager.swift
//  Test
//
//  Minimal Tap to Pay on iPhone integration using Stripe Terminal iOS SDK:
//  discover -> connect -> retrieve PaymentIntent -> collect -> confirm.
//

#if TAP_TO_PAY_ENABLED

import Foundation
import StripeTerminal

final class TapToPayTerminalManager {
    static let shared = TapToPayTerminalManager()

    // Ensure the SDK is initialized only once per app launch.
    private var isInitialized = false
    private let initLock = NSLock()

    // Stripe requires the reader delegate instance to be retained until the reader disconnects.
    // Keep strong references while we run a Tap-to-Pay payment flow.
    private var activeDiscoveryDelegate: TapToPayDiscoveryDelegate?
    private var activeReaderDelegate: TapToPayReaderDelegateAnnouncer?

    private init() {}

    private func ensureInitialized() {
        initLock.lock()
        defer { initLock.unlock() }
        guard !isInitialized else { return }

        // Must be called before using `Terminal.shared`.
        Terminal.initWithTokenProvider(TapToPayConnectionTokenProvider.shared)
        isInitialized = true
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
        // Keep the implementation minimal for now; delegate events can be expanded
        // later to surface progress/status to the UI.

        func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {}

        func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {}

        func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {}

        func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {}

        func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {}

        func reader(_ reader: Reader, didDisconnect reason: DisconnectReason) {}

        func reader(_ reader: Reader, didStartReconnect cancelable: Cancelable, disconnectReason: DisconnectReason) {}

        func readerDidSucceedReconnect(_ reader: Reader) {}

        func readerDidFailReconnect(_ reader: Reader) {}
    }

    enum TapToPayError: LocalizedError {
        case missingLocationId
        case noReadersFound
        case terminalConnectionFailed

        var errorDescription: String? {
            switch self {
            case .missingLocationId:
                return "Tap to Pay is not configured (missing `TAP_TO_PAY_LOCATION_ID`)."
            case .noReadersFound:
                return "No Tap to Pay readers were found on this device."
            case .terminalConnectionFailed:
                return "Could not connect to Tap to Pay reader."
            }
        }
    }

    /// Processes a Tap to Pay payment using an existing PaymentIntent client secret.
    func processPayment(clientSecret: String, locationId: String) async throws {
        ensureInitialized()

        guard !locationId.isEmpty else {
            throw TapToPayError.missingLocationId
        }

        defer {
            activeDiscoveryDelegate = nil
            activeReaderDelegate = nil
        }

        let reader = try await discoverTapToPayReader()
        try await connectTapToPayReader(reader: reader, locationId: locationId)

        // Payment collection/confirmation
        let paymentIntent = try await Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret)
        let collectedIntent = try await collectPaymentMethod(paymentIntent: paymentIntent)
        _ = try await confirmPaymentIntent(paymentIntent: collectedIntent)
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
                } else {
                    // Keep waiting; Tap to Pay discover returns once per call.
                    // We'll rely on the completion handler below.
                }
            }
            // Retain delegate for the duration of discovery.
            self.activeDiscoveryDelegate = delegate

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

    private func connectTapToPayReader(reader: Reader, locationId: String) async throws {
        let readerDelegate = TapToPayReaderDelegateAnnouncer()
        // Retain delegate for the lifetime of the connection.
        activeReaderDelegate = readerDelegate
        let connectionConfig = try TapToPayConnectionConfigurationBuilder(locationId: locationId)
            .delegate(readerDelegate)
            .build()

        try await withCheckedThrowingContinuation { continuation in
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
                    continuation.resume(throwing: NSError(domain: "TapToPay", code: -2, userInfo: [NSLocalizedDescriptionKey: "Collect payment method failed."]))
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
                    continuation.resume(throwing: NSError(domain: "TapToPay", code: -3, userInfo: [NSLocalizedDescriptionKey: "Confirm payment failed."]))
                }
            }
        }
    }
}

#endif
