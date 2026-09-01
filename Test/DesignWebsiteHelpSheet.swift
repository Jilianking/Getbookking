//
//  DesignWebsiteHelpSheet.swift
//
//  Single-sheet Website Builder help (?). Not a click-through tour.
//

import SwiftUI

enum DesignWebsiteHelpStore {
    static let seenKey = "designWebsiteHelpSheetSeen"
}

struct DesignWebsiteHelpSheet: View {
    var onDone: () -> Void

    private let lines: [String] = [
        "Turn **Edit** on.",
        "Tap a line to select it, then type to change the words.",
        "Tap **Text** to change color; tap **− / +** to change size. If the toolbar is hidden, tap **⌃** to show it.",
        "Tap **Background**, then tap a section to paint it — one card's color won't spread to the rest of the page.",
        "Tap a button's label to edit its words; tap around the label to change its fill.",
        "Tap a **photo** or a **service** to change it.",
        "Tap **Manage** to add more items, or edit hours and pages.",
        "Turn **Edit** off when you're done.",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(.init(line))
                            .font(.body)
                            .foregroundStyle(AppDesign.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Edit your site")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                        .fontWeight(.semibold)
                        .foregroundStyle(AppDesign.textPrimary)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
