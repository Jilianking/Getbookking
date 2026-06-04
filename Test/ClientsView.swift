import SwiftUI

struct ClientsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = ClientsViewModel()
    @State private var searchText = ""
    @State private var navPath: [String] = []
    @State private var showingAddCustomer = false
    @State private var alertMessage: String?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationStack(path: $navPath) {
            VStack(spacing: 0) {
                // Add Customer button
                Button {
                    if authViewModel.isDemoMode {
                        alertMessage = "Adding customers is not available in demo mode."
                    } else {
                        showingAddCustomer = true
                    }
                } label: {
                    HStack {
                        Image(systemName: "plus")
                        Text("Add Customer")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(AppDesign.brandDark)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 12)

                AppSearchField(placeholder: "Search clients...", text: $searchText)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)

                if viewModel.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        ForEach(alphabeticalSections, id: \.letter) { section in
                            Section(header: sectionHeader(section.letter)) {
                                ForEach(section.clients) { client in
                                    if let clientId = client.id {
                                        NavigationLink(value: clientId) {
                                            ClientRow(client: client)
                                        }
                                    } else {
                                        ClientRow(client: client)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(AppDesign.background)
                    .refreshable {
                        await viewModel.loadClients(isDemoMode: authViewModel.isDemoMode)
                        openPendingCustomerProfileIfNeeded()
                    }
                }
            }
            .appScreenBackground()
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .navigationDestination(for: String.self) { clientId in
                if let client = viewModel.clients.first(where: { $0.id == clientId }) {
                    ClientProfileView(client: client, clientsViewModel: viewModel, drawerState: drawerState)
                } else {
                    ContentUnavailableView("Customer not found", systemImage: "person.crop.circle.badge.questionmark")
                }
            }
            .task {
                await viewModel.loadClients(isDemoMode: authViewModel.isDemoMode)
                openPendingCustomerProfileIfNeeded()
            }
            .onChange(of: drawerState.customersDetailClientId) { _, _ in
                openPendingCustomerProfileIfNeeded()
            }
            .sheet(isPresented: $showingAddCustomer) {
                AddCustomerSheet(viewModel: viewModel) { customerId in
                    showingAddCustomer = false
                    navPath.append(customerId)
                }
            }
            .alert("Customers", isPresented: Binding(
                get: { alertMessage != nil },
                set: { if !$0 { alertMessage = nil } }
            )) {
                Button("OK", role: .cancel) { alertMessage = nil }
            } message: {
                Text(alertMessage ?? "")
            }
        }
    }

    private func openPendingCustomerProfileIfNeeded() {
        guard !viewModel.isLoading else { return }
        guard let clientId = drawerState.customersDetailClientId?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !clientId.isEmpty else { return }
        drawerState.customersDetailClientId = nil
        guard viewModel.clients.contains(where: { $0.id == clientId }) else { return }
        navPath = [clientId]
    }

    private var filteredClients: [Client] {
        if searchText.isEmpty {
            return viewModel.clients
        }
        return viewModel.clients.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            $0.email.localizedCaseInsensitiveContains(searchText) ||
            (PhoneFormatting.digits(from: $0.phone ?? "").contains(PhoneFormatting.digits(from: searchText)))
        }
    }

    private var alphabeticalSections: [(letter: String, clients: [Client])] {
        let grouped = Dictionary(grouping: filteredClients) { client in
            String(client.name.prefix(1).uppercased())
        }
        return grouped.keys.sorted().map { letter in
            (letter: letter, clients: grouped[letter] ?? [])
        }
    }

    private func sectionHeader(_ letter: String) -> some View {
        Text(letter)
            .font(.title2.weight(.bold))
            .foregroundColor(.secondary)
    }
}

private struct AddCustomerSheet: View {
    @ObservedObject var viewModel: ClientsViewModel
    var onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canSave: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasPhone = !PhoneFormatting.digits(from: phone).isEmpty
        return !trimmedName.isEmpty && (!trimmedEmail.isEmpty || hasPhone) && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textContentType(.name)
                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                    TextField("(555) 123-4567", text: Binding(
                        get: { phone },
                        set: { phone = PhoneFormatting.formatAsYouType($0) }
                    ))
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                } footer: {
                    Text("Name is required. Enter an email or phone number.")
                        .font(.caption)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add Customer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!canSave)
                }
            }
            .interactiveDismissDisabled(isSaving)
        }
    }

    private func save() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedPhone = PhoneFormatting.normalizedForStorage(phone)
        guard !trimmedName.isEmpty else {
            errorMessage = "Enter the customer's name."
            return
        }
        guard !trimmedEmail.isEmpty || normalizedPhone != nil else {
            errorMessage = "Enter an email or phone number."
            return
        }

        isSaving = true
        errorMessage = nil
        let client = Client(
            name: trimmedName,
            email: trimmedEmail,
            phone: normalizedPhone
        )
        Task {
            do {
                let customerId = try await viewModel.createClient(client)
                await MainActor.run {
                    isSaving = false
                    onCreated(customerId)
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    isSaving = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

struct ClientRow: View {
    let client: Client

    var body: some View {
        HStack(spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: nil,
                displayNameFallback: client.name,
                size: 44
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(client.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                if let phone = client.phone, !phone.isEmpty {
                    Text(PhoneFormatting.displayUS(phone))
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                if !client.email.isEmpty {
                    Text(client.email)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary.opacity(0.6))
        }
        .padding(14)
        .appCard()
        .padding(.vertical, 4)
    }
}
