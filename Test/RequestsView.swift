import SwiftUI

struct RequestsView: View {
    @StateObject private var viewModel = RequestsViewModel()
    @State private var selectedStatus: Request.RequestStatus? = .pending
    @State private var selectedRequest: Request?
    
    var body: some View {
        NavigationView {
            VStack {
                // Filter Picker
                Picker("Status", selection: $selectedStatus) {
                    Text("All").tag(nil as Request.RequestStatus?)
                    Text("Pending").tag(Request.RequestStatus.pending as Request.RequestStatus?)
                    Text("Confirmed").tag(Request.RequestStatus.confirmed as Request.RequestStatus?)
                    Text("Declined").tag(Request.RequestStatus.declined as Request.RequestStatus?)
                }
                .pickerStyle(.segmented)
                .padding()
                
                // Requests List
                if viewModel.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(filteredRequests) { request in
                        RequestRow(request: request)
                            .onTapGesture {
                                selectedRequest = request
                            }
                    }
                    .refreshable {
                        await viewModel.loadRequests()
                    }
                }
            }
            .navigationTitle("Requests")
            .sheet(item: $selectedRequest) { request in
                RequestDetailView(request: request, viewModel: viewModel)
            }
            .task {
                await viewModel.loadRequests()
            }
        }
    }
    
    private var filteredRequests: [Request] {
        if let status = selectedStatus {
            return viewModel.requests.filter { $0.status == status }
        }
        return viewModel.requests
    }
}

struct RequestDetailView: View {
    let request: Request
    @ObservedObject var viewModel: RequestsViewModel
    @Environment(\.dismiss) var dismiss
    @State private var status: Request.RequestStatus
    @State private var notes = ""
    
    init(request: Request, viewModel: RequestsViewModel) {
        self.request = request
        self.viewModel = viewModel
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
                        ForEach([Request.RequestStatus.pending, .discussed, .confirmed, .declined, .cancelled], id: \.self) { status in
                            Text(status.rawValue.capitalized).tag(status)
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
    
    private func saveChanges() {
        Task {
            await viewModel.updateRequest(request.id!, status: status, notes: notes.isEmpty ? nil : notes)
            dismiss()
        }
    }
}

