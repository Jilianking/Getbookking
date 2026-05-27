import SwiftUI

struct MessagesView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = MessagesViewModel()
    @State private var selectedThreadId: String?
    @State private var showingCompose = false
    @State private var searchText = ""
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if let threadId = selectedThreadId {
                    MessageThreadView(threadId: threadId, viewModel: viewModel, onBack: { selectedThreadId = nil })
                } else {
                    // Search
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.gray)
                        TextField("Search conversations...", text: $searchText)
                    }
                    .padding(10)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(10)
                    .padding(.horizontal)
                    .padding(.vertical, 8)

                    // Threads List
                    List(viewModel.threads, id: \.self) { threadId in
                        ThreadRow(threadId: threadId, viewModel: viewModel)
                            .onTapGesture {
                                selectedThreadId = threadId
                            }
                    }
                    .listStyle(.plain)
                    .refreshable {
                        await viewModel.loadThreads(isDemoMode: authViewModel.isDemoMode)
                    }
                }
            }
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    if selectedThreadId == nil {
                        Button(action: { showingCompose = true }) {
                            Image(systemName: "square.and.pencil")
                                .font(.body)
                        }
                    }
                }
            }
            .sheet(isPresented: $showingCompose) {
                ComposeMessageView(viewModel: viewModel, drawerState: drawerState)
            }
            .task {
                await viewModel.loadThreads(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }
}

struct ThreadRow: View {
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    @State private var lastMessage: Message?
    @State private var clientName: String = ""

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.purple.opacity(0.8))
                .frame(width: 44, height: 44)
                .overlay(
                    Text(clientName.prefix(1).uppercased())
                        .font(.headline)
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 4) {
                Text(clientName.isEmpty ? "Loading..." : clientName)
                    .font(.system(size: 16, weight: .semibold))
                if let message = lastMessage {
                    Text(message.content)
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if let message = lastMessage {
                Text(message.createdAt, style: .time)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Button(action: {}) {
                Image(systemName: "ellipsis")
                    .font(.body)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 8)
        .onAppear {
            loadThreadInfo()
        }
    }

    private func loadThreadInfo() {
        Task {
            let msgs = await viewModel.loadMessages(for: threadId)
            lastMessage = msgs.last
            clientName = lastMessage?.clientName ?? "Unknown"
        }
    }
}

struct MessageThreadView: View {
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    let onBack: () -> Void
    @State private var messages: [Message] = []
    @State private var newMessage = ""
    @State private var isLoading = false
    @State private var clientName = "Customer"
    @State private var clientPhone = ""

    var body: some View {
        VStack(spacing: 0) {
            // Header: back, avatar, name, phone
            HStack(spacing: 12) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                }
                Circle()
                    .fill(Color.purple.opacity(0.8))
                    .frame(width: 40, height: 40)
                    .overlay(Text(clientName.prefix(1).uppercased()).font(.headline).foregroundColor(.white))
                VStack(alignment: .leading, spacing: 2) {
                    Text(clientName)
                        .font(.headline)
                    if !clientPhone.isEmpty {
                        Text(clientPhone)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding()
            .background(Color(.systemBackground))

            Divider()

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(messages, id: \.stableId) { message in
                            MessageBubble(message: message)
                                .id(message.stableId)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.stableId, anchor: .bottom) }
                    }
                }
            }

            // Input: lightning, paperclip, field, send
            HStack(spacing: 12) {
                Button(action: {}) {
                    Image(systemName: "bolt")
                        .foregroundColor(.secondary)
                }
                Button(action: {}) {
                    Image(systemName: "paperclip")
                        .foregroundColor(.secondary)
                }
                TextField("Type a message...", text: $newMessage)
                    .textFieldStyle(.roundedBorder)
                Button(action: sendMessage) {
                    Image(systemName: "paperplane.fill")
                        .foregroundColor(.blue)
                }
                .disabled(newMessage.isEmpty || isLoading)
            }
            .padding()
        }
        .task {
            await loadMessages()
        }
        .onAppear {
            startListening()
        }
    }

    private func loadMessages() async {
        messages = await viewModel.loadMessages(for: threadId)
        if let first = messages.first {
            clientName = first.clientName
            clientPhone = PhoneFormatting.displayUS(first.clientId)
        }
    }

    private func startListening() {
        viewModel.listenToMessages(threadId: threadId) { newMessages in
            messages = newMessages
        }
    }

    private func sendMessage() {
        guard !newMessage.isEmpty else { return }
        isLoading = true
        Task {
            await viewModel.sendMessage(threadId: threadId, content: newMessage)
            await MainActor.run {
                newMessage = ""
                isLoading = false
            }
        }
    }
}

struct MessageBubble: View {
    let message: Message

    var body: some View {
        HStack {
            if message.sender == .admin {
                Spacer()
            }
            VStack(alignment: message.sender == .admin ? .trailing : .leading, spacing: 4) {
                Text(message.content)
                    .padding()
                    .background(message.sender == .admin ? Color.blue : Color.gray.opacity(0.2))
                    .foregroundColor(message.sender == .admin ? .white : .primary)
                    .cornerRadius(16)
                Text(message.createdAt, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            if message.sender == .client {
                Spacer()
            }
        }
    }
}

struct ComposeMessageView: View {
    @ObservedObject var viewModel: MessagesViewModel
    var drawerState: DrawerState
    @Environment(\.dismiss) var dismiss
    @State private var clientId = ""
    @State private var clientName = ""
    @State private var message = ""

    var body: some View {
        NavigationView {
            Form {
                TextField("Client ID", text: $clientId)
                TextField("Client Name", text: $clientName)
                TextField("Message", text: $message)
            }
            .navigationTitle("New Message")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: {
                        dismiss()
                        drawerState.isOpen = true
                    }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Send") {
                        sendMessage()
                    }
                    .disabled(clientId.isEmpty || clientName.isEmpty || message.isEmpty)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func sendMessage() {
        Task {
            await viewModel.sendMessage(
                threadId: clientId,
                content: message,
                clientName: clientName,
                clientId: clientId
            )
            dismiss()
        }
    }
}
