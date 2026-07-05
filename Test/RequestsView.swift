import SwiftUI
import FirebaseAuth

// MARK: - Booking request list filter (tenant + legacy)

private enum BookingRequestFilter: Int, CaseIterable, Identifiable, Hashable {
    case all
    case unread
    case newOnly
    case confirmed
    case cancelledOrDeclined

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .unread: return "Unread"
        case .newOnly: return "New"
        case .confirmed: return "Confirmed"
        case .cancelledOrDeclined: return "Cancelled / Declined"
        }
    }

    func matches(_ br: BookingRequest) -> Bool {
        let s = br.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch self {
        case .all: return true
        case .unread: return (s == "new" || s == "pending") && br.readAt == nil
        case .newOnly: return s == "new" || s == "pending"
        case .confirmed: return s == "confirmed"
        case .cancelledOrDeclined: return s == "cancelled" || s == "declined"
        }
    }

    func matches(_ r: Request) -> Bool {
        switch self {
        case .all: return true
        case .unread: return r.status == .pending && r.reviewedAt == nil
        case .newOnly: return r.status == .pending
        case .confirmed: return r.status == .confirmed
        case .cancelledOrDeclined: return r.status == .cancelled || r.status == .declined
        }
    }
}

struct RequestsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var appTour: AppTourCoordinator
    @StateObject private var viewModel = RequestsViewModel()
    @State private var requestFilter: BookingRequestFilter = .newOnly
    @State private var teamFilterKey: String = BookingAssigneeFilter.allKey
    @State private var selectedRequest: Request?
    @State private var selectedBookingRequest: BookingRequest?
    @State private var openConfirmWhenDetailAppears = false
    @State private var searchText = ""
    @State private var showSeedConfirm = false
    var drawerState: DrawerState
    let sectionTitle: String

    private var statusChipFilters: [(filter: BookingRequestFilter, title: String)] {
        [
            (.all, "All"),
            (.newOnly, "New"),
            (.confirmed, "Confirmed"),
        ]
    }

    var body: some View {
        navigationContent
            .navigationViewStyle(.stack)
    }

    private var navigationContent: some View {
        NavigationView {
            requestsScreenContent
                .appScreenBackground()
                .appNavigationChrome()
                .navigationTitle(sectionTitle)
                .navigationBarTitleDisplayMode(.large)
                .toolbar { requestsToolbar }
                .confirmationDialog(
                    "Load test booking requests?",
                    isPresented: $showSeedConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Add 100 test requests") {
                        Task { await viewModel.seedTestBookingRequests(count: 100) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Inserts sample rows into your business (source: seed). Owner only. Use on test tenants like test100.")
                }
                .sheet(item: $selectedRequest) { request in
                    RequestDetailView(request: request, viewModel: viewModel, drawerState: drawerState)
                }
                .sheet(item: $selectedBookingRequest, onDismiss: {
                    openConfirmWhenDetailAppears = false
                }) { br in
                    BookingRequestDetailView(
                        request: br,
                        viewModel: viewModel,
                        drawerState: drawerState,
                        teamAccess: authViewModel.teamAccess,
                        openConfirmOnAppear: openConfirmWhenDetailAppears
                    )
                }
                .onAppear {
                    viewModel.sessionStore = sessionStore
                }
                .task {
                    viewModel.sessionStore = sessionStore
                    await viewModel.loadRequests(
                        isDemoMode: authViewModel.isDemoMode,
                        sessionStore: sessionStore
                    )
                }
                .onChange(of: drawerState.appTourDismissModalsToken) { _, _ in
                    selectedBookingRequest = nil
                    selectedRequest = nil
                }
        }
    }

    private var requestsScreenContent: some View {
        VStack(spacing: 0) {
            searchAndFilterHeader
            requestsListBody
        }
    }

    private var searchAndFilterHeader: some View {
        VStack(spacing: 0) {
            AppSearchField(placeholder: "Search by name or email...", text: $searchText)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 10)

            AppFilterChipBar(filters: statusChipFilters, selection: $requestFilter)
                .padding(.bottom, 10)
                .appTourAnchor(
                    .requestsApprove,
                    isActive: appTour.isStepActive(.requestsApprove)
                        && viewModel.useTenantData
                        && filteredBookingRequests.isEmpty
                )

            if showsTeamFilter {
                teamFilterBar
            }
        }
    }

    private var teamFilterBar: some View {
        HStack(spacing: 8) {
            filterMenuLabel(
                title: "\(teamFilterTitle) (\(teamFilterCount(for: teamFilterKey)))"
            ) {
                Picker("Filter", selection: $teamFilterKey) {
                    Text("All (\(teamFilterCount(for: BookingAssigneeFilter.allKey)))")
                        .tag(BookingAssigneeFilter.allKey)
                    Text("Unassigned (\(teamFilterCount(for: BookingAssigneeFilter.unassignedKey)))")
                        .tag(BookingAssigneeFilter.unassignedKey)
                    if let owner = viewModel.teamFilterOwner {
                        Text("\(teamFilterLabel(for: owner)) (\(teamFilterCount(for: owner.uid)))")
                            .tag(owner.uid)
                    }
                    ForEach(viewModel.teamFilterRoster.filter { $0.accessRole != .owner }) { member in
                        Text("\(teamFilterLabel(for: member)) (\(teamFilterCount(for: member.uid)))")
                            .tag(member.uid)
                    }
                }
            }
            Button(action: refreshRequests) {
                Image(systemName: "arrow.clockwise")
                    .font(.body.weight(.medium))
                    .foregroundStyle(AppDesign.textPrimary)
                    .padding(10)
                    .background(AppDesign.cardBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(AppDesign.chipBorder, lineWidth: 1)
                    )
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private var requestsListBody: some View {
        if viewModel.isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.useTenantData && !authViewModel.teamAccess.canViewAllBookings {
            ContentUnavailableView(
                "Bookings restricted",
                systemImage: "lock.fill",
                description: Text("You don’t have permission to view all booking requests. Ask the owner to enable “View all bookings” for managers.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            requestsListSection
        }
    }

    private var requestsListSection: some View {
        VStack(spacing: 0) {
            List {
                if viewModel.useTenantData {
                    ForEach(filteredBookingRequests) { br in
                        bookingRequestListRow(br)
                    }
                } else {
                    ForEach(filteredRequests) { request in
                        RequestListRow(request: request)
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                            .onTapGesture { selectedRequest = request }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AppDesign.background)

            requestsListFooter
        }
    }

    private func bookingRequestListRow(_ br: BookingRequest) -> some View {
        BookingRequestListRow(
            request: br,
            viewModel: viewModel,
            teamAccess: authViewModel.teamAccess,
            onMarkRead: { markBookingRequestReadLocally(requestId: $0) },
            onAccept: { openBookingRequestForAccept(br) },
            onOpenDetail: { openBookingRequest(br) }
        )
        .appTourAnchor(
            .requestsApprove,
            isActive: appTour.isStepActive(.requestsApprove)
                && br.documentId == filteredBookingRequests.first?.documentId
        )
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private var requestsListFooter: some View {
        Text(requestsCountLabel)
            .font(.caption)
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)

        if let seedMessage = viewModel.seedMessage {
            Text(seedMessage)
                .font(.caption)
                .foregroundColor(.green)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        if let err = viewModel.actionError {
            Text(err)
                .font(.caption)
                .foregroundColor(.red)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
    }

    private var requestsCountLabel: String {
        let shown = viewModel.useTenantData ? filteredBookingRequests.count : filteredRequests.count
        let total = viewModel.useTenantData ? viewModel.bookingRequests.count : viewModel.requests.count
        return "Showing \(shown) of \(total) request(s)"
    }

    @ToolbarContentBuilder
    private var requestsToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
            Button(action: { drawerState.isOpen = true }) {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(AppDesign.textPrimary)
            }
        }
        #if DEBUG
        ToolbarItem(placement: .navigationBarTrailing) {
            if authViewModel.teamAccess.isOwner,
               viewModel.useTenantData,
               !authViewModel.isDemoMode {
                Button {
                    showSeedConfirm = true
                } label: {
                    if viewModel.isSeeding {
                        ProgressView()
                    } else {
                        Image(systemName: "tray.and.arrow.down.fill")
                    }
                }
                .disabled(viewModel.isSeeding)
            }
        }
        #endif
    }

    private func refreshRequests() {
        Task {
            await viewModel.refreshRequests(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
    }

    private func markBookingRequestReadLocally(requestId: String) {
        sessionStore.markBookingRequestReadLocally(requestId: requestId)
        if let index = viewModel.bookingRequests.firstIndex(where: { $0.documentId == requestId }) {
            viewModel.bookingRequests[index].readAt = Date()
        }
    }

    private func openBookingRequest(_ booking: BookingRequest) {
        openConfirmWhenDetailAppears = false
        markBookingRequestReadLocally(booking)
        selectedBookingRequest = booking
        Task {
            await viewModel.markBookingRequestAsReadIfNeeded(booking)
        }
    }

    private func openBookingRequestForAccept(_ booking: BookingRequest) {
        openConfirmWhenDetailAppears = true
        markBookingRequestReadLocally(booking)
        selectedBookingRequest = booking
        Task {
            await viewModel.markBookingRequestAsReadIfNeeded(booking)
        }
    }

    /// Immediate badge drop — does not wait on Firestore or view model tenant id.
    private func markBookingRequestReadLocally(_ booking: BookingRequest) {
        guard booking.readAt == nil,
              let requestId = booking.documentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requestId.isEmpty else { return }
        let readAt = Date()
        sessionStore.markBookingRequestReadLocally(requestId: requestId, readAt: readAt)
        if let index = viewModel.bookingRequests.firstIndex(where: { $0.documentId == requestId }) {
            viewModel.bookingRequests[index].readAt = readAt
        }
    }

    private var showsTeamFilter: Bool {
        viewModel.useTenantData
            && authViewModel.teamAccess.canViewAllBookings
            && authViewModel.teamAccess.showsStaffAssignmentUI(
                rosterCount: viewModel.teamFilterRoster.count
            )
    }

    @ViewBuilder
    private func filterMenuLabel<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Menu {
            content()
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppDesign.searchBackground)
            .foregroundStyle(AppDesign.textPrimary)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(AppDesign.chipBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var teamFilterTitle: String {
        switch teamFilterKey {
        case BookingAssigneeFilter.allKey:
            return "All"
        case BookingAssigneeFilter.unassignedKey:
            return "Unassigned"
        default:
            if let member = viewModel.teamFilterRoster.first(where: { $0.uid == teamFilterKey }) {
                return teamFilterLabel(for: member)
            }
            return "Team"
        }
    }

    private func teamFilterLabel(for member: TenantTeamMember) -> String {
        if member.accessRole == .owner { return "Owner" }
        return member.displayName
    }

    private func teamFilterCount(for key: String) -> Int {
        viewModel.bookingRequests.filter {
            $0.matchesAssigneeFilter(key: key, roster: viewModel.teamFilterRoster)
        }.count
    }

    private func legacyFilterCount(for filter: BookingRequestFilter) -> Int {
        viewModel.requests.filter { filter.matches($0) }.count
    }

    private var filteredRequests: [Request] {
        var list = viewModel.requests.filter { requestFilter.matches($0) }
        if !searchText.isEmpty {
            list = list.filter {
                $0.customerName.localizedCaseInsensitiveContains(searchText) ||
                ($0.customerEmail.localizedCaseInsensitiveContains(searchText))
            }
        }
        return list
    }

    private var filteredBookingRequests: [BookingRequest] {
        var list = viewModel.bookingRequests.filter {
            $0.matchesAssigneeFilter(key: teamFilterKey, roster: viewModel.teamFilterRoster)
        }
        list = list.filter { requestFilter.matches($0) }
        if !searchText.isEmpty {
            list = list.filter {
                ($0.customerName ?? "").localizedCaseInsensitiveContains(searchText) ||
                ($0.customerEmail ?? "").localizedCaseInsensitiveContains(searchText)
            }
        }
        return list
    }
}

struct StatusBadgeView: View {
    let status: String

    var body: some View {
        AppStatusPill(text: status, soft: true)
    }
}

struct BookingRequestListRow: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    let teamAccess: EffectiveTeamAccess
    var onMarkRead: ((String) -> Void)? = nil
    var onAccept: (() -> Void)? = nil
    var onOpenDetail: (() -> Void)? = nil

    private var statusLower: String {
        request.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var isPendingConfirmation: Bool {
        statusLower == "new" || statusLower == "pending"
    }

    private var canShowDeclineAction: Bool {
        teamAccess.canApproveRejectRequests && isPendingConfirmation
    }

    private var canShowAcceptAction: Bool {
        (teamAccess.isOwner || teamAccess.canViewAllBookings) && isPendingConfirmation
    }

    private var canShowApprovalActions: Bool {
        canShowDeclineAction || canShowAcceptAction
    }

    private var serviceName: String {
        (request.serviceName ?? request.serviceSlug ?? "Appointment").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var submittedAgo: String {
        guard let created = request.createdAt else { return "" }
        let interval = Date().timeIntervalSince(created)
        if interval < 3600 { return "\(max(1, Int(interval / 60)))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return created.formatted(.dateTime.month(.abbreviated).day())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            summarySection
            approvalActionsSection
        }
        .padding(16)
        .appCard()
    }

    private var summarySection: some View {
        Button(action: { onOpenDetail?() }) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    AppAvatarView(
                        tenantLogoURL: nil,
                        accountPhotoURL: nil,
                        displayNameFallback: request.customerName,
                        size: 44
                    )
                    VStack(alignment: .leading, spacing: 4) {
                        Text(request.customerName ?? "Unknown")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.textPrimary)
                        if !submittedAgo.isEmpty {
                            Text("Requested \(submittedAgo)")
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                    Spacer(minLength: 8)
                    AppStatusPill(text: request.status, soft: true)
                }

                metadataChipsRow
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var metadataChipsRow: some View {
        HStack(spacing: 8) {
            AppMetadataChip(icon: "scissors", text: serviceName)
            if let start = request.requestedStartTime {
                AppMetadataChip(
                    icon: "calendar",
                    text: start.formatted(.dateTime.month(.abbreviated).day())
                )
                AppMetadataChip(
                    icon: "clock",
                    text: start.formatted(date: .omitted, time: .shortened)
                )
            } else if let preferred = request.preferredTime, !preferred.isEmpty {
                AppMetadataChip(icon: "clock", text: preferred)
            }
        }
    }

    @ViewBuilder
    private var approvalActionsSection: some View {
        if canShowApprovalActions, let docId = request.documentId, !docId.isEmpty {
            HStack(spacing: 12) {
                if canShowDeclineAction {
                    declineButton(docId: docId)
                }
                if canShowAcceptAction {
                    acceptButton
                }
            }
        }
    }

    private func declineButton(docId: String) -> some View {
        Button {
            onMarkRead?(docId)
            Task {
                await viewModel.setBookingRequestStatus(
                    requestId: docId,
                    status: "declined",
                    notes: request.notes
                )
            }
        } label: {
            Text("Decline")
        }
        .buttonStyle(AppDeclineButtonStyle(enabled: !viewModel.isUpdatingStatus))
        .disabled(viewModel.isUpdatingStatus)
    }

    private var acceptButton: some View {
        Button(action: { onAccept?() }) {
            Text("Accept")
        }
        .buttonStyle(AppPrimaryButtonStyle(enabled: !viewModel.isUpdatingStatus))
        .disabled(viewModel.isUpdatingStatus)
    }
}

struct BookingRequestDetailView: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    var drawerState: DrawerState
    let teamAccess: EffectiveTeamAccess
    var openConfirmOnAppear: Bool = false
    @EnvironmentObject var sessionStore: TenantSessionStore
    @Environment(\.dismiss) var dismiss
    @State private var assigneePickerKey: String = BookingAssigneeFilter.unassignedKey
    @State private var assigneePickerReady = false
    @State private var showAssignScheduleSheet = false
    @State private var showConfirmAppointmentSheet = false
    @State private var confirmAppointmentSheetIsReschedule = false
    @State private var contactAlreadyExists = false
    @State private var didPresentInitialConfirm = false

    private var currentRequest: BookingRequest {
        guard let id = request.documentId,
              let fresh = viewModel.bookingRequests.first(where: { $0.documentId == id }) else {
            return request
        }
        return fresh
    }

    private var statusLower: String {
        currentRequest.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var canManageAssignment: Bool {
        teamAccess.isOwner || teamAccess.canViewAllBookings
    }

    private var showsStaffAssignmentUI: Bool {
        teamAccess.showsStaffAssignmentUI(rosterCount: viewModel.teamFilterRoster.count)
    }

    private var canPickArtistOnConfirm: Bool {
        canManageAssignment && showsStaffAssignmentUI
    }

    private var canShowApprovalActions: Bool {
        teamAccess.canApproveRejectRequests &&
            (statusLower == "new" || statusLower == "pending")
    }

    private var canConfirmPendingAppointment: Bool {
        canManageAssignment && isPendingConfirmation
    }

    private var canShowDeclineAction: Bool {
        canShowApprovalActions
    }

    private var confirmedTimeLabel: String {
        if statusLower == "confirmed", let start = currentRequest.requestedStartTime {
            return start.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
        }
        return "Not set yet"
    }

    private var isPendingConfirmation: Bool {
        statusLower == "new" || statusLower == "pending"
    }

    private var canEditConfirmedTime: Bool {
        if isPendingConfirmation { return canConfirmPendingAppointment }
        if statusLower == "confirmed" { return canManageAssignment }
        return false
    }

    private var canSendDepositSmsForRequest: Bool {
        guard teamAccess.canSendClientSms else { return false }
        let phone = (currentRequest.customerPhone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !PhoneFormatting.digits(from: phone).isEmpty
    }

    private var confirmedTimeSystemImage: String {
        statusLower == "confirmed" && currentRequest.requestedStartTime != nil
            ? "checkmark.circle.fill"
            : "clock.badge.questionmark"
    }

    var body: some View {
        detailNavigationStack
            .sheet(isPresented: $showAssignScheduleSheet) {
                AssignBookingScheduleSheet(
                    request: currentRequest,
                    viewModel: viewModel,
                    showsStaffPicker: showsStaffAssignmentUI
                )
            }
            .sheet(isPresented: $showConfirmAppointmentSheet) {
                ConfirmBookingAppointmentSheet(
                    request: currentRequest,
                    viewModel: viewModel,
                    canPickArtist: canPickArtistOnConfirm,
                    currentMemberUid: Auth.auth().currentUser?.uid,
                    isReschedule: confirmAppointmentSheetIsReschedule,
                    requiresDeposit: teamAccess.confirmationType.requiresDeposit,
                    depositAmount: teamAccess.depositAmount ?? viewModel.workflowDepositAmount,
                    canSendDepositSms: canSendDepositSmsForRequest
                )
            }
            .task(id: request.documentId) {
                markReadLocallyIfNeeded()
                await markReadIfNeeded()
                let exists = await viewModel.isBookingRequestCustomerInContacts(currentRequest)
                await MainActor.run { contactAlreadyExists = exists }
            }
            .onAppear {
                assigneePickerKey = Self.assigneePickerKey(
                    for: currentRequest,
                    roster: viewModel.teamFilterRoster
                )
                assigneePickerReady = true
                presentInitialConfirmIfNeeded()
            }
            .onChange(of: assigneePickerKey) { _, newKey in
                guard assigneePickerReady else { return }
                Task { await applyAssigneePickerKey(newKey) }
            }
    }

    private var detailNavigationStack: some View {
        NavigationView {
            ScrollView {
                detailScrollContent
                    .padding(16)
            }
            .appScreenBackground()
            .navigationTitle(request.customerName ?? "Request")
            .toolbar { detailToolbar }
        }
        .navigationViewStyle(.stack)
    }

    @ViewBuilder
    private var detailScrollContent: some View {
        VStack(spacing: 16) {
            detailHeaderCard
            serviceCard
            appointmentCard
            BookingRequestFormSectionsView(
                responses: currentRequest.formResponses,
                bookingTemplate: viewModel.tenantBookingTemplate
            )
            if let notes = request.notes, !notes.isEmpty {
                notesCard(notes)
            }
            contactCard
            approvalActionsCard
        }
    }

    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
            Button(action: {
                dismiss()
                drawerState.isOpen = true
            }) {
                Image(systemName: "line.3.horizontal")
            }
        }
        ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
        }
    }

    private var detailHeaderCard: some View {
        VStack(spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: nil,
                displayNameFallback: request.customerName ?? "?",
                size: 64
            )
            Text(request.customerName ?? "Unknown")
                .font(.title2.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
            AppStatusPill(text: currentRequest.status, soft: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .padding(.horizontal, 16)
        .appCard()
    }

    private var serviceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            BookingRequestSectionHeader(title: "Service")
            BookingRequestDetailRow(
                label: "Appointment type",
                value: currentRequest.serviceName ?? currentRequest.serviceSlug ?? "—"
            )
            if canManageAssignment, !isPendingConfirmation, showsStaffAssignmentUI {
                assignFromScheduleSection
            } else if let staff = currentRequest.assignedMemberDisplayLabel {
                BookingRequestDetailRow(label: "Assigned to", value: staff, systemImage: "person.fill")
            }
            if let mode = currentRequest.bookingModeUsed, !mode.isEmpty {
                BookingRequestDetailRow(label: "Booking mode", value: mode)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var appointmentCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            BookingRequestSectionHeader(title: "Appointment request")
            if let start = request.requestedStartTime {
                BookingRequestDetailRow(
                    label: "Requested date",
                    value: start.formatted(.dateTime.month(.abbreviated).day().year()),
                    systemImage: "calendar"
                )
                BookingRequestDetailRow(
                    label: "Requested time",
                    value: start.formatted(date: .omitted, time: .shortened),
                    systemImage: "clock"
                )
            } else if let created = request.createdAt {
                BookingRequestDetailRow(
                    label: "Submitted",
                    value: created.formatted(.dateTime.month(.abbreviated).day().year().hour().minute()),
                    systemImage: "calendar"
                )
            }
            if let pt = request.preferredTime, !pt.isEmpty {
                BookingRequestDetailRow(label: "Preferred time", value: pt, systemImage: "clock")
            }
            if let days = request.preferredDays, !days.isEmpty {
                BookingRequestDetailRow(
                    label: "Preferred days",
                    value: days.joined(separator: ", ")
                )
            }
            confirmedTimeSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    @ViewBuilder
    private var confirmedTimeSection: some View {
        if canEditConfirmedTime {
            Button(action: openConfirmedTimeEditor) {
                BookingRequestDetailRow(
                    label: "Confirmed time",
                    value: confirmedTimeLabel,
                    systemImage: confirmedTimeSystemImage,
                    showsChevron: true
                )
            }
            .buttonStyle(.plain)
        } else {
            BookingRequestDetailRow(
                label: "Confirmed time",
                value: confirmedTimeLabel,
                systemImage: confirmedTimeSystemImage
            )
        }
    }

    private func presentInitialConfirmIfNeeded() {
        guard openConfirmOnAppear, !didPresentInitialConfirm, canConfirmPendingAppointment else { return }
        didPresentInitialConfirm = true
        confirmAppointmentSheetIsReschedule = false
        showConfirmAppointmentSheet = true
    }

    private func openConfirmedTimeEditor() {
        confirmAppointmentSheetIsReschedule = !isPendingConfirmation
        showConfirmAppointmentSheet = true
    }

    private func notesCard(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            BookingRequestSectionHeader(title: "Notes")
            Text(notes)
                .font(.subheadline)
                .foregroundColor(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var contactCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            BookingRequestSectionHeader(title: "Contact")
                .padding(.bottom, 8)
            contactPhoneSection
            contactEmailSection
            Divider()
                .padding(.vertical, 8)
            contactCustomerSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    @ViewBuilder
    private var contactPhoneSection: some View {
        if let phone = request.customerPhone, !phone.isEmpty,
           let telURL = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })"),
           !phone.filter(\.isNumber).isEmpty {
            Link(destination: telURL) {
                contactRow(
                    icon: "phone.fill",
                    iconColor: .green,
                    title: PhoneFormatting.displayUS(phone),
                    trailing: "arrow.up.right"
                )
            }
            Divider()
            Button(action: openMessagesForClient) {
                contactRow(
                    icon: "message.fill",
                    iconColor: .blue,
                    title: "Message client",
                    trailing: "chevron.right"
                )
            }
            if let em = request.customerEmail, !em.isEmpty { Divider() }
        }
    }

    @ViewBuilder
    private var contactEmailSection: some View {
        if let email = request.customerEmail, !email.isEmpty,
           let mailURL = URL(string: "mailto:\(email)") {
            Link(destination: mailURL) {
                contactRow(
                    icon: "envelope.fill",
                    iconColor: .blue,
                    title: email,
                    trailing: "arrow.up.right",
                    titleLineLimit: 2
                )
            }
        }
    }

    @ViewBuilder
    private var contactCustomerSection: some View {
        if contactAlreadyExists {
            Button(action: openCustomerInCustomersList) {
                contactRow(
                    icon: "person.2.fill",
                    iconColor: .blue,
                    title: "View in Customers",
                    trailing: "chevron.right",
                    titleSemibold: true
                )
            }
        } else {
            Button {
                Task {
                    let saved = await viewModel.addBookingRequestCustomerToContacts(currentRequest)
                    if saved {
                        await MainActor.run { contactAlreadyExists = true }
                    }
                }
            } label: {
                contactRow(
                    icon: "person.crop.circle.badge.plus",
                    iconColor: .green,
                    title: "Add to contacts",
                    titleSemibold: true
                )
            }
        }
    }

    private func contactRow(
        icon: String,
        iconColor: Color,
        title: String,
        trailing: String? = nil,
        titleLineLimit: Int? = nil,
        titleSemibold: Bool = false
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundColor(iconColor)
                .frame(width: 24, alignment: .center)
            Text(title)
                .font(titleSemibold ? .subheadline.weight(.semibold) : .subheadline.weight(.medium))
                .foregroundColor(.primary)
                .lineLimit(titleLineLimit)
            Spacer()
            if let trailing {
                Image(systemName: trailing)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, trailing == nil ? 8 : 12)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var approvalActionsCard: some View {
        if canConfirmPendingAppointment || canShowDeclineAction {
            VStack(spacing: 12) {
                if let err = viewModel.actionError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack(spacing: 12) {
                    if canShowDeclineAction {
                        Button {
                            Task {
                                await viewModel.setBookingRequestStatus(
                                    requestId: request.documentId ?? "",
                                    status: "declined",
                                    notes: request.notes
                                )
                            }
                        } label: {
                            Text("Decline")
                        }
                        .buttonStyle(AppDeclineButtonStyle(enabled: !viewModel.isUpdatingStatus && !(request.documentId ?? "").isEmpty))
                        .disabled(viewModel.isUpdatingStatus || (request.documentId ?? "").isEmpty)
                    }

                    if canConfirmPendingAppointment {
                        Button {
                            confirmAppointmentSheetIsReschedule = false
                            showConfirmAppointmentSheet = true
                        } label: {
                            Text("Accept")
                        }
                        .buttonStyle(AppPrimaryButtonStyle(enabled: !viewModel.isUpdatingStatus && !(request.documentId ?? "").isEmpty))
                        .disabled(viewModel.isUpdatingStatus || (request.documentId ?? "").isEmpty)
                    }
                }
            }
            .padding(16)
            .appCard()
        } else if teamAccess.bookingRequiresApproval && !teamAccess.canApproveRejectRequests && (statusLower == "new" || statusLower == "pending") {
            Text("You can view this request but cannot approve or decline it.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .appCard()
        }
    }

    private var assignFromScheduleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let staff = currentRequest.assignedMemberDisplayLabel,
               let start = currentRequest.requestedStartTime {
                BookingRequestDetailRow(
                    label: "Assigned to",
                    value: "\(staff) · \(start.formatted(date: .omitted, time: .shortened))",
                    systemImage: "person.fill"
                )
            } else if let staff = currentRequest.assignedMemberDisplayLabel {
                BookingRequestDetailRow(label: "Assigned to", value: staff, systemImage: "person.fill")
            }
            Button {
                showAssignScheduleSheet = true
            } label: {
                Label(
                    assignScheduleButtonTitle,
                    systemImage: "calendar.badge.clock"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            if showsStaffAssignmentUI {
                DisclosureGroup("Quick assign") {
                    quickAssignPicker
                }
                .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var assignScheduleButtonTitle: String {
        if showsStaffAssignmentUI {
            return currentRequest.hasAssignedMember ? "Change time & assignee" : "Pick time & assign"
        }
        return currentRequest.requestedStartTime != nil ? "Change time" : "Pick time"
    }

    private var quickAssignPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Assign to", selection: $assigneePickerKey) {
                Text("Unassigned").tag(BookingAssigneeFilter.unassignedKey)
                ForEach(viewModel.teamFilterRoster) { member in
                    Text(assigneeOptionLabel(for: member)).tag(member.uid)
                }
            }
            .pickerStyle(.menu)
            .disabled(viewModel.isUpdatingAssignment || (currentRequest.documentId ?? "").isEmpty)
            if viewModel.isUpdatingAssignment {
                ProgressView()
                    .scaleEffect(0.85)
            }
        }
    }

    private func assigneeOptionLabel(for member: TenantTeamMember) -> String {
        if member.accessRole == .owner { return "Owner" }
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return member.displayName }
        return "\(member.displayName) · \(title)"
    }

    private func applyAssigneePickerKey(_ key: String) async {
        guard let rid = currentRequest.documentId, !rid.isEmpty else { return }
        let savedKey = Self.assigneePickerKey(for: currentRequest, roster: viewModel.teamFilterRoster)
        guard key != savedKey else { return }
        if key == BookingAssigneeFilter.unassignedKey {
            await viewModel.assignBookingRequest(requestId: rid, member: nil)
        } else if let member = viewModel.teamFilterRoster.first(where: { $0.uid == key }) {
            await viewModel.assignBookingRequest(requestId: rid, member: member)
        }
        await MainActor.run {
            let fresh = viewModel.bookingRequests.first(where: { $0.documentId == rid }) ?? currentRequest
            assigneePickerReady = false
            if viewModel.actionError != nil {
                assigneePickerKey = savedKey
            } else {
                assigneePickerKey = Self.assigneePickerKey(for: fresh, roster: viewModel.teamFilterRoster)
            }
            assigneePickerReady = true
        }
    }

    private static func assigneePickerKey(for request: BookingRequest, roster: [TenantTeamMember]) -> String {
        let uid = (request.assignedMemberUid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !uid.isEmpty, roster.contains(where: { $0.uid == uid }) { return uid }
        let reqEmail = (request.assignedMemberEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !reqEmail.isEmpty,
           let match = roster.first(where: { $0.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == reqEmail }) {
            return match.uid
        }
        let reqName = (request.assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !reqName.isEmpty,
           let match = roster.first(where: { $0.displayName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == reqName }) {
            return match.uid
        }
        return BookingAssigneeFilter.unassignedKey
    }

    private func markReadLocallyIfNeeded() {
        guard currentRequest.readAt == nil,
              let requestId = currentRequest.documentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requestId.isEmpty else { return }
        let readAt = Date()
        sessionStore.markBookingRequestReadLocally(requestId: requestId, readAt: readAt)
        if let index = viewModel.bookingRequests.firstIndex(where: { $0.documentId == requestId }) {
            viewModel.bookingRequests[index].readAt = readAt
        }
    }

    /// Detail open also marks read (idempotent if list tap already did).
    private func markReadIfNeeded() async {
        await viewModel.markBookingRequestAsReadIfNeeded(currentRequest)
    }

    private func openCustomerInCustomersList() {
        guard let customerId = RequestsViewModel.customerDocumentId(for: currentRequest) else { return }
        drawerState.customersDetailClientId = customerId
        drawerState.selectedSection = .clients
        drawerState.isOpen = false
        dismiss()
    }

    private func openMessagesForClient() {
        guard let phone = currentRequest.customerPhone, !phone.isEmpty else { return }
        drawerState.messagesComposePhone = phone
        drawerState.messagesComposeClientName = currentRequest.customerName ?? ""
        drawerState.messagesComposeBookingRequestId = currentRequest.documentId
        drawerState.messagesShouldOpenCompose = true
        drawerState.selectedSection = .messages
        drawerState.isOpen = false
        dismiss()
    }
}

struct RequestListRow: View {
    let request: Request

    var body: some View {
        HStack(spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: nil,
                displayNameFallback: request.customerName,
                size: 44
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(request.customerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text(request.customerEmail)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            AppStatusPill(text: request.status.rawValue, soft: true)
        }
        .padding(16)
        .appCard()
    }
}

struct RequestDetailView: View {
    let request: Request
    @ObservedObject var viewModel: RequestsViewModel
    var drawerState: DrawerState
    @Environment(\.dismiss) var dismiss
    @State private var status: Request.RequestStatus
    @State private var notes = ""

    init(request: Request, viewModel: RequestsViewModel, drawerState: DrawerState) {
        self.request = request
        self.viewModel = viewModel
        self.drawerState = drawerState
        _status = State(initialValue: request.status)
        _notes = State(initialValue: request.notes ?? "")
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Customer Information")) {
                    Text(request.customerName)
                    Text(request.customerEmail)
                    if let phone = request.customerPhone {
                        Text(PhoneFormatting.displayUS(phone))
                    }
                }

                Section(header: Text("Service Details")) {
                    Text(request.service.rawValue.capitalized)
                    Text(request.preferredTime)
                    if let description = request.description {
                        Text(description)
                    }
                }

                Section(header: Text("Status")) {
                    Picker("Status", selection: $status) {
                        ForEach([Request.RequestStatus.pending, .discussed, .confirmed, .declined, .cancelled], id: \.self) { s in
                            Text(s.rawValue.capitalized).tag(s)
                        }
                    }
                }

                Section(header: Text("Notes")) {
                    TextEditor(text: $notes)
                        .frame(height: 100)
                }

                Section {
                    Button("Save Changes") {
                        saveChanges()
                    }
                }
            }
            .appListSurface()
            .appScreenBackground()
            .navigationTitle(request.customerName)
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
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func saveChanges() {
        guard let id = request.id else { return }
        Task {
            await viewModel.updateRequest(id, status: status, notes: notes.isEmpty ? nil : notes)
            dismiss()
        }
    }
}
