//
//  TapToPayTerminalManager.swift
//  Stripe Terminal Tap to Pay: warm-up at launch, collect, confirm.
//

#if TAP_TO_PAY_ENABLED

import Foundation
import StripeTerminal

final class TapToPayTerminalManager {
    static let shared = TapToPayTerminalManager()

    private var isInitialized = false
    private let initLock = NSLock()

    private var activeDiscoveryDelegate: TapToPayDiscoveryDelegate?
    private var activeReaderDelegate: TapToPayReaderDelegateAnnouncer?
    private var connectedReader: Reader?

    private init() {}

    private func ensureInitialized() {
        initLock.lock()
        defer { initLock.unlock() }
        guard !isInitialized else { return }
        Terminal.setTokenProvider(TapToPayConnectionTokenProvider.shared)
        _ = Terminal.shared
        isInitialized = true
    }

    /// Discover + connect reader (launch / foreground / before checkout).
    func warmUpReader(locationId: String) async {
        guard !locationId.isEmpty else {
            await MainActor.run {
                TapToPayReaderSession.shared.markFailed("Tap to Pay location is not configured.")
            }
            return
        }
        if let blocking = TapToPayEligibility.blockingMessage() {
            await MainActor.run { TapToPayReaderSession.shared.markFailed(blocking) }
            return
        }

        ensureInitialized()

        if let deviceBlock = TapToPayEligibility.deviceSupportsTapToPay() {
            await MainActor.run { TapToPayReaderSession.shared.markFailed(deviceBlock) }
            return
        }

        if connectedReader != nil {
            await MainActor.run { TapToPayReaderSession.shared.markReady() }
            return
        }

        await MainActor.run { TapToPayReaderSession.shared.resetForWarmUp() }

        do {
            let reader = try await discoverTapToPayReader()
            try await connectTapToPayReader(reader: reader, locationId: locationId)
            connectedReader = reader
            await MainActor.run { TapToPayReaderSession.shared.markReady() }
        } catch {
            connectedReader = nil
            await MainActor.run {
                TapToPayReaderSession.shared.markFailed(TapToPayErrorMapper.userMessage(for: error))
            }
        }
    }

    func processPayment(clientSecret: String, locationId: String) async throws {
        ensureInitialized()
        guard !locationId.isEmpty else { throw TapToPayError.missingLocationId }

        if connectedReader == nil {
            try await warmUpReaderThrowing(locationId: locationId)
        }

        let paymentIntent = try await Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret)
        let collectedIntent = try await collectPaymentMethod(paymentIntent: paymentIntent)
        _ = try await confirmPaymentIntent(paymentIntent: collectedIntent)
    }

    private func warmUpReaderThrowing(locationId: String) async throws {
        if let blocking = TapToPayEligibility.blockingMessage() { throw TapToPayError.message(blocking) }
        if let deviceBlock = TapToPayEligibility.deviceSupportsTapToPay() { throw TapToPayError.message(deviceBlock) }
        let reader = try await discoverTapToPayReader()
        try await connectTapToPayReader(reader: reader, locationId: locationId)
        connectedReader = reader
        await MainActor.run { TapToPayReaderSession.shared.markReady() }
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
                TapToPayReaderSession.shared.markTermsAccepted()
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
            TapToPayTerminalManager.shared.connectedReader = nil
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
                return "Tap to Pay is not configured. Add a Terminal location in Stripe Dashboard."
            case .noReadersFound:
                return "No Tap to Pay reader is available on this device."
            case .terminalConnectionFailed:
                return "Could not connect to Tap to Pay."
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

    private func connectTapToPayReader(reader: Reader, locationId: String) async throws {
        let readerDelegate = TapToPayReaderDelegateAnnouncer()
        activeReaderDelegate = readerDelegate
        let connectionConfig = try TapToPayConnectionConfigurationBuilder(
            delegate: readerDelegate,
            locationId: locationId
        )
        .setAutoReconnectOnUnexpectedDisconnect(true)
        .build()

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
