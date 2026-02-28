import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DashboardViewModel()
    @State private var showingBookingForm = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Subtitle
                    Text("Real-time overview of your business")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    // Action buttons
                    HStack(spacing: 12) {
                        Button(action: {
                            drawerState.selectedSection = .messages
                            drawerState.isOpen = false
                        }) {
                            HStack {
                                Image(systemName: "message")
                                Text("Message")
                            }
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color(.systemBackground))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.gray.opacity(0.3), lineWidth: 1))
                            .cornerRadius(12)
                        }
                        .foregroundColor(.primary)

                        Button(action: { showingBookingForm = true }) {
                            HStack {
                                Image(systemName: "calendar.badge.plus")
                                Text("New Booking")
                            }
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.blue)
                            .foregroundColor(.white)
                            .cornerRadius(12)
                        }
                    }
                    .padding(.horizontal)

                    // Payments card
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Payments")
                                    .font(.title2.weight(.bold))
                                Text("Quick payment overview")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Button("View All") {
                                drawerState.selectedSection = .insights
                                drawerState.isOpen = false
                            }
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(.green)
                        }
                        .padding(.horizontal)

                        Button(action: {
                            drawerState.selectedSection = .insights
                            drawerState.isOpen = false
                        }) {
                            HStack(spacing: 16) {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color.green.opacity(0.2))
                                    .frame(width: 48, height: 48)
                                    .overlay(Image(systemName: "folder.fill").foregroundColor(.green))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("View Payments")
                                        .font(.subheadline.weight(.semibold))
                                    Text("Manage payments & transactions")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                Image(systemName: "dollarsign")
                                    .foregroundColor(.secondary)
                            }
                            .padding()
                            .background(Color.gray.opacity(0.06))
                            .cornerRadius(12)
                            .padding(.horizontal)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 12)
                    .background(Color(.systemBackground))
                    .cornerRadius(16)
                    .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
                    .padding(.horizontal)

                    // Recent Requests card
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Recent Requests")
                                    .font(.title2.weight(.bold))
                                Text("Latest booking inquiries")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Button("View All") {
                                drawerState.selectedSection = .requests
                                drawerState.isOpen = false
                            }
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(.blue)
                        }
                        .padding(.horizontal)

                        if viewModel.isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding()
                        } else if viewModel.useTenantData {
                            ForEach(viewModel.recentBookingRequests.prefix(5)) { br in
                                DashboardBookingRequestRow(request: br)
                            }
                            .padding(.horizontal)
                        } else {
                            ForEach(viewModel.recentRequests.prefix(5)) { request in
                                DashboardRequestRow(request: request)
                            }
                            .padding(.horizontal)
                        }
                    }
                    .padding(.vertical, 12)
                    .background(Color(.systemBackground))
                    .cornerRadius(16)
                    .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
                    .padding(.horizontal)
                }
                .padding(.vertical, 20)
            }
            .background(Color.gray.opacity(0.06))
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .font(.body)
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
        .task {
            await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
        }
        .sheet(isPresented: $showingBookingForm) {
            BookingFormView(drawerState: drawerState)
                .environmentObject(authViewModel)
                .onDisappear { Task { await viewModel.loadData(isDemoMode: authViewModel.isDemoMode) } }
        }
    }
}

struct DashboardBookingRequestRow: View {
    let request: BookingRequest

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.purple.opacity(0.8))
                .frame(width: 40, height: 40)
                .overlay(
                    Text((request.customerName ?? "?").prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                Text("\(request.serviceName ?? request.serviceSlug ?? "-") · \(request.createdAt?.formatted(.dateTime.month(.abbreviated).day()) ?? "-")")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
    }
}

struct DashboardRequestRow: View {
    let request: Request

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.purple.opacity(0.8))
                .frame(width: 40, height: 40)
                .overlay(
                    Text(request.customerName.prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName)
                    .font(.subheadline.weight(.semibold))
                Text("\(request.service.rawValue) · \(request.submittedAt, style: .date)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text(request.status.rawValue.capitalized)
                .font(.caption.weight(.medium))
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(statusColor)
                .cornerRadius(8)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
    }

    private var statusColor: Color {
        switch request.status {
        case .pending: return .orange
        case .confirmed: return .green
        case .declined: return .red
        default: return .gray
        }
    }
}
