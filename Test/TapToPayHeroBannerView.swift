//
//  TapToPayHeroBannerView.swift
//  Full-screen splash shown once to eligible users (Apple req 3.2 / 6.2).
//  Uses Apple’s official US-EN In-App Hero tile from the Tap to Pay Marketing Toolkit.
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

struct TapToPayHeroBannerView: View {
    var onGetStarted: () -> Void
    var onDismiss: () -> Void

    private var hasOfficialHero: Bool {
        TapToPayBranding.hasOfficialHeroBanner
    }

    var body: some View {
        Group {
            if hasOfficialHero {
                officialHero
            } else {
                fallbackHero
            }
        }
    }

    // MARK: - Official Apple In-App Hero tile

    private var officialHero: some View {
        ZStack {
            Color.white.ignoresSafeArea()

            GeometryReader { geo in
                let maxWidth = min(geo.size.width, 520)
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        Image(TapToPayBranding.heroBannerAssetName)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: maxWidth)
                            .accessibilityHidden(true)
                            // Cover the template’s “[Partner Button]” + replace with real CTAs.
                            .overlay {
                                GeometryReader { imageGeo in
                                    VStack(spacing: 0) {
                                        Spacer(minLength: 0)
                                        partnerCTAOverlay
                                            .frame(height: max(160, imageGeo.size.height * 0.30))
                                    }
                                }
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Tap to Pay on iPhone")
                            .accessibilityHint(TapToPayBranding.featureSubtitle)

                        // Extra bottom padding so Later isn’t flush to the home indicator.
                        Color.clear.frame(height: 8)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 12)
                }
            }
        }
    }

    /// White veil over the placeholder partner button + real CTAs (Apple template partner slot).
    private var partnerCTAOverlay: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)

            Button(action: onGetStarted) {
                Text(TapToPayBranding.primaryCTA)
                    .font(.headline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(.black)
                    .background(
                        Capsule(style: .continuous)
                            .fill(Color.white)
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(Color.black, lineWidth: 1.5)
                    )
            }
            .buttonStyle(.plain)

            Button(action: onDismiss) {
                Text("Later")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(white: 0.4))
            }
            .buttonStyle(.plain)

            Text(TapToPayBranding.heroTileLegal)
                .font(.system(size: 9))
                .foregroundStyle(Color(white: 0.45))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
                .padding(.top, 2)
                .padding(.bottom, 4)
        }
        .padding(.horizontal, 36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(
                colors: [
                    Color.white.opacity(0),
                    Color.white.opacity(0.85),
                    Color.white,
                    Color.white
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    // MARK: - Fallback (asset missing)

    private var fallbackHero: some View {
        ZStack {
            AppDesign.background.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 32)

                TapToPayOniPhoneMark(minHeight: 56)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 24)

                Text(TapToPayBranding.featureSubtitle)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppDesign.textPrimary)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 28)

                Text(TapToPayBranding.shortDisclaimer)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding(.horizontal, 28)

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    Button(action: onGetStarted) {
                        Text(TapToPayBranding.primaryCTA)
                            .font(.headline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .foregroundStyle(.white)
                            .background(Color.black)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)

                    Button(action: onDismiss) {
                        Text("Later")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 40)
            }
        }
    }
}

#endif
