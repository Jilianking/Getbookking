import Foundation
import Combine
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions

class RequestsViewModel: ObservableObject {
    @Published var requests: [Request] = []
    @Published var bookingRequests: [BookingRequest] = []
    @Published var tenantId: String?
    /// Firestore `tenants/{id}.industry` (BookingTemplate raw value); drives booking detail section titles.
    @Published var tenantIndustry: String?
    @Published var teamMembers: [TenantTeamMember] = []
    @Published var studioAvailability: ProviderAvailability = .default
    @Published var isLoading = false
    @Published var actionError: String?
    @Published var isUpdatingStatus = false
    @Published var isUpdatingAssignment = false
    @Published var isSeeding = false
    @Published var seedMessage: String?
    
    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    
    var useTenantData: Bool { tenantId != nil }

    /// Full team for booking list filter: owner first, then everyone else by name.
    var teamFilterRoster: [TenantTeamMember] {
        teamMembers.sorted { lhs, rhs in
            if lhs.accessRole == .owner, rhs.accessRole != .owner { return true }
            if rhs.accessRole == .owner, lhs.accessRole != .owner { return false }
            return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }
    }

    var teamFilterOwner: TenantTeamMember? {
        teamMembers.first { $0.accessRole == .owner }
    }

    /// For industry-specific copy (e.g. booking request form section titles).
    var tenantBookingTemplate: BookingTemplate? {
        guard let raw = tenantIndustry?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return BookingTemplate(rawValue: raw)
    }
    
    func loadRequests(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run {
                requests = []
                bookingRequests = []
                tenantId = nil
                tenantIndustry = nil
                teamMembers = []
                studioAvailability = .default
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
            let tid = profile?.tenantId
            let availability = profile?.availability ?? .default
            
            if let tid = tid {
                async let fetched = firebaseService.fetchTenantBookingRequests(tenantId: tid)
                async let tenantDoc = firebaseService.fetchTenant(tenantId: tid)
                async let membersPayload = functions.httpsCallable("listTenantMembers").call([:])
                let (bookingList, tenant, membersResult) = try await (fetched, tenantDoc, membersPayload)
                let industryRaw = (tenant?["industry"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let membersData = membersResult.data as? [String: Any]
                let roster = Self.parseTeamMembers(
                    membersData?["members"] as? [[String: Any]],
                    ownerUid: membersData?["ownerUid"] as? String
                )
                await MainActor.run {
                    tenantId = tid
                    tenantIndustry = industryRaw?.isEmpty == false ? industryRaw : nil
                    bookingRequests = bookingList
                    teamMembers = roster
                    studioAvailability = availability
                    requests = []
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchRequests()
                await MainActor.run {
                    tenantId = nil
                    tenantIndustry = nil
                    teamMembers = []
                    studioAvailability = availability
                    requests = fetched
                    bookingRequests = []
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading requests: \(error)")
        }
    }
    
    func updateRequest(_ requestId: String, status: Request.RequestStatus, notes: String?) async {
        var updates: [String: Any] = ["status": status.rawValue]
        if let notes = notes { updates["notes"] = notes }
        updates["reviewedAt"] = Date()
        
        do {
            if let tid = tenantId {
                try await firebaseService.updateTenantBookingRequest(tenantId: tid, requestId: requestId, updates: updates)
            } else {
                try await firebaseService.updateRequest(requestId, updates: updates)
            }
            await loadRequests()
        } catch {
            print("Error updating request: \(error)")
        }
    }
    
    func updateBookingRequest(_ requestId: String, status: String, notes: String?) async {
        await setBookingRequestStatus(requestId: requestId, status: status, notes: notes)
    }

    /// Uses Cloud Function so manager `approveRejectRequests` is enforced server-side.
    func setBookingRequestStatus(requestId: String, status: String, notes: String?) async {
        guard tenantId != nil else { return }
        await MainActor.run {
            isUpdatingStatus = true
            actionError = nil
        }
        var payload: [String: Any] = [
            "requestId": requestId,
            "status": status,
        ]
        if let notes { payload["notes"] = notes }
        do {
            _ = try await functions.httpsCallable("updateBookingRequestStatus").call(payload)
            await loadRequests()
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
        }
        await MainActor.run { isUpdatingStatus = false }
    }

    /// Owner / managers with view-all: set or clear staff on a booking request.
    func assignBookingRequest(
        requestId: String,
        member: TenantTeamMember?,
        scheduledStart: Date? = nil,
        preferredTimeLabel: String? = nil
    ) async {
        guard let tid = tenantId, !requestId.isEmpty else { return }
        await MainActor.run {
            isUpdatingAssignment = true
            actionError = nil
        }
        var updates: [String: Any]
        if let member {
            updates = [
                "assignedMemberUid": member.uid,
                "assignedMemberName": member.displayName,
                "assignedMemberEmail": member.email,
            ]
            if let scheduledStart {
                updates["requestedStartTime"] = scheduledStart
            }
            if let preferredTimeLabel, !preferredTimeLabel.isEmpty {
                updates["preferredTime"] = preferredTimeLabel
            }
        } else {
            updates = [
                "assignedMemberUid": FieldValue.delete(),
                "assignedMemberName": FieldValue.delete(),
                "assignedMemberEmail": FieldValue.delete(),
            ]
        }
        do {
            try await firebaseService.updateTenantBookingRequest(
                tenantId: tid,
                requestId: requestId,
                updates: updates
            )
            await loadRequests()
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
        }
        await MainActor.run { isUpdatingAssignment = false }
    }

    /// Marks the request as opened in-app (`readAt`). Does not change `status` (e.g. stays NEW).
    @discardableResult
    func markBookingRequestAsRead(requestId: String) async -> Bool {
        guard let tid = tenantId else { return false }
        do {
            try await firebaseService.updateTenantBookingRequest(
                tenantId: tid,
                requestId: requestId,
                updates: ["readAt": Date()]
            )
            await loadRequests()
            return true
        } catch {
            print("Error marking booking request read: \(error)")
            return false
        }
    }
    
    /// Owner-only (Cloud Function). Inserts test rows with `source: seed` (no push spam).
    func seedTestBookingRequests(count: Int = 100) async {
        guard tenantId != nil else {
            await MainActor.run { seedMessage = "Sign in to a business account first." }
            return
        }
        await MainActor.run {
            isSeeding = true
            seedMessage = nil
            actionError = nil
        }
        let payload: [String: Any] = [
            "confirm": "SEED_BOOKING_REQUESTS",
            "count": min(500, max(1, count)),
        ]
        do {
            let result = try await functions.httpsCallable("seedTenantBookingRequests").call(payload)
            let data = result.data as? [String: Any]
            let written = data?["written"] as? Int ?? count
            await loadRequests()
            await MainActor.run {
                seedMessage = "Added \(written) test request(s). Pull to refresh if needed."
            }
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
                seedMessage = nil
            }
        }
        await MainActor.run { isSeeding = false }
    }

    private static func parseTeamMembers(_ raw: [[String: Any]]?, ownerUid: String?) -> [TenantTeamMember] {
        guard let raw else { return [] }
        return raw.compactMap { row in
            guard let uid = row["uid"] as? String else { return nil }
            let role = TeamAccessRole.fromFirestore(row["accessRole"] as? String ?? row["role"] as? String)
            let fn = (row["firstName"] as? String) ?? ""
            let ln = (row["lastName"] as? String) ?? ""
            var name = "\(fn) \(ln)".trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { name = (row["displayName"] as? String) ?? (row["name"] as? String) ?? "Member" }
            if uid == ownerUid {
                return TenantTeamMember(
                    uid: uid,
                    displayName: name,
                    email: (row["email"] as? String) ?? "",
                    phone: (row["phone"] as? String) ?? "",
                    profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                    accessRole: .owner,
                    jobTitle: "",
                    memberSettings: TeamMemberSettings(),
                    personalConfirmationType: Self.parsePersonalConfirmationType(row),
                    effectiveConfirmationType: Self.parseEffectiveConfirmationType(row)
                )
            }
            return TenantTeamMember(
                uid: uid,
                displayName: name,
                email: (row["email"] as? String) ?? "",
                phone: (row["phone"] as? String) ?? "",
                profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                accessRole: role,
                jobTitle: (row["jobTitle"] as? String) ?? "",
                memberSettings: TeamMemberSettings(dictionary: row["memberSettings"] as? [String: Any]),
                personalConfirmationType: Self.parsePersonalConfirmationType(row),
                effectiveConfirmationType: Self.parseEffectiveConfirmationType(row)
            )
        }
    }

    private static func parsePersonalConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["personalConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func parseEffectiveConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["effectiveConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    func deleteRequest(_ requestId: String) async {
        do {
            if tenantId != nil {
                // Tenant requests: update status to cancelled instead of delete
                await updateBookingRequest(requestId, status: "cancelled", notes: nil)
            } else {
                try await firebaseService.deleteRequest(requestId)
                await loadRequests()
            }
        } catch {
            print("Error deleting request: \(error)")
        }
    }

    /// Stable `tenants/{id}/customers/{docId}` key (phone digits, then email slug).
    static func customerDocumentId(for booking: BookingRequest) -> String? {
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone)
        let digits = PhoneFormatting.digits(from: phone ?? "")
        if digits.count >= 10 { return String(digits.suffix(10)) }
        if !email.isEmpty {
            let safe = email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            return String(safe.prefix(120))
        }
        return nil
    }

    func addBookingRequestCustomerToContacts(_ booking: BookingRequest) async -> Bool {
        guard let tid = tenantId else { return false }
        let name = (booking.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone)
        guard !name.isEmpty else {
            await MainActor.run { actionError = "Customer name is required to save contact." }
            return false
        }
        guard !email.isEmpty || (phone != nil && !(phone ?? "").isEmpty) else {
            await MainActor.run { actionError = "Add an email or phone number to save contact." }
            return false
        }
        do {
            let customerId = Self.customerDocumentId(for: booking) ?? UUID().uuidString
            try await firebaseService.upsertTenantCustomer(
                tenantId: tid,
                customerId: customerId,
                name: name,
                email: email,
                phone: phone
            )
            await MainActor.run { actionError = nil }
            return true
        } catch {
            await MainActor.run { actionError = error.localizedDescription }
            return false
        }
    }

    func isBookingRequestCustomerInContacts(_ booking: BookingRequest) async -> Bool {
        guard let tid = tenantId else { return false }
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone) ?? ""
        let digits = PhoneFormatting.digits(from: phone)
        let targetPhoneId = digits.count >= 10 ? String(digits.suffix(10)) : ""
        let targetEmailId = email.isEmpty
            ? ""
            : String(email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression).prefix(120))
        do {
            let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
            return customers.contains { customer in
                let existingPhoneDigits = PhoneFormatting.digits(from: customer.phone ?? "")
                let existingPhoneId = existingPhoneDigits.count >= 10 ? String(existingPhoneDigits.suffix(10)) : ""
                let existingEmailId = customer.email
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                    .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
                if !targetPhoneId.isEmpty && existingPhoneId == targetPhoneId { return true }
                if !targetEmailId.isEmpty && String(existingEmailId.prefix(120)) == targetEmailId { return true }
                return false
            }
        } catch {
            return false
        }
    }
}

