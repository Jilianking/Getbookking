//
//  MessageComposerBar.swift
//
//  iMessage-style composer with + menu (icons from ui_icons.svg).
//

import SwiftUI
import FirebaseAuth

// MARK: - Icons (Assets.xcassets, sourced from ui_icons.svg)

enum MessageComposerIcon: CaseIterable, Identifiable {
    case deposit
    case paymentLink
    case bookingLink
    case bookAppointment
    case quickReplies

    var id: String { assetName }

    var assetName: String {
        switch self {
        case .deposit: return "MessageIconDeposit"
        case .paymentLink: return "MessageIconPaymentLink"
        case .bookingLink: return "MessageIconBookingLink"
        case .bookAppointment: return "MessageIconBookAppointment"
        case .quickReplies: return "MessageIconQuickReplies"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .deposit: return "Request deposit"
        case .paymentLink: return "Send payment link"
        case .bookingLink: return "Send booking link"
        case .bookAppointment: return "Book appointment"
        case .quickReplies: return "Quick replies"
        }
    }

    /// Top-to-bottom in the fan; deposit sits nearest the + button.
    static var stackOrder: [MessageComposerIcon] {
        [.quickReplies, .bookAppointment, .bookingLink, .paymentLink, .deposit]
    }

    static let iconSize: CGFloat = 40
    static let iconSpacing: CGFloat = 10
    static let plusButtonSize: CGFloat = 36
}

// MARK: - Composer bar

struct MessageComposerBar: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @Binding var message: String
    var darkStyle: Bool
    var placeholder: String
    var quickPresets: [String]
    var isSending: Bool
    var canSend: Bool
    var onSend: () -> Void
    var clientName: String
    var clientPhone: String
    var drawerState: DrawerState
    var isDemoMode: Bool
    @FocusState.Binding var fieldFocused: Bool

    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @State private var actionsExpanded = false
    @State private var quickRepliesExpanded = false
    @State private var bookingUrl = ""
    @State private var paymentSheetKind: MessagePaymentSheetKind?
    @State private var showingBookingForm = false
    @State private var actionNotice: String?

    private var usablePresets: [String] {
        quickPresets
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var visibleIcons: [MessageComposerIcon] {
        var icons = MessageComposerIcon.stackOrder
        if usablePresets.isEmpty {
            icons.removeAll { $0 == .quickReplies }
        }
        return icons
    }


    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            leftActionColumn

            VStack(alignment: .leading, spacing: 8) {
                if quickRepliesExpanded, !usablePresets.isEmpty {
                    quickRepliesPanel
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                }
                composerField
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, darkStyle ? 18 : 16)
        .padding(.top, darkStyle ? 12 : 16)
        .padding(.bottom, darkStyle ? 12 : 16)
        .background(composerBackground)
        .animation(.easeOut(duration: 0.22), value: actionsExpanded)
        .animation(.easeOut(duration: 0.22), value: quickRepliesExpanded)
        .task {
            await loadComposerContext()
        }
        .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
            Task { await paymentsViewModel.refreshStripeConnectStatus(isDemoMode: isDemoMode) }
        }
        .sheet(item: $paymentSheetKind) { kind in
            MessageInsertPaymentLinkSheet(
                viewModel: paymentsViewModel,
                kind: kind,
                onInsert: { text in
                    insertIntoMessage(text)
                    paymentSheetKind = nil
                    collapseMenus()
                },
                onDismiss: { paymentSheetKind = nil }
            )
        }
        .sheet(isPresented: $showingBookingForm) {
            BookingFormView(
                drawerState: drawerState,
                prefillName: prefillName,
                prefillPhone: prefillPhone
            )
            .environmentObject(authViewModel)
        }
        .alert("Message", isPresented: Binding(
            get: { actionNotice != nil },
            set: { if !$0 { actionNotice = nil } }
        )) {
            Button("OK", role: .cancel) { actionNotice = nil }
        } message: {
            Text(actionNotice ?? "")
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { fieldFocused = false }
            }
        }
    }

    private var composerBackground: Color {
        darkStyle ? Color(red: 0.08, green: 0.09, blue: 0.12) : AppDesign.cardBackground
    }

    /// Icons fan upward from ✕ / + on the left edge.
    private var leftActionColumn: some View {
        VStack(spacing: MessageComposerIcon.iconSpacing) {
            if actionsExpanded {
                if quickRepliesExpanded {
                    actionIconButton(.quickReplies, isSelected: true)
                        .transition(.asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .opacity),
                            removal: .opacity
                        ))
                } else {
                    ForEach(visibleIcons) { icon in
                        actionIconButton(icon, isSelected: false)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity
                            ))
                    }
                }
            }

            plusToggleButton
        }
        .frame(width: MessageComposerIcon.iconSize, alignment: .bottom)
    }

    private var plusToggleButton: some View {
        Button {
            withAnimation(.easeOut(duration: 0.22)) {
                if actionsExpanded {
                    collapseMenus()
                } else {
                    quickRepliesExpanded = false
                    actionsExpanded = true
                }
            }
        } label: {
            Image(systemName: actionsExpanded ? "xmark" : "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(darkStyle ? .white.opacity(0.9) : AppDesign.textPrimary)
                .frame(width: MessageComposerIcon.plusButtonSize, height: MessageComposerIcon.plusButtonSize)
                .background(
                    darkStyle
                        ? Color.white.opacity(0.1)
                        : Color(.secondarySystemFill)
                )
                .clipShape(Circle())
        }
        .accessibilityLabel(actionsExpanded ? "Close actions" : "Message actions")
    }

    private func actionIconButton(_ icon: MessageComposerIcon, isSelected: Bool = false) -> some View {
        Button {
            handleAction(icon)
        } label: {
            Image(icon.assetName)
                .resizable()
                .scaledToFit()
                .frame(width: MessageComposerIcon.iconSize, height: MessageComposerIcon.iconSize)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .stroke(isSelected ? Color.blue : Color.clear, lineWidth: 2)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(icon.accessibilityLabel)
        .opacity(isActionAvailable(icon) ? 1 : 0.38)
    }

    // MARK: Composer field

    @ViewBuilder
    private var composerField: some View {
        if darkStyle {
            HStack(spacing: 8) {
                TextField(placeholder, text: $message, axis: .vertical)
                    .focused($fieldFocused)
                    .foregroundColor(.white)
                    .lineLimit(1...4)
                sendButton(
                    activeColor: .blue,
                    idleColor: .white.opacity(0.55)
                )
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 42)
            .overlay(
                RoundedRectangle(cornerRadius: 21)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
        } else {
            HStack(spacing: 8) {
                TextField(placeholder, text: $message, axis: .vertical)
                    .focused($fieldFocused)
                    .lineLimit(1...4)
                sendButton(
                    activeColor: AppDesign.accentBlue,
                    idleColor: .secondary
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 21, style: .continuous)
                    .stroke(Color(.separator).opacity(0.35), lineWidth: 1)
            )
        }
    }

    private func sendButton(activeColor: Color, idleColor: Color) -> some View {
        Button(action: {
            if canSend && !isSending { onSend() }
        }) {
            if isSending {
                ProgressView()
                    .tint(activeColor)
            } else if darkStyle {
                Image(systemName: canSend ? "arrow.up.circle.fill" : "arrow.up.circle")
                    .font(.system(size: 21, weight: .regular))
                    .foregroundColor(canSend ? activeColor : idleColor)
            } else {
                Image(systemName: "paperplane.fill")
                    .foregroundColor(canSend ? activeColor : idleColor)
            }
        }
        .disabled(!canSend || isSending)
    }

    // MARK: Quick replies panel

    private var quickRepliesPanel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Quick replies")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(darkStyle ? Color.white.opacity(0.55) : Color.secondary)
                    .padding(.bottom, 2)

                ForEach(Array(usablePresets.enumerated()), id: \.offset) { _, text in
                    Button {
                        message = text
                        fieldFocused = true
                        withAnimation {
                            quickRepliesExpanded = false
                            actionsExpanded = false
                        }
                    } label: {
                        Text(text)
                            .font(.subheadline.weight(.medium))
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(darkStyle ? Color.white : Color.primary)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(darkStyle ? Color.white.opacity(0.16) : Color(.secondarySystemFill))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(
                                darkStyle ? Color.white.opacity(0.22) : Color(.separator).opacity(0.35),
                                lineWidth: 1
                            )
                    )
                }
            }
        }
        .frame(maxHeight: 220)
    }

    // MARK: Actions

    private func handleAction(_ icon: MessageComposerIcon) {
        switch icon {
        case .deposit:
            if isDemoMode {
                actionNotice = "Deposits aren't available in demo mode."
                return
            }
            guard paymentsViewModel.stripeConnected else {
                actionNotice = paymentsViewModel.stripePaymentsBlockedMessage
                return
            }
            paymentSheetKind = .deposit
        case .paymentLink:
            if isDemoMode {
                actionNotice = "Payment links aren't available in demo mode."
                return
            }
            guard paymentsViewModel.stripeConnected else {
                actionNotice = paymentsViewModel.stripePaymentsBlockedMessage
                return
            }
            paymentSheetKind = .payment
        case .bookingLink:
            guard !bookingUrl.isEmpty else {
                actionNotice = "Your booking site is not set up yet."
                return
            }
            insertIntoMessage("Book online here: \(bookingUrl)")
            collapseMenus()
        case .bookAppointment:
            showingBookingForm = true
            collapseMenus()
        case .quickReplies:
            withAnimation {
                if quickRepliesExpanded {
                    quickRepliesExpanded = false
                } else {
                    quickRepliesExpanded = true
                }
            }
        }
    }

    private func isActionAvailable(_ icon: MessageComposerIcon) -> Bool {
        switch icon {
        case .deposit, .paymentLink:
            return !isDemoMode && paymentsViewModel.stripeConnected
        case .bookingLink:
            return !bookingUrl.isEmpty
        case .bookAppointment, .quickReplies:
            return true
        }
    }

    private func insertIntoMessage(_ text: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            message = text
        } else {
            message = trimmed + "\n\n" + text
        }
        fieldFocused = true
    }

    private func collapseMenus() {
        actionsExpanded = false
        quickRepliesExpanded = false
    }

    private var prefillName: String? {
        let n = clientName.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? nil : n
    }

    private var prefillPhone: String? {
        let p = clientPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? nil : p
    }

    private func loadComposerContext() async {
        await paymentsViewModel.loadData(isDemoMode: isDemoMode)
        guard !isDemoMode, let uid = Auth.auth().currentUser?.uid else { return }
        let firebase = FirebaseService()
        if let profile = try? await firebase.fetchProviderProfile(uid: uid),
           let slug = profile.tenantSlug ?? profile.tenantId,
           !slug.isEmpty {
            bookingUrl = PublicBookingSite.urlString(forSlug: slug)
        }
    }
}

// MARK: - Payment link sheet (insert into composer)

enum MessagePaymentSheetKind: Identifiable {
    case deposit
    case payment

    var id: String {
        switch self {
        case .deposit: return "deposit"
        case .payment: return "payment"
        }
    }

    var title: String {
        switch self {
        case .deposit: return "Request deposit"
        case .payment: return "Send payment link"
        }
    }

    var prompt: String {
        switch self {
        case .deposit: return "Enter deposit amount"
        case .payment: return "Enter payment amount"
        }
    }

    func messagePrefix(for url: String) -> String {
        switch self {
        case .deposit: return "Pay your deposit here: \(url)"
        case .payment: return "Complete your payment here: \(url)"
        }
    }
}

struct MessageInsertPaymentLinkSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    let kind: MessagePaymentSheetKind
    let onInsert: (String) -> Void
    let onDismiss: () -> Void

    @State private var amountText = ""
    @FocusState private var isAmountFocused: Bool

    private static let suggestionAmounts: [(label: String, cents: Int)] = [
        ("$25", 2500),
        ("$50", 5000),
        ("$100", 10_000),
        ("$200", 20_000),
    ]

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var canCreate: Bool { amountCents >= 50 }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text(kind.prompt)
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                TextField("0.00", text: $amountText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .focused($isAmountFocused)
                    .padding(.horizontal, 24)

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                if let urlString = viewModel.depositLinkUrl, !urlString.isEmpty {
                    VStack(spacing: 16) {
                        Text("Link ready")
                            .font(.subheadline.weight(.semibold))
                        Button("Add to message") {
                            onInsert(kind.messagePrefix(for: urlString))
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                } else {
                    Button {
                        Task {
                            viewModel.depositLinkUrl = nil
                            await viewModel.createDepositLink(serviceAmountCents: amountCents)
                        }
                    } label: {
                        HStack {
                            if viewModel.isCreatingDepositLink {
                                ProgressView().tint(.white)
                            } else {
                                Text("Create link")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(canCreate ? Color.green : Color.gray)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                    }
                    .disabled(!canCreate || viewModel.isCreatingDepositLink)
                    .padding(.horizontal, 24)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 20)
            .navigationTitle(kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.depositLinkUrl = nil
                        onDismiss()
                    }
                }
                ToolbarItem(placement: .keyboard) {
                    HStack(spacing: 12) {
                        ForEach(Self.suggestionAmounts, id: \.cents) { item in
                            Button(item.label) {
                                amountText = String(format: "%.2f", Double(item.cents) / 100)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
            .onAppear {
                viewModel.depositLinkUrl = nil
                viewModel.errorMessage = nil
            }
        }
    }
}
