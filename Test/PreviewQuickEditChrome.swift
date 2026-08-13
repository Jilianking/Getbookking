//
//  PreviewQuickEditChrome.swift
//
//  Touch-friendly color wells + floating control pill while Quick edit is on.
//

import SwiftUI
import UIKit

struct QuickEditInlineFocus: Equatable, Identifiable {
    var id: String { key }

    var key: String
    var fontSize: Int
    var fontAdjustable: Bool
    /// Computed `color` of the focused element in the preview (RGB → hex).
    var colorHex: String
    /// `text` = site text token; `button` = accent/CTA label on a filled or outline button.
    var colorRole: String
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
    @ObservedObject var history: QuickEditHistoryStore
    @Binding var inlineFocus: QuickEditInlineFocus?
    @Binding var colorsDirty: Bool
    @Binding var selectedColorSurface: PreviewColorSurface?
    @Binding var selectedChromeColorTarget: PreviewQuickEditColorTarget?
    @Binding var isChromeCollapsed: Bool
    @AppStorage("quickEditFabPosX") private var storedFabPosX: Double = -1
    @AppStorage("quickEditFabPosY") private var storedFabPosY: Double = -1
    @State private var activeColorTarget: PreviewQuickEditColorTarget?
    @State private var activeColorSurface: PreviewColorSurface?
    @State private var focusedColorEdit: QuickEditInlineFocus?
    @State private var draggingFabPosition: CGPoint?
    @State private var fabDragStartPosition: CGPoint?
    @State private var isSavingColors = false
    /// When true, preview color taps (bands + CTA chrome) work; text/sheet taps are ignored.
    @State private var isBackgroundPaintArmed = false
    @State private var colorChangeBaseline: (tokens: WebColorPaletteTokens, hero: String)?

    private let collapsedFabSize: CGFloat = 52
    private let collapsedFabMargin: CGFloat = 16

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.clear
                    .allowsHitTesting(false)

                if isChromeCollapsed {
                    collapsedFloatingFAB(in: geo.size)
                } else {
                    VStack(spacing: 0) {
                        Spacer()
                            .allowsHitTesting(false)
                        expandedChrome
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
        .allowsHitTesting(true)
        .sheet(item: $activeColorTarget) { target in
            PreviewQuickEditColorSheet(
                title: target.label,
                initialHex: hex(for: target),
                onChange: { applyChromeColor(target: target, hex: $0) },
                onDismiss: {
                    activeColorTarget = nil
                    selectedChromeColorTarget = nil
                    if target == .button {
                        setBackgroundPaintArmed(false)
                    }
                    finishColorSheetDismiss()
                }
            )
        }
        .sheet(item: $activeColorSurface) { surface in
            PreviewQuickEditColorSheet(
                title: surface.label,
                initialHex: surface.hex(from: viewModel),
                onChange: { applySurfaceColor(surface: surface, hex: $0) },
                onDismiss: {
                    activeColorSurface = nil
                    selectedColorSurface = nil
                    setBackgroundPaintArmed(false)
                    finishColorSheetDismiss()
                }
            )
        }
        .sheet(item: $focusedColorEdit) { focus in
            PreviewQuickEditColorSheet(
                title: PreviewQuickEditColorTarget.text.label,
                initialHex: focus.colorHex,
                onChange: { applyFocusedElementColor(hex: $0, focus: focus) },
                onDismiss: {
                    focusedColorEdit = nil
                    finishColorSheetDismiss()
                }
            )
        }
        .onChange(of: selectedColorSurface) { _, surface in
            guard let surface else { return }
            presentColorSurface(surface)
        }
        .onChange(of: selectedChromeColorTarget) { _, target in
            guard let target else { return }
            presentChromeColor(target)
        }
        .onChange(of: isChromeCollapsed) { _, collapsed in
            if collapsed {
                draggingFabPosition = nil
                fabDragStartPosition = nil
            }
        }
        .onDisappear {
            setBackgroundPaintArmed(false)
        }
    }

    private var expandedChrome: some View {
        VStack(spacing: 6) {
            HStack {
                Spacer(minLength: 0)
                chromeCollapseButton
            }
            controlPill
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background {
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea(edges: .bottom)
        }
    }

    private var chromeCollapseButton: some View {
        Button {
            dismissColorSheets()
            isChromeCollapsed = true
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 28, height: 28)
                .background(Color(.systemGray5))
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Hide edit tools")
    }

    private func collapsedFloatingFAB(in containerSize: CGSize) -> some View {
        let position = resolvedFabPosition(in: containerSize)
        return collapsedFabButton
            .position(position)
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        if fabDragStartPosition == nil {
                            fabDragStartPosition = resolvedFabPosition(in: containerSize)
                        }
                        guard let origin = fabDragStartPosition else { return }
                        let next = CGPoint(
                            x: origin.x + value.translation.width,
                            y: origin.y + value.translation.height
                        )
                        draggingFabPosition = clampFabPosition(next, in: containerSize)
                    }
                    .onEnded { _ in
                        if let draggingFabPosition {
                            persistFabPosition(draggingFabPosition)
                        }
                        draggingFabPosition = nil
                        fabDragStartPosition = nil
                    }
            )
            .accessibilityLabel(colorsDirty ? "Show edit tools, unsaved colors" : "Show edit tools")
            .accessibilityAddTraits(.isButton)
    }

    private var addTextButton: some View {
        Button {
            setBackgroundPaintArmed(false)
            bridge.showEmptyTextSlots()
        } label: {
            VStack(spacing: 4) {
                Image(systemName: "text.badge.plus")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
                Text("Text")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show empty text slots")
        .opacity(isBackgroundPaintArmed ? 0.45 : 1)
    }

    private var collapsedFabButton: some View {
        Button {
            isChromeCollapsed = false
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "chevron.up")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: collapsedFabSize, height: collapsedFabSize)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.18), radius: 10, y: 4)

                if colorsDirty {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
                        .offset(x: 4, y: -4)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(colorsDirty ? "Show edit tools, unsaved colors" : "Show edit tools")
    }

    private func defaultFabPosition(in size: CGSize) -> CGPoint {
        let half = collapsedFabSize / 2
        let margin = collapsedFabMargin
        return CGPoint(
            x: size.width - margin - half,
            y: size.height - margin - half
        )
    }

    private func clampFabPosition(_ point: CGPoint, in size: CGSize) -> CGPoint {
        let half = collapsedFabSize / 2
        let margin = collapsedFabMargin
        return CGPoint(
            x: min(size.width - margin - half, max(margin + half, point.x)),
            y: min(size.height - margin - half, max(margin + half, point.y))
        )
    }

    private func resolvedFabPosition(in size: CGSize) -> CGPoint {
        if let draggingFabPosition {
            return clampFabPosition(draggingFabPosition, in: size)
        }
        if storedFabPosX >= 0, storedFabPosY >= 0 {
            return clampFabPosition(CGPoint(x: storedFabPosX, y: storedFabPosY), in: size)
        }
        return defaultFabPosition(in: size)
    }

    private func persistFabPosition(_ point: CGPoint) {
        storedFabPosX = Double(point.x)
        storedFabPosY = Double(point.y)
    }

    private var swatchColorHex: String {
        inlineFocus?.colorHex ?? viewModel.textColorHex
    }

    private var compactTextColorWell: some View {
        Button {
            setBackgroundPaintArmed(false)
            beginColorChangeBaseline()
            if let focus = inlineFocus {
                focusedColorEdit = focus
            } else {
                activeColorTarget = .text
            }
        } label: {
            VStack(spacing: 4) {
                PreviewColorWellCircle(hex: swatchColorHex, diameter: 40)
                Text(PreviewQuickEditColorTarget.text.label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Edit text color")
        .opacity(isBackgroundPaintArmed ? 0.45 : 1)
    }

    private var compactBackgroundPaintWell: some View {
        Button {
            setBackgroundPaintArmed(!isBackgroundPaintArmed)
        } label: {
            VStack(spacing: 4) {
                PreviewColorWellCircle(hex: viewModel.backgroundColorHex, diameter: 40)
                    .overlay {
                        if isBackgroundPaintArmed {
                            Circle()
                                .strokeBorder(Color.accentColor, lineWidth: 2.5)
                        }
                    }
                Text("Background")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(isBackgroundPaintArmed ? Color.accentColor : Color.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isBackgroundPaintArmed ? "Background paint on, tap to turn off" : "Paint background colors")
        .accessibilityAddTraits(isBackgroundPaintArmed ? .isSelected : [])
    }

    private func setBackgroundPaintArmed(_ armed: Bool) {
        guard isBackgroundPaintArmed != armed else {
            if armed {
                bridge.setBackgroundPaintMode(true)
            }
            return
        }
        isBackgroundPaintArmed = armed
        if armed {
            if inlineFocus != nil {
                bridge.commitDirtyEdits()
                inlineFocus = nil
            }
            isChromeCollapsed = false
        }
        bridge.setBackgroundPaintMode(armed)
    }

    private var controlPill: some View {
        HStack(alignment: .center, spacing: 10) {
            // Hide Background while editing text so font size + undo fit on screen.
            if isBackgroundPaintArmed || inlineFocus == nil {
                compactBackgroundPaintWell
            }
            compactTextColorWell
            addTextButton

            if !isBackgroundPaintArmed, let focus = inlineFocus {
                activeFieldEditor(focus: focus)
                    .frame(maxWidth: .infinity)
            } else {
                Spacer(minLength: 0)
            }

            undoRedoButtons
        }
        .padding(.horizontal, 10)
        .padding(.vertical, inlineFocus == nil || isBackgroundPaintArmed ? 8 : 10)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.systemBackground))
                .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
        )
    }

    @ViewBuilder
    private func activeFieldEditor(focus: QuickEditInlineFocus) -> some View {
        if focus.fontAdjustable {
            fontSizeStepper(focus: focus)
        }
    }

    private var undoRedoButtons: some View {
        HStack(spacing: 6) {
            Button {
                Task { await performHistory(.undo) }
            } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(history.canUndo ? Color.primary : Color.secondary.opacity(0.35))
                    .frame(width: 40, height: 40)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!history.canUndo || isSavingColors)
            .accessibilityLabel("Undo")

            Button {
                Task { await performHistory(.redo) }
            } label: {
                Image(systemName: "arrow.uturn.forward")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(history.canRedo ? Color.primary : Color.secondary.opacity(0.35))
                    .frame(width: 40, height: 40)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!history.canRedo || isSavingColors)
            .accessibilityLabel("Redo")
        }
    }

    private enum HistoryDirection {
        case undo
        case redo
    }

    private func performHistory(_ direction: HistoryDirection) async {
        setBackgroundPaintArmed(false)
        bridge.commitDirtyEdits()
        inlineFocus = nil

        let entry: QuickEditHistoryEntry?
        switch direction {
        case .undo: entry = history.popUndo()
        case .redo: entry = history.popRedo()
        }
        guard let entry else { return }

        history.beginApplyingHistory()
        defer { history.endApplyingHistory() }

        switch entry {
        case let .colors(before, after, heroBefore, heroAfter):
            let tokens = direction == .undo ? before : after
            let hero = direction == .undo ? heroBefore : heroAfter
            await MainActor.run {
                viewModel.applyColorTokensLocally(tokens)
                viewModel.previewHeroSlotColorHex = hero
                colorsDirty = true
                pushPreviewColors(heroSlotOverride: hero, fullBandPass: true)
            }
            await persistDirtyColorsIfNeeded()
        case let .text(before, after):
            let map = direction == .undo ? before : after
            let pairs = map.map { (fieldKey: $0.key, value: $0.value) }
            await viewModel.saveQuickEditBatch(pairs, reloadPreview: false)
            await MainActor.run {
                bridge.applyTextOverrides(map)
            }
        }
    }

    /// Flush preview paint, then upload colors when the color sheet closes.
    private func finishColorSheetDismiss() {
        bridge.flushPreviewColorPatch()
        commitColorBaselineIfNeeded()
        guard colorsDirty, !isSavingColors else { return }
        Task { await persistDirtyColorsIfNeeded() }
    }

    private func persistDirtyColorsIfNeeded() async {
        guard colorsDirty else { return }
        await MainActor.run { isSavingColors = true }
        let ok = await viewModel.savePreviewQuickEditColors(invalidatePreview: false)
        await MainActor.run {
            isSavingColors = false
            if ok {
                colorsDirty = false
                pushPreviewColors()
            }
        }
    }

    private func beginColorChangeBaseline() {
        guard !history.isApplyingHistory else { return }
        if colorChangeBaseline == nil {
            colorChangeBaseline = (
                tokens: viewModel.currentColorTokens(),
                hero: viewModel.previewHeroSlotColorHex
            )
        }
    }

    private func commitColorBaselineIfNeeded() {
        guard let baseline = colorChangeBaseline else { return }
        colorChangeBaseline = nil
        history.recordColors(
            before: baseline.tokens,
            after: viewModel.currentColorTokens(),
            heroBefore: baseline.hero,
            heroAfter: viewModel.previewHeroSlotColorHex
        )
    }

    private func dismissColorSheets() {
        activeColorTarget = nil
        activeColorSurface = nil
        selectedColorSurface = nil
        selectedChromeColorTarget = nil
        focusedColorEdit = nil
    }

    /// Opens a band color sheet; clears `selectedColorSurface` so the same band can be tapped again after Done.
    private func presentColorSurface(_ surface: PreviewColorSurface) {
        beginColorChangeBaseline()
        activeColorSurface = surface
        selectedColorSurface = nil
    }

    /// Opens Background / Text / Button color; clears binding so the same CTA can be tapped again after Done.
    private func presentChromeColor(_ target: PreviewQuickEditColorTarget) {
        beginColorChangeBaseline()
        activeColorTarget = target
        selectedChromeColorTarget = nil
    }

    private func fontSizeStepper(focus: QuickEditInlineFocus) -> some View {
        HStack(spacing: 8) {
            Button {
                let next = max(10, focus.fontSize - 2)
                bridge.setInlineFontSize(next)
                inlineFocus = QuickEditInlineFocus(
                    key: focus.key,
                    fontSize: next,
                    fontAdjustable: true,
                    colorHex: focus.colorHex,
                    colorRole: focus.colorRole
                )
            } label: {
                Image(systemName: "minus")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)

            Text("\(focus.fontSize)")
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .frame(minWidth: 32)

            Button {
                let next = min(96, focus.fontSize + 2)
                bridge.setInlineFontSize(next)
                inlineFocus = QuickEditInlineFocus(
                    key: focus.key,
                    fontSize: next,
                    fontAdjustable: true,
                    colorHex: focus.colorHex,
                    colorRole: focus.colorRole
                )
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
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

    private func applyFocusedElementColor(hex: String, focus: QuickEditInlineFocus) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        bridge.setInlineColor(normalized)
        if focus.colorRole == "button" {
            viewModel.primaryColorHex = normalized
            viewModel.primaryColorHoverHex = PreviewQuickEditChrome.derivedHoverHex(for: normalized)
            viewModel.syncPreviewHeroSlotColorFromTokens()
        } else {
            viewModel.textColorHex = normalized
        }
        colorsDirty = true
        pushPreviewColors()
        if var current = inlineFocus, current.key == focus.key {
            current.colorHex = normalized
            inlineFocus = current
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
        let heroOverride: String? = {
            guard surface == .hero,
                  !PreviewColorSurface.heroUsesPageBackground(family: viewModel.activeTemplateFamily)
            else { return nil }
            return normalized
        }()
        pushPreviewColors(heroSlotOverride: heroOverride, fullBandPass: needsFullBandPass(surface))
    }

    private func needsFullBandPass(_ surface: PreviewColorSurface) -> Bool {
        switch surface {
        case .card, .featured, .gallery, .about: return true
        case .page, .hero: return false
        }
    }

    private func pushPreviewColors(heroSlotOverride: String? = nil, fullBandPass: Bool = false) {
        bridge.schedulePreviewColorPatch(
            viewModel.previewColorPatchPayload(heroSlotOverride: heroSlotOverride),
            full: fullBandPass
        )
    }

    func openColorSurface(_ surface: PreviewColorSurface) {
        presentColorSurface(surface)
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
    var diameter: CGFloat = 56

    var body: some View {
        Circle()
            .fill(Color(hex: hex))
            .overlay(
                Circle()
                    .strokeBorder(Color.black.opacity(0.1), lineWidth: 1)
            )
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
    }
}

/// Full-screen system color wheel with an editable hex field (system hex row is unreliable when embedded).
private struct PreviewQuickEditColorSheet: View {
    let title: String
    let initialHex: String
    let onChange: (String) -> Void
    let onDismiss: () -> Void

    @State private var workingHex: String
    @State private var hexFieldText: String
    @FocusState private var hexFieldFocused: Bool

    init(
        title: String,
        initialHex: String,
        onChange: @escaping (String) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.title = title
        self.initialHex = initialHex
        self.onChange = onChange
        self.onDismiss = onDismiss
        let normalized = PreviewQuickEditHex.normalize(initialHex)
        _workingHex = State(initialValue: normalized)
        _hexFieldText = State(initialValue: PreviewQuickEditHex.digits(normalized))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                hexEditor
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Color(.secondarySystemBackground))

                SystemColorWheelPicker(hex: $workingHex) { picked in
                    applyHex(picked, updateField: true)
                }
                .ignoresSafeArea(edges: .bottom)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        commitHexFieldIfNeeded()
                        onDismiss()
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var hexEditor: some View {
        HStack(spacing: 10) {
            Text("Hex #")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            TextField("2A1810", text: $hexFieldText)
                .font(.body.monospaced())
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($hexFieldFocused)
                .onChange(of: hexFieldText) { _, newValue in
                    let filtered = PreviewQuickEditHex.sanitizeTyping(newValue)
                    if filtered != newValue {
                        hexFieldText = filtered
                        return
                    }
                    if filtered.count == 6 {
                        applyHex("#\(filtered)", updateField: false)
                    }
                }
                .onSubmit {
                    commitHexFieldIfNeeded()
                    hexFieldFocused = false
                }
            Spacer(minLength: 0)
            Circle()
                .fill(Color(hex: workingHex))
                .frame(width: 28, height: 28)
                .overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 1))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Hex color")
        .accessibilityValue(workingHex)
    }

    private func applyHex(_ hex: String, updateField: Bool) {
        let canonical = PreviewQuickEditHex.normalize(hex)
        if updateField {
            hexFieldText = PreviewQuickEditHex.digits(canonical)
        }
        guard canonical != workingHex else { return }
        workingHex = canonical
        onChange(canonical)
    }

    private func commitHexFieldIfNeeded() {
        let cleaned = PreviewQuickEditHex.sanitizeTyping(hexFieldText)
        if cleaned.count == 6 || cleaned.count == 3 {
            applyHex(cleaned, updateField: true)
        } else {
            hexFieldText = PreviewQuickEditHex.digits(workingHex)
        }
    }
}

private enum PreviewQuickEditHex {
    static func sanitizeTyping(_ raw: String) -> String {
        let stripped = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
            .uppercased()
        return String(stripped.filter(\.isHexDigit).prefix(6))
    }

    static func digits(_ hex: String) -> String {
        String(normalize(hex).drop(while: { $0 == "#" }))
    }

    static func normalize(_ hex: String) -> String {
        let cleaned = sanitizeTyping(hex)
        if cleaned.count == 6 { return "#\(cleaned)" }
        if cleaned.count == 3 {
            return "#\(cleaned.map { "\($0)\($0)" }.joined())"
        }
        return "#000000"
    }
}

private struct SystemColorWheelPicker: UIViewControllerRepresentable {
    @Binding var hex: String
    let onUserPicked: (String) -> Void

    func makeUIViewController(context: Context) -> UIColorPickerViewController {
        let picker = UIColorPickerViewController()
        picker.selectedColor = UIColor(Color(hex: hex))
        picker.supportsAlpha = false
        picker.delegate = context.coordinator
        context.coordinator.lastAppliedHex = PreviewQuickEditHex.normalize(hex)
        return picker
    }

    func updateUIViewController(_ uiViewController: UIColorPickerViewController, context: Context) {
        let normalized = PreviewQuickEditHex.normalize(hex)
        // Avoid resetting selectedColor on every SwiftUI pass — that breaks hex editing
        // and fights in-progress slider / spectrum interaction.
        guard normalized != context.coordinator.lastAppliedHex else { return }
        context.coordinator.lastAppliedHex = normalized
        context.coordinator.isApplyingProgrammatically = true
        uiViewController.selectedColor = UIColor(Color(hex: normalized))
        context.coordinator.isApplyingProgrammatically = false
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onUserPicked: onUserPicked)
    }

    final class Coordinator: NSObject, UIColorPickerViewControllerDelegate {
        let onUserPicked: (String) -> Void
        var lastAppliedHex: String = ""
        var isApplyingProgrammatically = false

        init(onUserPicked: @escaping (String) -> Void) {
            self.onUserPicked = onUserPicked
        }

        func colorPickerViewController(
            _ viewController: UIColorPickerViewController,
            didSelect color: UIColor,
            continuously: Bool
        ) {
            guard !isApplyingProgrammatically else { return }
            let picked = PreviewQuickEditHex.normalize(color.toPreviewHex())
            lastAppliedHex = picked
            onUserPicked(picked)
        }
    }
}

private extension UIColor {
    func toPreviewHex() -> String {
        Color(uiColor: self).toHex()
    }
}
