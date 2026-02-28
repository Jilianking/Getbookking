import SwiftUI

struct RequestsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = RequestsViewModel()
    @State private var selectedStatus: Request.RequestStatus? = nil
    @State private var selectedRequest: Request?
    @State private var selectedBookingRequest: BookingRequest?
    @State private var searchText = ""
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

                // Filter + refresh
                HStack {
                    Button(action: {}) {
                        HStack(spacing: 4) {
                            Text("All (\(viewModel.useTenantData ? viewModel.bookingRequests.count : viewModel.requests.count))")
                            Image(systemName: "arrow.up.arrow.down")
                                .font(.caption2)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(8)
                    }
                    .foregroundColor(.primary)
                    Spacer()
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
                }
            }
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .sheet(item: $selectedRequest) { request in
                RequestDetailView(request: request, viewModel: viewModel, drawerState: drawerState)
            }
            .sheet(item: $selectedBookingRequest) { br in
                BookingRequestDetailView(request: br, drawerState: drawerState)
            }
            .task {
                await viewModel.loadRequests(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }

    private var filteredRequests: [Request] {
        var list = viewModel.requests
        if let status = selectedStatus {
            list = list.filter { $0.status == status }
        }
        if !searchText.isEmpty {
            list = list.filter {
                $0.customerName.localizedCaseInsensitiveContains(searchText) ||
                ($0.customerEmail.localizedCaseInsensitiveContains(searchText))
            }
        }
        return list
    }

    private var filteredBookingRequests: [BookingRequest] {
        var list = viewModel.bookingRequests
        if let status = selectedStatus {
            list = list.filter { br in
                if status == .pending {
                    return br.status == "pending" || br.status == "NEW"
                }
                return br.status == status.rawValue
            }
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
                if let service = request.serviceName ?? request.serviceSlug, !service.isEmpty {
                    Text(service)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.gray.opacity(0.15))
                        .clipShape(Capsule())
                }
                Text(request.createdAt?.formatted(.dateTime.month(.abbreviated).day().hour().minute()) ?? "-")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            Spacer()
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
    var drawerState: DrawerState
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 16) {
                    // Hero header: large avatar, name
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

                    // Service card
                    VStack(alignment: .leading, spacing: 10) {
                        Text(request.serviceName ?? request.serviceSlug ?? "-")
                            .font(.headline.weight(.semibold))
                        if let pt = request.preferredTime, !pt.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "clock")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text("Preferred: \(pt)")
                                    .font(.subheadline)
                            }
                            .foregroundColor(.secondary)
                        }
                        if let start = request.requestedStartTime {
                            HStack(spacing: 6) {
                                Image(systemName: "calendar")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text("Requested: \(start.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")
                                    .font(.subheadline)
                            }
                            .foregroundColor(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Contact card with quick actions
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Contact")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.secondary)
                            .padding(.bottom, 12)
                        if let phone = request.customerPhone, !phone.isEmpty,
                           let telURL = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })"), !phone.filter(\.isNumber).isEmpty {
                            Link(destination: telURL) {
                                HStack(spacing: 12) {
                                    Image(systemName: "phone.fill")
                                        .font(.body)
                                        .foregroundColor(.green)
                                        .frame(width: 24, alignment: .center)
                                    Text(phone)
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
                            if let email = request.customerEmail, !email.isEmpty { Divider() }
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
                                        .lineLimit(1)
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)

                    // Notes card (if present)
                    if let notes = request.notes, !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Notes")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(.secondary)
                            Text(notes)
                                .font(.subheadline)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(Color(.systemBackground))
                        .cornerRadius(12)
                        .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
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
                    Text(phone)
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
                        Text(phone)
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
