//
//  StripeConnectLaunchCoordinator.swift
//
//  Full-screen "Opening Stripe…" overlay + fast Connect launch from any screen.
//

import SwiftUI
import Combine

@MainActor
final class StripeConnectLaunchCoordinator: ObservableObject {
    @Published private(set) var isOpening = false

    func prepareOpening() {
        isOpening = true
    }

    func finishOpening() {
        isOpening = false
    }

    @discardableResult
    func openConnect(
        from viewModel: PaymentsViewModel,
        isDemoMode: Bool
    ) async -> PaymentsViewModel.ConnectAccountLinkOutcome {
        if !isOpening {
            isOpening = true
        }
        defer { isOpening = false }
        return await viewModel.createConnectAccountLink(isDemoMode: isDemoMode)
    }
}

struct StripeConnectLaunchOverlay: View {
    let message: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.32)
                .ignoresSafeArea()
            VStack(spacing: 14) {
                ProgressView()
                    .tint(.white)
                    .scaleEffect(1.05)
                Text(message)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 22)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .transition(.opacity)
    }
}
