import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var appTour: AppTourCoordinator
    @ObservedObject var viewModel: DashboardViewModel
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @StateObject private var requestsViewModel = RequestsViewModel()
    @State private var selectedBookingRequest: BookingRequest?
    @State private var selectedRequest: Request?
    var drawerState: DrawerState
    #if TAP_TO_PAY_ENABLED
    @State private var showTapToPaySheet = false
    @State private var showTapToPayEducation = false
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
                            icon: "calendar.badge.checkmark",
                            title: "Schedule"
                        ) {
                            drawerState.calendarShouldOpenNewBooking = true
                            drawerState.selectedSection = .calendar
                            drawerState.isOpen = false
                        }
                        DashboardQuickTile(
                            icon: "wave.3.right.circle.fill",
                            title: "Take payment"
                        ) {
                            handleTakePaymentTapped()
                        }
                        .appTourAnchor(
                            .dashboardTakePayment,
                            isActive: appTour.isStepActive(.dashboardTakePayment)
                        )
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
            .scrollDisabled(appTour.isStepActive(.dashboardTakePayment))
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
                #if TAP_TO_PAY_ENABLED
                await paymentsViewModel.prewarmTapToPayOnLaunch(isDemoMode: authViewModel.isDemoMode)
                #endif
                await paymentsViewModel.prewarmConnectLinkIfNeeded(isDemoMode: authViewModel.isDemoMode)
                await requestsViewModel.refreshRequests(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            #if TAP_TO_PAY_ENABLED
            .overlay {
                if paymentsViewModel.isLaunchingTapToPay {
                    TapToPayLaunchOverlay(message: paymentsViewModel.tapToPayLaunchOverlayMessage)
                }
            }
            #endif
        }
        .navigationViewStyle(.stack)
        .task {
            requestsViewModel.sessionStore = sessionStore
            await viewModel.loadData(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
            await paymentsViewModel.loadData(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            #if TAP_TO_PAY_ENABLED
            await paymentsViewModel.prewarmTapToPayOnLaunch(isDemoMode: authViewModel.isDemoMode)
            #endif
            await paymentsViewModel.prewarmConnectLinkIfNeeded(isDemoMode: authViewModel.isDemoMode)
            await requestsViewModel.loadRequests(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
            Task {
                paymentsViewModel.invalidateConnectLinkPrefetch()
                await paymentsViewModel.refreshStripeConnectStatus(isDemoMode: authViewModel.isDemoMode)
                await paymentsViewModel.prewarmConnectLinkIfNeeded(isDemoMode: authViewModel.isDemoMode)
                #if TAP_TO_PAY_ENABLED
                await paymentsViewModel.prewarmTapToPayOnLaunch(isDemoMode: authViewModel.isDemoMode)
                #endif
            }
        }
        #if TAP_TO_PAY_ENABLED
        .sheet(isPresented: $showTapToPaySheet) {
            TapToPaySheet(viewModel: paymentsViewModel) {
                showTapToPaySheet = false
            }
        }
        .sheet(isPresented: $showTapToPayEducation) {
            TapToPayMerchantEducationView {
                showTapToPayEducation = false
                Task {
                    await paymentsViewModel.finishMerchantEducationAndContinueTapToPay(
                        isDemoMode: authViewModel.isDemoMode,
                        showCheckout: { showTapToPaySheet = true },
                        showAlert: { tapToPayAlertMessage = $0 }
                    )
                }
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
        .sheet(item: $selectedBookingRequest, onDismiss: {
            Task { await reloadAfterRequestDetail() }
        }) { booking in
            BookingRequestDetailView(
                request: booking,
                viewModel: requestsViewModel,
                drawerState: drawerState,
                teamAccess: authViewModel.teamAccess
            )
            .environmentObject(sessionStore)
        }
        .sheet(item: $selectedRequest) { request in
            RequestDetailView(request: request, viewModel: requestsViewModel, drawerState: drawerState)
        }
        .onAppear {
            requestsViewModel.sessionStore = sessionStore
        }
    }

    private func reloadAfterRequestDetail() async {
        sessionStore.invalidateBookings()
        await sessionStore.loadNewBookingsIfNeeded(force: true, isDemoMode: authViewModel.isDemoMode)
        await viewModel.refresh(sessionStore: sessionStore, isDemoMode: authViewModel.isDemoMode)
        await requestsViewModel.refreshRequests(
            isDemoMode: authViewModel.isDemoMode,
            sessionStore: sessionStore
        )
    }

    private func handleTakePaymentTapped() {
        #if TAP_TO_PAY_ENABLED
        Task {
            let result = await paymentsViewModel.launchTapToPayFlow(isDemoMode: authViewModel.isDemoMode)
            switch result {
            case .showMerchantEducation:
                await presentTapToPayMerchantEducationAndContinue()
            default:
                paymentsViewModel.applyTapToPayLaunchResult(
                    result,
                    isDemoMode: authViewModel.isDemoMode,
                    showCheckout: { showTapToPaySheet = true },
                    showAlert: { tapToPayAlertMessage = $0 },
                    showEducation: { showTapToPayEducation = true }
                )
            }
        }
        #else
        drawerState.selectedSection = .payments
        drawerState.isOpen = false
        #endif
    }

    #if TAP_TO_PAY_ENABLED
    private func presentTapToPayMerchantEducationAndContinue() async {
        await TapToPayMerchantEducationFlow.run(
            showFallbackSheet: { showTapToPayEducation = true },
            onFinished: {
                Task {
                    await paymentsViewModel.finishMerchantEducationAndContinueTapToPay(
                        isDemoMode: authViewModel.isDemoMode,
                        showCheckout: { showTapToPaySheet = true },
                        showAlert: { tapToPayAlertMessage = $0 }
                    )
                }
            }
        )
    }
    #endif

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
                            Button {
                                openBookingRequest(br)
                            } label: {
                                DashboardBookingRequestRow(request: br)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            } else {
                ForEach(viewModel.recentRequests.prefix(5)) { request in
                    Button {
                        selectedRequest = request
                    } label: {
                        DashboardRequestRow(request: request)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.bottom, 16)
        .appCard()
        .padding(.horizontal)
    }

    private func openBookingRequest(_ booking: BookingRequest) {
        markBookingRequestReadLocally(booking)
        selectedBookingRequest = booking
        Task {
            await requestsViewModel.markBookingRequestAsReadIfNeeded(booking)
        }
    }

    private func markBookingRequestReadLocally(_ booking: BookingRequest) {
        guard booking.readAt == nil,
              let requestId = booking.documentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requestId.isEmpty else { return }
        let readAt = Date()
        sessionStore.markBookingRequestReadLocally(requestId: requestId, readAt: readAt)
        if let index = requestsViewModel.bookingRequests.firstIndex(where: { $0.documentId == requestId }) {
            requestsViewModel.bookingRequests[index].readAt = readAt
        }
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
        .contentShape(Rectangle())
    }

    private var statusLabel: String {
        BookingRequestStatus.displayLabel(request.status)
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
        .contentShape(Rectangle())
    }
}
