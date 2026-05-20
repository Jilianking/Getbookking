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
    @Published var isLoading = false
    @Published var actionError: String?
    @Published var isUpdatingStatus = false
    
    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    
    var useTenantData: Bool { tenantId != nil }

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
                let (bookingList, tenant) = try await (fetched, tenantDoc)
                let industryRaw = (tenant?["industry"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                await MainActor.run {
                    tenantId = tid
                    tenantIndustry = industryRaw?.isEmpty == false ? industryRaw : nil
                    bookingRequests = bookingList
                    requests = []
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchRequests()
                await MainActor.run {
                    tenantId = nil
                    tenantIndustry = nil
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

