import Foundation
import Combine

class MessagesViewModel: ObservableObject {
    @Published var threads: [String] = []
    @Published var messages: [String: [Message]] = [:]
    
    private let firebaseService = FirebaseService()
    
    func loadThreads() async {
        do {
            let fetchedThreads = try await firebaseService.fetchAllThreads()
            await MainActor.run {
                threads = fetchedThreads
            }
        } catch {
            print("Error loading threads: \(error)")
        }
    }
    
    func loadMessages(for threadId: String) async -> [Message] {
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
            await loadMessages(for: threadId)
        } catch {
            print("Error sending message: \(error)")
        }
    }
    
    func listenToMessages(threadId: String, onUpdate: @escaping ([Message]) -> Void) {
        Task {
            let messages = await loadMessages(for: threadId)
            onUpdate(messages)
        }
    }
}

