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

    @Published private(set) var preparationProgress: Double?
    @Published private(set) var statusMessage: String?
    @Published private(set) var isReaderReady = false
    @Published private(set) var termsAcceptedOnDevice = false

    private init() {}

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

    func markTermsAccepted() {
        termsAcceptedOnDevice = true
    }

    func markFailed(_ message: String) {
        isReaderReady = false
        preparationProgress = nil
        statusMessage = message
    }

    func markDisconnected() {
        isReaderReady = false
        preparationProgress = nil
        statusMessage = "Reader disconnected"
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
