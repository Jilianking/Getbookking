import Foundation
import Combine

class MessagesViewModel: ObservableObject {
    @Published var threads: [String] = []
    @Published var messages: [String: [Message]] = [:]
    @Published var composeClients: [Client] = []
    
    private let firebaseService = FirebaseService()
    private var activeMessageThreadId: String?
    
    func loadThreads(isDemoMode: Bool = false) async {
        if isDemoMode {
            await MainActor.run {
                threads = []
            }
            return
        }
        do {
            let fetchedThreads = try await firebaseService.fetchAllThreads()
            await MainActor.run {
                threads = fetchedThreads
            }
        } catch {
            print("Error loading threads: \(error)")
        }
    }

    func startThreadsListening(isDemoMode: Bool = false) {
        if isDemoMode {
            threads = []
            return
        }
        firebaseService.startThreadsListener(
            onUpdate: { [weak self] threadIds in
                Task { @MainActor in
                    self?.threads = threadIds
                }
            },
            onError: { errorMessage in
                print("Threads listener error: \(errorMessage)")
            }
        )
    }

    func stopThreadsListening() {
        firebaseService.stopThreadsListener()
    }

    func loadComposeClients(isDemoMode: Bool = false) async {
        if isDemoMode {
            await MainActor.run {
                composeClients = []
            }
            return
        }
        do {
            let clients = try await firebaseService.fetchCurrentTenantCustomers()
            let sorted = clients.sorted { a, b in
                a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
            await MainActor.run {
                composeClients = sorted
            }
        } catch {
            print("Error loading compose clients: \(error)")
        }
    }
    
    func loadMessages(for threadId: String, isDemoMode: Bool = false) async -> [Message] {
        if isDemoMode {
            return []
        }
        do {
            let fetchedMessages = try await firebaseService.fetchMessages(threadId: threadId)
            await MainActor.run {
                messages[threadId] = fetchedMessages
            }
            return fetchedMessages
        } catch {
            print("Error loading messages: \(error)")
            return []
        }
    }
    
    func sendMessage(
        threadId: String,
        content: String,
        clientName: String? = nil,
        clientId: String? = nil
    ) async {
        var finalClientId = clientId
        var finalClientName = clientName
        
        if finalClientId == nil || finalClientName == nil {
            if let existingMessages = messages[threadId], let firstMessage = existingMessages.first {
                finalClientId = firstMessage.clientId
                finalClientName = firstMessage.clientName
            }
        }
        
        guard let clientId = finalClientId, let clientName = finalClientName else {
            print("Cannot send message: missing client info")
            return
        }
        
        let message = Message(
            id: nil,
            clientId: clientId,
            clientName: clientName,
            content: content,
            sender: .admin,
            createdAt: Date(),
            read: false,
            threadId: threadId
        )
        
        do {
            try await firebaseService.sendMessage(message)
            _ = await loadMessages(for: threadId)
        } catch {
            print("Error sending message: \(error)")
        }
    }
    
    func listenToMessages(threadId: String, onUpdate: @escaping ([Message]) -> Void) {
        activeMessageThreadId = threadId
        firebaseService.startMessagesListener(
            threadId: threadId,
            onUpdate: { [weak self] newMessages in
                Task { @MainActor in
                    self?.messages[threadId] = newMessages
                    onUpdate(newMessages)
                }
            },
            onError: { errorMessage in
                print("Messages listener error: \(errorMessage)")
            }
        )
    }

    func stopListeningToMessages(threadId: String) {
        firebaseService.stopMessagesListener(threadId: threadId)
        if activeMessageThreadId == threadId {
            activeMessageThreadId = nil
        }
    }

    deinit {
        firebaseService.stopAllSmsListeners()
    }
}

