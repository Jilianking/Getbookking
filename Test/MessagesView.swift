import SwiftUI

struct MessagesView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var appTour: AppTourCoordinator
    @StateObject private var viewModel = MessagesViewModel()
    @State private var selectedThreadId: String?
    @State private var showingCompose = false
    @State private var composePrefillPhone = ""
    @State private var composePrefillName = ""
    @State private var composePrefillBookingRequestId: String?
    @State private var composePrefillMessage = ""
    @State private var pendingThreadComposerDraft = ""
    @State private var searchText = ""
    @State private var showErrorAlert = false
    @StateObject private var messagingSettingsViewModel = ManagerSettingsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    private var visibleSummaries: [SmsThreadSummary] {
        let access = authViewModel.teamAccess
        if access.isOwner || access.accessRole == .manager {
            // Studio inbox only — personal-line texts stay with that teammate.
            return viewModel.threadSummaries.filter(\.isStudioLine)
        }
        if access.usesOwnSms, let uid = authViewModel.currentUserUid {
            return viewModel.threadSummaries.filter { summary in
                guard let assigned = summary.assignedMemberUid else { return false }
                return assigned == uid
            }
        }
        return []
    }

    private var filteredSummaries: [SmsThreadSummary] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = visibleSummaries
        guard !q.isEmpty else { return base }
        let qDigits = PhoneFormatting.digits(from: searchText)
        return base.filter { summary in
            let displayName = viewModel.resolvedDisplayName(for: summary)
            return displayName.lowercased().contains(q)
                || summary.clientName.lowercased().contains(q)
                || summary.lastMessageBody.lowercased().contains(q)
                || (!qDigits.isEmpty && PhoneFormatting.digits(from: summary.threadId).contains(qDigits))
        }
    }

    var body: some View {
        NavigationView {
            ZStack {
                VStack(spacing: 0) {
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
                                    Button("New message") {
                                        resetComposePrefill()
                                        showingCompose = true
                                    }
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
                                    .appTourAnchor(
                                        .messagesReply,
                                        isActive: appTour.isStepActive(.messagesReply)
                                            && summary.threadId == filteredSummaries.first?.threadId
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
                            .scrollDismissesKeyboard(.interactively)
                        }
                    }
                    .refreshable {
                        await viewModel.loadThreads(
                            isDemoMode: authViewModel.isDemoMode,
                            sessionStore: sessionStore
                        )
                        await viewModel.loadComposeClients(
                            isDemoMode: authViewModel.isDemoMode,
                            sessionStore: sessionStore
                        )
                    }
                }
                .allowsHitTesting(selectedThreadId == nil)
                .accessibilityHidden(selectedThreadId != nil)

                if let threadId = selectedThreadId {
                    MessageThreadView(
                        threadId: threadId,
                        viewModel: viewModel,
                        drawerState: drawerState,
                        initialComposerDraft: pendingThreadComposerDraft,
                        onConsumedComposerDraft: { pendingThreadComposerDraft = "" },
                        onBack: {
                            selectedThreadId = nil
                            pendingThreadComposerDraft = ""
                        }
                    )
                    .transition(.move(edge: .trailing))
                    .zIndex(1)
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(selectedThreadId == nil ? .large : .inline)
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

                            Button(action: {
                                resetComposePrefill()
                                showingCompose = true
                            }) {
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
                    prefillMessage: composePrefillMessage,
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
            .onChange(of: selectedThreadId) { _, threadId in
                // Thread owns left-edge swipe for back; inbox allows root drawer edge-open.
                drawerState.suppressDrawerEdgeOpen = threadId != nil
                guard threadId == nil else { return }
                Task {
                    await viewModel.loadComposeClients(
                        isDemoMode: authViewModel.isDemoMode,
                        sessionStore: sessionStore
                    )
                }
            }
            .onChange(of: drawerState.selectedSection) { _, section in
                if section == .messages {
                    drawerState.suppressDrawerEdgeOpen = selectedThreadId != nil
                }
            }
            .onChange(of: drawerState.messagesOpenThreadId) { _, threadId in
                applyOpenThreadFromPush(threadId)
            }
            .onChange(of: drawerState.messagesShouldOpenCompose) { _, shouldOpen in
                guard shouldOpen else { return }
                applyMessagesComposePrefill(from: drawerState)
                selectedThreadId = nil
                showingCompose = true
            }
            .onChange(of: drawerState.appTourDismissModalsToken) { _, _ in
                selectedThreadId = nil
                showingCompose = false
            }
            .onChange(of: appTour.activeStep) { _, step in
                guard step == .messagesReply else { return }
                Task {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    if selectedThreadId == nil, let first = filteredSummaries.first {
                        selectedThreadId = first.threadId
                    }
                }
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
                await viewModel.loadComposeClients(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await viewModel.loadSmsQuickPresets(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                applyOpenThreadFromPush(drawerState.messagesOpenThreadId)
                if drawerState.messagesShouldOpenCompose {
                    applyMessagesComposePrefill(from: drawerState)
                    showingCompose = true
                }
            }
            .onDisappear {
                viewModel.stopThreadsListening()
                drawerState.suppressDrawerEdgeOpen = false
            }
        }
        .navigationViewStyle(.stack)
    }

    private func applyOpenThreadFromPush(_ threadId: String?) {
        let trimmed = (threadId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        showingCompose = false
        let draft = (drawerState.messagesComposeBody ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        pendingThreadComposerDraft = draft
        drawerState.messagesComposeBody = nil
        selectedThreadId = PhoneFormatting.smsThreadId(trimmed)
        drawerState.messagesOpenThreadId = nil
    }

    private func applyMessagesComposePrefill(from drawerState: DrawerState) {
        composePrefillPhone = drawerState.messagesComposePhone ?? ""
        composePrefillName = drawerState.messagesComposeClientName ?? ""
        composePrefillBookingRequestId = drawerState.messagesComposeBookingRequestId
        composePrefillMessage = drawerState.messagesComposeBody ?? ""
        drawerState.messagesComposePhone = nil
        drawerState.messagesComposeClientName = nil
        drawerState.messagesComposeBookingRequestId = nil
        drawerState.messagesComposeBody = nil
        drawerState.messagesShouldOpenCompose = false
    }

    private func resetComposePrefill() {
        composePrefillPhone = ""
        composePrefillName = ""
        composePrefillBookingRequestId = nil
        composePrefillMessage = ""
    }
}

struct ThreadRow: View {
    let summary: SmsThreadSummary
    @ObservedObject var viewModel: MessagesViewModel
    var showsDivider: Bool = true

    private var displayName: String {
        viewModel.resolvedDisplayName(for: summary)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                AppAvatarView(
                    tenantLogoURL: nil,
                    accountPhotoURL: nil,
                    displayNameFallback: displayName,
                    size: 44
                )
                VStack(alignment: .leading, spacing: 4) {
                    Text(displayName)
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
    @EnvironmentObject var appTour: AppTourCoordinator
    let threadId: String
    @ObservedObject var viewModel: MessagesViewModel
    var drawerState: DrawerState
    var initialComposerDraft: String = ""
    var onConsumedComposerDraft: () -> Void = {}
    let onBack: () -> Void
    @State private var messages: [Message] = []
    @State private var newMessage = ""
    @State private var isLoading = false
    @State private var clientName = "Customer"
    @State private var clientPhone = ""
    @State private var linkedBookingRequestId: String?
    @State private var showThreadError = false
    @State private var showClientProfile = false
    @StateObject private var clientsViewModel = ClientsViewModel()
    @FocusState private var isComposerFocused: Bool
    @State private var mediaPreviewSelection: MessageMediaPreviewSelection?
    @State private var interactiveBackOffset: CGFloat = 0

    private let interactiveBackEdgeWidth: CGFloat = 28
    private let interactiveBackDismissThreshold: CGFloat = 110

    var body: some View {
        VStack(spacing: 0) {
            // Header: back, name, phone, profile
            HStack(spacing: 16) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 32, height: 36)
                        .contentShape(Rectangle())
                }
                Button {
                    openClientProfile()
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(clientName)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(AppDesign.textPrimary)
                        if !clientPhone.isEmpty {
                            Text(clientPhone)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                Spacer()
                Button {
                    openClientProfile()
                } label: {
                    Image(systemName: "info.circle")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(AppDesign.textPrimary)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel("Customer profile")
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
                                MessageBubble(message: message) { urls, index in
                                    isComposerFocused = false
                                    mediaPreviewSelection = MessageMediaPreviewSelection(
                                        urls: urls,
                                        initialIndex: index
                                    )
                                }
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
                .onChange(of: isComposerFocused) { _, focused in
                    guard focused, let last = messages.last else { return }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(280))
                        withAnimation {
                            proxy.scrollTo(last.stableId, anchor: .bottom)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            MessageComposerBar(
                message: $newMessage,
                darkStyle: false,
                placeholder: "Type a message...",
                quickPresets: viewModel.smsQuickPresets,
                isSending: isLoading,
                canSend: true,
                onSend: sendMessage,
                onSendPaymentRequest: sendPaymentRequest,
                onSendPhoto: sendPhoto,
                clientName: clientName,
                clientPhone: clientPhone,
                bookingRequestId: linkedBookingRequestId,
                drawerState: drawerState,
                isDemoMode: authViewModel.isDemoMode,
                fieldFocused: $isComposerFocused
            )
            .appTourAnchor(.messagesReply, isActive: appTour.isStepActive(.messagesReply))
        }
        .background(AppDesign.cardBackground)
        .offset(x: max(0, interactiveBackOffset))
        .shadow(color: interactiveBackOffset > 0 ? Color.black.opacity(0.12) : .clear, radius: 8, x: -4, y: 0)
        .overlay(alignment: .leading) {
            Color.clear
                .frame(width: interactiveBackEdgeWidth)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .highPriorityGesture(interactiveBackGesture)
                .accessibilityHidden(true)
        }
        .fullScreenCover(item: $mediaPreviewSelection) { selection in
            BookingRequestMediaFullScreenPreview(
                urls: selection.urls,
                initialIndex: selection.initialIndex
            )
        }
        .task {
            if let summary = viewModel.summary(for: threadId) {
                clientPhone = PhoneFormatting.displayUS(summary.clientPhoneForSend)
                clientName = viewModel.resolvedDisplayName(for: summary)
            }
            await sessionStore.loadBookingsIfNeeded(isDemoMode: authViewModel.isDemoMode)
            let phoneForLookup = clientPhone.isEmpty ? threadId : clientPhone
            linkedBookingRequestId = BookingRequestPaymentLookup.bookingRequestId(
                forClientPhone: phoneForLookup,
                in: sessionStore.bookingRequests
            )
            await clientsViewModel.loadClients(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            await viewModel.loadComposeClients(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            refreshClientDisplayName()
            await loadMessages()
            await viewModel.loadSmsQuickPresets(isDemoMode: authViewModel.isDemoMode)
        }
        .onChange(of: viewModel.threadSummaries) { _, _ in
            refreshClientDisplayName()
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
            applyPendingComposerDraftIfNeeded()
        }
        .onChange(of: initialComposerDraft) { _, _ in
            applyPendingComposerDraftIfNeeded()
        }
        .onDisappear {
            viewModel.stopListeningToMessages(threadId: threadId)
        }
        .sheet(isPresented: $showClientProfile, onDismiss: {
            Task {
                await clientsViewModel.refreshClients(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await viewModel.loadComposeClients(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                refreshClientDisplayName()
            }
        }) {
            NavigationStack {
                ClientProfileView(
                    client: clientsViewModel.resolveClient(
                        name: clientName,
                        phone: clientPhone.isEmpty ? threadId : clientPhone
                    ),
                    clientsViewModel: clientsViewModel,
                    drawerState: drawerState
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showClientProfile = false }
                    }
                }
            }
            .environmentObject(authViewModel)
            .environmentObject(sessionStore)
        }
    }

    private var interactiveBackGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                let dx = value.translation.width
                let dy = abs(value.translation.height)
                guard dx > 0, dx > dy * 0.6 else { return }
                if isComposerFocused {
                    isComposerFocused = false
                }
                interactiveBackOffset = dx
            }
            .onEnded { value in
                let shouldGoBack =
                    value.translation.width > interactiveBackDismissThreshold
                    || value.predictedEndTranslation.width > interactiveBackDismissThreshold * 1.6
                if shouldGoBack {
                    onBack()
                } else {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
                        interactiveBackOffset = 0
                    }
                }
            }
    }

    private func applyPendingComposerDraftIfNeeded() {
        let draft = initialComposerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.isEmpty else { return }
        newMessage = draft
        isComposerFocused = true
        onConsumedComposerDraft()
    }

    private func openClientProfile() {
        isComposerFocused = false
        showClientProfile = true
    }

    private func refreshClientDisplayName() {
        let phone = clientPhone.isEmpty
            ? (viewModel.summary(for: threadId)?.clientPhoneForSend ?? threadId)
            : clientPhone
        if clientPhone.isEmpty {
            clientPhone = PhoneFormatting.displayUS(phone)
        }
        let stored = viewModel.summary(for: threadId)?.clientName
            ?? messages.first?.clientName
            ?? clientName
        clientName = ClientsViewModel.displayName(
            stored: stored,
            phone: phone,
            clients: clientsViewModel.clients.isEmpty
                ? viewModel.composeClients
                : clientsViewModel.clients
        )
    }

    private func loadMessages() async {
        messages = await viewModel.loadMessages(
            for: threadId,
            isDemoMode: authViewModel.isDemoMode,
            sessionStore: sessionStore
        )
        if clientPhone.isEmpty, let first = messages.first {
            clientPhone = PhoneFormatting.displayUS(first.clientId)
        }
        refreshClientDisplayName()
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
            let summary = viewModel.summary(for: threadId)
            let ok = await viewModel.sendMessage(
                threadId: threadId,
                content: body,
                clientName: clientName,
                clientId: summary?.clientPhoneForSend,
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

    private func sendPaymentRequest(kind: MessagePaymentSheetKind, amountCents: Int, url: String) {
        isLoading = true
        Task {
            let summary = viewModel.summary(for: threadId)
            let ok = await viewModel.sendMessage(
                threadId: threadId,
                content: "",
                clientName: clientName,
                clientId: summary?.clientPhoneForSend,
                paymentKind: kind.paymentKind,
                amountCents: amountCents,
                paymentUrl: url,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            await MainActor.run {
                if ok {
                    isComposerFocused = false
                }
                isLoading = false
            }
        }
    }

    private func sendPhoto(_ imageDataList: [Data], caption: String) {
        isLoading = true
        Task {
            let summary = viewModel.summary(for: threadId)
            let ok = await viewModel.sendPhotoMessage(
                threadId: threadId,
                imageDataList: imageDataList,
                caption: caption,
                clientName: clientName,
                clientId: summary?.clientPhoneForSend,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            await MainActor.run {
                if ok {
                    isComposerFocused = false
                }
                isLoading = false
            }
        }
    }
}

struct MessageBubble: View {
    let message: Message
    var onOpenMedia: (([URL], Int) -> Void)? = nil

    private var isAdmin: Bool { message.sender == .admin }

    var body: some View {
        HStack {
            if isAdmin {
                Spacer()
            }
            VStack(alignment: isAdmin ? .trailing : .leading, spacing: 4) {
                if message.isPaymentRequest {
                    MessagePaymentBubble(message: message, isAdmin: isAdmin)
                } else {
                    VStack(alignment: isAdmin ? .trailing : .leading, spacing: 8) {
                        if message.hasMedia {
                            MessageMediaBubble(
                                urls: message.mediaUrls,
                                isAdmin: isAdmin,
                                onOpen: onOpenMedia
                            )
                        }
                        let text = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !text.isEmpty {
                            MessageBubbleText(content: message.content, isAdmin: isAdmin)
                                .padding()
                                .background(isAdmin ? AppDesign.messageSentBackground : AppDesign.searchBackground)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                    }
                }
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

private struct MessageMediaBubble: View {
    let urls: [String]
    let isAdmin: Bool
    var onOpen: (([URL], Int) -> Void)? = nil

    private var resolvedURLs: [URL] {
        urls.compactMap { raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return URL(string: trimmed)
        }
    }

    var body: some View {
        VStack(alignment: isAdmin ? .trailing : .leading, spacing: 6) {
            ForEach(Array(resolvedURLs.enumerated()), id: \.offset) { index, url in
                Button {
                    onOpen?(resolvedURLs, index)
                } label: {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFill()
                                .frame(width: 220, height: 280)
                                .clipped()
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        case .failure:
                            mediaPlaceholder(systemName: "photo")
                        case .empty:
                            ProgressView()
                                .frame(width: 220, height: 160)
                                .background(isAdmin ? AppDesign.messageSentBackground : AppDesign.searchBackground)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        @unknown default:
                            mediaPlaceholder(systemName: "photo")
                        }
                    }
                    .frame(width: 220, height: 280)
                    .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View photo")
            }
        }
    }

    private func mediaPlaceholder(systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.title2)
            .foregroundStyle(isAdmin ? Color.white.opacity(0.8) : AppDesign.textSecondary)
            .frame(width: 220, height: 160)
            .background(isAdmin ? AppDesign.messageSentBackground : AppDesign.searchBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct MessageMediaPreviewSelection: Identifiable {
    let id: String
    let urls: [URL]
    let initialIndex: Int

    init(urls: [URL], initialIndex: Int) {
        self.urls = urls
        self.initialIndex = max(0, min(initialIndex, max(urls.count - 1, 0)))
        let joined = urls.map(\.absoluteString).joined(separator: "|")
        self.id = "\(joined)#\(self.initialIndex)"
    }
}

/// Apple Cash–style amount card for deposit / payment link messages.
private struct MessagePaymentBubble: View {
    let message: Message
    let isAdmin: Bool

    private var payURL: URL? {
        guard let raw = message.paymentUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "creditcard.fill")
                    .font(.system(size: 13, weight: .semibold))
                Text(message.paymentKind?.title ?? "Payment")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isAdmin ? Color.white.opacity(0.9) : AppDesign.textSecondary)

            Text(message.formattedPaymentAmount ?? "$0.00")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(isAdmin ? Color.white : AppDesign.textPrimary)
                .monospacedDigit()

            if let url = payURL {
                Link(destination: url) {
                    Text("Pay")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(isAdmin ? Color.white.opacity(0.22) : AppDesign.accentBlue)
                        .foregroundStyle(isAdmin ? Color.white : Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
        .padding(16)
        .frame(minWidth: 168, maxWidth: 260, alignment: .leading)
        .background(isAdmin ? AppDesign.messageSentBackground : AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
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
    var prefillMessage: String = ""
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
                    canSend: recipientPhoneForSend != nil,
                    onSend: sendMessage,
                    onSendPaymentRequest: sendPaymentRequest,
                    onSendPhoto: sendPhoto,
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
            if message.isEmpty, !prefillMessage.isEmpty {
                message = prefillMessage
            }
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
            if !prefillMessage.isEmpty {
                toFieldFocused = true
            } else if clientPhone.isEmpty {
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
            let memberLine: String? = {
                let access = authViewModel.teamAccess
                guard access.usesOwnSms else { return nil }
                let phone = access.memberSmsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
                return phone.isEmpty ? nil : phone
            }()
            let ok = await viewModel.sendMessage(
                threadId: e164Phone,
                content: trimmedMessage,
                clientName: name.isEmpty ? nil : name,
                clientId: e164Phone,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore,
                memberLinePhone: memberLine
            )
            if ok {
                let openId: String = {
                    if let memberLine,
                       let scoped = PhoneFormatting.lineScopedThreadId(linePhone: memberLine, clientPhone: e164Phone) {
                        return scoped
                    }
                    return e164Phone
                }()
                onSent?(openId)
                dismiss()
            }
        }
    }

    private func sendPaymentRequest(kind: MessagePaymentSheetKind, amountCents: Int, url: String) {
        guard let e164Phone = recipientPhoneForSend else {
            viewModel.lastError = "Enter a valid phone number."
            return
        }
        var name = selectedClientName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            if let match = viewModel.composeClients.first(where: {
                PhoneFormatting.digits(from: $0.phone ?? "") == PhoneFormatting.digits(from: e164Phone)
            }) {
                name = match.name
            }
        }
        Task {
            let memberLine: String? = {
                let access = authViewModel.teamAccess
                guard access.usesOwnSms else { return nil }
                let phone = access.memberSmsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
                return phone.isEmpty ? nil : phone
            }()
            let ok = await viewModel.sendMessage(
                threadId: e164Phone,
                content: "",
                clientName: name.isEmpty ? nil : name,
                clientId: e164Phone,
                paymentKind: kind.paymentKind,
                amountCents: amountCents,
                paymentUrl: url,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore,
                memberLinePhone: memberLine
            )
            if ok {
                let openId: String = {
                    if let memberLine,
                       let scoped = PhoneFormatting.lineScopedThreadId(linePhone: memberLine, clientPhone: e164Phone) {
                        return scoped
                    }
                    return e164Phone
                }()
                onSent?(openId)
                dismiss()
            }
        }
    }

    private func sendPhoto(_ imageDataList: [Data], caption: String) {
        guard let e164Phone = recipientPhoneForSend else {
            viewModel.lastError = "Enter a valid phone number."
            return
        }
        var name = selectedClientName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            if let match = viewModel.composeClients.first(where: {
                PhoneFormatting.digits(from: $0.phone ?? "") == PhoneFormatting.digits(from: e164Phone)
            }) {
                name = match.name
            }
        }
        Task {
            let memberLine: String? = {
                let access = authViewModel.teamAccess
                guard access.usesOwnSms else { return nil }
                let phone = access.memberSmsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
                return phone.isEmpty ? nil : phone
            }()
            let ok = await viewModel.sendPhotoMessage(
                threadId: e164Phone,
                imageDataList: imageDataList,
                caption: caption,
                clientName: name.isEmpty ? nil : name,
                clientId: e164Phone,
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore,
                memberLinePhone: memberLine
            )
            if ok {
                let openId: String = {
                    if let memberLine,
                       let scoped = PhoneFormatting.lineScopedThreadId(linePhone: memberLine, clientPhone: e164Phone) {
                        return scoped
                    }
                    return e164Phone
                }()
                onSent?(openId)
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

