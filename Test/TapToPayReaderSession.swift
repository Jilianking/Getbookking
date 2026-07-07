//
//  TapToPayReaderSession.swift
//  Shared reader status for UI (progress, display messages, readiness).
//

#if TAP_TO_PAY_ENABLED

import Combine
import Foundation
import StripeTerminal

@MainActor
final class TapToPayReaderSession: ObservableObject {
    static let shared = TapToPayReaderSession()

    private static let termsConfirmedKey = "tapToPayTermsConfirmedByApple"
    private static let termsMigrationKey = "tapToPayTermsMigrationV3"

    @Published private(set) var preparationProgress: Double?
    @Published private(set) var statusMessage: String?
    @Published private(set) var isReaderReady = false
    /// True only after Apple T&C was confirmed via Stripe Terminal delegate (or a successful terms connect).
    @Published private(set) var termsAcceptedOnDevice = false

    private var termsAcceptanceContinuation: CheckedContinuation<Bool, Never>?
    private var termsAcceptanceTimeoutTask: Task<Void, Never>?

    private init() {
        migrateLegacyTermsAcceptanceIfNeeded()
        termsAcceptedOnDevice = UserDefaults.standard.bool(forKey: Self.termsConfirmedKey)
    }

    private func migrateLegacyTermsAcceptanceIfNeeded() {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: Self.termsMigrationKey) == false else { return }
        defaults.removeObject(forKey: "tapToPayTermsAcceptedOnDevice")
        defaults.removeObject(forKey: Self.termsConfirmedKey)
        defaults.set(true, forKey: Self.termsMigrationKey)
    }

    func resetForWarmUp() {
        preparationProgress = nil
        statusMessage = "Preparing Tap to Pay…"
        isReaderReady = false
    }

    func updateProgress(_ progress: Float) {
        preparationProgress = Double(progress)
        statusMessage = "Updating reader software… \(Int(progress * 100))%"
    }

    func updateDisplayMessage(_ message: ReaderDisplayMessage) {
        statusMessage = TapToPayReaderSession.humanReadable(displayMessage: message)
    }

    func updateReaderInput(_ options: ReaderInputOptions) {
        if !options.isEmpty {
            statusMessage = "Present card to reader"
        }
    }

    func markReady() {
        preparationProgress = 1
        statusMessage = "Ready for Tap to Pay"
        isReaderReady = true
    }

    func beginWaitingForAppleTermsAcceptance(timeoutSeconds: Double = 120) {
        cancelWaitingForAppleTermsAcceptance(resumeValue: false)
        termsAcceptanceTimeoutTask = Task { @MainActor in
            let nanos = UInt64(max(1, timeoutSeconds) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            finishWaitingForAppleTermsAcceptance(accepted: termsAcceptedOnDevice)
        }
    }

    func waitForAppleTermsAcceptance() async -> Bool {
        if termsAcceptedOnDevice { return true }
        return await withCheckedContinuation { continuation in
            termsAcceptanceContinuation = continuation
        }
    }

    func markTermsAcceptedFromApple() {
        termsAcceptedOnDevice = true
        UserDefaults.standard.set(true, forKey: Self.termsConfirmedKey)
        finishWaitingForAppleTermsAcceptance(accepted: true)
    }

    /// After a successful reader connect with no T&C error, Stripe has satisfied Apple's requirement.
    func markTermsConfirmedAfterSuccessfulConnect() {
        markTermsAcceptedFromApple()
    }

    func cancelWaitingForAppleTermsAcceptance(resumeValue: Bool = false) {
        termsAcceptanceTimeoutTask?.cancel()
        termsAcceptanceTimeoutTask = nil
        if let continuation = termsAcceptanceContinuation {
            termsAcceptanceContinuation = nil
            continuation.resume(returning: resumeValue)
        }
    }

    private func finishWaitingForAppleTermsAcceptance(accepted: Bool) {
        termsAcceptanceTimeoutTask?.cancel()
        termsAcceptanceTimeoutTask = nil
        if let continuation = termsAcceptanceContinuation {
            termsAcceptanceContinuation = nil
            continuation.resume(returning: accepted)
        }
    }

    func markFailed(_ message: String) {
        isReaderReady = false
        preparationProgress = nil
        statusMessage = message
        cancelWaitingForAppleTermsAcceptance(resumeValue: false)
    }

    func markDisconnected() {
        isReaderReady = false
        preparationProgress = nil
        statusMessage = "Reader disconnected"
        cancelWaitingForAppleTermsAcceptance(resumeValue: false)
    }

    private static func humanReadable(displayMessage: ReaderDisplayMessage) -> String {
        switch displayMessage {
        case .retryCard:
            return "Retry card"
        case .insertCard:
            return "Insert card"
        case .insertOrSwipeCard:
            return "Insert or swipe card"
        case .swipeCard:
            return "Swipe card"
        case .removeCard:
            return "Remove card"
        case .multipleContactlessCardsDetected:
            return "Multiple cards detected — use one card only"
        case .tryAnotherReadMethod:
            return "Try another read method"
        case .tryAnotherCard:
            return "Try another card"
        case .cardRemovedTooEarly:
            return "Card removed too early"
        @unknown default:
            return "Follow prompts on screen"
        }
    }
}

#endif
