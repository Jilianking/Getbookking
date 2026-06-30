//
//  TapToPayKeypad.swift
//

#if TAP_TO_PAY_ENABLED

import SwiftUI

struct TapToPayKeypad: View {
    let onDigit: (Int) -> Void
    let onDoubleZero: () -> Void
    let onDelete: () -> Void

    private let keySize: CGFloat = 72
    private let columnSpacing: CGFloat = 18
    private let rowSpacing: CGFloat = 14

    var body: some View {
        VStack(spacing: rowSpacing) {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: columnSpacing), count: 3),
                spacing: rowSpacing
            ) {
                ForEach(1...9, id: \.self) { digit in
                    keyButton(title: "\(digit)") { onDigit(digit) }
                }
                keyButton(title: "·") { onDoubleZero() }
                keyButton(title: "0") { onDigit(0) }
                keyButton(systemImage: "delete.backward.fill", accessibilityLabel: "Delete") { onDelete() }
            }
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.systemGray5))
        )
    }

    @ViewBuilder
    private func keyButton(
        title: String? = nil,
        systemImage: String? = nil,
        accessibilityLabel: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color(.systemBackground))
                    .shadow(color: Color.black.opacity(0.06), radius: 1, x: 0, y: 1)
                    .frame(width: keySize, height: keySize)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.title3.weight(.regular))
                        .foregroundStyle(AppDesign.textPrimary)
                } else if let title {
                    Text(title)
                        .font(.system(size: 32, weight: .regular, design: .rounded))
                        .foregroundStyle(AppDesign.textPrimary)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: keySize)
            .contentShape(Circle())
        }
        .buttonStyle(TapToPayKeypadButtonStyle())
        .accessibilityLabel(accessibilityLabel ?? title ?? "")
    }
}

private struct TapToPayKeypadButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

#endif
