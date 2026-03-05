//
//  DesignViewModel.swift
//
//  Web page design: branding, form fields, services, contact.
//

import Foundation
import Combine
import FirebaseAuth

enum DesignTab: String, CaseIterable {
    case template
    case branding
    case form
    case services
    case contact
}

class DesignViewModel: ObservableObject {
    @Published var tenantId: String?
    @Published var tenantSlug: String?
    @Published var bookingUrl: String = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var saveSuccess = false

    // Branding
    @Published var logoUrl: String = ""
    @Published var isUploadingLogo = false
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

    // Contact
    @Published var contactPhone: String = ""
    @Published var contactEmail: String = ""
    @Published var contactAddress: String = ""
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
                logoUrl = tenant?["logoUrl"] as? String ?? ""
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
                contactPhone = tenant?["contactPhone"] as? String ?? ""
                contactEmail = tenant?["contactEmail"] as? String ?? ""
                contactAddress = tenant?["contactAddress"] as? String ?? ""
                showContactOnPage = tenant?["showContactOnPage"] as? Bool ?? true
                industry = tenant?["industry"] as? String
                isLoading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }

    func saveBranding() async {
        guard let tid = tenantId else { return }
        let updates: [String: Any] = [
            "logoUrl": logoUrl,
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
            "backgroundPatternOpacity": backgroundPatternOpacity
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
