import SwiftUI

struct ClientsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = ClientsViewModel()
    @State private var searchText = ""
    @State private var navPath: [String] = []
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationStack(path: $navPath) {
            VStack(spacing: 0) {
                // Add Customer button
                Button(action: {}) {
                    HStack {
                        Image(systemName: "plus")
                        Text("Add Customer")
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.black)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
                .padding(.horizontal)
                .padding(.bottom, 12)

                // Search
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.gray)
                    TextField("Search", text: $searchText)
                }
                .padding(10)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(10)
                .padding(.horizontal)
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
                    .refreshable {
                        await viewModel.loadClients(isDemoMode: authViewModel.isDemoMode)
                        openPendingCustomerProfileIfNeeded()
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

struct ClientRow: View {
    let client: Client

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.black)
                .frame(width: 44, height: 44)
                .overlay(
                    Text(client.name.prefix(1).uppercased())
                        .font(.headline)
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(client.name)
                    .font(.subheadline.weight(.semibold))
                if let phone = client.phone {
                    Text(phone)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Text(client.email)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
