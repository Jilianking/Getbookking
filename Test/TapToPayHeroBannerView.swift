//
//  TapToPayHeroBannerView.swift
//  Full-screen splash shown once to eligible users (Apple req 3.2 / 6.2).
//  Uses official Tap to Pay on iPhone badge when available; otherwise compliant fallback mark.
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

struct TapToPayHeroBannerView: View {
    var onGetStarted: () -> Void
    var onDismiss: () -> Void

    var body: some View {
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

                VStack(spacing: 12) {
                    featureRow(
                        icon: "creditcard.fill",
                        text: "Accept contactless cards — no card reader needed."
                    )
                    featureRow(
                        icon: "wave.3.right.circle.fill",
                        text: "Customers can pay with digital wallets on their device."
                    )
                    featureRow(
                        icon: "iphone",
                        text: "Hold the customer's card or device near the top of your iPhone."
                    )
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 40)

                Spacer(minLength: 0)

                VStack(spacing: 12) {
                    Button(action: onGetStarted) {
                        Text("Get started")
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

    private func featureRow(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
                .frame(width: 24)
                .padding(.top, 2)
            Text(text)
                .font(.body)
                .foregroundStyle(AppDesign.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

#endif
