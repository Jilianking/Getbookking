//
//  TapToPayMerchantEducation.swift
//  Apple merchant education after Tap to Pay T&C (req 4.1–4.6).
//  Prefers Apple’s How to Tap overlay (iOS 18+); fallback uses US-EN toolkit education videos + approved copy.
//

#if TAP_TO_PAY_ENABLED

import AVKit
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

// MARK: - Toolkit education assets + approved copy

private enum TapToPayEducationPage: Int, CaseIterable, Identifiable {
    case contactlessCard
    case iphoneWallet
    case watchWallet
    case acceptedPayments

    var id: Int { rawValue }

    /// Bundle resource name (no extension) for US-EN 9x16 toolkit animations.
    var videoResourceName: String? {
        switch self {
        case .contactlessCard: return "TTPoiP_CardToiPhone_9x16_en-US"
        case .iphoneWallet: return "TTPoiP_iPhoneToiPhone_9x16_en-US"
        case .watchWallet: return "TTPoiP_WatchToiPhone_9x16_en-US"
        case .acceptedPayments: return nil
        }
    }

    var title: String {
        switch self {
        case .contactlessCard: return "Contactless cards"
        case .iphoneWallet: return "Apple Pay & digital wallets"
        case .watchWallet: return "Apple Watch & wallets"
        case .acceptedPayments: return "Accepted payments"
        }
    }

    /// Approved how-to subheads / body from Tap to Pay Marketing Copy Blocks (US).
    var body: String {
        switch self {
        case .contactlessCard:
            return TapToPayBranding.educationCardBody
        case .iphoneWallet, .watchWallet:
            return TapToPayBranding.educationWalletBody
        case .acceptedPayments:
            return TapToPayBranding.educationAcceptedPaymentsBody
        }
    }
}

// MARK: - Fallback education (iOS 17 / when Apple overlay unavailable)

struct TapToPayMerchantEducationView: View {
    var onContinue: () -> Void

    @State private var page = 0
    private let pages = TapToPayEducationPage.allCases

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TabView(selection: $page) {
                    ForEach(pages) { educationPage in
                        educationPageView(educationPage)
                            .tag(educationPage.rawValue)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .always))

                Button(action: advance) {
                    Text(page < pages.count - 1 ? "Next" : "Continue")
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

    @ViewBuilder
    private func educationPageView(_ page: TapToPayEducationPage) -> some View {
        ScrollView {
            VStack(spacing: 16) {
                if let resource = page.videoResourceName {
                    TapToPayLoopingEducationVideo(resourceName: resource)
                        .frame(maxWidth: 320)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                } else {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 52))
                        .foregroundStyle(AppDesign.brandDark)
                        .padding(.top, 28)
                }

                Text(page.title)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppDesign.textPrimary)
                    .padding(.horizontal, 24)

                Text(page.body)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 16)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func advance() {
        if page < pages.count - 1 {
            withAnimation { page += 1 }
        } else {
            onContinue()
        }
    }
}

/// Muted looping playback of an Apple toolkit education MP4 from the app bundle.
private struct TapToPayLoopingEducationVideo: View {
    let resourceName: String

    @State private var player: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .disabled(true)
                    .aspectRatio(9 / 16, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityLabel("Tap to Pay on iPhone demonstration")
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.black.opacity(0.06))
                    .aspectRatio(9 / 16, contentMode: .fit)
                    .overlay {
                        ProgressView()
                    }
            }
        }
        .onAppear(perform: prepareAndPlay)
        .onDisappear {
            player?.pause()
        }
    }

    private func prepareAndPlay() {
        guard player == nil else {
            player?.play()
            return
        }
        guard let url = Bundle.main.url(forResource: resourceName, withExtension: "mp4") else {
            return
        }
        let template = AVPlayerItem(url: url)
        let queue = AVQueuePlayer()
        queue.isMuted = true
        looper = AVPlayerLooper(player: queue, templateItem: template)
        player = queue
        queue.play()
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
