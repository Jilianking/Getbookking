//
//  InAppSafari.swift
//
//  Presents marketing / Stripe HTTPS URLs in SFSafariViewController (App Review Guideline 4).
//

import SwiftUI
import SafariServices

extension Notification.Name {
    static let openMarketingInAppSafari = Notification.Name("openMarketingInAppSafari")
    static let marketingInAppSafariDidDismiss = Notification.Name("marketingInAppSafariDidDismiss")
}

enum MarketingInAppSafari {
    @MainActor
    static func present(_ url: URL) {
        NotificationCenter.default.post(
            name: .openMarketingInAppSafari,
            object: nil,
            userInfo: ["url": url]
        )
    }

    @MainActor
    static func present(urlString: String) {
        guard let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        present(url)
    }
}

/// Wraps SFSafariViewController for use in a SwiftUI sheet.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let vc = SFSafariViewController(url: url)
        vc.preferredControlTintColor = UIColor(AppDesign.textPrimary)
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            NotificationCenter.default.post(name: .marketingInAppSafariDidDismiss, object: nil)
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
