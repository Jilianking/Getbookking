import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

class RequestsViewModel: ObservableObject {
    @Published var requests: [Request] = []
    @Published var bookingRequests: [BookingRequest] = []
    @Published var tenantId: String?
    /// Firestore `tenants/{id}.industry` (BookingTemplate raw value); drives booking detail section titles.
    @Published var tenantIndustry: String?
    /// Non-owner roster for Booking Requests assignee filter.
    @Published var teamMembers: [TenantTeamMember] = []
    @Published var isLoading = false
    @Published var actionError: String?
    @Published var isUpdatingStatus = false
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
                    requests = []
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchRequests()
                await MainActor.run {
                    tenantId = nil
                    tenantIndustry = nil
                    teamMembers = []
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
                    profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                    accessRole: .owner,
                    jobTitle: "",
                    memberSettings: TeamMemberSettings()
                )
            }
            return TenantTeamMember(
                uid: uid,
                displayName: name,
                email: (row["email"] as? String) ?? "",
                profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                accessRole: role,
                jobTitle: (row["jobTitle"] as? String) ?? "",
                memberSettings: TeamMemberSettings(dictionary: row["memberSettings"] as? [String: Any])
            )
        }
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
}

