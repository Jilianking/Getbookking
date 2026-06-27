//
//  DemoPersonaPickerView.swift
//
//  Salon / gym demo selection after tapping Try a live demo on login.
//

import SwiftUI

struct DemoPersonaPickerView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var isStartingDemo = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Explore the full app with sample data. Nothing you do is saved.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)

                ForEach(DemoPersona.allCases) { persona in
                    Button {
                        startDemo(persona)
                    } label: {
                        DemoPersonaCard(persona: persona)
                    }
                    .buttonStyle(.plain)
                    .disabled(isStartingDemo)
                }
            }
            .padding(24)
        }
        .appScreenBackground()
        .navigationTitle("Try a live demo")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func startDemo(_ persona: DemoPersona) {
        isStartingDemo = true
        authViewModel.demoLogin(persona: persona)
        isStartingDemo = false
    }
}

private struct DemoPersonaCard: View {
    let persona: DemoPersona

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: persona.iconSystemName)
                .font(.title2)
                .foregroundStyle(AppDesign.linkAccent)
            Text(persona == .salon ? "Salon" : "Gym")
                .font(.headline)
                .foregroundStyle(AppDesign.textPrimary)
            Text(persona.businessName)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            Text(persona.subtitle)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(AppDesign.chipBorder, lineWidth: 1)
        )
    }
}
