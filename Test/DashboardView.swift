import SwiftUI

struct DashboardView: View {
    @StateObject private var viewModel = DashboardViewModel()
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    // Metrics Cards
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                        MetricCard(
                            title: "Pending Requests",
                            value: "\(viewModel.pendingRequestsCount)",
                            color: .orange
                        )
                        MetricCard(
                            title: "Upcoming Bookings",
                            value: "\(viewModel.upcomingBookingsCount)",
                            color: .blue
                        )
                        MetricCard(
                            title: "Total Clients",
                            value: "\(viewModel.totalClientsCount)",
                            color: .green
                        )
                        MetricCard(
                            title: "Monthly Revenue",
                            value: "$\(Int(viewModel.monthlyRevenue))",
                            color: .purple
                        )
                    }
                    .padding()
                    
                    // Recent Requests
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Recent Requests")
                            .font(.system(size: 24, weight: .bold))
                            .padding(.horizontal)
                        
                        if viewModel.isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding()
                        } else {
                            ForEach(viewModel.recentRequests.prefix(5)) { request in
                                RequestRow(request: request)
                            }
                        }
                    }
                    .padding(.vertical)
                }
            }
            .navigationTitle("Dashboard")
            .refreshable {
                await viewModel.refresh()
            }
        }
        .task {
            await viewModel.loadData()
        }
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    let color: Color
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.system(size: 32, weight: .bold))
                .foregroundColor(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.gray.opacity(0.1))
        .cornerRadius(12)
    }
}

struct RequestRow: View {
    let request: Request
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(request.customerName)
                    .font(.system(size: 16, weight: .semibold))
                Text(request.service.rawValue.capitalized)
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
            }
            
            Spacer()
            
            Text(request.status.rawValue.capitalized)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(statusColor)
                .cornerRadius(8)
        }
        .padding()
        .background(Color.gray.opacity(0.05))
        .cornerRadius(8)
        .padding(.horizontal)
    }
    
    var statusColor: Color {
        switch request.status {
        case .pending: return .orange
        case .confirmed: return .green
        case .declined: return .red
        default: return .gray
        }
    }
}

