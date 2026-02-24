import Foundation
import Combine
import FirebaseAuth

class ClientsViewModel: ObservableObject {
    @Published var clients: [Client] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadClients(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run {
                clients = []
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
            if let tid = profile?.tenantId {
                let fetched = try await firebaseService.fetchTenantCustomers(tenantId: tid)
                await MainActor.run {
                    clients = fetched
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchClients()
                await MainActor.run {
                    clients = fetched
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading clients: \(error)")
        }
    }
    
    func createClient(_ client: Client) async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            if let tid = profile?.tenantId {
                let customerId = (client.phone ?? "").replacingOccurrences(of: "[^0-9]", with: "", options: .regularExpression)
                let docId = customerId.isEmpty ? UUID().uuidString : customerId
                try await firebaseService.upsertTenantCustomer(tenantId: tid, customerId: docId, name: client.name, email: client.email, phone: client.phone)
            } else {
                _ = try await firebaseService.createClient(client)
            }
            await loadClients()
        } catch {
            print("Error creating client: \(error)")
        }
    }
    
    func updateClient(_ clientId: String, updates: [String: Any]) async {
        guard let uid = Auth.auth().currentUser?.uid else { return }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            if let tid = profile?.tenantId {
                try await firebaseService.updateTenantCustomer(tenantId: tid, customerId: clientId, updates: updates)
            } else {
                try await firebaseService.updateClient(clientId, updates: updates)
            }
            await loadClients()
        } catch {
            print("Error updating client: \(error)")
        }
    }
}

