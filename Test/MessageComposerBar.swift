//
//  MessageComposerBar.swift
//
//  iMessage-style composer with labeled + action tray.
//

import SwiftUI
import FirebaseAuth
import PhotosUI
import UIKit

// MARK: - Icons (Assets.xcassets, sourced from ui_icons.svg)

enum MessageComposerIcon: CaseIterable, Identifiable {
    case photo
    case deposit
    case paymentLink
    case bookingLink
    case bookAppointment
    case quickReplies

    var id: String { title }

    var title: String {
        switch self {
        case .photo: return "Photo"
        case .deposit: return "Request deposit"
        case .paymentLink: return "Request payment"
        case .bookingLink: return "Booking link"
        case .bookAppointment: return "Book session"
        case .quickReplies: return "Quick reply"
        }
    }

    var accessibilityLabel: String { title }

    var systemImage: String {
        switch self {
        case .photo: return "photo.fill"
        case .deposit: return "arrow.down.circle.fill"
        case .paymentLink: return "creditcard.fill"
        case .bookingLink: return "link"
        case .bookAppointment: return "calendar"
        case .quickReplies: return "bolt.fill"
        }
    }

    var accentColor: Color {
        switch self {
        case .photo: return Color(red: 0.35, green: 0.72, blue: 0.45)
        case .deposit: return Color(red: 0.20, green: 0.55, blue: 0.95)
        case .paymentLink: return Color(red: 0.23, green: 0.48, blue: 0.95)
        case .bookingLink: return Color(red: 0.55, green: 0.40, blue: 0.28)
        case .bookAppointment: return Color(red: 0.95, green: 0.55, blue: 0.20)
        case .quickReplies: return Color(white: 0.72)
        }
    }

    /// Top-to-bottom above the +; money actions first (thumb lands here).
    static var stackOrder: [MessageComposerIcon] {
        [.photo, .paymentLink, .deposit, .bookAppointment, .bookingLink, .quickReplies]
    }

    static let iconSize: CGFloat = 36
    static let iconSpacing: CGFloat = 14
    static let plusButtonSize: CGFloat = 36
}

private struct PendingMessagePhoto: Identifiable {
    let id: UUID
    let data: Data
    let image: UIImage

    init(id: UUID = UUID(), data: Data, image: UIImage) {
        self.id = id
        self.data = data
        self.image = image
    }
}

// MARK: - Composer bar

struct MessageComposerBar: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var sessionStore: TenantSessionStore
    @Binding var message: String
    var darkStyle: Bool
    var placeholder: String
    var quickPresets: [String]
    var isSending: Bool
    var canSend: Bool
    var onSend: () -> Void
    /// When set, deposit/payment sheets send a structured amount bubble instead of inserting text.
    var onSendPaymentRequest: ((MessagePaymentSheetKind, Int, String) -> Void)? = nil
    /// Draft photos + optional caption — caller uploads and sends MMS.
    var onSendPhoto: (([Data], String) -> Void)? = nil
    var clientName: String
    var clientPhone: String
    var bookingRequestId: String?
    var drawerState: DrawerState
    var isDemoMode: Bool
    @FocusState.Binding var fieldFocused: Bool
    /// Fired when tray / draft-photo chrome collapses so the thread can pin to the latest message.
    var onComposerChromeChanged: (() -> Void)? = nil

    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @StateObject private var requestsViewModel = RequestsViewModel()
    @State private var actionsExpanded = false
    @State private var quickRepliesExpanded = false
    @State private var bookingUrl = ""
    @State private var paymentSheetKind: MessagePaymentSheetKind?
    @State private var showingStaffScheduleSheet = false
    @State private var showingLegacyBookingForm = false
    @State private var actionNotice: String?
    @State private var showingPhotoPicker = false
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var pendingPhotos: [PendingMessagePhoto] = []

    private static let maxPendingPhotos = 5

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

    private var hasPendingPhoto: Bool { !pendingPhotos.isEmpty }

    private var hasTypedText: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Parent `canSend` = recipient ready; composer also requires text and/or a draft photo.
    private var sendEnabled: Bool {
        !isSending && canSend && (hasTypedText || hasPendingPhoto)
    }


    var body: some View {
        VStack(alignment: .leading, spacing: MessageComposerIcon.iconSpacing) {
            if actionsExpanded {
                actionTray
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            HStack(alignment: .bottom, spacing: 10) {
                plusToggleButton

                VStack(alignment: .leading, spacing: 8) {
                    if quickRepliesExpanded, !usablePresets.isEmpty {
                        quickRepliesPanel
                            .transition(.opacity.combined(with: .move(edge: .trailing)))
                    }
                    if !pendingPhotos.isEmpty {
                        pendingPhotosStrip
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    composerField
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, darkStyle ? 18 : 16)
        .padding(.top, darkStyle ? 12 : 16)
        .padding(.bottom, darkStyle ? 12 : 16)
        .background(composerBackground)
        .animation(.easeOut(duration: 0.22), value: actionsExpanded)
        .animation(.easeOut(duration: 0.22), value: quickRepliesExpanded)
        .animation(.easeOut(duration: 0.2), value: pendingPhotos.count)
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
                bookingRequestId: bookingRequestId,
                sendImmediately: onSendPaymentRequest != nil,
                onComplete: { amountCents, url in
                    if let onSendPaymentRequest {
                        onSendPaymentRequest(kind, amountCents, url)
                    } else {
                        insertIntoMessage(kind.messagePrefix(for: url))
                    }
                    paymentSheetKind = nil
                    collapseMenus()
                },
                onDismiss: { paymentSheetKind = nil }
            )
        }
        .sheet(isPresented: $showingStaffScheduleSheet) {
            StaffScheduleClientAppointmentSheet(
                prefillName: prefillName,
                prefillPhone: prefillPhone,
                viewModel: requestsViewModel,
                canPickArtist: canPickArtistOnConfirm,
                requiresDeposit: authViewModel.teamAccess.confirmationType.requiresDeposit,
                depositAmount: authViewModel.teamAccess.depositAmount ?? requestsViewModel.workflowDepositAmount,
                studioCanSendSms: authViewModel.teamAccess.canSendClientSms
            )
        }
        .sheet(isPresented: $showingLegacyBookingForm) {
            BookingFormView(
                drawerState: drawerState,
                prefillName: prefillName,
                prefillPhone: prefillPhone,
                staffSchedulingForClient: true
            )
            .environmentObject(authViewModel)
        }
        .alert("Message", isPresented: Binding(
            get: { actionNotice != nil },
            set: { if !$0 { actionNotice = nil } }
        )) {
            if actionNotice == Constants.App.paidFeatureUpgradeMessage,
               paymentsViewModel.isTenantOwner {
                Button("Start paid plan") {
                    Task { _ = await paymentsViewModel.startSubscriptionToday() }
                }
            }
            Button("OK", role: .cancel) { actionNotice = nil }
        } message: {
            Text(actionNotice ?? "")
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $photoPickerItems,
            maxSelectionCount: max(1, Self.maxPendingPhotos - pendingPhotos.count),
            matching: .images,
            photoLibrary: .shared()
        )
        .onChange(of: photoPickerItems) { _, newItems in
            guard !newItems.isEmpty else { return }
            Task {
                await loadPendingPhotos(from: newItems)
            }
        }
        .onChange(of: actionsExpanded) { _, expanded in
            // Tray open ⇒ keyboard must stay down and field unfocusable.
            if expanded {
                dismissKeyboard()
            } else {
                notifyComposerChromeChanged()
            }
        }
        .onChange(of: quickRepliesExpanded) { _, expanded in
            if !expanded {
                notifyComposerChromeChanged()
            }
        }
        .onChange(of: pendingPhotos.count) { oldCount, newCount in
            if newCount < oldCount {
                notifyComposerChromeChanged()
            }
        }
    }

    private func notifyComposerChromeChanged() {
        onComposerChromeChanged?()
    }

    private var composerBackground: Color {
        darkStyle ? Color(red: 0.08, green: 0.09, blue: 0.12) : AppDesign.cardBackground
    }

    /// Labeled actions stack upward from the + / ✕ (mockup-style tray).
    private var actionTray: some View {
        VStack(alignment: .leading, spacing: MessageComposerIcon.iconSpacing) {
            if quickRepliesExpanded {
                actionLabeledButton(.quickReplies, isSelected: true)
            } else {
                ForEach(visibleIcons) { icon in
                    actionLabeledButton(icon, isSelected: false)
                }
            }
        }
    }

    private var plusToggleButton: some View {
        Button {
            dismissKeyboard()
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

    private func actionLabeledButton(_ icon: MessageComposerIcon, isSelected: Bool = false) -> some View {
        Button {
            handleAction(icon)
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(icon.accentColor)
                    Image(systemName: icon.systemImage)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(icon == .quickReplies ? Color.black.opacity(0.75) : Color.white)
                }
                .frame(width: MessageComposerIcon.iconSize, height: MessageComposerIcon.iconSize)
                .overlay(
                    Circle()
                        .stroke(isSelected ? Color.white.opacity(0.85) : Color.clear, lineWidth: 2)
                )

                Text(icon.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(darkStyle ? Color.white : AppDesign.textPrimary)
                    .lineLimit(1)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(icon.accessibilityLabel)
        .opacity(isActionAvailable(icon) ? 1 : 0.38)
    }

    // MARK: Composer field

    private var pendingPhotosStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(pendingPhotos) { draft in
                    pendingPhotoThumb(draft)
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 2)
            .padding(.bottom, 2)
        }
    }

    private func pendingPhotoThumb(_ draft: PendingMessagePhoto) -> some View {
        ZStack(alignment: .topTrailing) {
            Image(uiImage: draft.image)
                .resizable()
                .scaledToFill()
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(
                            darkStyle ? Color.white.opacity(0.18) : Color(.separator).opacity(0.35),
                            lineWidth: 1
                        )
                )

            Button {
                removePendingPhoto(id: draft.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(
                        Color.white,
                        Color.black.opacity(0.55)
                    )
            }
            .buttonStyle(.plain)
            .padding(4)
            .accessibilityLabel("Remove photo")
        }
        .frame(width: 72, height: 72)
    }

    @ViewBuilder
    private var composerField: some View {
        if darkStyle {
            HStack(spacing: 8) {
                TextField(placeholder, text: $message, axis: .vertical)
                    .focused($fieldFocused)
                    .foregroundColor(.white)
                    .lineLimit(1...4)
                    .disabled(actionsExpanded)
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
            .allowsHitTesting(!actionsExpanded)
        } else {
            HStack(spacing: 8) {
                TextField(placeholder, text: $message, axis: .vertical)
                    .focused($fieldFocused)
                    .lineLimit(1...4)
                    .disabled(actionsExpanded)
                sendButton(
                    activeColor: AppDesign.brandDark,
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
            .allowsHitTesting(!actionsExpanded)
        }
    }

    private func sendButton(activeColor: Color, idleColor: Color) -> some View {
        Button(action: performSend) {
            if isSending {
                ProgressView()
                    .tint(activeColor)
            } else if darkStyle {
                Image(systemName: sendEnabled ? "arrow.up.circle.fill" : "arrow.up.circle")
                    .font(.system(size: 21, weight: .regular))
                    .foregroundColor(sendEnabled ? activeColor : idleColor)
            } else {
                Image(systemName: "paperplane.fill")
                    .foregroundColor(sendEnabled ? activeColor : idleColor)
            }
        }
        .disabled(!sendEnabled)
    }

    private func performSend() {
        guard sendEnabled else { return }
        if !pendingPhotos.isEmpty {
            let caption = message.trimmingCharacters(in: .whitespacesAndNewlines)
            let payloads = pendingPhotos.map(\.data)
            clearPendingPhotos()
            message = ""
            onSendPhoto?(payloads, caption)
            return
        }
        onSend()
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
        case .photo:
            if isDemoMode {
                actionNotice = "Photos aren't available in demo mode."
                return
            }
            guard onSendPhoto != nil else {
                actionNotice = "Photos aren't available right now."
                return
            }
            if pendingPhotos.count >= Self.maxPendingPhotos {
                actionNotice = "You can attach up to \(Self.maxPendingPhotos) photos."
                return
            }
            collapseMenus()
            showingPhotoPicker = true
        case .deposit:
            if isDemoMode {
                actionNotice = "Deposits aren't available in demo mode."
                return
            }
            guard paymentsViewModel.subscriptionPaid else {
                actionNotice = Constants.App.paidFeatureUpgradeMessage
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
            guard paymentsViewModel.subscriptionPaid else {
                actionNotice = Constants.App.paidFeatureUpgradeMessage
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
            collapseMenus()
            insertIntoMessage("Book online here: \(bookingUrl)", refocusComposer: true)
        case .bookAppointment:
            openStaffScheduleSheet()
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
        case .photo:
            return !isDemoMode && onSendPhoto != nil
        case .deposit, .paymentLink:
            return !isDemoMode && paymentsViewModel.subscriptionPaid && paymentsViewModel.stripeConnected
        case .bookingLink:
            return !bookingUrl.isEmpty
        case .bookAppointment, .quickReplies:
            return true
        }
    }

    private func loadPendingPhotos(from items: [PhotosPickerItem]) async {
        defer {
            Task { @MainActor in
                photoPickerItems = []
            }
        }
        var loaded: [PendingMessagePhoto] = []
        var failed = 0
        for item in items.prefix(Self.maxPendingPhotos) {
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      !data.isEmpty,
                      let image = UIImage(data: data) else {
                    failed += 1
                    continue
                }
                loaded.append(PendingMessagePhoto(data: data, image: image))
            } catch {
                failed += 1
            }
        }
        await MainActor.run {
            if loaded.isEmpty {
                actionNotice = "Couldn't load that photo."
                return
            }
            let room = max(0, Self.maxPendingPhotos - pendingPhotos.count)
            let toAdd = Array(loaded.prefix(room))
            if toAdd.isEmpty {
                actionNotice = "You can attach up to \(Self.maxPendingPhotos) photos."
                return
            }
            pendingPhotos.append(contentsOf: toAdd)
            fieldFocused = true
            if failed > 0 || loaded.count > room {
                // Soft notice only when something was skipped.
                if pendingPhotos.count >= Self.maxPendingPhotos {
                    actionNotice = "You can attach up to \(Self.maxPendingPhotos) photos."
                } else if failed > 0 {
                    actionNotice = "Couldn't load some photos."
                }
            }
        }
    }

    private func removePendingPhoto(id: UUID) {
        pendingPhotos.removeAll { $0.id == id }
    }

    private func clearPendingPhotos() {
        pendingPhotos = []
    }

    private func insertIntoMessage(_ text: String, refocusComposer: Bool = true) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            message = text
        } else {
            message = trimmed + "\n\n" + text
        }
        guard refocusComposer else { return }
        // Wait for the tray collapse to settle, then bring the keyboard back
        // under the field so it doesn't jump with the layout change.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(240))
            fieldFocused = true
        }
    }

    private func collapseMenus() {
        actionsExpanded = false
        quickRepliesExpanded = false
    }

    private func dismissKeyboard() {
        fieldFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private var prefillName: String? {
        let n = clientName.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? nil : n
    }

    private var prefillPhone: String? {
        let p = clientPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? nil : p
    }

    private var canPickArtistOnConfirm: Bool {
        let access = authViewModel.teamAccess
        let canManage = access.canViewAllBookings
        return canManage && access.showsStaffAssignmentUI(
            rosterCount: requestsViewModel.teamFilterRoster.count
        )
    }

    private func openStaffScheduleSheet() {
        Task {
            requestsViewModel.sessionStore = sessionStore
            await requestsViewModel.loadRequests(isDemoMode: isDemoMode, sessionStore: sessionStore)
            await MainActor.run {
                if sessionStore.tenantId != nil {
                    showingStaffScheduleSheet = true
                } else {
                    showingLegacyBookingForm = true
                }
            }
        }
    }

    private func loadComposerContext() async {
        requestsViewModel.sessionStore = sessionStore
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

    var paymentKind: MessagePaymentKind {
        switch self {
        case .deposit: return .deposit
        case .payment: return .payment
        }
    }
}

struct MessageInsertPaymentLinkSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    let kind: MessagePaymentSheetKind
    var bookingRequestId: String?
    var sendImmediately: Bool = false
    let onComplete: (Int, String) -> Void
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
                        Button(sendImmediately ? "Send" : "Add to message") {
                            onComplete(amountCents, urlString)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                } else {
                    Button {
                        isAmountFocused = false
                        Task {
                            viewModel.depositLinkUrl = nil
                            await viewModel.createDepositLink(
                                serviceAmountCents: amountCents,
                                bookingRequestId: bookingRequestId
                            )
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
                ToolbarItemGroup(placement: .keyboard) {
                    ForEach(Self.suggestionAmounts, id: \.cents) { item in
                        Button(item.label) {
                            amountText = String(format: "%.2f", Double(item.cents) / 100)
                        }
                    }
                    Spacer()
                    Button("Done") { isAmountFocused = false }
                }
            }
            .onAppear {
                viewModel.depositLinkUrl = nil
                viewModel.errorMessage = nil
            }
            .onChange(of: viewModel.depositLinkUrl) { _, newValue in
                if newValue != nil {
                    isAmountFocused = false
                }
            }
        }
    }
}
