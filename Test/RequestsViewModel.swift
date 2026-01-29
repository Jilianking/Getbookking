import Foundation
import Combine

class RequestsViewModel: ObservableObject {
    @Published var requests: [Request] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadRequests() async {
        await MainActor.run {
            isLoading = true
        }
        
        do {
            let fetchedRequests = try await firebaseService.fetchRequests()
            await MainActor.run {
                requests = fetchedRequests
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
            print("Error loading requests: \(error)")
        }
    }
    
    func updateRequest(_ requestId: String, status: Request.RequestStatus, notes: String?) async {
        var updates: [String: Any] = ["status": status.rawValue]
        if let notes = notes {
            updates["notes"] = notes
        }
        updates["reviewedAt"] = Date()
        
        do {
            try await firebaseService.updateRequest(requestId, updates: updates)
            await loadRequests()
        } catch {
            print("Error updating request: \(error)")
        }
    }
    
    func deleteRequest(_ requestId: String) async {
        do {
            try await firebaseService.deleteRequest(requestId)
            await loadRequests()
        } catch {
            print("Error deleting request: \(error)")
        }
    }
}

