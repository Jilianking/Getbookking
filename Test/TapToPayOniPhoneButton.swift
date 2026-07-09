//
//  TapToPayOniPhoneButton.swift
//  Apple HIG–compliant entry point for Tap to Pay on iPhone (req 5.1–5.5).
//

#if TAP_TO_PAY_ENABLED

import SwiftUI
import UIKit

/// Shared Tap to Pay on iPhone marketing asset + fallback styling (Apple Developer Marketing Guidelines).
enum TapToPayBranding {
    static let officialBadgeAssetName = "TapToPayOniPhoneBadge"
    static let featureSubtitle = "Accept contactless cards and digital wallets with your iPhone."

    static var hasOfficialBadge: Bool {
        UIImage(named: officialBadgeAssetName) != nil
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
