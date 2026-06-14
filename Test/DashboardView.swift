import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @ObservedObject var viewModel: DashboardViewModel
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @State private var showingBookingForm = false
    var drawerState: DrawerState
    let sectionTitle: String

    private let statColumns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    private var displayPendingRequestsCount: Int {
        viewModel.useTenantData ? sessionStore.pendingRequestsCount : viewModel.pendingRequestsCount
    }

    private var displayUnreadRequestsCount: Int {
        viewModel.useTenantData ? sessionStore.unreadRequestsCount : viewModel.unreadRequestsCount
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppScreenTitle(title: sectionTitle)
                    LazyVGrid(columns: statColumns, spacing: 12) {
                        AppStatCard(
                            title: "New requests",
                            value: "\(displayPendingRequestsCount)",
                            subtitle: displayUnreadRequestsCount > 0
                                ? "\(displayUnreadRequestsCount) unread"
                                : "awaiting review"
                        )
                        AppStatCard(
                            title: "Confirmed",
                            value: "\(viewModel.confirmedThisMonthCount)",
                            subtitle: "this month"
                        )
                        AppStatCard(
                            title: "Clients",
                            value: "\(viewModel.totalClientsCount)",
                            subtitle: "total"
                        )
                        AppStatCard(
                            title: "Balance",
                            value: balanceDisplay,
                            subtitle: paymentsViewModel.stripeConnected ? "available" : "connect Stripe"
                        )
                    }
                    .padding(.horizontal)

                    HStack(spacing: 12) {
                        AppQuickActionCard(
                            icon: "message.fill",
                            title: "Message",
                            subtitle: "Text a client"
                        ) {
                            drawerState.selectedSection = .messages
                            drawerState.isOpen = false
                        }
                        AppQuickActionCard(
                            icon: "calendar.badge.plus",
                            title: "New booking",
                            subtitle: "Add manually"
                        ) {
                            showingBookingForm = true
                        }
                    }
                    .padding(.horizontal)

                    recentRequestsCard
                }
                .padding(.vertical, 16)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
                await paymentsViewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
        .task {
            await viewModel.loadData(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
            await paymentsViewModel.loadData(isDemoMode: authViewModel.isDemoMode)
        }
        .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
            Task { await paymentsViewModel.refreshStripeConnectStatus(isDemoMode: authViewModel.isDemoMode) }
        }
        .sheet(isPresented: $showingBookingForm) {
            BookingFormView(drawerState: drawerState)
                .environmentObject(authViewModel)
                .onDisappear {
                    Task {
                        sessionStore.invalidateBookings()
                        await viewModel.loadData(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
                    }
                }
        }
    }

    private var balanceDisplay: String {
        if paymentsViewModel.availableBalance > 0 {
            return String(format: "$%.0f", paymentsViewModel.availableBalance)
        }
        if viewModel.monthlyRevenue > 0 {
            return String(format: "$%.0f", viewModel.monthlyRevenue)
        }
        return "$0"
    }

    private var recentRequestsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent requests")
                    .font(.headline)
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer()
                Button("View all") {
                    drawerState.selectedSection = .requests
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.linkAccent)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)

            if viewModel.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else if viewModel.useTenantData {
                if viewModel.recentBookingRequests.isEmpty {
                    Text("No requests yet")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                } else {
                    VStack(spacing: 0) {
                        ForEach(viewModel.recentBookingRequests.prefix(5)) { br in
                            DashboardBookingRequestRow(request: br)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            } else {
                ForEach(viewModel.recentRequests.prefix(5)) { request in
                    DashboardRequestRow(request: request)
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.bottom, 16)
        .appCard()
        .padding(.horizontal)
    }
}

struct DashboardBookingRequestRow: View {
    let request: BookingRequest

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(AppDesign.brandDark.opacity(0.85))
                .frame(width: 40, height: 40)
                .overlay(
                    Text((request.customerName ?? "?").prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text("\(request.serviceName ?? request.serviceSlug ?? "-") · \(request.createdAt?.formatted(.dateTime.month(.abbreviated).day()) ?? "-")")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            Spacer()
            AppStatusPill(text: statusLabel, soft: true)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
    }

    private var statusLabel: String {
        let s = request.status.uppercased()
        if s == "NEW" { return "New" }
        if s == "CONFIRMED" { return "Confirmed" }
        if s == "DECLINED" { return "Declined" }
        return request.status.capitalized
    }
}

struct DashboardRequestRow: View {
    let request: Request

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(AppDesign.brandDark.opacity(0.85))
                .frame(width: 40, height: 40)
                .overlay(
                    Text(request.customerName.prefix(2).uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(request.customerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text("\(request.service.rawValue) · \(request.submittedAt, style: .date)")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            Spacer()
            AppStatusPill(text: request.status.rawValue.capitalized, soft: true)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
    }
}
