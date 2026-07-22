import Foundation
import Combine
import FirebaseAuth

class ClientsViewModel: ObservableObject {
    @Published var clients: [Client] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadClients(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            if let sessionStore, sessionStore.isDemoSession {
                await MainActor.run {
                    clients = sessionStore.customers
                    isLoading = false
                }
                return
            }
            await MainActor.run {
                clients = []
                isLoading = false
            }
            return
        }
        
        do {
            guard Auth.auth().currentUser?.uid != nil else {
                await MainActor.run { isLoading = false }
                return
            }

            if let sessionStore {
                await sessionStore.ensureSessionLoaded(isDemoMode: false)
                await sessionStore.loadCustomersIfNeeded(force: false, isDemoMode: false)
                await MainActor.run {
                    clients = sessionStore.customers
                    isLoading = false
                }
                return
            }

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

    func refreshClients(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        sessionStore?.invalidateCustomers()
        await loadClients(isDemoMode: isDemoMode, sessionStore: sessionStore)
    }
    
    /// Creates a customer; returns document id for navigation.
    func createClient(_ client: Client) async throws -> String {
        guard let uid = Auth.auth().currentUser?.uid else {
            throw NSError(
                domain: "ClientsViewModel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "You must be signed in to add a customer."]
            )
        }
        let profile = try await firebaseService.fetchProviderProfile(uid: uid)
        if let tid = profile?.tenantId {
            let docId = Self.tenantCustomerDocumentId(email: client.email, phone: client.phone)
            try await firebaseService.upsertTenantCustomer(
                tenantId: tid,
                customerId: docId,
                name: client.name,
                email: client.email,
                phone: client.phone
            )
            await loadClients()
            return docId
        }
        let legacyId = try await firebaseService.createClient(client)
        await loadClients()
        return legacyId
    }

    static func tenantCustomerDocumentId(email: String, phone: String?) -> String {
        let digits = PhoneFormatting.digits(from: PhoneFormatting.normalizedForStorage(phone) ?? "")
        if digits.count >= 10 { return String(digits.suffix(10)) }
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !normalizedEmail.isEmpty {
            let safe = normalizedEmail.replacingOccurrences(
                of: "[^a-z0-9]+",
                with: "_",
                options: .regularExpression
            )
            return String(safe.prefix(120))
        }
        return UUID().uuidString
    }

    /// Best matching saved customer, or a lightweight client for message/request phone contacts.
    func resolveClient(name: String, phone: String) -> Client {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = trimmedName.isEmpty ? "Customer" : trimmedName
        let dig = PhoneFormatting.digits(from: phone)
        if dig.count >= 10 {
            let suffix = String(dig.suffix(10))
            if let match = clients.first(where: {
                let p = PhoneFormatting.digits(from: $0.phone ?? "")
                return p.count >= 10 && String(p.suffix(10)) == suffix
            }) {
                return match
            }
            let stored = PhoneFormatting.normalizedForStorage(phone) ?? phone
            return Client(
                id: suffix,
                name: displayName,
                email: "",
                phone: stored
            )
        }
        if !trimmedName.isEmpty,
           let match = clients.first(where: {
               $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == trimmedName.lowercased()
           }) {
            return match
        }
        return Client(
            id: UUID().uuidString,
            name: displayName,
            email: "",
            phone: phone.isEmpty ? nil : phone
        )
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

