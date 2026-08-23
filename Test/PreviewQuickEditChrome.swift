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

/// Touch-friendly color wells + floating control pill while Quick edit is on.
struct PreviewQuickEditChrome: View {
    @ObservedObject var viewModel: DesignViewModel
    var bridge: WebViewQuickEditBridge
    @ObservedObject var history: QuickEditHistoryStore
    @Binding var inlineFocus: QuickEditInlineFocus?
    @Binding var colorsDirty: Bool
    /// Band paint tap from the WebView (role + optional `data-bk-surface-key` in one value).
    @Binding var selectedSurfacePaint: PreviewSurfacePaintRequest?
    @Binding var selectedChromeColorTarget: PreviewQuickEditColorTarget?
    /// Classic per-button key from the last CTA paint tap (`data-cta-key`).
    @Binding var selectedChromeCtaKey: String?
    @Binding var isChromeCollapsed: Bool
    /// `/book` preview — Background well can show the booking canvas fill (`*.bookingPage`).
    var isBookingCanvasPreview: Bool = false
    /// Booking canvas key for the active theme (`blade.bookingPage` / `luxe.bookingPage`).
    var bookingPageSurfaceKey: String? = nil
    @AppStorage("quickEditFabPosX") private var storedFabPosX: Double = -1
    @AppStorage("quickEditFabPosY") private var storedFabPosY: Double = -1
    @State private var activeColorTarget: PreviewQuickEditColorTarget?
    @State private var activeColorSurface: PreviewColorSurface?
    @State private var activeSurfaceKey: String?
    @State private var focusedColorEdit: QuickEditInlineFocus?
    @State private var activeButtonColorKey: String?
    @State private var buttonColorBaseline: (key: String, hex: String)?
    @State private var surfaceColorBaseline: (key: String, hex: String)?
    @State private var draggingFabPosition: CGPoint?
    @State private var fabDragStartPosition: CGPoint?
    @State private var isSavingColors = false
    /// When true, preview color taps (bands + CTA chrome) work; text/sheet taps are ignored.
    @State private var isBackgroundPaintArmed = false
    @State private var isSidebarMenuExpanded = false
    @State private var colorChangeBaseline: (tokens: WebColorPaletteTokens, hero: String, sidebar: String, sidebarText: String, sidebarIcon: String, sidebarClose: String)?
    @State private var fieldColorBaseline: (key: String, hex: String)?
    @State private var textColorSaveTask: Task<Void, Never>?
    @State private var buttonColorSaveTask: Task<Void, Never>?
    @State private var surfaceColorSaveTask: Task<Void, Never>?

    private let collapsedFabSize: CGFloat = 52
    private let collapsedFabMargin: CGFloat = 16
    /// Undo + redo (40 each + 6 gap) + 8 spacing + FAB.
    private var collapsedClusterWidth: CGFloat { 40 + 6 + 40 + 8 + collapsedFabSize }
    private var collapsedClusterHeight: CGFloat { collapsedFabSize }

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
                    selectedChromeCtaKey = nil
                    if target == .button {
                        commitButtonColorBaselineIfNeeded()
                        flushButtonColorSave()
                        activeButtonColorKey = nil
                        setBackgroundPaintArmed(false)
                    }
                    finishColorSheetDismiss()
                }
            )
        }
        .sheet(item: $activeColorSurface) { surface in
            PreviewQuickEditColorSheet(
                title: surfaceSheetTitle(surface, key: activeSurfaceKey),
                initialHex: resolvedSurfaceHex(surface: surface, key: activeSurfaceKey),
                onChange: { applySurfaceColor(surface: surface, hex: $0) },
                onDismiss: {
                    // Flush keyed save before clearing baseline / active key.
                    flushSurfaceColorSave()
                    commitSurfaceColorBaselineIfNeeded()
                    activeColorSurface = nil
                    activeSurfaceKey = nil
                    selectedSurfacePaint = nil
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
                    commitFieldColorBaselineIfNeeded()
                    flushFocusedTextColorSave()
                    focusedColorEdit = nil
                    finishColorSheetDismiss()
                }
            )
        }
        .onChange(of: selectedSurfacePaint) { _, request in
            guard let request else { return }
            presentColorSurface(request.surface, surfaceKey: request.surfaceKey)
        }
        .onChange(of: selectedChromeColorTarget) { _, target in
            guard let target else { return }
            presentChromeColor(target)
        }
        .onChange(of: inlineFocus) { _, focus in
            if focus != nil {
                isSidebarMenuExpanded = false
            }
        }
        .onChange(of: isChromeCollapsed) { _, collapsed in
            if collapsed {
                draggingFabPosition = nil
                fabDragStartPosition = nil
                isSidebarMenuExpanded = false
            }
        }
        .onDisappear {
            setBackgroundPaintArmed(false)
            flushSurfaceColorSave()
            flushButtonColorSave()
            // Ensure Edit-off teardown still has the latest maps on the bridge.
            bridge.syncStyleMapsFromViewModel(
                buttons: viewModel.webButtonColors,
                surfaces: viewModel.webSurfaceColors,
                textColors: viewModel.webTextColors,
                textFontSizes: viewModel.webTextFontSizes
            )
            Task { await viewModel.persistAllQuickEditStyleMaps() }
        }
        .onAppear {
            bridge.syncStyleMapsFromViewModel(
                buttons: viewModel.webButtonColors,
                surfaces: viewModel.webSurfaceColors,
                textColors: viewModel.webTextColors,
                textFontSizes: viewModel.webTextFontSizes
            )
            bridge.reapplyCachedStyleMaps()
        }
    }

    private var expandedChrome: some View {
        VStack(spacing: 6) {
            HStack {
                Spacer(minLength: 0)
                chromeCollapseButton
            }
            if isSidebarMenuExpanded, !isBackgroundPaintArmed, inlineFocus == nil {
                sidebarChromeChipRow
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

    private var sidebarChromeChipRow: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            sidebarChromeChip(surface: .sidebarOpen, title: "Open", systemImage: "line.3.horizontal")
            sidebarChromeChip(surface: .sidebarClose, title: "Close", systemImage: "xmark")
            sidebarChromeChip(surface: .sidebar, title: "Background")
            sidebarChromeChip(surface: .sidebarText, title: "Text")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.systemBackground))
                .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        )
    }

    private func sidebarChromeChip(surface: PreviewColorSurface, title: String, systemImage: String? = nil) -> some View {
        Button {
            presentColorSurface(surface)
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    PreviewColorWellCircle(hex: surface.hex(from: viewModel), diameter: 36)
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(sidebarChipGlyphColor(for: surface.hex(from: viewModel)))
                    }
                }
                Text(title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Edit \(title.lowercased()) color")
    }

    private func sidebarChipGlyphColor(for hex: String) -> Color {
        let c = Color(hex: hex)
        guard let comps = UIColor(c).cgColor.components, comps.count >= 3 else { return .white }
        let lum = 0.299 * comps[0] + 0.587 * comps[1] + 0.114 * comps[2]
        return lum > 0.58 ? Color(white: 0.12) : .white
    }

    private var sidebarMenuButton: some View {
        Button {
            setBackgroundPaintArmed(false)
            withAnimation(.easeInOut(duration: 0.18)) {
                isSidebarMenuExpanded.toggle()
            }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 40, height: 40)
                    .background(isSidebarMenuExpanded ? Color.accentColor.opacity(0.15) : Color(.systemGray6))
                    .clipShape(Circle())
                    .overlay {
                        if isSidebarMenuExpanded {
                            Circle()
                                .strokeBorder(Color.accentColor, lineWidth: 2)
                        }
                    }
                Text("Sidebar")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(isSidebarMenuExpanded ? Color.accentColor : Color.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isSidebarMenuExpanded ? "Hide sidebar color tools" : "Sidebar color tools")
        .accessibilityAddTraits(isSidebarMenuExpanded ? .isSelected : [])
        .opacity(isBackgroundPaintArmed ? 0.45 : 1)
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
        return HStack(spacing: 8) {
            undoRedoButtons
            collapsedFabButton
        }
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
        let halfW = collapsedClusterWidth / 2
        let halfH = collapsedClusterHeight / 2
        let margin = collapsedFabMargin
        return CGPoint(
            x: size.width - margin - halfW,
            y: size.height - margin - halfH
        )
    }

    private func clampFabPosition(_ point: CGPoint, in size: CGSize) -> CGPoint {
        let halfW = collapsedClusterWidth / 2
        let halfH = collapsedClusterHeight / 2
        let margin = collapsedFabMargin
        return CGPoint(
            x: min(size.width - margin - halfW, max(margin + halfW, point.x)),
            y: min(size.height - margin - halfH, max(margin + halfH, point.y))
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
            if let focus = inlineFocus {
                beginFieldColorBaseline(focus: focus)
                focusedColorEdit = focus
            } else {
                beginColorChangeBaseline()
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
                PreviewColorWellCircle(hex: backgroundWellHex, diameter: 40)
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

    private var backgroundWellHex: String {
        if isBookingCanvasPreview,
           let key = bookingPageSurfaceKey,
           let override = viewModel.webSurfaceColors[key],
           override.hasPrefix("#") {
            return WebColorPalettes.normalizeHex(override)
        }
        return viewModel.backgroundColorHex
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
            isSidebarMenuExpanded = false
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
            if isBackgroundPaintArmed || inlineFocus == nil {
                sidebarMenuButton
            }

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

        let entry: QuickEditHistoryEntry?
        switch direction {
        case .undo: entry = history.popUndo()
        case .redo: entry = history.popRedo()
        }
        guard let entry else { return }

        history.beginApplyingHistory()
        defer { history.endApplyingHistory() }

        switch entry {
        case .fontSize, .fieldColor, .buttonColor, .surfaceColor:
            break
        default:
            bridge.commitDirtyEdits()
            inlineFocus = nil
        }

        switch entry {
        case let .colors(before, after, heroBefore, heroAfter, sidebarBefore, sidebarAfter, sidebarTextBefore, sidebarTextAfter, sidebarIconBefore, sidebarIconAfter, sidebarCloseBefore, sidebarCloseAfter):
            let tokens = direction == .undo ? before : after
            let hero = direction == .undo ? heroBefore : heroAfter
            let sidebar = direction == .undo ? sidebarBefore : sidebarAfter
            let sidebarText = direction == .undo ? sidebarTextBefore : sidebarTextAfter
            let sidebarIcon = direction == .undo ? sidebarIconBefore : sidebarIconAfter
            let sidebarClose = direction == .undo ? sidebarCloseBefore : sidebarCloseAfter
            await MainActor.run {
                viewModel.applyColorTokensLocally(tokens)
                viewModel.previewHeroSlotColorHex = hero
                viewModel.sidebarBackgroundColorHex = sidebar
                viewModel.sidebarTextColorHex = sidebarText
                viewModel.sidebarIconColorHome = sidebarIcon
                viewModel.sidebarIconColorBooking = sidebarIcon
                viewModel.sidebarCloseIconColorHex = sidebarClose
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
        case let .fontSize(key, before, after):
            let px = direction == .undo ? before : after
            await MainActor.run {
                bridge.applyFontSizes([key: px])
                if var focus = inlineFocus, focus.key == key {
                    focus.fontSize = px
                    inlineFocus = focus
                }
            }
            await viewModel.persistQuickEditFontSize(fieldKey: key, px: px)
        case let .fieldColor(key, before, after):
            let hex = direction == .undo ? before : after
            await MainActor.run {
                bridge.applyFieldColors([key: hex])
                if var focus = inlineFocus, focus.key == key {
                    focus.colorHex = hex
                    inlineFocus = focus
                }
            }
            await viewModel.persistQuickEditTextColor(fieldKey: key, hex: hex)
        case let .buttonColor(key, before, after):
            let hex = direction == .undo ? before : after
            await MainActor.run {
                viewModel.webButtonColors[key] = hex
                bridge.applyButtonColors(viewModel.webButtonColors)
            }
            await viewModel.persistQuickEditButtonColor(fieldKey: key, hex: hex)
        case let .surfaceColor(key, before, after):
            let hex = direction == .undo ? before : after
            await MainActor.run {
                viewModel.webSurfaceColors[key] = hex
                bridge.applySurfaceColors(viewModel.webSurfaceColors)
            }
            await viewModel.persistQuickEditSurfaceColor(fieldKey: key, hex: hex)
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
                hero: viewModel.previewHeroSlotColorHex,
                sidebar: viewModel.sidebarBackgroundColorHex,
                sidebarText: viewModel.sidebarTextColorHex,
                sidebarIcon: viewModel.sidebarIconColorHome,
                sidebarClose: viewModel.sidebarCloseIconColorHex
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
            heroAfter: viewModel.previewHeroSlotColorHex,
            sidebarBefore: baseline.sidebar,
            sidebarAfter: viewModel.sidebarBackgroundColorHex,
            sidebarTextBefore: baseline.sidebarText,
            sidebarTextAfter: viewModel.sidebarTextColorHex,
            sidebarIconBefore: baseline.sidebarIcon,
            sidebarIconAfter: viewModel.sidebarIconColorHome,
            sidebarCloseBefore: baseline.sidebarClose,
            sidebarCloseAfter: viewModel.sidebarCloseIconColorHex
        )
    }

    private func beginFieldColorBaseline(focus: QuickEditInlineFocus) {
        guard !history.isApplyingHistory else { return }
        if fieldColorBaseline == nil {
            fieldColorBaseline = (key: focus.key, hex: focus.colorHex)
        }
    }

    private func commitFieldColorBaselineIfNeeded() {
        guard let baseline = fieldColorBaseline else { return }
        fieldColorBaseline = nil
        let after = inlineFocus?.key == baseline.key ? (inlineFocus?.colorHex ?? baseline.hex) : baseline.hex
        history.recordFieldColor(key: baseline.key, before: baseline.hex, after: after)
    }

    private func dismissColorSheets() {
        activeColorTarget = nil
        activeColorSurface = nil
        activeSurfaceKey = nil
        selectedSurfacePaint = nil
        selectedChromeColorTarget = nil
        selectedChromeCtaKey = nil
        focusedColorEdit = nil
        isSidebarMenuExpanded = false
    }

    /// Opens a band color sheet; clears `selectedSurfacePaint` so the same band can be tapped again after Done.
    private func presentColorSurface(_ surface: PreviewColorSurface, surfaceKey: String? = nil) {
        beginColorChangeBaseline()
        let isSidebarChrome = surface == .sidebar || surface == .sidebarOpen
            || surface == .sidebarClose || surface == .sidebarText
        let trimmed = (surfaceKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let key = isSidebarChrome ? "" : trimmed
        activeSurfaceKey = key.isEmpty ? nil : key
        if let key = activeSurfaceKey {
            let before = viewModel.webSurfaceColors[key] ?? surface.hex(from: viewModel)
            surfaceColorBaseline = (key: key, hex: before)
        } else {
            surfaceColorBaseline = nil
        }
        activeColorSurface = surface
        selectedSurfacePaint = nil
    }

    private func resolvedSurfaceHex(surface: PreviewColorSurface, key: String?) -> String {
        if let key, !key.isEmpty,
           let override = viewModel.webSurfaceColors[key],
           override.hasPrefix("#") {
            return WebColorPalettes.normalizeHex(override)
        }
        return surface.hex(from: viewModel)
    }

    private func surfaceSheetTitle(_ surface: PreviewColorSurface, key: String?) -> String {
        let k = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if k == "luxe.about" || k == "stonecut.about" { return "Home about" }
        if k == "stonecut.location" { return "Location" }
        if k == "stonecut.when" { return "Hours" }
        if k == "stonecut.where" { return "Where" }
        if k == "studio12.when" { return "Hours" }
        if k == "studio12.bookCta" { return "Book CTA" }
        if k == "studio12.where" { return "Find us" }
        if k == "studio12.map" { return "Map" }
        if k == "studio12.info" { return "Location" }
        if k == "studio12.philosophy" { return "Philosophy" }
        if k == "luxe.contact" { return "Contact" }
        if k == "luxe.legal" || k.hasSuffix(".footer") { return "Footer" }
        if k == "luxe.team" || k == "stonecut.team" || k == "studio12.team" { return "Meet the team" }
        if k == "luxe.featured" { return "Featured work" }
        if k.hasSuffix(".gallery") && !k.hasSuffix("galleryPage") { return "Gallery preview" }
        if k == "studio12.process" { return "Process" }
        if k == "studio12.testimonials" { return "Testimonials" }
        if k.hasSuffix(".bookingPage") { return "Booking page" }
        if k.hasSuffix(".bookingCard") { return "Booking card" }
        if k.hasSuffix(".shopPage") { return "Shop page" }
        if k.hasSuffix(".galleryPage") { return "Gallery page" }
        if k.hasSuffix(".teamPage") || k.hasSuffix(".memberPage") { return "Team page" }
        if k == "charter.chartersPage" { return "Our charters" }
        if k == "charter.featured" { return "Featured section" }
        if k.contains(".featCard.") { return "Featured charter" }
        if k.contains(".homeProduct.") { return "Shop preview card" }
        if k.contains(".shopProduct.") { return "Product card" }
        if k == "charter.quoteCard" { return "Quote card" }
        if k == "charter.stickyBook" { return "Booking card" }
        if k == "charter.captain" { return "Captain card" }
        if k.contains(".howStep.") { return "How it works step" }
        if k == "charter.aboutContact" { return "Contact captain" }
        if k.contains(".addon.") { return "Add-on" }
        if k == "charter.orderCard" { return "Order summary" }
        if k == "charter.confirmCard" { return "Confirmation card" }
        if k.hasSuffix(".nav") { return "Header" }
        if k.hasSuffix(".services") { return "Services" }
        if k.contains(".svcCard.") { return "Service card" }
        if k.contains(".homeTeamCard.") || k.contains(".teamCard.") { return "Team card" }
        if k.contains(".testimonialCard.") { return "Testimonial" }
        if k.contains(".processStep.") { return "Experience step" }
        if k.hasSuffix(".shop") { return "Shop preview" }
        if k.hasSuffix(".hero") { return "Hero" }
        return surface.label
    }

    private func commitSurfaceColorBaselineIfNeeded() {
        guard let baseline = surfaceColorBaseline else { return }
        surfaceColorBaseline = nil
        let after = viewModel.webSurfaceColors[baseline.key] ?? baseline.hex
        history.recordSurfaceColor(key: baseline.key, before: baseline.hex, after: after)
    }

    /// Opens Background / Text / Button color; clears binding so the same CTA can be tapped again after Done.
    private func presentChromeColor(_ target: PreviewQuickEditColorTarget) {
        beginColorChangeBaseline()
        if target == .button {
            let key = (selectedChromeCtaKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            activeButtonColorKey = key.isEmpty ? nil : key
            if let key = activeButtonColorKey {
                let before = viewModel.webButtonColors[key] ?? viewModel.primaryColorHex
                buttonColorBaseline = (key: key, hex: before)
            } else {
                buttonColorBaseline = nil
            }
        } else {
            activeButtonColorKey = nil
            buttonColorBaseline = nil
        }
        activeColorTarget = target
        selectedChromeColorTarget = nil
        selectedChromeCtaKey = nil
    }

    private func commitButtonColorBaselineIfNeeded() {
        guard let baseline = buttonColorBaseline else { return }
        buttonColorBaseline = nil
        let after = viewModel.webButtonColors[baseline.key] ?? baseline.hex
        history.recordButtonColor(key: baseline.key, before: baseline.hex, after: after)
    }

    private func fontSizeStepper(focus: QuickEditInlineFocus) -> some View {
        HStack(spacing: 8) {
            Button {
                applyFontSizeChange(focus: focus, next: max(10, focus.fontSize - 2))
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
                applyFontSizeChange(focus: focus, next: min(96, focus.fontSize + 2))
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

    private func applyFontSizeChange(focus: QuickEditInlineFocus, next: Int) {
        guard next != focus.fontSize else { return }
        history.recordFontSize(key: focus.key, before: focus.fontSize, after: next)
        bridge.setInlineFontSize(next)
        inlineFocus = QuickEditInlineFocus(
            key: focus.key,
            fontSize: next,
            fontAdjustable: true,
            colorHex: focus.colorHex,
            colorRole: focus.colorRole
        )
        viewModel.webTextFontSizes[focus.key] = String(next)
        Task { await viewModel.persistQuickEditFontSize(fieldKey: focus.key, px: next) }
    }

    private func hex(for target: PreviewQuickEditColorTarget) -> String {
        switch target {
        case .background: return viewModel.backgroundColorHex
        case .text: return viewModel.textColorHex
        case .button:
            if let key = activeButtonColorKey,
               let override = viewModel.webButtonColors[key],
               !override.isEmpty {
                return override
            }
            return viewModel.primaryColorHex
        }
    }

    /// Recolors only the focused blue-box node. Site-wide Text / Button tokens stay on the unfocused wells.
    private func applyFocusedElementColor(hex: String, focus: QuickEditInlineFocus) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        bridge.setInlineColor(normalized)
        if var current = inlineFocus, current.key == focus.key {
            current.colorHex = normalized
            inlineFocus = current
        }
        // Keep ViewModel map warm so Edit-off persist cannot miss a cancelled debounce.
        viewModel.setQuickEditTextColorLocally(fieldKey: focus.key, hex: normalized)
        scheduleFocusedTextColorSave(key: focus.key, hex: normalized)
    }

    private func scheduleFocusedTextColorSave(key: String, hex: String) {
        textColorSaveTask?.cancel()
        textColorSaveTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await viewModel.persistQuickEditTextColor(fieldKey: key, hex: hex)
        }
    }

    private func flushFocusedTextColorSave() {
        textColorSaveTask?.cancel()
        textColorSaveTask = nil
        guard let focus = inlineFocus ?? focusedColorEdit else { return }
        let key = focus.key
        let hex = focus.colorHex
        Task { await viewModel.persistQuickEditTextColor(fieldKey: key, hex: hex) }
    }

    private func applyChromeColor(target: PreviewQuickEditColorTarget, hex: String) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        switch target {
        case .background:
            viewModel.backgroundColorHex = normalized
            viewModel.syncPreviewHeroSlotColorFromTokens()
            colorsDirty = true
            pushPreviewColors()
        case .text:
            if let focus = inlineFocus {
                applyFocusedElementColor(hex: normalized, focus: focus)
            } else {
                viewModel.textColorHex = normalized
                colorsDirty = true
                pushPreviewColors()
            }
        case .button:
            // Per-CTA override when a `data-cta-key` is focused; otherwise global primary.
            if let key = activeButtonColorKey, !key.isEmpty {
                viewModel.webButtonColors[key] = normalized
                bridge.applyButtonColors(viewModel.webButtonColors)
                // Persist promptly — do not rely only on debounce surviving Edit-off.
                Task { await viewModel.persistQuickEditButtonColor(fieldKey: key, hex: normalized) }
                scheduleButtonColorSave(key: key, hex: normalized)
            } else {
                viewModel.primaryColorHex = normalized
                viewModel.primaryColorHoverHex = PreviewQuickEditChrome.derivedHoverHex(for: normalized)
                viewModel.syncPreviewHeroSlotColorFromTokens()
                colorsDirty = true
                pushPreviewColors()
            }
        }
    }

    private func scheduleButtonColorSave(key: String, hex: String) {
        buttonColorSaveTask?.cancel()
        buttonColorSaveTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await viewModel.persistQuickEditButtonColor(fieldKey: key, hex: hex)
        }
    }

    private func flushButtonColorSave() {
        buttonColorSaveTask?.cancel()
        buttonColorSaveTask = nil
        guard let key = activeButtonColorKey ?? buttonColorBaseline?.key else { return }
        let hex = viewModel.webButtonColors[key] ?? viewModel.primaryColorHex
        Task { await viewModel.persistQuickEditButtonColor(fieldKey: key, hex: hex) }
    }

    private func applySurfaceColor(surface: PreviewColorSurface, hex: String) {
        let normalized = WebColorPalettes.normalizeHex(hex)
        // Per-band override when a `data-bk-surface-key` is focused; otherwise shared role tokens.
        if let key = activeSurfaceKey, !key.isEmpty {
            viewModel.webSurfaceColors[key] = normalized
            bridge.syncStyleMapsFromViewModel(
                buttons: viewModel.webButtonColors,
                surfaces: viewModel.webSurfaceColors,
                textColors: viewModel.webTextColors,
                textFontSizes: viewModel.webTextFontSizes
            )
            bridge.applySurfaceColors(viewModel.webSurfaceColors)
            // Persist immediately so Edit-off / navigation cannot cancel a debounced write.
            Task { await viewModel.persistQuickEditSurfaceColor(fieldKey: key, hex: normalized) }
            scheduleSurfaceColorSave(key: key, hex: normalized)
            return
        }
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

    private func scheduleSurfaceColorSave(key: String, hex: String) {
        surfaceColorSaveTask?.cancel()
        surfaceColorSaveTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await viewModel.persistQuickEditSurfaceColor(fieldKey: key, hex: hex)
        }
    }

    private func flushSurfaceColorSave() {
        surfaceColorSaveTask?.cancel()
        surfaceColorSaveTask = nil
        guard let key = activeSurfaceKey ?? surfaceColorBaseline?.key else { return }
        let hex = viewModel.webSurfaceColors[key]
            ?? surfaceColorBaseline?.hex
            ?? viewModel.backgroundColorHex
        Task { await viewModel.persistQuickEditSurfaceColor(fieldKey: key, hex: hex) }
    }

    private func needsFullBandPass(_ surface: PreviewColorSurface) -> Bool {
        switch surface {
        case .card, .featured, .gallery, .about, .sidebar, .sidebarOpen, .sidebarClose, .sidebarText: return true
        case .page, .hero: return false
        }
    }

    private func pushPreviewColors(heroSlotOverride: String? = nil, fullBandPass: Bool = false) {
        bridge.schedulePreviewColorPatch(
            viewModel.previewColorPatchPayload(heroSlotOverride: heroSlotOverride),
            full: fullBandPass
        )
    }

    func openColorSurface(_ surface: PreviewColorSurface, surfaceKey: String? = nil) {
        presentColorSurface(surface, surfaceKey: surfaceKey)
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
