//
//  PreviewQuickEditChrome.swift
//
//  Touch-friendly color wells + floating control pill while Quick edit is on.
//

import SwiftUI
import UIKit

struct QuickEditInlineFocus: Equatable {
    var key: String
    var fontSize: Int
    var fontAdjustable: Bool
}

enum PreviewQuickEditColorTarget: String, Identifiable {
    case background
    case text
    case button

    var id: String { rawValue }

    var label: String {
        switch self {
        case .background: return "Background"
        case .text: return "Text"
        case .button: return "Button"
        }
    }

    static let quickEditRow: [PreviewQuickEditColorTarget] = [.background, .text, .button]
}

struct PreviewQuickEditChrome: View {
    @ObservedObject var viewModel: DesignViewModel
    var bridge: WebViewQuickEditBridge
    @Binding var inlineFocus: QuickEditInlineFocus?
    @Binding var colorsDirty: Bool
    @Binding var selectedColorSurface: PreviewColorSurface?
    @State private var activeColorTarget: PreviewQuickEditColorTarget?
    @State private var activeColorSurface: PreviewColorSurface?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
                .allowsHitTesting(false)

            VStack(spacing: 14) {
                if selectedColorSurface != nil || supportsTappableColorBands {
                    Text(selectedColorSurface.map { "Editing: \($0.label)" } ?? "Tap a section in the preview to change its color")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                colorRow
                controlPill
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 10)
            .background {
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .allowsHitTesting(true)
        .sheet(item: $activeColorTarget) { target in
            PreviewQuickEditColorSheet(
                title: target.label,
                initialHex: hex(for: target),
                onChange: { applyChromeColor(target: target, hex: $0) },
                onDismiss: { activeColorTarget = nil }
            )
        }
        .sheet(item: $activeColorSurface) { surface in
            PreviewQuickEditColorSheet(
                title: surface.label,
                initialHex: surface.hex(from: viewModel),
                onChange: { applySurfaceColor(surface: surface, hex: $0) },
                onDismiss: { activeColorSurface = nil }
            )
        }
        .onChange(of: selectedColorSurface) { _, surface in
            if let surface {
                activeColorSurface = surface
            }
        }
    }

    private var activeTemplateFamily: TemplateFamily {
        viewModel.activeTemplateFamily
    }

    private var supportsTappableColorBands: Bool {
        switch activeTemplateFamily {
        case .luxe, .blade, .stonecut, .classic:
            return true
        case .studio12:
            return false
        }
    }

    private var colorRow: some View {
        HStack(spacing: 0) {
            PreviewTouchColorWell(
                title: selectedColorSurface?.label ?? "Section",
                hex: selectedColorSurface?.hex(from: viewModel) ?? viewModel.backgroundColorHex
            ) {
                if let selectedColorSurface {
                    activeColorSurface = selectedColorSurface
                } else {
                    activeColorSurface = .page
                }
            }
            .frame(maxWidth: .infinity)

            PreviewTouchColorWell(
                title: PreviewQuickEditColorTarget.text.label,
                hex: viewModel.textColorHex
            ) {
                activeColorTarget = .text
            }
            .frame(maxWidth: .infinity)

            PreviewTouchColorWell(
                title: PreviewQuickEditColorTarget.button.label,
                hex: viewModel.primaryColorHex
            ) {
                activeColorTarget = .button
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var controlPill: some View {
        HStack(spacing: 12) {
            HStack(spacing: 0) {
                Button {
                    bridge.navigateEditable(delta: -1)
                } label: {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)

                Divider()
                    .frame(height: 22)

                Button {
                    bridge.navigateEditable(delta: 1)
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
            }
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Group {
                if let focus = inlineFocus, focus.fontAdjustable {
                    fontSizeStepper(focus: focus)
                } else {
                    Circle()
                        .fill(Color(hex: viewModel.primaryColorHex))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Circle()
                                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1)
                        )
                }
            }
            .frame(maxWidth: .infinity)

            Button {
                bridge.commitDirtyEdits()
                inlineFocus = nil
                if colorsDirty {
                    Task {
                        await viewModel.savePreviewQuickEditColors()
                        await MainActor.run { colorsDirty = false }
                    }
                }
            } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(Color.black))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Done editing")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.systemBackground))
                .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
        )
    }

    private func fontSizeStepper(focus: QuickEditInlineFocus) -> some View {
        HStack(spacing: 10) {
            Button {
                let next = max(10, focus.fontSize - 2)
                bridge.setInlineFontSize(next)
                inlineFocus = QuickEditInlineFocus(key: focus.key, fontSize: next, fontAdjustable: true)
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            Text("\(focus.fontSize)")
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .frame(minWidth: 36)

            Button {
                let next = min(96, focus.fontSize + 2)
                bridge.setInlineFontSize(next)
                inlineFocus = QuickEditInlineFocus(key: focus.key, fontSize: next, fontAdjustable: true)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private func hex(for target: PreviewQuickEditColorTarget) -> String {
        switch target {
        case .background: return viewModel.backgroundColorHex
        case .text: return viewModel.textColorHex
        case .button: return viewModel.primaryColorHex
        }
    }

    private func applyChromeColor(target: PreviewQuickEditColorTarget, hex: String) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        switch target {
        case .background:
            viewModel.backgroundColorHex = normalized
            viewModel.syncPreviewHeroSlotColorFromTokens()
        case .text:
            viewModel.textColorHex = normalized
        case .button:
            viewModel.primaryColorHex = normalized
            viewModel.primaryColorHoverHex = PreviewQuickEditChrome.derivedHoverHex(for: normalized)
            viewModel.syncPreviewHeroSlotColorFromTokens()
        }
        colorsDirty = true
        pushPreviewColors()
    }

    private func applySurfaceColor(surface: PreviewColorSurface, hex: String) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        surface.applyColorHex(normalized, to: viewModel)
        if surface == .page {
            viewModel.syncPreviewHeroSlotColorFromTokens()
        }
        colorsDirty = true
        let heroOverride = surface == .hero ? normalized : nil
        pushPreviewColors(heroSlotOverride: heroOverride)
    }

    private func pushPreviewColors(heroSlotOverride: String? = nil) {
        bridge.applyPreviewColorPatch(viewModel.previewColorPatchPayload(heroSlotOverride: heroSlotOverride))
    }

    func openColorSurface(_ surface: PreviewColorSurface) {
        selectedColorSurface = surface
        activeColorSurface = surface
    }

    /// Simple hover for live button color tweaks (full palette save still uses stored hover on commit).
    static func derivedHoverHex(for primary: String) -> String {
        let base = Color(hex: primary)
        guard let comps = UIColor(base).cgColor.components else { return primary }
        let r = comps.count >= 3 ? comps[0] : 0
        let g = comps.count >= 3 ? comps[1] : 0
        let b = comps.count >= 3 ? comps[2] : 0
        let lum = 0.299 * r + 0.587 * g + 0.114 * b
        let factor: CGFloat = lum > 0.55 ? 0.82 : 1.14
        func clamp(_ v: CGFloat) -> CGFloat { min(1, max(0, v)) }
        return String(
            format: "#%02X%02X%02X",
            Int(clamp(r * factor) * 255),
            Int(clamp(g * factor) * 255),
            Int(clamp(b * factor) * 255)
        )
    }
}

private struct PreviewTouchColorWell: View {
    let title: String
    let hex: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                PreviewColorWellCircle(hex: hex)
                Text(title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Edit \(title) color")
    }
}

private struct PreviewColorWellCircle: View {
    let hex: String

    var body: some View {
        Circle()
            .fill(Color(hex: hex))
            .overlay(
                Circle()
                    .strokeBorder(Color.black.opacity(0.1), lineWidth: 1)
            )
            .frame(width: 56, height: 56)
            .contentShape(Circle())
    }
}

/// Full-screen system color wheel (no extra tap on a small swatch).
private struct PreviewQuickEditColorSheet: View {
    let title: String
    let initialHex: String
    let onChange: (String) -> Void
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            SystemColorWheelPicker(initialHex: initialHex, onChange: onChange)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { onDismiss() }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct SystemColorWheelPicker: UIViewControllerRepresentable {
    let initialHex: String
    let onChange: (String) -> Void

    func makeUIViewController(context: Context) -> UIColorPickerViewController {
        let picker = UIColorPickerViewController()
        picker.selectedColor = UIColor(Color(hex: initialHex))
        picker.supportsAlpha = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIColorPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onChange: onChange)
    }

    final class Coordinator: NSObject, UIColorPickerViewControllerDelegate {
        let onChange: (String) -> Void

        init(onChange: @escaping (String) -> Void) {
            self.onChange = onChange
        }

        func colorPickerViewControllerDidSelectColor(_ viewController: UIColorPickerViewController) {
            onChange(viewController.selectedColor.toPreviewHex())
        }

        func colorPickerViewController(
            _ viewController: UIColorPickerViewController,
            didSelect color: UIColor,
            continuously: Bool
        ) {
            onChange(color.toPreviewHex())
        }
    }
}

private extension UIColor {
    func toPreviewHex() -> String {
        Color(uiColor: self).toHex()
    }
}
