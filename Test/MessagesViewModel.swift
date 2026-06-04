import Foundation
import Combine
import FirebaseFunctions

class MessagesViewModel: ObservableObject {
    @Published var threadSummaries: [SmsThreadSummary] = []
    @Published var messages: [String: [Message]] = [:]
    @Published var composeClients: [Client] = []
    @Published var smsQuickPresets: [String] = []
    @Published var lastError: String?
    @Published var isSending = false

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    private var activeMessageThreadId: String?

    var threads: [String] {
        threadSummaries.map(\.threadId)
    }

    func loadThreads(isDemoMode: Bool = false) async {
        if isDemoMode {
            await MainActor.run {
                threadSummaries = []
            }
            return
        }
        do {
            let fetched = try await firebaseService.fetchAllThreads()
            await MainActor.run {
                threadSummaries = fetched
                lastError = nil
            }
        } catch {
            print("Error loading threads: \(error)")
            await MainActor.run {
                lastError = error.localizedDescription
            }
        }
    }

    func startThreadsListening(isDemoMode: Bool = false) {
        if isDemoMode {
            threadSummaries = []
            return
        }
        firebaseService.startThreadsListener(
            onUpdate: { [weak self] summaries in
                Task { @MainActor in
                    self?.threadSummaries = summaries
                }
            },
            onError: { [weak self] errorMessage in
                print("Threads listener error: \(errorMessage)")
                Task { @MainActor in
                    self?.lastError = errorMessage
                }
            }
        )
    }

    func stopThreadsListening() {
        firebaseService.stopThreadsListener()
    }

    func loadSmsQuickPresets(isDemoMode: Bool = false) async {
        if isDemoMode {
            await MainActor.run {
                smsQuickPresets = ManagerSettingsViewModel.defaultQuickReplyPresets
            }
            return
        }
        do {
            let result = try await functions.httpsCallable("listTenantMembers").call([:])
            guard let data = result.data as? [String: Any] else { return }
            let quick = (data["smsQuickPresets"] as? [String])?
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty } ?? []
            await MainActor.run {
                smsQuickPresets = quick.isEmpty
                    ? ManagerSettingsViewModel.defaultQuickReplyPresets
                    : quick
            }
        } catch {
            print("Error loading SMS quick presets: \(error)")
        }
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
        let normalizedId = PhoneFormatting.smsThreadId(threadId)
        do {
            let fetchedMessages = try await firebaseService.fetchMessages(threadId: normalizedId)
            await MainActor.run {
                messages[normalizedId] = fetchedMessages
            }
            return fetchedMessages
        } catch {
            print("Error loading messages: \(error)")
            await MainActor.run {
                lastError = error.localizedDescription
            }
            return []
        }
    }

    @discardableResult
    func sendMessage(
        threadId: String,
        content: String,
        clientName: String? = nil,
        clientId: String? = nil
    ) async -> Bool {
        let normalizedThreadId = PhoneFormatting.smsThreadId(threadId)
        var finalClientId = clientId.map { PhoneFormatting.smsThreadId($0) }
        var finalClientName = clientName?.trimmingCharacters(in: .whitespacesAndNewlines)

        if finalClientId == nil || (finalClientName ?? "").isEmpty {
            if let existingMessages = messages[normalizedThreadId], let firstMessage = existingMessages.first {
                finalClientId = finalClientId ?? PhoneFormatting.smsThreadId(firstMessage.clientId)
                if (finalClientName ?? "").isEmpty {
                    finalClientName = firstMessage.clientName
                }
            }
        }

        guard let clientId = finalClientId ?? PhoneFormatting.e164US(threadId) else {
            await MainActor.run {
                lastError = "Enter a valid phone number."
            }
            return false
        }

        let resolvedName: String = {
            let trimmed = (finalClientName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
            return PhoneFormatting.displayUS(clientId)
        }()

        let message = Message(
            id: nil,
            clientId: clientId,
            clientName: resolvedName,
            content: content,
            sender: .admin,
            createdAt: Date(),
            read: false,
            threadId: normalizedThreadId
        )

        await MainActor.run {
            isSending = true
            lastError = nil
        }

        do {
            try await firebaseService.sendMessage(message)
            _ = await loadMessages(for: normalizedThreadId)
            await loadThreads()
            await MainActor.run {
                isSending = false
            }
            return true
        } catch {
            print("Error sending message: \(error)")
            await MainActor.run {
                isSending = false
                lastError = error.localizedDescription
            }
            return false
        }
    }

    func listenToMessages(threadId: String, onUpdate: @escaping ([Message]) -> Void) {
        let normalizedId = PhoneFormatting.smsThreadId(threadId)
        activeMessageThreadId = normalizedId
        firebaseService.startMessagesListener(
            threadId: normalizedId,
            onUpdate: { [weak self] newMessages in
                Task { @MainActor in
                    self?.messages[normalizedId] = newMessages
                    onUpdate(newMessages)
                }
            },
            onError: { [weak self] errorMessage in
                print("Messages listener error: \(errorMessage)")
                Task { @MainActor in
                    self?.lastError = errorMessage
                }
            }
        )
    }

    func stopListeningToMessages(threadId: String) {
        let normalizedId = PhoneFormatting.smsThreadId(threadId)
        firebaseService.stopMessagesListener(threadId: normalizedId)
        if activeMessageThreadId == normalizedId {
            activeMessageThreadId = nil
        }
    }

    func summary(for threadId: String) -> SmsThreadSummary? {
        let normalized = PhoneFormatting.smsThreadId(threadId)
        return threadSummaries.first {
            PhoneFormatting.smsThreadId($0.threadId) == normalized
        }
    }

    deinit {
        firebaseService.stopAllSmsListeners()
    }
}
