import Foundation
import Combine

class ClientsViewModel: ObservableObject {
    @Published var clients: [Client] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadClients() async {
        await MainActor.run {
            isLoading = true
        }
        
        do {
            let fetchedClients = try await firebaseService.fetchClients()
            await MainActor.run {
                clients = fetchedClients
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
            print("Error loading clients: \(error)")
        }
    }
    
    func createClient(_ client: Client) async {
        do {
            _ = try await firebaseService.createClient(client)
            await loadClients()
        } catch {
            print("Error creating client: \(error)")
        }
    }
    
    func updateClient(_ clientId: String, updates: [String: Any]) async {
        do {
            try await firebaseService.updateClient(clientId, updates: updates)
            await loadClients()
        } catch {
            print("Error updating client: \(error)")
        }
    }
}

