import Foundation
import Combine
import FirebaseAuth

class RequestsViewModel: ObservableObject {
    @Published var requests: [Request] = []
    @Published var bookingRequests: [BookingRequest] = []
    @Published var tenantId: String?
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    var useTenantData: Bool { tenantId != nil }
    
    func loadRequests(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run {
                requests = []
                bookingRequests = []
                tenantId = nil
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
                let fetched = try await firebaseService.fetchTenantBookingRequests(tenantId: tid)
                await MainActor.run {
                    tenantId = tid
                    bookingRequests = fetched
                    requests = []
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchRequests()
                await MainActor.run {
                    tenantId = nil
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
        var updates: [String: Any] = ["status": status]
        if let notes = notes { updates["notes"] = notes }
        updates["reviewedAt"] = Date()
        
        guard let tid = tenantId else { return }
        do {
            try await firebaseService.updateTenantBookingRequest(tenantId: tid, requestId: requestId, updates: updates)
            await loadRequests()
        } catch {
            print("Error updating request: \(error)")
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

