//
//  TapToPayMerchantEducation.swift
//  Apple merchant education after Tap to Pay T&C (req 4.1–4.6).
//

#if TAP_TO_PAY_ENABLED

import SwiftUI
import UIKit
#if canImport(ProximityReader)
import ProximityReader
#endif

enum TapToPayMerchantEducationStore {
    private static let seenKey = "tapToPayMerchantEducationSeen"

    static var hasSeenEducation: Bool {
        UserDefaults.standard.bool(forKey: seenKey)
    }

    static func markEducationSeen() {
        UserDefaults.standard.set(true, forKey: seenKey)
    }

    static var shouldShowAfterTermsAcceptance: Bool {
        !hasSeenEducation
    }
}

enum TapToPayMerchantEducationPresenter {
    /// Presents Apple’s “How to Tap” overlay on iOS 18+, otherwise signals fallback UI.
    @MainActor
    static func presentHowToTap() async -> Bool {
        #if canImport(ProximityReader)
        if #available(iOS 18.0, *) {
            return await TapToPayAppleHowToTapOverlay.present()
        }
        #endif
        return false
    }
}

#if canImport(ProximityReader)
@available(iOS 18.0, *)
private enum TapToPayAppleHowToTapOverlay {
    @MainActor
    static func present() async -> Bool {
        guard let topViewController = UIApplication.bookkingTopViewController else {
            return false
        }

        do {
            let discovery = ProximityReaderDiscovery()
            let content = try await discovery.content(for: .payment(.howToTap))
            try await discovery.presentContent(content, from: topViewController)
            return true
        } catch {
            return false
        }
    }
}
#endif

private extension UIApplication {
    @MainActor
    static var bookkingTopViewController: UIViewController? {
        let scenes = shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        guard var top = window?.rootViewController else { return nil }
        while let presented = top.presentedViewController {
            top = presented
        }
        return top
    }
}

// MARK: - Fallback education (iOS 17 / when Apple overlay unavailable)

struct TapToPayMerchantEducationView: View {
    var onContinue: () -> Void

    @State private var page = 0
    private let pageCount = 4

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    educationPage(
                        icon: "checkmark.circle.fill",
                        iconColor: AppDesign.accentGreen,
                        title: "You’re set up for Tap to Pay",
                        body: "Your iPhone can now accept in-person contactless payments from cards and digital wallets."
                    )
                    .tag(0)

                    educationPage(
                        icon: "creditcard.fill",
                        iconColor: AppDesign.accentBlue,
                        title: "Contactless cards",
                        body: "Ask the customer to hold their card flat near the top of your iPhone. Keep steady until you see the checkmark."
                    )
                    .tag(1)

                    educationPage(
                        icon: "wave.3.right.circle.fill",
                        iconColor: AppDesign.brandWarm,
                        title: "Apple Pay & digital wallets",
                        body: "Customers can pay the same way with Apple Pay and other digital wallets — hold their device near the top of your iPhone."
                    )
                    .tag(2)

                    educationPage(
                        icon: "checkmark.seal.fill",
                        iconColor: AppDesign.brandDark,
                        title: "Accepted payments",
                        body: "Visa, Mastercard, American Express, and Discover contactless cards and wallets are supported in the United States."
                    )
                    .tag(3)
                }
                .tabViewStyle(.page(indexDisplayMode: .always))

                Button(action: advance) {
                    Text(page < pageCount - 1 ? "Next" : "Continue")
                        .font(.headline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .foregroundStyle(.white)
                        .background(AppDesign.brandDark)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .appScreenBackground()
            .navigationTitle("How to use Tap to Pay")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func educationPage(
        icon: String,
        iconColor: Color,
        title: String,
        body: String
    ) -> some View {
        VStack(spacing: 20) {
            Spacer(minLength: 12)
            Image(systemName: icon)
                .font(.system(size: 52))
                .foregroundStyle(iconColor)
            Text(title)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
                .foregroundStyle(AppDesign.textPrimary)
                .padding(.horizontal, 24)
            Text(body)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal, 28)
            Spacer(minLength: 12)
        }
    }

    private func advance() {
        if page < pageCount - 1 {
            withAnimation { page += 1 }
        } else {
            onContinue()
        }
    }
}

/// Runs merchant education (Apple overlay and/or fallback sheet), then calls `onFinished`.
@MainActor
enum TapToPayMerchantEducationFlow {
    static func run(
        showFallbackSheet: @escaping () -> Void,
        onFinished: @escaping () -> Void
    ) async {
        let usedAppleOverlay = await TapToPayMerchantEducationPresenter.presentHowToTap()
        if usedAppleOverlay {
            TapToPayMerchantEducationStore.markEducationSeen()
            onFinished()
            return
        }
        showFallbackSheet()
        // `onFinished` runs when the sheet’s Continue is tapped.
    }

    static func runFromSettings(showFallbackSheet: @escaping () -> Void) async {
        let usedAppleOverlay = await TapToPayMerchantEducationPresenter.presentHowToTap()
        if !usedAppleOverlay {
            showFallbackSheet()
        }
    }
}

#endif
