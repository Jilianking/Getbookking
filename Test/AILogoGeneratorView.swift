//
//  AILogoGeneratorView.swift
//
//  Dedicated page under drawer for AI logo generation.
//

import SwiftUI

struct AILogoGeneratorView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = AILogoGeneratorViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Generate logo concepts with AI. Save any image to Photos and use it however you want.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    if viewModel.displayName.isEmpty && !authViewModel.isDemoMode {
                        contentUnavailable
                    } else {
                        contentBody
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }

    private var contentUnavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No business connected")
                .font(.headline)
            Text("Sign up or link your business to generate logos.")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal)
    }

    private var contentBody: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Preview / empty state
            Group {
                if let image = viewModel.generatedImage {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Generated logo")
                            .font(.headline)

                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 220, height: 220)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16)
                                    .strokeBorder(Color(.separator), lineWidth: 0.5)
                            )

                        HStack(spacing: 12) {
                            Button {
                                viewModel.saveGeneratedImageToPhotos()
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "square.and.arrow.down")
                                    Text("Save to Photos")
                                }
                                .font(.caption.weight(.medium))
                            }
                            .disabled(viewModel.isGeneratingAILogo)

                            Button(role: .destructive) {
                                viewModel.clearGeneratedImage()
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "trash")
                                    Text("Clear")
                                }
                                .font(.caption.weight(.medium))
                            }
                            .disabled(viewModel.isGeneratingAILogo)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Generated logo")
                            .font(.headline)
                        Text("Type a prompt below, then tap Generate logo.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Color(.secondarySystemGroupedBackground))
                            .frame(width: 220, height: 220)
                            .overlay(
                                Image(systemName: "sparkles")
                                    .font(.title2)
                                    .foregroundColor(.secondary)
                            )
                    }
                }
            }

            Divider()

            Toggle("Prefer white background", isOn: $viewModel.preferWhiteBackground)

            Text("Describe your logo")
                .font(.headline)
            Text("Example: \"A crown above the letter K, gold and navy, modern and clean\"")
                .font(.caption)
                .foregroundColor(.secondary)

            TextEditor(text: $viewModel.aiLogoPrompt)
                .frame(minHeight: 90)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(Color(.separator), lineWidth: 0.5)
                )

            if let err = viewModel.errorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
            if let ok = viewModel.saveSuccessMessage {
                Text(ok)
                    .font(.caption)
                    .foregroundColor(.green)
            }

            Button {
                Task { await viewModel.generateAILogo() }
            } label: {
                HStack(spacing: 8) {
                    if viewModel.isGeneratingAILogo {
                        ProgressView().tint(.white)
                    }
                    Image(systemName: "sparkles")
                    Text(viewModel.isGeneratingAILogo ? "Generating..." : "Generate logo")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                viewModel.isGeneratingAILogo ||
                viewModel.aiLogoPrompt.trimmingCharacters(in: .whitespacesAndNewlines).count < 3
            )

            if viewModel.isGeneratingAILogo {
                Text("This may take up to 30 seconds.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal)
    }
}
