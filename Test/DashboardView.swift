import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @ObservedObject var viewModel: DashboardViewModel
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    var drawerState: DrawerState
    #if TAP_TO_PAY_ENABLED
    @State private var showTapToPaySheet = false
    @State private var tapToPayAlertMessage: String?
    #endif

    private var dashboardHeadline: String {
        DashboardGreeting.headline(
            displayName: authViewModel.currentUserDisplayName,
            email: authViewModel.currentUserEmail
        )
    }

    private let statColumns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    private let quickActionColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

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
                    AppBrandScreenTitle(title: dashboardHeadline)
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
                    }
                    .padding(.horizontal)

                    LazyVGrid(columns: quickActionColumns, spacing: 10) {
                        DashboardQuickTile(
                            icon: "dollarsign.circle.fill",
                            title: "Revenue"
                        ) {
                            drawerState.selectedSection = .payments
                            drawerState.isOpen = false
                        }
                        DashboardQuickTile(
                            icon: "wave.3.right.circle.fill",
                            title: "Take payment"
                        ) {
                            handleTakePaymentTapped()
                        }
                        DashboardQuickTile(
                            icon: "message.fill",
                            title: "Message"
                        ) {
                            drawerState.selectedSection = .messages
                            drawerState.isOpen = false
                        }
                    }
                    .padding(.horizontal)

                    DashboardRevenueChartCard(
                        points: viewModel.weeklyRevenue,
                        thisWeek: viewModel.revenueThisWeek,
                        weekOverWeekPct: viewModel.revenueWeekOverWeekPct,
                        thisMonth: viewModel.revenueThisMonth,
                        monthOverMonthPct: viewModel.revenueMonthOverMonthPct,
                        avgPerWeek: viewModel.revenueAvgPerWeek,
                        showsConnectPrompt: viewModel.useTenantData && !paymentsViewModel.stripeConnected
                    )
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
                await paymentsViewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
        }
        .navigationViewStyle(.stack)
        .task {
            await viewModel.loadData(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
            await paymentsViewModel.loadData(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
            Task { await paymentsViewModel.refreshStripeConnectStatus(isDemoMode: authViewModel.isDemoMode) }
        }
        #if TAP_TO_PAY_ENABLED
        .sheet(isPresented: $showTapToPaySheet) {
            TapToPaySheet(viewModel: paymentsViewModel) {
                showTapToPaySheet = false
            }
        }
        .alert("Tap to Pay", isPresented: Binding(
            get: { tapToPayAlertMessage != nil },
            set: { if !$0 { tapToPayAlertMessage = nil } }
        )) {
            Button("OK", role: .cancel) { tapToPayAlertMessage = nil }
        } message: {
            Text(tapToPayAlertMessage ?? "")
        }
        #endif
    }

    private func handleTakePaymentTapped() {
        #if TAP_TO_PAY_ENABLED
        if authViewModel.isDemoMode {
            tapToPayAlertMessage = "Tap to Pay isn't available in demo mode."
            return
        }
        if !paymentsViewModel.canTakePayments {
            tapToPayAlertMessage = "Your studio collects payments for you. Ask your admin to enable independent payouts."
            return
        }
        if let block = TapToPayEligibility.blockingMessage() {
            tapToPayAlertMessage = block
            return
        }
        if !paymentsViewModel.stripeConnected {
            Task { await paymentsViewModel.createConnectAccountLink(isDemoMode: false) }
            return
        }
        Task {
            if paymentsViewModel.resolvedTapToPayLocationId.isEmpty {
                do {
                    try await paymentsViewModel.ensureTapToPayLocation()
                } catch {
                    tapToPayAlertMessage = FirebaseFunctionsErrorHelper.message(from: error)
                    return
                }
            }
            if paymentsViewModel.resolvedTapToPayLocationId.isEmpty {
                tapToPayAlertMessage = "Tap to Pay could not be set up. Add your business address under Website Design, then try again."
                return
            }
            showTapToPaySheet = true
        }
        #else
        drawerState.selectedSection = .payments
        drawerState.isOpen = false
        #endif
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
