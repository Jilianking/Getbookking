//
//  TapToPayOniPhoneButton.swift
//  Apple HIG–compliant entry point for Tap to Pay on iPhone (req 5.1–5.5).
//

#if TAP_TO_PAY_ENABLED

import SwiftUI
import UIKit

/// Shared Tap to Pay on iPhone marketing assets + approved copy (Apple TTPOI Marketing Guide, US).
enum TapToPayBranding {
    static let officialBadgeAssetName = "TapToPayOniPhoneBadge"
    /// Official US-EN In-App Hero tile from Marketing Templates (APR / toolkit April 2026).
    static let heroBannerAssetName = "TapToPayHeroBanner"

    /// Approved value-prop subheadline (Marketing Copy Blocks).
    static let featureSubtitle = "Accept contactless payments right on your iPhone."
    static let primaryCTA = "Get started"
    static let shortDisclaimer = "Terms apply."
    /// Legal line shown on Apple’s US-EN In-App Hero tile (matches toolkit export).
    static let heroTileLegal =
        "Some contactless cards may not be accepted. Transaction limits may apply. The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC."

    /// Approved push notification (Marketing Copy Blocks — value proposition).
    static let pushTitle = "Accept in-person payments with Tap to Pay on iPhone."
    static let pushBody =
        "You can accept all types of contactless payments right on your iPhone—from physical debit and credit cards to Apple Pay and other digital wallets. Terms apply."

    /// Approved how-to copy (Marketing Copy Blocks — How to use).
    static let educationCardBody =
        "Your customer simply holds their card horizontally over the contactless symbol on your iPhone for a few seconds, until the Done checkmark appears."
    static let educationWalletBody =
        "Your customer simply holds their device over the contactless symbol on your iPhone for a few seconds, until the Done checkmark appears."
    static let educationAcceptedPaymentsBody =
        "Visa, Mastercard, American Express, and Discover contactless cards and wallets are supported in the United States."

    static var hasOfficialBadge: Bool {
        UIImage(named: officialBadgeAssetName) != nil
    }

    static var hasOfficialHeroBanner: Bool {
        UIImage(named: heroBannerAssetName) != nil
    }
}

/// Official badge when present; otherwise Apple-compliant black fallback with `wave.3.right.circle.fill`.
struct TapToPayOniPhoneMark: View {
    var maxWidth: CGFloat = .infinity
    var minHeight: CGFloat = 52

    var body: some View {
        Group {
            if TapToPayBranding.hasOfficialBadge {
                Image(TapToPayBranding.officialBadgeAssetName)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxWidth)
                    .frame(minHeight: minHeight)
                    .accessibilityLabel("Tap to Pay on iPhone")
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "wave.3.right.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                    Text("Tap to Pay on iPhone")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: maxWidth, minHeight: minHeight, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.black)
                )
                .accessibilityLabel("Tap to Pay on iPhone")
            }
        }
    }
}

/// Prominent, always-enabled control to start Tap to Pay (terms, enablement, or checkout).
struct TapToPayOniPhoneButton: View {
    var subtitle: String?
    var showsActivity: Bool = false
    let action: () -> Void

    private var hasOfficialBadge: Bool {
        TapToPayBranding.hasOfficialBadge
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                if hasOfficialBadge {
                    TapToPayOniPhoneMark()
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: "wave.3.right.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Tap to Pay on iPhone")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.leading)
                            if let subtitle, !subtitle.isEmpty {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(Color.white.opacity(0.82))
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 0)
                        if showsActivity {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.white.opacity(0.75))
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.black)
                    )
                }

                if hasOfficialBadge, showsActivity {
                    ProgressView()
                        .tint(.primary)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Starts Tap to Pay on iPhone")
    }
}

#endif
