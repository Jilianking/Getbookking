//
//  FirebaseService.swift
//  Test
//
//  Firebase Firestore operations for bookings, tenants, and legacy collections.
//

import Foundation
import Combine
import UIKit
import FirebaseFirestore
import FirebaseStorage

class FirebaseService: ObservableObject {
    @Published var bookings: [Booking] = []
    @Published var services: [Service] = []
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let db = Firestore.firestore()
    private var bookingsListener: ListenerRegistration?

    // MARK: - Fetch Services (legacy)
    func fetchServices() async {
        await MainActor.run { isLoading = true }
        do {
            let snapshot = try await db.collection("services").getDocuments()
            let fetchedServices = snapshot.documents.compactMap { doc -> Service? in
                let data = doc.data()
                return Service(
                    id: doc.documentID,
                    name: data["name"] as? String ?? "",
                    description: data["description"] as? String,
                    price: data["price"] as? Double,
                    duration: data["duration"] as? Int
                )
            }
            await MainActor.run {
                self.services = fetchedServices
                self.isLoading = false
            }
        } catch {
            await MainActor.run {
                self.errorMessage = "Failed to fetch services: \(error.localizedDescription)"
                self.isLoading = false
            }
        }
    }

    // MARK: - Create Booking
    func createBooking(_ booking: Booking) async throws -> String {
        let bookingData: [String: Any] = [
            "name": booking.name,
            "email": booking.email,
            "phone": booking.phone,
            "service": booking.service,
            "date": booking.date,
            "timeSlot": booking.timeSlot ?? "",
            "promoCode": booking.promoCode ?? "",
            "status": booking.status.rawValue,
            "createdAt": Timestamp(date: Date()),
            "notes": booking.notes ?? ""
        ]
        let docRef = try await db.collection("bookings").addDocument(data: bookingData)
        return docRef.documentID
    }

    // MARK: - Fetch Available Time Slots
    func fetchAvailableTimeSlots(for date: Date) async throws -> [String] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!
        let startTimestamp = Timestamp(date: startOfDay)
        let endTimestamp = Timestamp(date: endOfDay)

        let snapshot = try await db.collection("bookings")
            .whereField("date", isGreaterThanOrEqualTo: startTimestamp)
            .whereField("date", isLessThan: endTimestamp)
            .whereField("status", in: ["pending", "approved"])
            .getDocuments()

        let bookedSlots = snapshot.documents.compactMap { doc -> String? in
            doc.data()["timeSlot"] as? String
        }
        let allSlots = generateTimeSlots()
        return allSlots.filter { !bookedSlots.contains($0) }
    }

    private func generateTimeSlots() -> [String] {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        var slots: [String] = []
        let calendar = Calendar.current
        var date = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date())!
        while calendar.component(.hour, from: date) < 18 {
            slots.append(formatter.string(from: date))
            if let nextDate = calendar.date(byAdding: .hour, value: 1, to: date) {
                date = nextDate
            } else { break }
        }
        return slots
    }

    // MARK: - Validate Promo Code
    func validatePromoCode(_ code: String) async throws -> PromoCode? {
        let snapshot = try await db.collection("promoCodes")
            .whereField("code", isEqualTo: code.uppercased())
            .whereField("isActive", isEqualTo: true)
            .limit(to: 1)
            .getDocuments()
        guard let doc = snapshot.documents.first else { return nil }
        let data = doc.data()
        guard let codeString = data["code"] as? String,
              let discount = data["discount"] as? Double,
              let isActive = data["isActive"] as? Bool else { return nil }
        return PromoCode(
            id: doc.documentID,
            code: codeString,
            discount: discount,
            isActive: isActive,
            validUntil: data["validUntil"] as? Timestamp
        )
    }

    // MARK: - Fetch Requests (legacy)
    func fetchRequests() async throws -> [Request] {
        let snapshot = try await db.collection("requests").getDocuments()
        return snapshot.documents.compactMap { doc -> Request? in
            var data = firestoreDictToJSONCompatible(doc.data())
            data["id"] = doc.documentID
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            guard var request = try? decoder.decode(Request.self, from: jsonData) else { return nil }
            request.id = doc.documentID
            return request
        }
    }

    func updateRequest(_ requestId: String, updates: [String: Any]) async throws {
        var firestoreUpdates = updates
        if let reviewedAt = firestoreUpdates["reviewedAt"] as? Date {
            firestoreUpdates["reviewedAt"] = Timestamp(date: reviewedAt)
        }
        try await db.collection("requests").document(requestId).updateData(firestoreUpdates)
    }

    func deleteRequest(_ requestId: String) async throws {
        try await db.collection("requests").document(requestId).delete()
    }

    // MARK: - Fetch Clients (legacy)
    func fetchClients() async throws -> [Client] {
        let snapshot = try await db.collection("clients").getDocuments()
        return snapshot.documents.compactMap { doc -> Client? in
            var data = firestoreDictToJSONCompatible(doc.data())
            data["id"] = doc.documentID
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            guard var client = try? decoder.decode(Client.self, from: jsonData) else { return nil }
            client.id = doc.documentID
            return client
        }
    }

    func createClient(_ client: Client) async throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(client)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode client"])
        }
        let docRef = try await db.collection("clients").addDocument(data: dict)
        return docRef.documentID
    }

    func updateClient(_ clientId: String, updates: [String: Any]) async throws {
        var data = updates
        for key in ["createdAt", "lastContact", "updatedAt"] {
            if let date = data[key] as? Date { data[key] = Timestamp(date: date) }
        }
        try await db.collection("clients").document(clientId).updateData(data)
    }

    // MARK: - Fetch Events
    func fetchEvents(startDate: Date, endDate: Date) async throws -> [Event] {
        let startTimestamp = Timestamp(date: startDate)
        let endTimestamp = Timestamp(date: endDate)
        let snapshot = try await db.collection("events")
            .whereField("start", isGreaterThanOrEqualTo: startTimestamp)
            .whereField("start", isLessThan: endTimestamp)
            .getDocuments()
        return snapshot.documents.compactMap { doc -> Event? in
            var data = firestoreDictToJSONCompatible(doc.data())
            data["id"] = doc.documentID
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            guard var event = try? decoder.decode(Event.self, from: jsonData) else { return nil }
            event.id = doc.documentID
            return event
        }
    }

    func createEvent(_ event: Event) async throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(event)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode event"])
        }
        let docRef = try await db.collection("events").addDocument(data: dict)
        return docRef.documentID
    }

    // MARK: - Messages
    func fetchAllThreads() async throws -> [String] {
        let snapshot = try await db.collection("messages").getDocuments()
        let threadIds = Set(snapshot.documents.compactMap { doc -> String? in
            doc.data()["threadId"] as? String
        })
        return Array(threadIds)
    }

    func fetchMessages(threadId: String) async throws -> [Message] {
        let snapshot = try await db.collection("messages")
            .whereField("threadId", isEqualTo: threadId)
            .order(by: "createdAt", descending: false)
            .getDocuments()
        return snapshot.documents.compactMap { doc -> Message? in
            var data = firestoreDictToJSONCompatible(doc.data())
            data["id"] = doc.documentID
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            guard var message = try? decoder.decode(Message.self, from: jsonData) else { return nil }
            message.id = doc.documentID
            return message
        }
    }

    func sendMessage(_ message: Message) async throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(message)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode message"])
        }
        _ = try await db.collection("messages").addDocument(data: dict)
    }

    // MARK: - Tenant / Multi-tenant
    func slug(from business: String) -> String {
        business.lowercased()
            .components(separatedBy: .alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined()
    }

    func fetchTenantSlug(tenantId: String) async throws -> String? {
        let doc = try await db.collection("tenants").document(tenantId).getDocument()
        return doc.data()?["slug"] as? String
    }

    func fetchTenant(tenantId: String) async throws -> [String: Any]? {
        let doc = try await db.collection("tenants").document(tenantId).getDocument()
        return doc.data()
    }

    func fetchTenantStripeAccountId(tenantId: String) async throws -> String? {
        let doc = try await db.collection("tenants").document(tenantId).getDocument()
        return doc.data()?["stripeAccountId"] as? String
    }

    func fetchTenantBookingRequests(tenantId: String) async throws -> [BookingRequest] {
        let snapshot = try await db.collection("tenants").document(tenantId)
            .collection("bookingRequests")
            .order(by: "createdAt", descending: true)
            .getDocuments()
        return snapshot.documents.compactMap { doc -> BookingRequest? in
            let d = doc.data()
            return BookingRequest(
                documentId: doc.documentID,
                status: d["status"] as? String ?? "NEW",
                source: d["source"] as? String,
                serviceId: d["serviceId"] as? String,
                serviceSlug: d["serviceSlug"] as? String,
                serviceName: d["serviceName"] as? String,
                tenantId: d["tenantId"] as? String,
                customerId: d["customerId"] as? String,
                customerName: d["customerName"] as? String,
                customerPhone: d["customerPhone"] as? String,
                customerEmail: d["customerEmail"] as? String,
                bookingModeUsed: d["bookingModeUsed"] as? String,
                preferredDays: d["preferredDays"] as? [String],
                preferredTime: d["preferredTime"] as? String,
                requestedStartTime: (d["requestedStartTime"] as? Timestamp)?.dateValue(),
                notes: d["notes"] as? String,
                formResponses: d["formResponses"] as? [String: Any],
                createdAt: (d["createdAt"] as? Timestamp)?.dateValue(),
                readAt: (d["readAt"] as? Timestamp)?.dateValue()
            )
        }
    }

    func updateTenantBookingRequest(tenantId: String, requestId: String, updates: [String: Any]) async throws {
        var firestoreUpdates = updates
        if let reviewedAt = firestoreUpdates["reviewedAt"] as? Date {
            firestoreUpdates["reviewedAt"] = Timestamp(date: reviewedAt)
        }
        if let readAt = firestoreUpdates["readAt"] as? Date {
            firestoreUpdates["readAt"] = Timestamp(date: readAt)
        }
        try await db.collection("tenants").document(tenantId)
            .collection("bookingRequests").document(requestId)
            .setData(firestoreUpdates, merge: true)
    }

    func createTenantBookingRequest(tenantId: String, customerName: String, customerEmail: String, customerPhone: String?, serviceId: String?, serviceSlug: String?, serviceName: String?, preferredTime: String?, requestedStartTime: Date?, notes: String?, formResponses: [String: Any]?) async throws -> String {
        var data: [String: Any] = [
            "status": "NEW",
            "source": "admin_app",
            "tenantId": tenantId,
            "customerName": customerName,
            "customerEmail": customerEmail,
            "createdAt": Timestamp(date: Date())
        ]
        if let phone = customerPhone, !phone.isEmpty { data["customerPhone"] = phone }
        if let sid = serviceId { data["serviceId"] = sid }
        if let slug = serviceSlug { data["serviceSlug"] = slug }
        if let name = serviceName { data["serviceName"] = name }
        if let pt = preferredTime, !pt.isEmpty { data["preferredTime"] = pt }
        if let start = requestedStartTime { data["requestedStartTime"] = Timestamp(date: start) }
        if let n = notes, !n.isEmpty { data["notes"] = n }
        if let fr = formResponses { data["formResponses"] = fr }
        let ref = try await db.collection("tenants").document(tenantId)
            .collection("bookingRequests")
            .addDocument(data: data)
        return ref.documentID
    }

    func fetchTenantCustomers(tenantId: String) async throws -> [Client] {
        let snapshot = try await db.collection("tenants").document(tenantId)
            .collection("customers")
            .getDocuments()
        return snapshot.documents.compactMap { doc -> Client? in
            let d = doc.data()
            guard let name = d["name"] as? String else { return nil }
            let email = d["email"] as? String ?? ""
            let updatedAt = (d["updatedAt"] as? Timestamp)?.dateValue()
            return Client(
                id: doc.documentID,
                name: name,
                email: email,
                phone: d["phone"] as? String,
                createdAt: updatedAt ?? Date(),
                lastContact: updatedAt,
                totalAppointments: 0,
                notes: nil,
                preferences: nil
            )
        }
    }

    func upsertTenantCustomer(tenantId: String, customerId: String, name: String, email: String, phone: String?) async throws {
        var data: [String: Any] = [
            "name": name,
            "email": email,
            "updatedAt": Timestamp(date: Date())
        ]
        if let p = phone { data["phone"] = p }
        try await db.collection("tenants").document(tenantId).collection("customers").document(customerId).setData(data, merge: true)
    }

    func updateTenantCustomer(tenantId: String, customerId: String, updates: [String: Any]) async throws {
        var data = updates
        data["updatedAt"] = Timestamp(date: Date())
        try await db.collection("tenants").document(tenantId).collection("customers").document(customerId).setData(data, merge: true)
    }

    // MARK: - Provider Profile
    func createProviderProfile(
        uid: String,
        email: String,
        name: String,
        firstName: String,
        lastName: String,
        business: String,
        industry: String,
        subscriptionPlan: String
    ) async throws {
        let slugValue = slug(from: business).isEmpty ? "business\(uid.prefix(8))" : slug(from: business)
        let indNorm = industry.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedIndustry = industry.trimmingCharacters(in: .whitespacesAndNewlines)
        let template = BookingTemplate(rawValue: indNorm) ?? BookingTemplate(rawValue: trimmedIndustry) ?? .custom

        let tenantId = try await createTenant(
            displayName: business,
            slug: slugValue,
            industry: template.rawValue,
            ownerUid: uid,
            subscriptionPlan: subscriptionPlan
        )

        // Apply booking template immediately so services/form fields are ready right after sign up.
        // (Settings → "Save and apply to website" should no longer be required for initial setup.)
        let schema = template.formFields.map { $0.toFirestore() }
        for (index, item) in template.defaultServices.enumerated() {
            _ = try await createTenantService(
                tenantId: tenantId,
                name: item.name,
                durationMinutes: item.durationMinutes,
                sortOrder: index
            )
        }
        let webThemeId = WebTheme.defaultTheme(forIndustry: template.rawValue).rawValue
        try await updateTenant(tenantId: tenantId, updates: [
            "formSchema": schema,
            "industry": template.rawValue,
            "webThemeId": webThemeId
        ])

        let data: [String: Any] = [
            "tenantId": tenantId,
            "tenantSlug": slugValue,
            "email": email,
            "name": name,
            "firstName": firstName,
            "lastName": lastName,
            "profilePhotoUrl": "",
            "business": business,
            "industry": template.rawValue,
            "subscriptionPlan": subscriptionPlan,
            "subscriptionStatus": "active",
            "availability": [
                "timeSlots": [["open": 9, "close": 18, "type": "open_booking"]],
                "daysOpen": ProviderAvailability.default.daysOpen,
                "timeZone": ProviderAvailability.default.timeZone
            ],
            "workflow": [
                "confirmationType": ProviderWorkflow.default.confirmationType.rawValue,
                "responseTimeHours": ProviderWorkflow.default.responseTimeHours
            ],
            "createdAt": Timestamp(date: Date())
        ]
        try await db.collection("users").document(uid).setData(data)
    }

    func fetchProviderProfile(uid: String) async throws -> ProviderProfile? {
        let doc = try await db.collection("users").document(uid).getDocument()
        guard doc.exists, let data = doc.data() else { return nil }
        return parseProviderProfile(data: data)
    }

    func updateProviderProfile(uid: String, updates: [String: Any]) async throws {
        try await db.collection("users").document(uid).setData(updates, merge: true)
    }

    // MARK: - Tenant design (branding, services)
    func updateTenant(tenantId: String, updates: [String: Any]) async throws {
        try await db.collection("tenants").document(tenantId).setData(updates, merge: true)
    }

    func fetchTenantServices(tenantId: String) async throws -> [TenantService] {
        let snapshot = try await db.collection("tenants").document(tenantId).collection("services").getDocuments()
        let mapped = snapshot.documents.compactMap { doc -> TenantService? in
            let d = doc.data()
            guard let slug = d["slug"] as? String, let name = d["name"] as? String else { return nil }
            let rawPrice = d["price"]
            let price: Double? = {
                if let x = rawPrice as? Double, x > 0 { return x }
                if let x = rawPrice as? Int, x > 0 { return Double(x) }
                return nil
            }()
            let rawDur = d["durationMinutes"]
            let durationParsed: Int? = {
                if let n = rawDur as? Int, n > 0 { return n }
                if let n = rawDur as? Double, n > 0 { return Int(n) }
                if let s = rawDur as? String, let v = Int(s.trimmingCharacters(in: .whitespaces)), v > 0 { return v }
                return nil
            }()
            return TenantService(
                id: doc.documentID,
                slug: slug,
                name: name,
                durationMinutes: durationParsed,
                description: d["description"] as? String,
                sortOrder: d["sortOrder"] as? Int ?? Int.max,
                price: price,
                isActive: d["isActive"] as? Bool ?? true,
                bookingModeOverride: d["bookingModeOverride"] as? String,
                formSchema: d["formSchema"] as? [[String: Any]]
            )
        }
        return mapped.sorted {
            if $0.sortOrder != $1.sortOrder { return $0.sortOrder < $1.sortOrder }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// Merge payload for name, slug, duration, optional description, optional starting price on Blade.
    func tenantServiceDisplayUpdates(
        name: String,
        slug: String,
        durationMinutes: Int?,
        description: String?,
        startingPrice: Double?
    ) -> [String: Any] {
        var u: [String: Any] = [
            "name": name,
            "slug": slug
        ]
        if let dm = durationMinutes, dm > 0 {
            u["durationMinutes"] = dm
        } else {
            u["durationMinutes"] = FieldValue.delete()
        }
        let desc = description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if desc.isEmpty {
            u["description"] = FieldValue.delete()
        } else {
            u["description"] = desc
        }
        if let p = startingPrice, p > 0 {
            u["price"] = p
        } else {
            u["price"] = FieldValue.delete()
        }
        return u
    }

    func createTenantService(
        tenantId: String,
        name: String,
        durationMinutes: Int?,
        slug: String? = nil,
        description: String? = nil,
        sortOrder: Int = 0,
        startingPrice: Double? = nil
    ) async throws -> String {
        let slugValue = slug ?? self.slug(from: name)
        var data: [String: Any] = [
            "slug": slugValue,
            "name": name,
            "isActive": true,
            "sortOrder": sortOrder
        ]
        if let dm = durationMinutes, dm > 0 {
            data["durationMinutes"] = dm
        }
        if let d = description?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty {
            data["description"] = d
        }
        if let p = startingPrice, p > 0 {
            data["price"] = p
        }
        let ref = try await db.collection("tenants").document(tenantId).collection("services").addDocument(data: data)
        return ref.documentID
    }

    func updateTenantService(tenantId: String, serviceId: String, updates: [String: Any]) async throws {
        try await db.collection("tenants").document(tenantId).collection("services").document(serviceId).setData(updates, merge: true)
    }

    func deleteTenantService(tenantId: String, serviceId: String) async throws {
        try await db.collection("tenants").document(tenantId).collection("services").document(serviceId).delete()
    }

    func uploadTenantLogo(tenantId: String, imageData: Data) async throws -> String {
        let storage = Storage.storage()
        let ref = storage.reference().child("tenants/\(tenantId)/logo.jpg")
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(imageData, maxLongEdge: 1024, compressionQuality: 0.88)
        _ = try await ref.putDataAsync(payload, metadata: metadata)
        let url = try await ref.downloadURL()
        return url.absoluteString
    }

    func deleteTenantLogoFile(tenantId: String) async throws {
        let ref = Storage.storage().reference().child("tenants/\(tenantId)/logo.jpg")
        try await ref.delete()
    }

    func uploadProviderProfilePhoto(uid: String, imageData: Data) async throws -> String {
        let storage = Storage.storage()
        let ref = storage.reference().child("users/\(uid)/profile.jpg")
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(imageData, maxLongEdge: 900, compressionQuality: 0.85)
        _ = try await ref.putDataAsync(payload, metadata: metadata)
        let url = try await ref.downloadURL()
        return url.absoluteString
    }

    func deleteProviderProfilePhotoFile(uid: String) async throws {
        let ref = Storage.storage().reference().child("users/\(uid)/profile.jpg")
        try await ref.delete()
    }

    // MARK: - Tenant Products
    func fetchTenantProducts(tenantId: String) async throws -> [Product] {
        let snapshot = try await db.collection("tenants").document(tenantId).collection("products").getDocuments()
        return snapshot.documents.compactMap { doc -> Product? in
            let d = doc.data()
            guard let name = d["name"] as? String else { return nil }
            return Product(
                id: doc.documentID,
                name: name,
                category: d["category"] as? String ?? "",
                description: d["description"] as? String ?? "",
                price: d["price"] as? Double ?? 0,
                salePrice: d["salePrice"] as? Double,
                imageUrl: d["imageUrl"] as? String ?? "",
                isActive: d["isActive"] as? Bool ?? true
            )
        }
    }

    func createTenantProduct(
        tenantId: String,
        name: String,
        category: String,
        description: String,
        price: Double,
        salePrice: Double?,
        imageUrl: String,
        isActive: Bool
    ) async throws -> String {
        var data: [String: Any] = [
            "name": name,
            "category": category,
            "price": price,
            "imageUrl": imageUrl,
            "isActive": isActive
        ]
        let desc = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !desc.isEmpty { data["description"] = desc }
        if let sp = salePrice { data["salePrice"] = sp }
        let ref = try await db.collection("tenants").document(tenantId).collection("products").addDocument(data: data)
        return ref.documentID
    }

    func deleteTenantProduct(tenantId: String, productId: String) async throws {
        try await db.collection("tenants").document(tenantId).collection("products").document(productId).delete()
    }

    func uploadProductImage(tenantId: String, imageData: Data) async throws -> String {
        let storage = Storage.storage()
        let name = UUID().uuidString + ".jpg"
        let ref = storage.reference().child("tenants/\(tenantId)/products/\(name)")
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(imageData, maxLongEdge: 1680, compressionQuality: 0.82)
        _ = try await ref.putDataAsync(payload, metadata: metadata)
        let url = try await ref.downloadURL()
        return url.absoluteString
    }

    func uploadTenantHeroImage(tenantId: String, imageData: Data) async throws -> String {
        let storage = Storage.storage()
        let ref = storage.reference().child("tenants/\(tenantId)/hero.jpg")
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(imageData, maxLongEdge: 2400, compressionQuality: 0.84)
        _ = try await ref.putDataAsync(payload, metadata: metadata)
        let url = try await ref.downloadURL()
        return url.absoluteString
    }

    func uploadTenantGalleryImage(tenantId: String, imageData: Data) async throws -> String {
        let storage = Storage.storage()
        let name = UUID().uuidString + ".jpg"
        let ref = storage.reference().child("tenants/\(tenantId)/gallery/\(name)")
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        let payload = ImageUploadPreprocessor.prepareJPEGForUpload(imageData, maxLongEdge: 1680, compressionQuality: 0.82)
        _ = try await ref.putDataAsync(payload, metadata: metadata)
        let url = try await ref.downloadURL()
        return url.absoluteString
    }

    private func createTenant(
        displayName: String,
        slug: String,
        industry: String,
        ownerUid: String,
        subscriptionPlan: String
    ) async throws -> String {
        let ref = db.collection("tenants").document()
        try await ref.setData([
            "slug": slug,
            "displayName": displayName,
            "industry": industry,
            "ownerUid": ownerUid,
            "subscriptionPlan": subscriptionPlan,
            "isActive": true,
            "bookingModeDefault": "request",
            "requireApprovalForSlotBookings": true,
            "maxBookingWindowDays": 30,
            "bufferMinutes": 15
        ])
        return ref.documentID
    }

    /// Convert Firestore Timestamp values to seconds since 1970 for JSON decoding
    private func firestoreDictToJSONCompatible(_ dict: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in dict {
            if let ts = value as? Timestamp {
                result[key] = ts.dateValue().timeIntervalSince1970
            } else if let arr = value as? [Any] {
                result[key] = arr.map { item -> Any in
                    if let ts = item as? Timestamp { return ts.dateValue().timeIntervalSince1970 }
                    return item
                }
            } else if let sub = value as? [String: Any] {
                result[key] = firestoreDictToJSONCompatible(sub)
            } else {
                result[key] = value
            }
        }
        return result
    }

    private func parseProviderProfile(data: [String: Any]) -> ProviderProfile? {
        guard let business = data["business"] as? String,
              let email = data["email"] as? String,
              let subscriptionPlan = data["subscriptionPlan"] as? String else { return nil }
        let firstName = (data["firstName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastName = (data["lastName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let fallbackName = (data["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let composedName = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespacesAndNewlines)
        let name = composedName.isEmpty ? fallbackName : composedName
        let industry = (data["industry"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "custom"
        let profilePhotoUrl = (data["profilePhotoUrl"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let subscriptionStatus = data["subscriptionStatus"] as? String ?? "active"
        let createdAt = (data["createdAt"] as? Timestamp)?.dateValue()

        var availability = ProviderAvailability.default
        if let avail = data["availability"] as? [String: Any] {
            if let slots = avail["timeSlots"] as? [[String: Any]], !slots.isEmpty {
                availability.timeSlots = slots.enumerated().map { i, s in
                    let typeRaw = s["type"] as? String ?? "open_booking"
                    let type = SlotType(rawValue: typeRaw) ?? .openBooking
                    return TimeSlot(
                        id: "\(i)",
                        open: s["open"] as? Int ?? 9,
                        close: s["close"] as? Int ?? 18,
                        type: type,
                        customLabel: s["customLabel"] as? String,
                        recurringDays: s["recurringDays"] as? [Int]
                    )
                }
            } else if let open = avail["openHour"] as? Int, let close = avail["closeHour"] as? Int {
                availability.timeSlots = [TimeSlot(open: open, close: close)]
            }
            availability.daysOpen = avail["daysOpen"] as? [Int] ?? availability.daysOpen
            availability.timeZone = avail["timeZone"] as? String ?? availability.timeZone
            availability.blockedDates = avail["blockedDates"] as? [String] ?? []
            availability.availableDates = avail["availableDates"] as? [String] ?? []
        }

        var workflow = ProviderWorkflow.default
        if let wf = data["workflow"] as? [String: Any] {
            if let typeRaw = wf["confirmationType"] as? String, let type = BookingConfirmationType(rawValue: typeRaw) {
                workflow.confirmationType = type
            } else if let modeRaw = wf["mode"] as? String {
                workflow.confirmationType = (modeRaw == "fixed_slots") ? .instantBook : .requestApprove
            }
            workflow.responseTimeHours = wf["responseTimeHours"] as? Int ?? workflow.responseTimeHours
            workflow.depositAmount = wf["depositAmount"] as? Double
        }

        let tenantId = data["tenantId"] as? String
        let tenantSlug = data["tenantSlug"] as? String

        return ProviderProfile(
            tenantId: tenantId,
            tenantSlug: tenantSlug,
            name: name,
            firstName: firstName,
            lastName: lastName,
            profilePhotoUrl: profilePhotoUrl,
            business: business,
            industry: industry,
            email: email,
            subscriptionPlan: subscriptionPlan,
            subscriptionStatus: subscriptionStatus,
            availability: availability,
            workflow: workflow,
            createdAt: createdAt
        )
    }
}
