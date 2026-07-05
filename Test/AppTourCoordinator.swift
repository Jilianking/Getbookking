//
//  AppTourCoordinator.swift
//  Multi-step onboarding: Dashboard → Requests → Messages → Design → Payments.
//

import Combine
import SwiftUI

enum AppTourStep: Int, CaseIterable, Identifiable {
    case dashboardTakePayment = 1
    case requestsApprove = 2
    case messagesReply = 3
    case designWebsite = 4
    case paymentsHistory = 5

    var id: Int { rawValue }

    var adminSection: AdminSection {
        switch self {
        case .dashboardTakePayment: return .dashboard
        case .requestsApprove: return .requests
        case .messagesReply: return .messages
        case .designWebsite: return .design
        case .paymentsHistory: return .payments
        }
    }

    var message: String {
        switch self {
        case .dashboardTakePayment:
            return "When it's time to get paid, tap here and hold their card to your phone."
        case .requestsApprove:
            return "Review new booking requests — tap Accept to confirm or Decline to pass."
        case .messagesReply:
            return "Reply to clients by text — keep the conversation in one place."
        case .designWebsite:
            return "This is your live booking site. Tap Manage to edit your look and services."
        case .paymentsHistory:
            return "Track payments and payouts here as you get booked."
        }
    }

    var stepLabel: String {
        "Step \(rawValue) of \(AppTourStep.allCases.count)"
    }

    var isLast: Bool { self == .paymentsHistory }

    var nextButtonTitle: String { isLast ? "Done" : "Next" }
}

enum AppTourStore {
    private static let demoCompletedKey = "appTourCompletedInDemo"

    /// While tuning the tour, keep `false` so Skip/Done does not stick in demo (no reinstall).
    static let persistDemoDismissal = false

    static var hasCompletedDemoTour: Bool {
        UserDefaults.standard.bool(forKey: demoCompletedKey)
    }

    static var shouldShowDemoTour: Bool {
        if !persistDemoDismissal { return true }
        return !hasCompletedDemoTour
    }

    static func markDemoTourCompletedIfNeeded() {
        guard persistDemoDismissal else { return }
        UserDefaults.standard.set(true, forKey: demoCompletedKey)
    }

    static func isAppTourPending(from data: [String: Any]) -> Bool {
        guard let onboarding = data["onboarding"] as? [String: Any] else { return false }
        if onboarding["appTourCompleted"] as? Bool == true { return false }
        if onboarding["appTourPending"] as? Bool == true { return true }
        return onboarding["tapToPayDashboardTipPending"] as? Bool ?? false
    }
}

struct AppTourFramePreferenceKey: PreferenceKey {
    static var defaultValue: [AppTourStep: CGRect] = [:]

    static func reduce(value: inout [AppTourStep: CGRect], nextValue: () -> [AppTourStep: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

extension View {
    func appTourAnchor(_ step: AppTourStep, isActive: Bool) -> some View {
        background {
            if isActive {
                GeometryReader { geo in
                    Color.clear.preference(
                        key: AppTourFramePreferenceKey.self,
                        value: [step: geo.frame(in: .global)]
                    )
                }
            }
        }
    }
}

@MainActor
final class AppTourCoordinator: ObservableObject {
    @Published private(set) var activeStep: AppTourStep?
    @Published private(set) var anchorFrames: [AppTourStep: CGRect] = [:]

    var isActive: Bool { activeStep != nil }

    var currentHoleGlobal: CGRect {
        guard let step = activeStep else { return .zero }
        return anchorFrames[step] ?? .zero
    }

    func shouldStart(
        isDemoMode: Bool,
        appTourPending: Bool,
        isOwner: Bool,
        demoSessionReady: Bool
    ) -> Bool {
        guard isOwner || isDemoMode else { return false }
        if isDemoMode {
            guard demoSessionReady else { return false }
            return AppTourStore.shouldShowDemoTour
        }
        return appTourPending
    }

    func start(from step: AppTourStep = .dashboardTakePayment) {
        anchorFrames = [:]
        activeStep = step
    }

    func updateFrames(_ frames: [AppTourStep: CGRect]) {
        anchorFrames.merge(frames, uniquingKeysWith: { _, new in new })
    }

    func isStepActive(_ step: AppTourStep) -> Bool {
        activeStep == step
    }

    func advance(
        drawerState: DrawerState,
        visitedSections: inout Set<AdminSection>,
        onComplete: () -> Void
    ) {
        guard let current = activeStep else { return }
        if let next = AppTourStep(rawValue: current.rawValue + 1) {
            anchorFrames = [:]
            activeStep = next
            visitedSections.insert(next.adminSection)
            drawerState.selectedSection = next.adminSection
            drawerState.isOpen = false
        } else {
            finish(onComplete: onComplete)
        }
    }

    func skipTour(onComplete: () -> Void) {
        finish(onComplete: onComplete)
    }

    private func finish(onComplete: () -> Void) {
        activeStep = nil
        anchorFrames = [:]
        onComplete()
    }
}
