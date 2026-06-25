import SwiftUI

struct MessagesView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = MessagesViewModel()
    @State private var selectedThreadId: String?
    @State private var showingCompose = false
    @State private var composePrefillPhone = ""
    @State private var composePrefillName = ""
    @State private var composePrefillBookingRequestId: String?
    @State private var searchText = ""
    @State private var showErrorAlert = false
    @StateObject private var messagingSettingsViewModel = ManagerSettingsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    private var visibleSummaries: [SmsThreadSummary] {
        let access = authViewModel.teamAccess
        if access.isOwner || access.accessRole == .manager {
            return viewModel.threadSummaries
        }
        if access.usesOwnSms, let uid = authViewModel.currentUserUid {
            return viewModel.threadSummaries.filter { summary in
                guard let assigned = summary.assignedMemberUid else { return false }
                return assigned == uid
            }
        }
        return viewModel.threadSummaries
    }

    private var filteredSummaries: [SmsThreadSummary] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = visibleSummaries
        guard !q.isEmpty else { return base }
        let qDigits = PhoneFormatting.digits(from: searchText)
        return base.filter { summary in
            summary.clientName.lowercased().contains(q)
                || summary.lastMessageBody.lowercased().contains(q)
                || (!qDigits.isEmpty && PhoneFormatting.digits(from: summary.threadId).contains(qDigits))
        }
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if let threadId = selectedThreadId {
                    MessageThreadView(
                        threadId: threadId,
                        viewModel: viewModel,
                        drawerState: drawerState,
                        onBack: { selectedThreadId = nil }
                    )
                } else {
                    AppSearchField(placeholder: "Search conversations...", text: $searchText)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)

                    Group {
                        if filteredSummaries.isEmpty {
                            ContentUnavailableView {
                                Label("No messages yet", systemImage: "message")
                            } description: {
                                Text(searchText.isEmpty
                                    ? "Tap the compose button to text a client."
                                    : "No conversations match your search.")
                            } actions: {
                                if searchText.isEmpty {
                                    Button("New message") { showingCompose = true }
                                }
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            List {
                                ForEach(Array(filteredSummaries.enumerated()), id: \.element.id) { index, summary in
                                    ThreadRow(
                                        summary: summary,
                                        viewModel: viewModel,
                                        showsDivider: index < filteredSummaries.count - 1
                                    )
                                    .contentShape(Rectangle())
                                    .onTapGesture {
                                        selectedThreadId = summary.threadId
                                    }
                                    .listRowInsets(EdgeInsets())
                                    .listRowSeparator(.hidden)
                                    .listRowBackground(AppDesign.cardBackground)
                                }
                            }
                            .listStyle(.plain)
                            .scrollContentBackground(.hidden)
                            .background(AppDesign.cardBackground)
                            .environment(\.defaultMinListRowHeight, 1)
                        }
                    }
                    .refreshable {
                        await viewModel.loadThreads(
                            isDemoMode: authViewModel.isDemoMode,
                            sessionStore: sessionStore
                        )
                    }
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    if selectedThreadId == nil {
                        HStack(spacing: 16) {
                            NavigationLink {
                                MessagesSettingsView(viewModel: messagingSettingsViewModel)
                                    .environmentObject(authViewModel)
                            } label: {
                                Image(systemName: "gearshape")
                                    .font(.body)
                            }
                            .accessibilityLabel("Messaging settings")

                            Button(action: { showingCompose = true }) {
                                Image(systemName: "square.and.pencil")
                                    .font(.body)
                            }
                            .accessibilityLabel("New message")
                        }
                    }
                }
            }
            .sheet(isPresented: $showingCompose) {
                ComposeMessageView(
                    viewModel: viewModel,
                    drawerState: drawerState,
                    prefillPhone: composePrefillPhone,
                    prefillClientName: composePrefillName,
                    prefillBookingRequestId: composePrefillBookingRequestId,
                    onSent: { threadId in
                        selectedThreadId = threadId
                    }
                )
                .environmentObject(authViewModel)
                .environmentObject(sessionStore)
            }
            .onChange(of: viewModel.lastError) { _, err in
                showErrorAlert = err != nil
            }
            .alert("Message", isPresented: $showErrorAlert) {
                Button("OK", role: .cancel) {
                    viewModel.lastError = nil
                }
            } message: {
                Text(viewModel.lastError ?? "")
            }
            .onChange(of: drawerState.messagesShouldOpenCompose) { _, shouldOpen in
                guard shouldOpen else { return }
                composePrefillPhone = drawerState.messagesComposePhone ?? ""
                composePrefillName = drawerState.messagesComposeClientName ?? ""
                composePrefillBookingRequestId = drawerState.messagesComposeBookingRequestId
                drawerState.messagesComposePhone = nil
                drawerState.messagesComposeClientName = nil
                drawerState.messagesComposeBookingRequestId = nil
                drawerState.messagesShouldOpenCompose = false
                selectedThreadId = nil
                showingCompose = true
            }
            .task {
                viewModel.startThreadsListening(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await viewModel.loadThreads(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await viewModel.loadSmsQuickPresets(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                if drawerState.messagesShouldOpenCompose {
                    composePrefillPhone = drawerState.messagesComposePhone ?? ""
                    composePrefillName = drawerState.messagesComposeClientName ?? ""
                    composePrefillBookingRequestId = drawerState.messagesComposeBookingRequestId
                    drawerState.messagesComposePhone = nil
                    drawerState.messagesComposeClientName = nil
                    drawerState.messagesComposeBookingRequestId = nil
                    drawerState.messagesShouldOpenCompose = false
                    showingCompose = true
                }
            }
            .onDisappear {
                viewModel.stopThreadsListening()
            }
        }
        .navigationViewStyle(.stack)
    }
}

struct ThreadRow: View {
    let summary: SmsThreadSummary
    @ObservedObject var viewModel: MessagesViewModel
    var showsDivider: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                AppAvatarView(
                    tenantLogoURL: nil,
                    accountPhotoURL: nil,
                    displayNameFallback: summary.clientName,
                    size: 44
                )
                VStack(alignment: .leading, spacing: 4) {
                    Text(summary.clientName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    if !summary.lastMessageBody.isEmpty {
                        Text(summary.lastMessageBody)
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
                if let lastAt = summary.lastMessageAt {
                    Text(lastAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if showsDivider {
                Divider()
                    .overlay(AppDesign.chipBorder.opacity(0.5))
                    .padding(.leading, 72)
            }
        }
    }
}

struct MessageThreadView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    var drawerState: DrawerState
    let onBack: () -> Void
    @State private var messages: [Message] = []
    @State private var newMessage = ""
    @State private var isLoading = false
    @State private var clientName = "Customer"
    @State private var clientPhone = ""
    @State private var linkedBookingRequestId: String?
    @State private var showThreadError = false
    @FocusState private var isComposerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Header: back, avatar, name, phone
            HStack(spacing: 12) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                }
                AppAvatarView(
                    tenantLogoURL: nil,
                    accountPhotoURL: nil,
                    displayNameFallback: clientName,
                    size: 40
                )
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
            }
            .padding()
            .background(AppDesign.cardBackground)
            .contentShape(Rectangle())
            .onTapGesture { isComposerFocused = false }

            Divider()

            // Messages
            ScrollViewReader { proxy in
                GeometryReader { geo in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(messages, id: \.stableId) { message in
                                MessageBubble(message: message)
                                    .id(message.stableId)
                            }
                        }
                        .padding()
                        .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .top)
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.stableId, anchor: .bottom) }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            MessageComposerBar(
                message: $newMessage,
                darkStyle: true,
                placeholder: "Type a message...",
                quickPresets: viewModel.smsQuickPresets,
                isSending: isLoading,
                canSend: !newMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                onSend: sendMessage,
                clientName: clientName,
                clientPhone: clientPhone,
                bookingRequestId: linkedBookingRequestId,
                drawerState: drawerState,
                isDemoMode: authViewModel.isDemoMode,
                fieldFocused: $isComposerFocused
            )
        }
        .task {
            if let summary = viewModel.summary(for: threadId) {
                clientName = summary.clientName
                clientPhone = PhoneFormatting.displayUS(summary.threadId)
            }
            await sessionStore.loadBookingsIfNeeded(isDemoMode: authViewModel.isDemoMode)
            let phoneForLookup = clientPhone.isEmpty ? threadId : clientPhone
            linkedBookingRequestId = BookingRequestPaymentLookup.bookingRequestId(
                forClientPhone: phoneForLookup,
                in: sessionStore.bookingRequests
            )
            await loadMessages()
            await viewModel.loadSmsQuickPresets(isDemoMode: authViewModel.isDemoMode)
        }
        .onChange(of: viewModel.lastError) { _, err in
            showThreadError = err != nil
        }
        .alert("Could not send", isPresented: $showThreadError) {
            Button("OK", role: .cancel) { viewModel.lastError = nil }
        } message: {
            Text(viewModel.lastError ?? "")
        }
        .onAppear {
            startListening()
        }
        .onDisappear {
            viewModel.stopListeningToMessages(threadId: threadId)
        }
    }

    private func loadMessages() async {
        messages = await viewModel.loadMessages(
            for: threadId,
            isDemoMode: authViewModel.isDemoMode,
            sessionStore: sessionStore
        )
        if let first = messages.first {
            clientName = first.clientName
            clientPhone = PhoneFormatting.displayUS(first.clientId)
        }
    }

    private func startListening() {
        if authViewModel.isDemoMode, sessionStore.isDemoSession { return }
        viewModel.listenToMessages(threadId: threadId) { newMessages in
            messages = newMessages
        }
    }

    private func sendMessage() {
        let body = newMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        isLoading = true
        Task {
            let ok = await viewModel.sendMessage(
                threadId: threadId,
                content: body,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            await MainActor.run {
                if ok {
                    newMessage = ""
                    isComposerFocused = false
                }
                isLoading = false
            }
        }
    }
}

struct MessageBubble: View {
    let message: Message

    private var isAdmin: Bool { message.sender == .admin }

    var body: some View {
        HStack {
            if isAdmin {
                Spacer()
            }
            VStack(alignment: isAdmin ? .trailing : .leading, spacing: 4) {
                MessageBubbleText(content: message.content, isAdmin: isAdmin)
                    .padding()
                    .background(isAdmin ? AppDesign.accentBlue : AppDesign.searchBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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

/// Plain text plus tappable, underlined URLs (payment links, booking links, etc.).
private struct MessageBubbleText: View {
    let content: String
    let isAdmin: Bool

    var body: some View {
        Text(attributedContent)
            .font(.body)
            .tint(isAdmin ? Color.white.opacity(0.95) : AppDesign.linkAccent)
    }

    private var attributedContent: AttributedString {
        var result = AttributedString(content)
        let textColor: Color = isAdmin ? .white : AppDesign.textPrimary
        let linkColor: Color = isAdmin ? Color.white.opacity(0.95) : AppDesign.linkAccent
        result.foregroundColor = textColor

        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return result
        }
        let fullRange = NSRange(content.startIndex..<content.endIndex, in: content)
        for match in detector.matches(in: content, options: [], range: fullRange) {
            guard let url = match.url,
                  let stringRange = Range(match.range, in: content),
                  let attrRange = Range(stringRange, in: result) else { continue }
            result[attrRange].link = url
            result[attrRange].underlineStyle = .single
            result[attrRange].foregroundColor = linkColor
        }
        return result
    }
}

struct ComposeMessageView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @ObservedObject var viewModel: MessagesViewModel
    var drawerState: DrawerState
    var prefillPhone: String = ""
    var prefillClientName: String = ""
    var prefillBookingRequestId: String?
    var onSent: ((String) -> Void)?
    @Environment(\.dismiss) var dismiss
    @State private var showSendError = false
    @State private var clientPhone = ""
    @State private var linkedBookingRequestId: String?
    @State private var message = ""
    @State private var selectedClientName = ""
    @State private var showingClientPicker = false
    @State private var pickerSearchText = ""
    @FocusState private var toFieldFocused: Bool
    @FocusState private var messageFieldFocused: Bool

    var body: some View {
        ZStack {
            Color(red: 0.08, green: 0.09, blue: 0.12).ignoresSafeArea()
            VStack(spacing: 14) {
                ZStack {
                    Text("New Message")
                        .font(.system(size: 33, weight: .bold))
                        .foregroundColor(.white)
                    HStack {
                        Spacer()
                        Button(action: { dismiss() }) {
                            Image(systemName: "xmark")
                                .font(.system(size: 20, weight: .medium))
                                .foregroundColor(.white.opacity(0.85))
                                .frame(width: 46, height: 46)
                                .background(Color.white.opacity(0.08))
                                .clipShape(Circle())
                        }
                    }
                }
                .padding(.top, 12)
                .padding(.horizontal, 18)

                HStack(spacing: 10) {
                    Text("To:")
                        .foregroundColor(.white.opacity(0.6))
                    TextField(
                        "",
                        text: Binding(
                            get: { clientPhone },
                            set: { newValue in
                                selectedClientName = ""
                                let hasLetters = newValue.rangeOfCharacter(from: .letters) != nil
                                if hasLetters {
                                    clientPhone = newValue
                                } else {
                                    clientPhone = PhoneFormatting.formatAsYouType(newValue)
                                }
                            }
                        )
                    )
                        .focused($toFieldFocused)
                        .keyboardType(.default)
                        .textInputAutocapitalization(.never)
                        .foregroundColor(.white)
                    Button(action: {
                        showingClientPicker = true
                    }) {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white.opacity(0.9))
                            .frame(width: 30, height: 30)
                            .background(Color.white.opacity(0.1))
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 46)
                .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.12), lineWidth: 1))
                .padding(.horizontal, 18)

                if !suggestionClients.isEmpty && toFieldFocused {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(Array(suggestionClients.enumerated()), id: \.offset) { index, client in
                                Button(action: {
                                    clientPhone = PhoneFormatting.displayUS(client.phone ?? "")
                                    selectedClientName = client.name
                                    toFieldFocused = false
                                    messageFieldFocused = true
                                }) {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(client.name)
                                                .foregroundColor(.white)
                                                .font(.system(size: 16, weight: .medium))
                                            Text(PhoneFormatting.displayUS(client.phone ?? ""))
                                                .foregroundColor(.white.opacity(0.65))
                                                .font(.system(size: 13))
                                        }
                                        Spacer()
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 10)
                                }
                                .buttonStyle(.plain)
                                if index < suggestionClients.count - 1 {
                                    Divider().background(Color.white.opacity(0.08))
                                }
                            }
                        }
                    }
                    .frame(maxHeight: 210)
                    .background(Color.white.opacity(0.03))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.white.opacity(0.1), lineWidth: 1)
                    )
                    .padding(.horizontal, 18)
                }

                Spacer()
                    .contentShape(Rectangle())
                    .onTapGesture { messageFieldFocused = false }

                MessageComposerBar(
                    message: $message,
                    darkStyle: true,
                    placeholder: "iMessage",
                    quickPresets: viewModel.smsQuickPresets,
                    isSending: viewModel.isSending,
                    canSend: canSend,
                    onSend: sendMessage,
                    clientName: selectedClientName,
                    clientPhone: clientPhone,
                    bookingRequestId: linkedBookingRequestId,
                    drawerState: drawerState,
                    isDemoMode: authViewModel.isDemoMode,
                    fieldFocused: $messageFieldFocused
                )
            }
        }.onAppear {
            if clientPhone.isEmpty, !prefillPhone.isEmpty {
                clientPhone = PhoneFormatting.displayUS(prefillPhone)
            }
            if selectedClientName.isEmpty, !prefillClientName.isEmpty {
                selectedClientName = prefillClientName
            }
            linkedBookingRequestId = prefillBookingRequestId
            Task {
                await sessionStore.loadBookingsIfNeeded(isDemoMode: authViewModel.isDemoMode)
                if linkedBookingRequestId == nil {
                    linkedBookingRequestId = BookingRequestPaymentLookup.bookingRequestId(
                        forClientPhone: clientPhone,
                        in: sessionStore.bookingRequests
                    )
                }
                await viewModel.loadComposeClients(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await viewModel.loadSmsQuickPresets(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            if clientPhone.isEmpty {
                toFieldFocused = true
            } else {
                messageFieldFocused = true
            }
        }
        .onChange(of: clientPhone) { _, _ in
            guard prefillBookingRequestId == nil else { return }
            linkedBookingRequestId = BookingRequestPaymentLookup.bookingRequestId(
                forClientPhone: clientPhone,
                in: sessionStore.bookingRequests
            )
        }
        .onChange(of: viewModel.lastError) { _, err in
            showSendError = err != nil
        }
        .alert("Could not send", isPresented: $showSendError) {
            Button("OK", role: .cancel) { viewModel.lastError = nil }
        } message: {
            Text(viewModel.lastError ?? "")
        }
        .sheet(isPresented: $showingClientPicker) {
            ComposeClientPickerSheet(
                clients: viewModel.composeClients,
                searchText: $pickerSearchText,
                onPick: { client in
                    clientPhone = PhoneFormatting.displayUS(client.phone ?? "")
                    selectedClientName = client.name
                    toFieldFocused = false
                    messageFieldFocused = true
                    showingClientPicker = false
                }
            )
        }
    }

    private var filteredClients: [Client] {
        let query = clientPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return viewModel.composeClients }
        let qLower = query.lowercased()
        let qDigits = PhoneFormatting.digits(from: query)
        return viewModel.composeClients.filter { client in
            let nameMatch = client.name.lowercased().contains(qLower)
            let phoneDigits = PhoneFormatting.digits(from: client.phone ?? "")
            let phoneMatch = !qDigits.isEmpty && phoneDigits.contains(qDigits)
            return nameMatch || phoneMatch
        }
    }

    private var suggestionClients: [Client] {
        Array(filteredClients.prefix(6))
    }

    private var recipientPhoneForSend: String? {
        PhoneFormatting.e164US(clientPhone)
    }

    private var canSend: Bool {
        recipientPhoneForSend != nil &&
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendMessage() {
        guard let e164Phone = recipientPhoneForSend else { return }
        let trimmedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedMessage.isEmpty else { return }
        var name = selectedClientName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            if let match = viewModel.composeClients.first(where: {
                PhoneFormatting.digits(from: $0.phone ?? "") == PhoneFormatting.digits(from: e164Phone)
            }) {
                name = match.name
            }
        }
        Task {
            let ok = await viewModel.sendMessage(
                threadId: e164Phone,
                content: trimmedMessage,
                clientName: name.isEmpty ? nil : name,
                clientId: e164Phone,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            if ok {
                onSent?(e164Phone)
                dismiss()
            }
        }
    }
}

private struct ComposeClientPickerSheet: View {
    let clients: [Client]
    @Binding var searchText: String
    let onPick: (Client) -> Void
    @Environment(\.dismiss) private var dismiss

    private var filtered: [Client] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return clients }
        let qLower = query.lowercased()
        let qDigits = PhoneFormatting.digits(from: query)
        return clients.filter { client in
            let nameMatch = client.name.lowercased().contains(qLower)
            let phoneDigits = PhoneFormatting.digits(from: client.phone ?? "")
            let phoneMatch = !qDigits.isEmpty && phoneDigits.contains(qDigits)
            return nameMatch || phoneMatch
        }
    }

    var body: some View {
        NavigationView {
            List {
                ForEach(Array(filtered.enumerated()), id: \.offset) { _, client in
                    Button(action: {
                        onPick(client)
                        dismiss()
                    }) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(client.name)
                                    .foregroundColor(.primary)
                                Text(PhoneFormatting.displayUS(client.phone ?? ""))
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .appListSurface()
            .searchable(text: $searchText, prompt: "Search name or number")
            .navigationTitle("Choose Recipient")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}

