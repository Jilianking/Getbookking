//
//  TapToPayDashboardSpotlightOverlay.swift
//  Full-screen coach mark with cutout (used by AppTourCoordinator).
//

import SwiftUI

extension View {
    func appTourSpotlightOverlay(
        isPresented: Bool,
        holeGlobal: CGRect,
        message: String,
        stepLabel: String,
        primaryButtonTitle: String,
        onPrimary: @escaping () -> Void,
        onSkipTour: @escaping () -> Void
    ) -> some View {
        overlay {
            if isPresented {
                AppTourSpotlightOverlayContainer(
                    holeGlobal: holeGlobal,
                    message: message,
                    stepLabel: stepLabel,
                    primaryButtonTitle: primaryButtonTitle,
                    onPrimary: onPrimary,
                    onSkipTour: onSkipTour
                )
            }
        }
    }
}

private struct AppTourSpotlightOverlayContainer: View {
    let holeGlobal: CGRect
    let message: String
    let stepLabel: String
    let primaryButtonTitle: String
    let onPrimary: () -> Void
    let onSkipTour: () -> Void

    var body: some View {
        GeometryReader { geo in
            let overlayOrigin = geo.frame(in: .global).origin
            let hole = CGRect(
                x: holeGlobal.minX - overlayOrigin.x,
                y: holeGlobal.minY - overlayOrigin.y,
                width: holeGlobal.width,
                height: holeGlobal.height
            )
            AppTourSpotlightOverlay(
                hole: hole,
                containerSize: geo.size,
                message: message,
                stepLabel: stepLabel,
                primaryButtonTitle: primaryButtonTitle,
                onPrimary: onPrimary,
                onSkipTour: onSkipTour
            )
        }
        .ignoresSafeArea()
    }
}

struct AppTourSpotlightOverlay: View {
    let hole: CGRect
    let containerSize: CGSize
    let message: String
    let stepLabel: String
    let primaryButtonTitle: String
    let onPrimary: () -> Void
    let onSkipTour: () -> Void

    private let dimOpacity: Double = 0.58
    private let holePadding: CGFloat = 4
    private let bottomPanelHeight: CGFloat = 168

    private var hasHole: Bool {
        hole.width > 1 && hole.height > 1
    }

    private var expandedHole: CGRect {
        hole.insetBy(dx: -holePadding, dy: -holePadding)
    }

    /// Arrow fits between the cutout and the bottom message panel.
    private var showsArrow: Bool {
        guard hasHole else { return false }
        let arrowBottom = expandedHole.maxY + 56
        return arrowBottom < containerSize.height - bottomPanelHeight
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if hasHole {
                SpotlightDimCutout(hole: expandedHole, containerSize: containerSize, opacity: dimOpacity)
                    .allowsHitTesting(false)
            } else {
                Color.black.opacity(dimOpacity)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }

            VStack(alignment: .trailing, spacing: 4) {
                Button("Skip tour", action: onSkipTour)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Text(stepLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.85))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .padding(.top, 8)
            .padding(.trailing, 12)

            if showsArrow {
                VStack(spacing: 0) {
                    Spacer()
                        .frame(height: max(expandedHole.maxY + 12, 0))

                    SpotlightCurvedArrow()
                        .stroke(Color.white, lineWidth: 2)
                        .frame(width: 56, height: 44)
                        .frame(maxWidth: .infinity)
                        .offset(x: expandedHole.midX - containerSize.width / 2)

                    Spacer()
                        .frame(minHeight: bottomPanelHeight + 24)
                }
            }

            VStack(spacing: 0) {
                Spacer()

                VStack(spacing: 12) {
                    Text(message)
                        .font(.body)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 12)

                    Button(action: onPrimary) {
                        Text(primaryButtonTitle)
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(AppDesign.brandDark)
                }
                .padding(.horizontal, 28)
                .padding(.top, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
                .background(
                    LinearGradient(
                        colors: [
                            Color.black.opacity(0),
                            Color.black.opacity(0.72),
                            Color.black.opacity(0.88),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }
}

private struct SpotlightDimCutout: View {
    let hole: CGRect
    let containerSize: CGSize
    let opacity: Double

    var body: some View {
        Canvas { context, size in
            var path = Path(CGRect(origin: .zero, size: size))
            path.addRoundedRect(
                in: hole,
                cornerSize: CGSize(width: 14, height: 14),
                style: .continuous
            )
            context.fill(
                path,
                with: .color(.black.opacity(opacity)),
                style: FillStyle(eoFill: true)
            )
        }
        .frame(width: containerSize.width, height: containerSize.height)
    }
}

private struct SpotlightCurvedArrow: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - 4, y: rect.minY + 6),
            control: CGPoint(x: rect.midX + 18, y: rect.midY)
        )
        path.move(to: CGPoint(x: rect.maxX - 4, y: rect.minY + 6))
        path.addLine(to: CGPoint(x: rect.maxX - 14, y: rect.minY + 4))
        path.move(to: CGPoint(x: rect.maxX - 4, y: rect.minY + 6))
        path.addLine(to: CGPoint(x: rect.maxX - 2, y: rect.minY + 16))
        return path
    }
}
