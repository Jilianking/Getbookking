import SwiftUI

struct RequestsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = RequestsViewModel()
    @State private var selectedStatus: Request.RequestStatus? = .pending
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
                BookingRequestDetailView(request: br, viewModel: viewModel, drawerState: drawerState)
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
            list = list.filter { $0.status == status.rawValue }
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

struct BookingRequestListRow: View {
    let request: BookingRequest

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.black)
                .frame(width: 40, height: 40)
                .overlay(
                    Text((request.customerName ?? "?").prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                Text(request.customerEmail ?? "")
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
            Text(request.createdAt?.formatted(.dateTime.month(.abbreviated).day()) ?? "-")
                .font(.caption)
                .foregroundColor(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 8)
    }
}

struct BookingRequestDetailView: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    var drawerState: DrawerState
    @Environment(\.dismiss) var dismiss
    @State private var status: String
    @State private var notes = ""

    init(request: BookingRequest, viewModel: RequestsViewModel, drawerState: DrawerState) {
        self.request = request
        self.viewModel = viewModel
        self.drawerState = drawerState
        _status = State(initialValue: request.status)
        _notes = State(initialValue: request.notes ?? "")
    }

    private func saveChanges() {
        guard let id = request.documentId else { return }
        Task {
            await viewModel.updateBookingRequest(id, status: status, notes: notes.isEmpty ? nil : notes)
            dismiss()
        }
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Customer Information")) {
                    Text(request.customerName ?? "-")
                    Text(request.customerEmail ?? "-")
                    if let phone = request.customerPhone {
                        Text(phone)
                    }
                }

                Section(header: Text("Service Details")) {
                    Text(request.serviceName ?? request.serviceSlug ?? "-")
                    if let pt = request.preferredTime, !pt.isEmpty {
                        Text("Preferred: \(pt)")
                    }
                }

                Section(header: Text("Status")) {
                    Picker("Status", selection: $status) {
                        Text("NEW").tag("NEW")
                        Text("Reviewed").tag("reviewed")
                        Text("Confirmed").tag("confirmed")
                        Text("Declined").tag("declined")
                        Text("Cancelled").tag("cancelled")
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
