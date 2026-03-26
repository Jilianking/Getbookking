//
//  AILogoGeneratorViewModel.swift
//
//  Dedicated AI logo generation page (OpenAI gpt-image-1).
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions
import UIKit

enum LogoQuickStyle: String, CaseIterable, Identifiable {
    case minimal
    case masculine
    case luxury
    case playful
    case iconOnly = "icon only"
    case wordmark

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

enum LogoLayoutStyle: String, CaseIterable, Identifiable {
    case iconAboveText = "Icon above text"
    case iconLeftText = "Icon left of text"
    case wordmarkOnly = "Wordmark only"

    var id: String { rawValue }
}

enum LogoIconTheme: String, CaseIterable, Identifiable {
    case barber
    case crown
    case floral
    case abstract
    case butterfly
    case tattooMachine = "tattoo machine"

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

class AILogoGeneratorViewModel: ObservableObject {
    @Published var displayName: String = ""
    @Published var aiLogoPrompt: String = ""
    @Published var generatedImage: UIImage?
    @Published var isLoading = false
    @Published var isGeneratingAILogo = false
    @Published var saveSuccessMessage: String?
    @Published var errorMessage: String?
    @Published var selectedQuickStyle: LogoQuickStyle = .minimal
    @Published var preferWhiteBackground = true
    @Published var avoidScriptFonts = true
    @Published var editableBusinessName: String = ""
    @Published var editableTagline: String = ""
    @Published var primaryColorName: String = "Black"
    @Published var secondaryColorName: String = "Gold"
    @Published var selectedLayoutStyle: LogoLayoutStyle = .iconAboveText
    @Published var selectedIconTheme: LogoIconTheme = .barber

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions()
    private var previousGeneratedImage: UIImage?

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run {
                displayName = ""
                generatedImage = nil
                isLoading = false
            }
            return
        }
        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                await MainActor.run {
                    displayName = ""
                    generatedImage = nil
                    isLoading = false
                }
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            await MainActor.run {
                displayName = tenant?["displayName"] as? String ?? ""
                editableBusinessName = displayName
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func generateAILogo() async {
        let prompt = composedPrompt().trimmingCharacters(in: .whitespacesAndNewlines)
        await requestGeneration(withPrompt: prompt)
    }

    func applyStructuredEdit() async {
        let prompt = structuredEditPrompt().trimmingCharacters(in: .whitespacesAndNewlines)
        await requestGeneration(withPrompt: prompt)
    }

    private func requestGeneration(withPrompt prompt: String) async {
        guard prompt.count >= 3 else {
            await MainActor.run { errorMessage = "Enter at least a few words describing your logo." }
            return
        }
        await MainActor.run { isGeneratingAILogo = true; errorMessage = nil }
        do {
            let result = try await functions.httpsCallable("generateTenantLogoWithOpenAI").call([
                "prompt": prompt,
                "businessName": displayName
            ])
            let dict = result.data as? [String: Any]
            let imageBase64 = dict?["imageBase64"] as? String ?? ""
            let imageData = Data(base64Encoded: imageBase64)
            let image = imageData.flatMap { UIImage(data: $0) }
            if image == nil {
                throw NSError(domain: "AILogoGenerator", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to decode generated image."])
            }
            await MainActor.run {
                if let current = generatedImage {
                    previousGeneratedImage = current
                }
                generatedImage = image
                isGeneratingAILogo = false
                saveSuccessMessage = nil
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isGeneratingAILogo = false
            }
        }
    }

    func clearGeneratedImage() {
        generatedImage = nil
        saveSuccessMessage = nil
        previousGeneratedImage = nil
    }

    func saveGeneratedImageToPhotos() {
        guard let image = generatedImage else { return }
        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        saveSuccessMessage = "Saved to Photos."
    }

    func applyQuickPrompt(_ text: String) {
        aiLogoPrompt = text
    }

    func undoLastEdit() {
        guard let prev = previousGeneratedImage else { return }
        generatedImage = prev
        previousGeneratedImage = nil
    }

    var canUndo: Bool { previousGeneratedImage != nil }

    private func composedPrompt() -> String {
        let typed = aiLogoPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return "" }

        var parts: [String] = [typed]
        if preferWhiteBackground {
            parts.append("Use a clean white background behind the logo.")
        }
        parts.append("Make it high contrast and legible at small sizes.")
        return parts.joined(separator: " ")
    }

    private func structuredEditPrompt() -> String {
        var parts: [String] = []
        let brand = editableBusinessName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !brand.isEmpty {
            parts.append("Set the brand name text to \"\(brand)\".")
        }
        let tagline = editableTagline.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tagline.isEmpty {
            parts.append("Add tagline text: \"\(tagline)\".")
        } else {
            parts.append("No tagline.")
        }
        parts.append("Primary color: \(primaryColorName). Secondary color: \(secondaryColorName).")
        parts.append("Layout: \(selectedLayoutStyle.rawValue).")
        parts.append("Icon theme: \(selectedIconTheme.rawValue).")
        if preferWhiteBackground {
            parts.append("Use a clean white background behind the logo.")
        }
        parts.append("Keep it professional, high contrast, and legible at small sizes.")
        return parts.joined(separator: " ")
    }
}
