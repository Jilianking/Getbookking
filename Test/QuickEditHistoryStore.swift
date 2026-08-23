//
//  QuickEditHistoryStore.swift
//
//  Session undo/redo for Design Quick Edit (text, colors, font size, field color).
//

import Combine
import Foundation
import SwiftUI

enum QuickEditHistoryEntry: Equatable {
    case colors(
        before: WebColorPaletteTokens,
        after: WebColorPaletteTokens,
        heroBefore: String,
        heroAfter: String,
        sidebarBefore: String,
        sidebarAfter: String,
        sidebarTextBefore: String,
        sidebarTextAfter: String,
        sidebarIconBefore: String,
        sidebarIconAfter: String,
        sidebarCloseBefore: String,
        sidebarCloseAfter: String
    )
    case text(before: [String: String], after: [String: String])
    case fontSize(key: String, before: Int, after: Int)
    case fieldColor(key: String, before: String, after: String)
    case buttonColor(key: String, before: String, after: String)
    case surfaceColor(key: String, before: String, after: String)
}

@MainActor
final class QuickEditHistoryStore: ObservableObject {
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false

    private var undoStack: [QuickEditHistoryEntry] = []
    private var redoStack: [QuickEditHistoryEntry] = []
    private(set) var isApplyingHistory = false
    private let maxEntries = 40

    func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
        refreshFlags()
    }

    func recordColors(
        before: WebColorPaletteTokens,
        after: WebColorPaletteTokens,
        heroBefore: String,
        heroAfter: String,
        sidebarBefore: String,
        sidebarAfter: String,
        sidebarTextBefore: String,
        sidebarTextAfter: String,
        sidebarIconBefore: String,
        sidebarIconAfter: String,
        sidebarCloseBefore: String,
        sidebarCloseAfter: String
    ) {
        guard !isApplyingHistory else { return }
        guard before != after
            || heroBefore != heroAfter
            || sidebarBefore != sidebarAfter
            || sidebarTextBefore != sidebarTextAfter
            || sidebarIconBefore != sidebarIconAfter
            || sidebarCloseBefore != sidebarCloseAfter
        else { return }
        pushUndo(
            .colors(
                before: before,
                after: after,
                heroBefore: heroBefore,
                heroAfter: heroAfter,
                sidebarBefore: sidebarBefore,
                sidebarAfter: sidebarAfter,
                sidebarTextBefore: sidebarTextBefore,
                sidebarTextAfter: sidebarTextAfter,
                sidebarIconBefore: sidebarIconBefore,
                sidebarIconAfter: sidebarIconAfter,
                sidebarCloseBefore: sidebarCloseBefore,
                sidebarCloseAfter: sidebarCloseAfter
            )
        )
    }

    func recordText(before: [String: String], after: [String: String]) {
        guard !isApplyingHistory else { return }
        var filteredBefore: [String: String] = [:]
        var filteredAfter: [String: String] = [:]
        for (key, newValue) in after {
            let oldValue = before[key] ?? ""
            if oldValue != newValue {
                filteredBefore[key] = oldValue
                filteredAfter[key] = newValue
            }
        }
        guard !filteredAfter.isEmpty else { return }
        pushUndo(.text(before: filteredBefore, after: filteredAfter))
    }

    func recordFontSize(key: String, before: Int, after: Int) {
        guard !isApplyingHistory else { return }
        guard !key.isEmpty, before != after else { return }
        pushUndo(.fontSize(key: key, before: before, after: after))
    }

    func recordFieldColor(key: String, before: String, after: String) {
        guard !isApplyingHistory else { return }
        let oldHex = before.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let newHex = after.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !key.isEmpty, oldHex != newHex else { return }
        pushUndo(.fieldColor(key: key, before: before, after: after))
    }

    func recordButtonColor(key: String, before: String, after: String) {
        guard !isApplyingHistory else { return }
        let oldHex = before.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let newHex = after.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !key.isEmpty, oldHex != newHex else { return }
        pushUndo(.buttonColor(key: key, before: before, after: after))
    }

    func recordSurfaceColor(key: String, before: String, after: String) {
        guard !isApplyingHistory else { return }
        let oldHex = before.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let newHex = after.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !key.isEmpty, oldHex != newHex else { return }
        pushUndo(.surfaceColor(key: key, before: before, after: after))
    }

    func popUndo() -> QuickEditHistoryEntry? {
        guard let entry = undoStack.popLast() else { return nil }
        redoStack.append(entry)
        refreshFlags()
        return entry
    }

    func popRedo() -> QuickEditHistoryEntry? {
        guard let entry = redoStack.popLast() else { return nil }
        undoStack.append(entry)
        refreshFlags()
        return entry
    }

    func beginApplyingHistory() {
        isApplyingHistory = true
    }

    func endApplyingHistory() {
        isApplyingHistory = false
    }

    private func pushUndo(_ entry: QuickEditHistoryEntry) {
        undoStack.append(entry)
        if undoStack.count > maxEntries {
            undoStack.removeFirst(undoStack.count - maxEntries)
        }
        redoStack.removeAll()
        refreshFlags()
    }

    private func refreshFlags() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
    }
}
