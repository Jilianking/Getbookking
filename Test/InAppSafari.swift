//
//  InAppSafari.swift
//
//  Presents marketing / Stripe / billing URLs in SFSafariViewController (in-app sheet).
//

import Combine
import SafariServices
import SwiftUI
import UIKit

enum InAppSafariContext: Equatable {
    case general
    case billing
    case stripeConnect
}

extension Notification.Name {
    /// Posted when an in-app Safari sheet closes after a billing-related URL.
    static let inAppSafariBillingDismissed = Notification.Name("inAppSafariBillingDismissed")
}

@MainActor
final class InAppSafariCoordinator: ObservableObject {
    static let shared = InAppSafariCoordinator()

    struct Session: Identifiable {
        let id = UUID()
        let url: URL
        let context: InAppSafariContext
    }

    @Published var session: Session?
    private var pendingDismissContext: InAppSafariContext?

    private init() {}

    @discardableResult
    func present(url: URL, context: InAppSafariContext = .general) -> Bool {
        guard InAppSafari.shouldPresentInApp(url) else {
            Task { @MainActor in
                _ = await UIApplication.shared.open(url)
            }
            return true
        }
        pendingDismissContext = context
        session = Session(url: url, context: context)
        return true
    }

    func clearSession() {
        session = nil
    }

    func handleDismiss() {
        let context = pendingDismissContext ?? session?.context ?? .general
        pendingDismissContext = nil
        switch context {
        case .stripeConnect:
            StripeConnectRefresh.request()
        case .billing:
            NotificationCenter.default.post(name: .inAppSafariBillingDismissed, object: nil)
        case .general:
            break
        }
    }
}

enum InAppSafari {
    /// http(s) URLs use the in-app Safari sheet; other schemes open externally.
    static func shouldPresentInApp(_ url: URL) -> Bool {
        let scheme = (url.scheme ?? "").lowercased()
        return scheme == "http" || scheme == "https"
    }

    @MainActor
    @discardableResult
    static func openSync(_ url: URL, context: InAppSafariContext = .general) -> Bool {
        InAppSafariCoordinator.shared.present(url: url, context: context)
    }

    @MainActor
    @discardableResult
    static func open(_ url: URL, context: InAppSafariContext = .general) async -> Bool {
        openSync(url, context: context)
    }

    /// Subscription / portal checkout (Guideline 3.1.1 US): Safari.app, not the in-app sheet.
    @MainActor
    @discardableResult
    static func openInSystemBrowser(_ url: URL) async -> Bool {
        await UIApplication.shared.open(url)
    }
}

struct InAppSafariSheetModifier: ViewModifier {
    @ObservedObject private var coordinator = InAppSafariCoordinator.shared

    func body(content: Content) -> some View {
        content
            .sheet(item: $coordinator.session, onDismiss: {
                coordinator.handleDismiss()
            }) { session in
                SafariView(url: session.url)
                    .ignoresSafeArea()
            }
    }
}

extension View {
    func inAppSafariSheet() -> some View {
        modifier(InAppSafariSheetModifier())
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
            Task { @MainActor in
                InAppSafariCoordinator.shared.clearSession()
            }
        }
    }
}
