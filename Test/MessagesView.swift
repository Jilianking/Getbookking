import SwiftUI

struct MessagesView: View {
    @StateObject private var viewModel = MessagesViewModel()
    @State private var selectedThreadId: String?
    @State private var showingCompose = false
    
    var body: some View {
        NavigationView {
            VStack {
                if let threadId = selectedThreadId {
                    MessageThreadView(threadId: threadId, viewModel: viewModel)
                } else {
                    // Threads List
                    List(viewModel.threads, id: \.self) { threadId in
                        ThreadRow(threadId: threadId, viewModel: viewModel)
                            .onTapGesture {
                                selectedThreadId = threadId
                            }
                    }
                    .refreshable {
                        await viewModel.loadThreads()
                    }
                }
            }
            .navigationTitle("Messages")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { showingCompose = true }) {
                        Image(systemName: "square.and.pencil")
                    }
                }
                
                if selectedThreadId != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back") {
                            selectedThreadId = nil
                        }
                    }
                }
            }
            .sheet(isPresented: $showingCompose) {
                ComposeMessageView(viewModel: viewModel)
            }
            .task {
                await viewModel.loadThreads()
            }
        }
    }
}

struct ThreadRow: View {
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    @State private var lastMessage: Message?
    @State private var clientName: String = ""
    
    var body: some View {
        HStack {
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
            
            if let message = lastMessage, !message.read {
                Circle()
                    .fill(Color.blue)
                    .frame(width: 8, height: 8)
            }
        }
        .onAppear {
            loadThreadInfo()
        }
    }
    
    private func loadThreadInfo() {
        Task {
            let messages = await viewModel.loadMessages(for: threadId)
            lastMessage = messages.last
            clientName = lastMessage?.clientName ?? "Unknown"
        }
    }
}

struct MessageThreadView: View {
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    @State private var messages: [Message] = []
    @State private var newMessage = ""
    @State private var isLoading = false
    
    var body: some View {
        VStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { oldValue, newValue in
                    if let lastMessage = messages.last {
                        withAnimation {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
            }
            
            HStack {
                TextField("Type a message...", text: $newMessage)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                
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
            await viewModel.sendMessage(
                threadId: threadId,
                content: newMessage
            )
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Send") {
                        sendMessage()
                    }
                    .disabled(clientId.isEmpty || clientName.isEmpty || message.isEmpty)
                }
            }
        }
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

