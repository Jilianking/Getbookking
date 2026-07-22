//
//  AppDesign.swift
//
//  Shared visual language (warm neutrals, card UI) with light/dark adaptive colors.
//

import SwiftUI
import UIKit

enum AppDesign {
    static let drawerWidth: CGFloat = 300

    /// Option B wordmark: Tenor Sans, uppercase, wide tracking (login + brand chrome).
    static let brandWordmarkFontPostScriptName = "TenorSans"
    static let brandWordmarkTrackingEm: CGFloat = 0.22

    static func brandWordmarkFont(size: CGFloat = 26) -> Font {
        .custom(brandWordmarkFontPostScriptName, size: size)
    }

    static func brandWordmarkTracking(forSize size: CGFloat) -> CGFloat {
        size * brandWordmarkTrackingEm
    }

    /// Screen titles (nav large titles, login card headers) — Tenor Sans, lighter tracking than wordmark.
    static func screenHeaderFont(size: CGFloat = 34) -> Font {
        brandWordmarkFont(size: size)
    }

    static func screenHeaderTracking(forSize size: CGFloat) -> CGFloat {
        size * 0.06
    }

    static func brandUIFont(size: CGFloat) -> UIFont {
        UIFont(name: brandWordmarkFontPostScriptName, size: size)
            ?? .systemFont(ofSize: size, weight: .bold)
    }

    // Marketing site tokens (https://marketing — light mode)
    static let brandDark = Color(hex: 0x2C2018)
    static let brandWarm = Color(hex: 0x8B6F47)
    static let brandCream = adaptive(
        light: UIColor(hex: 0xF5EDD8),
        dark: UIColor(red: 0.22, green: 0.20, blue: 0.18, alpha: 1)
    )
    static let brandMuted = adaptive(
        light: UIColor(hex: 0xC9B8A0),
        dark: UIColor(red: 0.45, green: 0.40, blue: 0.36, alpha: 1)
    )

    /// Legacy iOS accents — prefer brandWarm / brandDark in new UI.
    static let calendarAppointmentFill = Color(hex: 0xE8F5F3)
    static let calendarAppointmentAccent = Color(hex: 0x3D9B8F)

    static let accentGreen = Color(red: 0.30, green: 0.69, blue: 0.31)
    static let accentBlue = Color(red: 0.23, green: 0.48, blue: 0.95)
    static let accentRed = Color(red: 0.85, green: 0.22, blue: 0.22)
    static let statusPending = adaptive(
        light: UIColor(red: 0.55, green: 0.38, blue: 0.12, alpha: 1),
        dark: UIColor(red: 0.92, green: 0.78, blue: 0.45, alpha: 1)
    )
    static let pendingBackground = adaptive(
        light: UIColor(red: 0.98, green: 0.94, blue: 0.86, alpha: 1),
        dark: UIColor(red: 0.22, green: 0.18, blue: 0.12, alpha: 1)
    )

    static let statusCancelled = adaptive(
        light: UIColor(hex: 0x8B4A3A),
        dark: UIColor(red: 0.85, green: 0.45, blue: 0.38, alpha: 1)
    )

    static let background = adaptive(
        light: UIColor(hex: 0xFDFAF6),
        dark: UIColor(red: 0.09, green: 0.08, blue: 0.07, alpha: 1)
    )
    static let cardBackground = adaptive(
        light: .white,
        dark: UIColor(red: 0.16, green: 0.14, blue: 0.12, alpha: 1)
    )
    static let textPrimary = adaptive(
        light: UIColor(hex: 0x1A1410),
        dark: UIColor(red: 0.96, green: 0.94, blue: 0.91, alpha: 1)
    )
    static let textSecondary = adaptive(
        light: UIColor(hex: 0x6B5E4A),
        dark: UIColor(red: 0.68, green: 0.62, blue: 0.55, alpha: 1)
    )
    static let declineBackground = adaptive(
        light: UIColor(red: 0.98, green: 0.93, blue: 0.90, alpha: 1),
        dark: UIColor(red: 0.28, green: 0.14, blue: 0.14, alpha: 1)
    )
    static let searchBackground = adaptive(
        light: UIColor(hex: 0xF5EDD8),
        dark: UIColor(red: 0.22, green: 0.20, blue: 0.18, alpha: 1)
    )
    static let chipBorder = adaptive(
        light: UIColor(hex: 0xE8E0D4),
        dark: UIColor(red: 0.32, green: 0.29, blue: 0.26, alpha: 1)
    )
    static let linkAccent = brandWarm
    static let iconTileForeground = brandWarm
    static let iconTileBackground = brandCream
    static let chartBarFill = brandWarm
    static let chipSelectedForeground = Color.white
    static let chipSelectedBackground = brandDark

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }

    static func softStatusColors(for status: String) -> (foreground: Color, background: Color) {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "new":
            return (brandWarm, brandCream)
        case "pending", "pending_deposit", "pending_consultation":
            return (statusPending, pendingBackground)
        case "confirmed":
            return (textPrimary, searchBackground)
        case "declined", "cancelled":
            return (statusCancelled, declineBackground)
        default:
            return (textSecondary, searchBackground)
        }
    }

    static func cardShadowOpacity(for colorScheme: ColorScheme) -> Double {
        colorScheme == .dark ? 0.2 : 0.04
    }
}

struct AppCardModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .background(AppDesign.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(
                color: .black.opacity(AppDesign.cardShadowOpacity(for: colorScheme)),
                radius: 8,
                x: 0,
                y: 2
            )
    }
}

extension View {
    func appCard() -> some View {
        modifier(AppCardModifier())
    }

    func appScreenBackground() -> some View {
        background(AppDesign.background)
    }

    func appListSurface() -> some View {
        scrollContentBackground(.hidden)
            .background(AppDesign.background)
    }
}

private struct AppNavigationChromeModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .toolbarBackground(AppDesign.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(colorScheme == .dark ? .dark : .light, for: .navigationBar)
    }
}

extension View {
    func appNavigationChrome() -> some View {
        modifier(AppNavigationChromeModifier())
    }
}

enum AppNavigationAppearance {
    static func configure() {
        let largeFont = UIFont.systemFont(ofSize: 34, weight: .bold)
        let inlineFont = UIFont.systemFont(ofSize: 17, weight: .semibold)
        let titleColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.96, green: 0.94, blue: 0.91, alpha: 1)
                : UIColor(red: 0.10, green: 0.08, blue: 0.06, alpha: 1)
        }
        let backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.09, green: 0.08, blue: 0.07, alpha: 1)
                : UIColor(red: 0.992, green: 0.980, blue: 0.965, alpha: 1)
        }

        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = backgroundColor
        appearance.shadowColor = .clear
        appearance.largeTitleTextAttributes = [
            .font: largeFont,
            .foregroundColor: titleColor,
        ]
        appearance.titleTextAttributes = [
            .font: inlineFont,
            .foregroundColor: titleColor,
        ]

        let navBar = UINavigationBar.appearance()
        navBar.standardAppearance = appearance
        navBar.scrollEdgeAppearance = appearance
        navBar.compactAppearance = appearance
        navBar.compactScrollEdgeAppearance = appearance
    }
}

/// In-content screen title (system bold) for Settings, Insights, etc.
struct AppScreenTitle: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.largeTitle.bold())
            .foregroundStyle(AppDesign.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 2)
    }
}

/// Brand screen title (Tenor Sans) — Dashboard only.
struct AppBrandScreenTitle: View {
    let title: String

    var body: some View {
        Text(title)
            .font(AppDesign.screenHeaderFont(size: 34))
            .tracking(AppDesign.screenHeaderTracking(forSize: 34))
            .foregroundStyle(AppDesign.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 2)
    }
}

struct AppSectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(AppDesign.textSecondary.opacity(0.85))
            .tracking(0.6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.top, 4)
            .padding(.bottom, 6)
    }
}

struct AppSettingsRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    var value: String?
    var status: String?
    var statusColor: Color = AppDesign.accentGreen

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(iconColor.opacity(0.14))
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(iconColor)
                )
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.textPrimary)
            Spacer(minLength: 8)
            if let status {
                Text(status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            } else if let value {
                Text(value)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .lineLimit(1)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary.opacity(0.55))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

struct InsightMetricTile: View {
    let icon: String
    let iconColor: Color
    let iconBackground: Color
    let value: String
    let label: String
    let trend: String
    var trendPositive: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(iconBackground)
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(iconColor)
                )
            Text(value)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(AppDesign.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            Text(trend)
                .font(.caption2.weight(.medium))
                .foregroundStyle(trendPositive ? AppDesign.brandWarm : AppDesign.textSecondary)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .appCard()
    }
}

struct AppStatCard: View {
    let title: String
    let value: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            Text(value)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(AppDesign.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(AppDesign.textSecondary.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }
}

struct AppQuickActionCard: View {
    let icon: String
    let title: String
    let subtitle: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(AppDesign.textPrimary)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .appCard()
        }
        .buttonStyle(.plain)
    }
}

struct DashboardQuickTile: View {
    let icon: String
    let title: String
    var value: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(AppDesign.textPrimary)
                if let value {
                    Text(value)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AppDesign.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, 8)
            .appCard()
        }
        .buttonStyle(.plain)
    }
}

struct AppStatusPill: View {
    let text: String
    var color: Color = AppDesign.accentBlue
    var soft: Bool = false

    var body: some View {
        let colors = soft
            ? AppDesign.softStatusColors(for: text)
            : (foreground: .white, background: color)
        Text(displayText)
            .font(.caption.weight(.semibold))
            .foregroundStyle(colors.foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(colors.background)
            .clipShape(Capsule())
    }

    private var displayText: String {
        BookingRequestStatus.displayLabel(text)
    }
}

/// Multiline bio editor with reliable copy/paste (prefer over `TextField(axis: .vertical)` in Forms).
struct TeamMemberBioTextEditor: View {
    let placeholder: String
    @Binding var text: String
    var minHeight: CGFloat = 88

    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .frame(minHeight: minHeight)
                .scrollContentBackground(.hidden)
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(placeholder)
                    .font(.body)
                    .foregroundStyle(Color(.placeholderText))
                    .padding(.top, 8)
                    .padding(.horizontal, 4)
                    .allowsHitTesting(false)
            }
        }
    }
}

struct AppSearchField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(AppDesign.textSecondary.opacity(0.7))
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(AppDesign.textPrimary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct AppFilterChipBar<Filter: Hashable>: View {
    let filters: [(filter: Filter, title: String)]
    @Binding var selection: Filter

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(filters.indices, id: \.self) { index in
                    let item = filters[index]
                    let selected = selection == item.filter
                    Button {
                        selection = item.filter
                    } label: {
                        Text(item.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(selected ? AppDesign.chipSelectedForeground : AppDesign.textPrimary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 9)
                            .background(selected ? AppDesign.chipSelectedBackground : AppDesign.cardBackground)
                            .clipShape(Capsule())
                            .overlay(
                                Capsule()
                                    .stroke(selected ? Color.clear : AppDesign.chipBorder, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
        }
    }
}

struct AppMetadataChip: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(1)
        }
        .foregroundStyle(AppDesign.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(AppDesign.chipBorder.opacity(0.6), lineWidth: 1)
        )
    }
}

struct AppPrimaryButtonStyle: ButtonStyle {
    var enabled: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(enabled ? AppDesign.brandDark : AppDesign.brandDark.opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(configuration.isPressed ? 0.88 : 1)
    }
}

struct AppDeclineButtonStyle: ButtonStyle {
    var enabled: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AppDesign.statusCancelled)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(AppDesign.declineBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(configuration.isPressed ? 0.88 : 1)
            .opacity(enabled ? 1 : 0.5)
    }
}

/// Switch with distinct track colors for on/off (Quick edit, feature toggles).
struct AppTwoToneSwitchToggleStyle: ToggleStyle {
    var onColor: Color = AppDesign.brandWarm
    var offColor: Color = AppDesign.chipBorder

    private let trackWidth: CGFloat = 51
    private let trackHeight: CGFloat = 31
    private let thumbPadding: CGFloat = 2

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                Capsule()
                    .fill(configuration.isOn ? onColor : offColor)
                    .frame(width: trackWidth, height: trackHeight)
                Circle()
                    .fill(Color.white)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
                    .padding(thumbPadding)
            }
            .frame(width: trackWidth, height: trackHeight)
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.2), value: configuration.isOn)
    }
}

struct AppDrawerBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.red)
                .clipShape(Capsule())
        }
    }
}

struct AppAvatarView: View {
    let tenantLogoURL: String?
    let accountPhotoURL: String?
    let displayNameFallback: String?
    var size: CGFloat = 44

    @State private var imageOpaque = false
    @State private var imageRetryCount = 0

    private var resolvedImageURL: URL? {
        let a = accountPhotoURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !a.isEmpty, let u = URL(string: a) { return u }
        let t = tenantLogoURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !t.isEmpty, let u = URL(string: t) { return u }
        return nil
    }

    private var initials: String {
        let name = displayNameFallback ?? "A"
        let parts = name.split(separator: " ")
        if parts.count >= 2 {
            return "\(parts[0].prefix(1))\(parts[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(AppDesign.brandDark.opacity(0.92))
                .frame(width: size, height: size)
                .overlay(
                    Text(initials)
                        .font(.system(size: size * 0.34, weight: .semibold))
                        .foregroundStyle(.white)
                )
            if let url = resolvedImageURL {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                            .onAppear {
                                withAnimation(.easeIn(duration: 0.2)) { imageOpaque = true }
                            }
                    } else {
                        Color.clear
                    }
                }
                .id("\(url.absoluteString)-\(imageRetryCount)")
                .frame(width: size, height: size)
                .clipShape(Circle())
                .opacity(imageOpaque ? 1 : 0)
            }
        }
        .frame(width: size, height: size)
    }
}

private extension UIColor {
    convenience init(hex: Int, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

private extension Color {
    init(hex: Int) {
        self.init(uiColor: UIColor(hex: hex))
    }
}
