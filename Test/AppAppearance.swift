//
//  AppAppearance.swift
//
//  User preference: light or dark admin UI.
//

import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
    case light
    case dark

    var id: String { rawValue }

    var isDark: Bool { self == .dark }

    var preferredColorScheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// Maps stored preference; legacy `system` values become light.
    static func resolved(from raw: String) -> AppAppearance {
        AppAppearance(rawValue: raw) ?? .light
    }
}

enum AppAppearanceStorage {
    static let key = "appAppearance"
}

/// Sun (light) / moon (dark) appearance switch for Settings.
struct AppSunMoonAppearanceToggle: View {
    @Binding var isDark: Bool

    private let trackWidth: CGFloat = 72
    private let trackHeight: CGFloat = 34
    private let thumbSize: CGFloat = 26

    var body: some View {
        Button {
            isDark.toggle()
        } label: {
            ZStack {
                Capsule()
                    .fill(isDark ? AppDesign.brandDark : AppDesign.chipBorder)
                    .frame(width: trackWidth, height: trackHeight)

                HStack(spacing: 0) {
                    Image(systemName: "sun.max.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(
                            isDark ? Color.white.opacity(0.35) : AppDesign.brandWarm
                        )
                        .frame(maxWidth: .infinity)

                    Image(systemName: "moon.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(
                            isDark ? Color.white.opacity(0.92) : AppDesign.textSecondary.opacity(0.45)
                        )
                        .frame(maxWidth: .infinity)
                }
                .frame(width: trackWidth, height: trackHeight)

                HStack {
                    if isDark { Spacer(minLength: 0) }
                    Circle()
                        .fill(Color.white)
                        .shadow(color: Color.black.opacity(0.16), radius: 1.5, x: 0, y: 1)
                        .frame(width: thumbSize, height: thumbSize)
                        .padding(4)
                    if !isDark { Spacer(minLength: 0) }
                }
                .frame(width: trackWidth, height: trackHeight)
            }
            .frame(width: trackWidth, height: trackHeight)
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.2), value: isDark)
        .accessibilityLabel("Appearance")
        .accessibilityValue(isDark ? "Dark" : "Light")
    }
}
