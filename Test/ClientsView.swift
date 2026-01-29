import SwiftUI

struct ClientsView: View {
    @StateObject private var viewModel = ClientsViewModel()
    @State private var searchText = ""
    
    var body: some View {
        NavigationView {
            VStack {
                SearchBar(text: $searchText)
                
                if viewModel.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(filteredClients) { client in
                        NavigationLink(destination: ClientDetailView(client: client)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(client.name)
                                    .font(.system(size: 16, weight: .semibold))
                                Text(client.email)
                                    .font(.system(size: 14))
                                    .foregroundColor(.secondary)
                                Text("\(client.totalAppointments) appointments")
                                    .font(.system(size: 12))
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .refreshable {
                        await viewModel.loadClients()
                    }
                }
            }
            .navigationTitle("Clients")
            .task {
                await viewModel.loadClients()
            }
        }
    }
    
    private var filteredClients: [Client] {
        if searchText.isEmpty {
            return viewModel.clients
        }
        return viewModel.clients.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            $0.email.localizedCaseInsensitiveContains(searchText)
        }
    }
}

struct ClientDetailView: View {
    let client: Client
    
    var body: some View {
        Form {
            Section(header: Text("Contact Information")) {
                Text(client.name)
                Text(client.email)
                if let phone = client.phone {
                    Text(phone)
                }
            }
            
            Section(header: Text("Statistics")) {
                Text("Total Appointments: \(client.totalAppointments)")
                if let lastContact = client.lastContact {
                    Text("Last Contact: \(lastContact, style: .date)")
                }
            }
            
            if let notes = client.notes {
                Section(header: Text("Notes")) {
                    Text(notes)
                }
            }
        }
        .navigationTitle(client.name)
    }
}

struct SearchBar: View {
    @Binding var text: String
    
    var body: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.gray)
            
            TextField("Search clients...", text: $text)
            
            if !text.isEmpty {
                Button(action: { text = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.gray)
                }
            }
        }
        .padding()
        .background(Color.gray.opacity(0.1))
        .cornerRadius(10)
        .padding(.horizontal)
    }
}

