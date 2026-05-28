import SwiftUI

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
        case .unread: return s == "new" && br.readAt == nil
        case .newOnly: return s == "new"
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
    @StateObject private var viewModel = RequestsViewModel()
    @State private var requestFilter: BookingRequestFilter = .all
    @State private var teamFilterKey: String = BookingAssigneeFilter.allKey
    @State private var selectedRequest: Request?
    @State private var selectedBookingRequest: BookingRequest?
    @State private var searchText = ""
    @State private var showSeedConfirm = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                Text("Manage and review appointment requests")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.bottom, 8)

                // Search
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.gray)
                    TextField("Search by name or email...", text: $searchText)
                }
                .padding(10)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(10)
                .padding(.horizontal)
                .padding(.bottom, 8)

                // Team filter (tenant) or status filter (legacy) + refresh
                HStack(alignment: .center, spacing: 8) {
                    if showsTeamFilter {
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
                    } else if !viewModel.useTenantData {
                        filterMenuLabel(
                            title: "\(requestFilter.title) (\(legacyFilterCount(for: requestFilter)))"
                        ) {
                            Picker("Status", selection: $requestFilter) {
                                ForEach(BookingRequestFilter.allCases) { filter in
                                    Text("\(filter.title) (\(legacyFilterCount(for: filter)))")
                                        .tag(filter)
                                }
                            }
                        }
                    }

                    Button(action: { Task { await viewModel.loadRequests(isDemoMode: authViewModel.isDemoMode) } }) {
                        Image(systemName: "arrow.clockwise")
                            .padding(8)
                            .background(Color.black)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 12)

                // List
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
                    List {
                        if viewModel.useTenantData {
                            ForEach(filteredBookingRequests) { br in
                                BookingRequestListRow(request: br)
                                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                    .listRowSeparator(.hidden)
                                    .listRowBackground(Color.clear)
                                    .onTapGesture { selectedBookingRequest = br }
                            }
                        } else {
                            ForEach(filteredRequests) { request in
                                RequestListRow(request: request)
                                    .onTapGesture { selectedRequest = request }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(Color(.systemGroupedBackground))

                    Text("Showing \(viewModel.useTenantData ? filteredBookingRequests.count : filteredRequests.count) of \(viewModel.useTenantData ? viewModel.bookingRequests.count : viewModel.requests.count) request(s)")
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
            }
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
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
            .sheet(item: $selectedBookingRequest) { br in
                BookingRequestDetailView(
                    request: br,
                    viewModel: viewModel,
                    drawerState: drawerState,
                    teamAccess: authViewModel.teamAccess
                )
            }
            .task {
                await viewModel.loadRequests(isDemoMode: authViewModel.isDemoMode)
                await authViewModel.refreshTeamAccess()
            }
        }
        .navigationViewStyle(.stack)
    }

    private var showsTeamFilter: Bool {
        viewModel.useTenantData && authViewModel.teamAccess.canViewAllBookings
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
            .background(Color.gray.opacity(0.12))
            .foregroundColor(.primary)
            .cornerRadius(8)
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
        if !searchText.isEmpty {
            list = list.filter {
                ($0.customerName ?? "").localizedCaseInsensitiveContains(searchText) ||
                ($0.customerEmail ?? "").localizedCaseInsensitiveContains(searchText)
            }
        }
        return list
    }
}

// MARK: - Status Badge (Square-style colored pill)
private func statusBadgeColor(_ status: String) -> Color {
    switch status.lowercased() {
    case "new": return Color.green
    case "confirmed": return Color.blue
    case "reviewed": return Color.gray
    case "declined", "cancelled": return Color.red.opacity(0.9)
    default: return Color.gray
    }
}

struct StatusBadgeView: View {
    let status: String

    var body: some View {
        Text(status.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(statusBadgeColor(status))
            .clipShape(Capsule())
    }
}

struct BookingRequestListRow: View {
    let request: BookingRequest

    /// Green dot only for unread NEW requests; no dot otherwise.
    private var showUnreadNewDot: Bool {
        request.status.uppercased() == "NEW" && request.readAt == nil
    }

    private var serviceAndDateLine: String {
        let service = (request.serviceName ?? request.serviceSlug ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let when = request.requestedStartTime ?? request.createdAt
        let dateStr = when.map {
            $0.formatted(.dateTime.month(.abbreviated).day().year())
        } ?? ""
        let staff = request.assignedMemberDisplayLabel
        var parts: [String] = []
        if !service.isEmpty { parts.append(service) }
        if !dateStr.isEmpty { parts.append(dateStr) }
        if let staff, !staff.isEmpty { parts.append(staff) }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(Color.black)
                .frame(width: 48, height: 48)
                .overlay(
                    Text((request.customerName ?? "?").prefix(2).uppercased())
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 4) {
                Text(request.customerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                Text(serviceAndDateLine)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                Text(request.createdAt?.formatted(.dateTime.month(.abbreviated).day().hour().minute()) ?? "Submitted —")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Group {
                if showUnreadNewDot {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 8, height: 8)
                } else {
                    Color.clear.frame(width: 8, height: 8)
                }
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
        }
        .padding(16)
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }
}

struct BookingRequestDetailView: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    var drawerState: DrawerState
    let teamAccess: EffectiveTeamAccess
    @Environment(\.dismiss) var dismiss
    @State private var assigneePickerKey: String = BookingAssigneeFilter.unassignedKey
    @State private var assigneePickerReady = false
    @State private var showAssignScheduleSheet = false
    @State private var contactAlreadyExists = false

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

    private var canShowApprovalActions: Bool {
        teamAccess.canApproveRejectRequests &&
            (statusLower == "new" || statusLower == "pending")
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 16) {
                    // Header: avatar, name (no status pill — read state uses `readAt` only)
                    VStack(spacing: 12) {
                        Circle()
                            .fill(Color.black)
                            .frame(width: 64, height: 64)
                            .overlay(
                                Text((request.customerName ?? "?").prefix(2).uppercased())
                                    .font(.title2.weight(.semibold))
                                    .foregroundColor(.white)
                            )
                        Text(request.customerName ?? "Unknown")
                            .font(.title2.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                    .padding(.horizontal, 16)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Service / appointment type
                    VStack(alignment: .leading, spacing: 12) {
                        BookingRequestSectionHeader(title: "Service")
                        BookingRequestDetailRow(
                            label: "Appointment type",
                            value: currentRequest.serviceName ?? currentRequest.serviceSlug ?? "—"
                        )
                        if canManageAssignment {
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
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Appointment scheduling
                    VStack(alignment: .leading, spacing: 12) {
                        BookingRequestSectionHeader(title: "Appointment")
                        if let start = request.requestedStartTime {
                            BookingRequestDetailRow(
                                label: "Date",
                                value: start.formatted(.dateTime.month(.abbreviated).day().year()),
                                systemImage: "calendar"
                            )
                            BookingRequestDetailRow(
                                label: "Time",
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
                            BookingRequestDetailRow(label: "Preferred", value: pt, systemImage: "clock")
                        }
                        if let days = request.preferredDays, !days.isEmpty {
                            BookingRequestDetailRow(
                                label: "Preferred days",
                                value: days.joined(separator: ", ")
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Contact
                    VStack(alignment: .leading, spacing: 0) {
                        BookingRequestSectionHeader(title: "Contact")
                            .padding(.bottom, 8)
                        if let phone = request.customerPhone, !phone.isEmpty,
                           let telURL = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })"), !phone.filter(\.isNumber).isEmpty {
                            Link(destination: telURL) {
                                HStack(spacing: 12) {
                                    Image(systemName: "phone.fill")
                                        .font(.body)
                                        .foregroundColor(.green)
                                        .frame(width: 24, alignment: .center)
                                    Text(PhoneFormatting.displayUS(phone))
                                        .font(.subheadline.weight(.medium))
                                        .foregroundColor(.primary)
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }
                            if let em = request.customerEmail, !em.isEmpty { Divider() }
                        }
                        if let email = request.customerEmail, !email.isEmpty,
                           let mailURL = URL(string: "mailto:\(email)") {
                            Link(destination: mailURL) {
                                HStack(spacing: 12) {
                                    Image(systemName: "envelope.fill")
                                        .font(.body)
                                        .foregroundColor(.blue)
                                        .frame(width: 24, alignment: .center)
                                    Text(email)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundColor(.primary)
                                        .lineLimit(2)
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }
                        }
                        Divider()
                            .padding(.vertical, 8)
                        if contactAlreadyExists {
                            Button(action: openCustomerInCustomersList) {
                                HStack(spacing: 12) {
                                    Image(systemName: "person.2.fill")
                                        .font(.body)
                                        .foregroundColor(.blue)
                                        .frame(width: 24, alignment: .center)
                                    Text("View in Customers")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(.primary)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .padding(.vertical, 8)
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
                                HStack(spacing: 12) {
                                    Image(systemName: "person.crop.circle.badge.plus")
                                        .font(.body)
                                        .foregroundColor(.green)
                                        .frame(width: 24, alignment: .center)
                                    Text("Add to contacts")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(.primary)
                                    Spacer()
                                }
                                .padding(.vertical, 8)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Notes
                    if let notes = request.notes, !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            BookingRequestSectionHeader(title: "Notes")
                            Text(notes)
                                .font(.subheadline)
                                .foregroundColor(.primary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(Color(.systemBackground))
                        .cornerRadius(12)
                        .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    }

                    // Custom form fields (web / admin)
                    BookingRequestFormSectionsView(
                        responses: request.formResponses,
                        bookingTemplate: viewModel.tenantBookingTemplate
                    )

                    if canShowApprovalActions {
                        VStack(spacing: 12) {
                            if let err = viewModel.actionError {
                                Text(err)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            HStack(spacing: 12) {
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
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                }
                                .buttonStyle(.bordered)
                                .disabled(viewModel.isUpdatingStatus || (request.documentId ?? "").isEmpty)

                                Button {
                                    Task {
                                        await viewModel.setBookingRequestStatus(
                                            requestId: request.documentId ?? "",
                                            status: "confirmed",
                                            notes: request.notes
                                        )
                                    }
                                } label: {
                                    Text("Confirm")
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(viewModel.isUpdatingStatus || (request.documentId ?? "").isEmpty)
                            }
                        }
                        .padding(16)
                        .background(Color(.systemBackground))
                        .cornerRadius(12)
                        .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    } else if teamAccess.bookingRequiresApproval && !teamAccess.canApproveRejectRequests && (statusLower == "new" || statusLower == "pending") {
                        Text("You can view this request but cannot approve or decline it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                            .background(Color(.systemBackground))
                            .cornerRadius(12)
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(request.customerName ?? "Request")
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
                    Button("Done") { dismiss() }
                }
            }
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $showAssignScheduleSheet) {
            AssignBookingScheduleSheet(request: currentRequest, viewModel: viewModel)
        }
        .task(id: request.documentId) {
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
        }
        .onChange(of: assigneePickerKey) { _, newKey in
            guard assigneePickerReady else { return }
            Task { await applyAssigneePickerKey(newKey) }
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
                    currentRequest.hasAssignedMember ? "Change time & assignee" : "Pick time & assign",
                    systemImage: "calendar.badge.clock"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            DisclosureGroup("Quick assign") {
                quickAssignPicker
            }
            .font(.caption)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    /// First open sets `readAt` in Firestore (status stays NEW). List hides the green dot after reload.
    private func markReadIfNeeded() async {
        guard currentRequest.readAt == nil else { return }
        guard let rid = currentRequest.documentId else { return }
        _ = await viewModel.markBookingRequestAsRead(requestId: rid)
    }

    private func openCustomerInCustomersList() {
        guard let customerId = RequestsViewModel.customerDocumentId(for: currentRequest) else { return }
        drawerState.customersDetailClientId = customerId
        drawerState.selectedSection = .clients
        drawerState.isOpen = false
        dismiss()
    }
}

struct RequestListRow: View {
    let request: Request

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "square")
                .font(.body)
                .foregroundColor(.gray)
            Circle()
                .fill(Color.black)
                .frame(width: 40, height: 40)
                .overlay(
                    Text(request.customerName.prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName)
                    .font(.subheadline.weight(.semibold))
                Text(request.customerEmail)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                if let phone = request.customerPhone {
                    Text(PhoneFormatting.displayUS(phone))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
            Text(request.appointmentDate != nil ? request.appointmentDate!.formatted(.dateTime.month(.abbreviated).day()) : request.submittedAt.formatted(.dateTime.month(.abbreviated).day()))
                .font(.caption)
                .foregroundColor(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 8)
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
