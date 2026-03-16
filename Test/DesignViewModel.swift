//
//  DesignViewModel.swift
//
//  Web page design: branding, form fields, services, contact.
//

import Foundation
import Combine
import FirebaseAuth

enum DesignTab: String, CaseIterable {
    case home
    case gallery
    case book
    case about
}

struct GalleryCategory: Identifiable, Equatable {
    var id: String
    var name: String
    var images: [String]

    init(id: String = UUID().uuidString, name: String = "", images: [String] = []) {
        self.id = id
        self.name = name
        self.images = images
    }

    func toFirestore() -> [String: Any] {
        return ["name": name, "images": images]
    }

    static func fromFirestore(_ data: [String: Any]) -> GalleryCategory? {
        guard let name = data["name"] as? String else { return nil }
        let images = data["images"] as? [String] ?? []
        return GalleryCategory(name: name, images: images)
    }
}

class DesignViewModel: ObservableObject {
    @Published var tenantId: String?
    @Published var tenantSlug: String?
    @Published var bookingUrl: String = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false

    // Home: appearance + hero + featured work
    @Published var displayName: String = ""
    @Published var logoUrl: String = ""
    @Published var isUploadingLogo = false
    @Published var heroImageUrl: String = ""
    @Published var isUploadingHero = false
    @Published var galleryImages: [String] = []
    @Published var isUploadingGallery = false
    @Published var galleryGridLayout: String = "3x1"
    @Published var backgroundColorHex: String = "#FFFFFF"
    @Published var cardSurfaceColorHex: String = "#F5F5F5"
    @Published var textColorHex: String = "#333333"
    @Published var primaryColorHex: String = "#000000"
    @Published var primaryColorHoverHex: String = "#333333"
    @Published var successColorHex: String = "#22C55E"
    @Published var fontFamily: String = "system"
    @Published var fontBodySize: String = "medium"
    @Published var cardBorderRadius: Double = 12
    @Published var tagline: String = ""
    @Published var backgroundPattern: String = ""
    @Published var backgroundPatternColorHex: String = "#333333"
    @Published var backgroundPatternOpacity: Double = 0.15

    // Form fields
    @Published var formFields: [FormField] = []

    // Services
    @Published var services: [TenantService] = []

    // Template / industry
    @Published var industry: String?

    // Sidebar appearance (empty = auto-detect: black on white bg, white on colored bg)
    @Published var sidebarIconColorHome: String = ""
    @Published var sidebarIconColorBooking: String = ""

    // Gallery page categories
    @Published var galleryCategories: [GalleryCategory] = []
    @Published var isUploadingCategoryImage = false

    // About: about text + contact
    @Published var aboutText: String = ""
    @Published var contactPhone: String = ""
    @Published var contactEmail: String = ""
    @Published var contactAddress: String = ""
    @Published var businessHours: String = ""
    @Published var instagramHandle: String = ""
    @Published var showContactOnPage: Bool = true

    private let firebaseService = FirebaseService()
    private let hostingBase = "https://test-app-96812.web.app"

    var hasTenant: Bool { tenantId != nil }

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run {
                tenantId = nil
                tenantSlug = nil
                bookingUrl = ""
                formFields = FormField.defaultFields
                services = []
                industry = nil
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
            guard let tid = profile?.tenantId, let slug = profile?.tenantSlug ?? profile?.tenantId else {
                await MainActor.run {
                    tenantId = nil
                    tenantSlug = nil
                    bookingUrl = ""
                    formFields = FormField.defaultFields
                    services = []
                    industry = nil
                    isLoading = false
                }
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let svc = try await firebaseService.fetchTenantServices(tenantId: tid)
            await MainActor.run {
                tenantId = tid
                tenantSlug = slug
                bookingUrl = "\(hostingBase)/\(slug)"
                displayName = tenant?["displayName"] as? String ?? ""
                logoUrl = tenant?["logoUrl"] as? String ?? ""
                heroImageUrl = tenant?["heroImageUrl"] as? String ?? ""
                galleryImages = tenant?["galleryImages"] as? [String] ?? []
                galleryGridLayout = tenant?["galleryGridLayout"] as? String ?? "3x1"
                backgroundColorHex = tenant?["backgroundColor"] as? String ?? "#FFFFFF"
                cardSurfaceColorHex = tenant?["cardSurfaceColor"] as? String ?? "#F5F5F5"
                textColorHex = tenant?["textColor"] as? String ?? "#333333"
                primaryColorHex = tenant?["primaryColor"] as? String ?? "#000000"
                primaryColorHoverHex = tenant?["primaryColorHover"] as? String ?? "#333333"
                successColorHex = tenant?["successColor"] as? String ?? "#22C55E"
                fontFamily = tenant?["fontFamily"] as? String ?? "system"
                fontBodySize = tenant?["fontBodySize"] as? String ?? "medium"
                cardBorderRadius = (tenant?["cardBorderRadius"] as? Double) ?? 12
                tagline = tenant?["tagline"] as? String ?? ""
                backgroundPattern = tenant?["backgroundPattern"] as? String ?? ""
                backgroundPatternColorHex = tenant?["backgroundPatternColor"] as? String ?? "#333333"
                backgroundPatternOpacity = tenant?["backgroundPatternOpacity"] as? Double ?? 0.15
                if let schema = tenant?["formSchema"] as? [[String: Any]] {
                    formFields = schema.compactMap { FormField.fromFirestore($0) }
                    if formFields.isEmpty { formFields = FormField.defaultFields }
                } else {
                    formFields = FormField.defaultFields
                }
                services = svc
                aboutText = tenant?["aboutText"] as? String ?? ""
                contactPhone = tenant?["contactPhone"] as? String ?? ""
                contactEmail = tenant?["contactEmail"] as? String ?? ""
                contactAddress = (tenant?["address"] as? String) ?? (tenant?["contactAddress"] as? String) ?? ""
                businessHours = tenant?["businessHours"] as? String ?? ""
                instagramHandle = tenant?["instagramHandle"] as? String ?? ""
                showContactOnPage = tenant?["showContactOnPage"] as? Bool ?? true
                industry = tenant?["industry"] as? String
                sidebarIconColorHome = tenant?["sidebarIconColorHome"] as? String ?? ""
                sidebarIconColorBooking = tenant?["sidebarIconColorBooking"] as? String ?? ""
                if let catArray = tenant?["galleryCategories"] as? [[String: Any]] {
                    galleryCategories = catArray.compactMap { GalleryCategory.fromFirestore($0) }
                } else {
                    galleryCategories = []
                }
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func saveHome() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "displayName": displayName,
            "logoUrl": logoUrl,
            "heroImageUrl": heroImageUrl,
            "galleryImages": galleryImages,
            "galleryGridLayout": galleryGridLayout,
            "backgroundColor": backgroundColorHex,
            "cardSurfaceColor": cardSurfaceColorHex,
            "textColor": textColorHex,
            "primaryColor": primaryColorHex,
            "primaryColorHover": primaryColorHoverHex,
            "successColor": successColorHex,
            "fontFamily": fontFamily,
            "fontBodySize": fontBodySize,
            "cardBorderRadius": cardBorderRadius,
            "tagline": tagline,
            "backgroundPattern": backgroundPattern,
            "backgroundPatternColor": backgroundPatternColorHex,
            "backgroundPatternOpacity": backgroundPatternOpacity,
            "sidebarIconColorHome": sidebarIconColorHome,
            "sidebarIconColorBooking": sidebarIconColorBooking
        ]
        await saveTenantUpdates(tid, updates)
    }

    func saveAbout() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "aboutText": aboutText,
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "contactAddress": contactAddress,
            "address": contactAddress,
            "businessHours": businessHours,
            "instagramHandle": instagramHandle,
            "showContactOnPage": showContactOnPage
        ]
        await saveTenantUpdates(tid, updates)
    }

    func uploadLogo(imageData: Data) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingLogo = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantLogo(tenantId: tid, imageData: imageData)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["logoUrl": url])
            await MainActor.run {
                logoUrl = url
                isUploadingLogo = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingLogo = false
            }
        }
    }

    func uploadHeroImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingHero = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantHeroImage(tenantId: tid, imageData: imageData)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["heroImageUrl": url])
            await MainActor.run {
                heroImageUrl = url
                isUploadingHero = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingHero = false
            }
        }
    }

    func addGalleryImage(imageData: Data) async {
        guard let tid = tenantId else { return }
        await MainActor.run { isUploadingGallery = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            var updated = galleryImages
            updated.append(url)
            try await firebaseService.updateTenant(tenantId: tid, updates: ["galleryImages": updated])
            await MainActor.run {
                galleryImages = updated
                isUploadingGallery = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingGallery = false
            }
        }
    }

    func removeGalleryImage(at index: Int) async {
        guard let tid = tenantId else { return }
        guard index >= 0, index < galleryImages.count else { return }
        var updated = galleryImages
        updated.remove(at: index)
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: ["galleryImages": updated])
            await MainActor.run { galleryImages = updated }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func saveGallery() async {
        guard let tid = tenantId else { return }
        let catData = galleryCategories.map { $0.toFirestore() }
        await saveTenantUpdates(tid, ["galleryCategories": catData])
    }

    func addGalleryCategory() {
        galleryCategories.append(GalleryCategory(name: "New Category"))
    }

    func removeGalleryCategory(at index: Int) {
        guard index >= 0, index < galleryCategories.count else { return }
        galleryCategories.remove(at: index)
    }

    func addCategoryImage(categoryIndex: Int, imageData: Data) async {
        guard let tid = tenantId, categoryIndex >= 0, categoryIndex < galleryCategories.count else { return }
        await MainActor.run { isUploadingCategoryImage = true; errorMessage = nil }
        do {
            let url = try await firebaseService.uploadTenantGalleryImage(tenantId: tid, imageData: imageData)
            await MainActor.run {
                galleryCategories[categoryIndex].images.append(url)
                isUploadingCategoryImage = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isUploadingCategoryImage = false
            }
        }
    }

    func removeCategoryImage(categoryIndex: Int, imageIndex: Int) {
        guard categoryIndex >= 0, categoryIndex < galleryCategories.count else { return }
        guard imageIndex >= 0, imageIndex < galleryCategories[categoryIndex].images.count else { return }
        galleryCategories[categoryIndex].images.remove(at: imageIndex)
    }

    func saveFormFields() async {
        guard let tid = tenantId else { return }
        let schema = formFields.map { $0.toFirestore() }
        await saveTenantUpdates(tid, ["formSchema": schema])
    }

    func saveContact() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "contactPhone": contactPhone,
            "contactEmail": contactEmail,
            "contactAddress": contactAddress,
            "showContactOnPage": showContactOnPage
        ]
        await saveTenantUpdates(tid, updates)
    }

    private func saveTenantUpdates(_ tid: String, _ updates: [String: Any]) async {
        await MainActor.run { errorMessage = nil; saveSuccess = false }
        do {
            try await firebaseService.updateTenant(tenantId: tid, updates: updates)
            await MainActor.run {
                saveSuccess = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    saveSuccess = false
                }
            }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func addService(name: String, durationMinutes: Int) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        do {
            _ = try await firebaseService.createTenantService(tenantId: tid, name: name, durationMinutes: durationMinutes)
            await loadData()
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func deleteService(_ service: TenantService) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        do {
            try await firebaseService.deleteTenantService(tenantId: tid, serviceId: service.id)
            await MainActor.run { services.removeAll { $0.id == service.id } }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }

    func addFormField() {
        formFields.append(FormField(key: "field_\(formFields.count + 1)", label: "New field", type: .text, required: false))
    }

    func removeFormField(_ field: FormField) {
        formFields.removeAll { $0.id == field.id }
    }


    func applyTemplate(_ template: BookingTemplate) async {
        guard let tid = tenantId else { return }
        await MainActor.run { errorMessage = nil }
        do {
            formFields = template.formFields
            let schema = formFields.map { $0.toFirestore() }

            for svc in services {
                try await firebaseService.deleteTenantService(tenantId: tid, serviceId: svc.id)
            }
            services = []

            for item in template.defaultServices {
                _ = try await firebaseService.createTenantService(tenantId: tid, name: item.name, durationMinutes: item.durationMinutes)
            }

            try await firebaseService.updateTenant(tenantId: tid, updates: [
                "formSchema": schema,
                "industry": template.rawValue,
            ])

            await loadData()
            await MainActor.run { saveSuccess = true }
            Task { @MainActor in try? await Task.sleep(nanoseconds: 2_000_000_000); saveSuccess = false }
        } catch {
            await MainActor.run { errorMessage = error.localizedDescription }
        }
    }
}

extension FormField {
    static let defaultFields: [FormField] = [
        FormField(id: "name", key: "name", label: "Full Name", type: .text, required: true),
        FormField(id: "email", key: "email", label: "Email", type: .email, required: true),
        FormField(id: "phone", key: "phone", label: "Phone", type: .phone, required: true),
        FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false)
    ]
}
