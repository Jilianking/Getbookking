//
//  AdminRootView.swift
//
//  Root admin UI: sidebar drawer + main content.
//

import SwiftUI
import Observation

enum AdminSection: String, CaseIterable, Identifiable {
    case dashboard
    case requests
    case calendar
    case messages
    case clients
    case team
    case design
    case websiteProfile
    case shop
    case insights
    case payments
    case settings

    var id: String { rawValue }

    /// Drawer order (Team before Settings).
    static var drawerOrder: [AdminSection] {
        [
            .dashboard, .requests, .calendar, .messages, .clients,
            .team, .design, .websiteProfile, .shop, .insights, .payments, .settings,
        ]
    }

    /// Short label for nav bar and drawer (matches product mockups).
    var shortTitle: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .requests: return "Requests"
        case .calendar: return "Calendar"
        case .messages: return "Messages"
        case .clients: return "Clients"
        case .team: return "Team"
        case .design: return "Website Builder"
        case .websiteProfile: return "Website profile"
        case .shop: return "Shop"
        case .insights: return "Insights"
        case .payments: return "Payments"
        case .settings: return "Settings"
        }
    }

    var title: String { shortTitle }

    enum DrawerGroup: String, Hashable {
        case main = "Main"
        case business = "Business"
        case more = "More"
    }

    var drawerGroup: DrawerGroup {
        switch self {
        case .dashboard, .requests, .calendar, .messages: return .main
        case .clients, .team, .design, .websiteProfile, .insights, .payments: return .business
        case .shop, .settings: return .more
        }
    }

    static let drawerGroupOrder: [DrawerGroup] = [.main, .business, .more]

    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2.fill"
        case .requests: return "doc.text"
        case .calendar: return "calendar"
        case .messages: return "message"
        case .clients: return "person.2.fill"
        case .team: return "person.3.fill"
        case .design: return "paintbrush.fill"
        case .websiteProfile: return "globe"
        case .shop: return "bag.fill"
        case .insights: return "chart.bar.fill"
        case .payments: return "dollarsign.circle.fill"
        case .settings: return "gear"
        }
    }
}

enum RequestsDeepLinkFilter: String, Equatable {
    case newOnly
    case confirmed
}

@Observable
final class DrawerState {
    var isOpen = false
    /// Right-side activity panel (notification center). Mutually exclusive with `isOpen`.
    var isActivityOpen = false
    var selectedSection: AdminSection = .dashboard
    /// Opens a specific customer profile in Clients (Firestore doc id).
    var customersDetailClientId: String?
    /// Prefill Messages compose from customer profile or receipt share.
    var messagesComposePhone: String?
    var messagesComposeClientName: String?
    var messagesComposeBookingRequestId: String?
    var messagesComposeBody: String?
    var messagesShouldOpenCompose = false
    /// Open a specific SMS thread from a push notification.
    var messagesOpenThreadId: String?
    /// When true, root left-edge swipe won't open the drawer (message thread owns that edge for back).
    var suppressDrawerEdgeOpen = false
    /// Dashboard Schedule quick action → Calendar + New Booking sheet.
    var calendarShouldOpenNewBooking = false
    /// Dashboard New requests / Confirmed cards → Requests with matching filter chip.
    var requestsInitialFilter: RequestsDeepLinkFilter?
    /// Activity bell → Requests with one booking request opened (Firestore doc id).
    var requestsOpenRequestId: String?
    /// Activity bell → Shop with one order opened.
    var shopOpenOrderId: String?
    /// Incremented when the app tour advances — child views dismiss sheets / inline panels.
    var appTourDismissModalsToken: Int = 0

    /// Prefer opening an existing SMS thread. Falls back to compose when there is no phone but a body to send.
    func openExistingMessagesThread(
        phone: String?,
        clientName: String? = nil,
        bookingRequestId: String? = nil,
        body: String? = nil
    ) {
        let trimmedPhone = (phone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBody = (body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let threadId = trimmedPhone.isEmpty ? "" : PhoneFormatting.smsThreadId(trimmedPhone)

        messagesComposePhone = nil
        messagesComposeClientName = nil
        messagesComposeBookingRequestId = nil
        messagesComposeBody = nil
        messagesShouldOpenCompose = false
        messagesOpenThreadId = nil

        if !threadId.isEmpty {
            messagesOpenThreadId = threadId
            if !trimmedBody.isEmpty {
                messagesComposeBody = trimmedBody
            }
            _ = clientName
            _ = bookingRequestId
        } else if !trimmedBody.isEmpty {
            messagesComposeBody = trimmedBody
            messagesComposeClientName = clientName
            messagesComposeBookingRequestId = bookingRequestId
            messagesShouldOpenCompose = true
        }

        selectedSection = .messages
        isOpen = false
        isActivityOpen = false
    }

    func openActivityDrawer() {
        isOpen = false
        isActivityOpen = true
    }

    func closeActivityDrawer() {
        isActivityOpen = false
    }
}

struct AdminRootView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var appTour = AppTourCoordinator()
    @State private var drawerState = DrawerState()
    @StateObject private var dashboardMetrics = DashboardViewModel()
    @State private var visitedSections: Set<AdminSection> = [.dashboard]

    /// Solo owners use Business settings only; hide Team from the drawer.
    private var drawerSections: [AdminSection] {
        var sections: [AdminSection]
        if authViewModel.isDemoMode {
            sections = AdminSection.drawerOrder.filter { $0 != .team }
            if sessionStore.tenant?["shopEnabled"] as? Bool != true {
                sections = sections.filter { $0 != .shop }
            }
        } else {
            let hideTeam =
                authViewModel.teamAccess.isOwner
                && authViewModel.tenantSubscriptionPlan.usesBusinessSettingsHub
            if hideTeam {
                sections = AdminSection.drawerOrder.filter { $0 != .team }
            } else {
                sections = AdminSection.drawerOrder
            }
        }

        if authViewModel.teamAccess.isOwner || authViewModel.isDemoMode {
            sections = sections.filter { $0 != .websiteProfile }
        } else {
            sections = sections.filter { $0 != .design }
            if !authViewModel.teamAccess.canAccessWebsiteProfile {
                sections = sections.filter { $0 != .websiteProfile }
            }
            let access = authViewModel.teamAccess
            let showPayments =
                access.canTakePayments
                || (access.accessRole == .manager && access.permissions.viewEarningsReports)
            if !showPayments {
                sections = sections.filter { $0 != .payments }
            }
        }
        return sections
    }

    private var sessionTaskId: String {
        if authViewModel.isDemoMode {
            return authViewModel.demoPersona?.slug ?? "demo-unknown"
        }
        return authViewModel.currentUserUid ?? ""
    }

    var body: some View {
        ZStack(alignment: .leading) {
            // Main content
            VStack(spacing: 0) {
                if authViewModel.isDemoMode {
                    demoBanner
                }
                mainContent
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Drawer overlay
            if drawerState.isOpen {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            drawerState.isOpen = false
                        }
                    }
                    .highPriorityGesture(
                        DragGesture(minimumDistance: 16, coordinateSpace: .local)
                            .onEnded { value in
                                // Left swipe => close. Keep the gesture horizontal-dominant to avoid
                                // interfering with vertical scrolling behind the overlay.
                                let dx = value.translation.width // left swipe: negative
                                let dy = abs(value.translation.height)
                                guard dx < -56, abs(dx) > dy * 1.15 else { return }
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    drawerState.isOpen = false
                                }
                            }
                    )

                drawerContent
                    .frame(width: AppDesign.drawerWidth)
                    .background(AppDesign.cardBackground)
                    .shadow(color: .black.opacity(0.12), radius: 12, x: 4, y: 0)
                    .transition(.move(edge: .leading))
            }

            // Activity drawer (right)
            if drawerState.isActivityOpen {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            drawerState.closeActivityDrawer()
                        }
                    }
                    .highPriorityGesture(
                        DragGesture(minimumDistance: 16, coordinateSpace: .local)
                            .onEnded { value in
                                // Right swipe => close.
                                let dx = value.translation.width
                                let dy = abs(value.translation.height)
                                guard dx > 56, dx > dy * 1.15 else { return }
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    drawerState.closeActivityDrawer()
                                }
                            }
                    )

                ActivityDrawerPanel(drawerState: drawerState)
                    .frame(width: AppDesign.drawerWidth)
                    .shadow(color: .black.opacity(0.12), radius: 12, x: -4, y: 0)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .transition(.move(edge: .trailing))
            }

        }
        .overlay(alignment: .leading) {
            drawerEdgeOpenHitArea
        }
        .environmentObject(appTour)
        .onPreferenceChange(AppTourFramePreferenceKey.self) { frames in
            appTour.updateFrames(frames)
        }
        .animation(.easeInOut(duration: 0.2), value: drawerState.isOpen)
        .animation(.easeInOut(duration: 0.2), value: drawerState.isActivityOpen)
        .onChange(of: drawerState.isOpen) { _, open in
            if open { drawerState.isActivityOpen = false }
        }
        .onChange(of: drawerState.isActivityOpen) { _, open in
            if open { drawerState.isOpen = false }
        }
        .onChange(of: drawerState.selectedSection) { _, section in
            visitedSections.insert(section)
            // Leaving Messages clears thread edge ownership even if the view stays mounted.
            if section != .messages {
                drawerState.suppressDrawerEdgeOpen = false
            }
        }
        .onChange(of: authViewModel.tenantSubscriptionPlan) { _, _ in
            if !drawerSections.contains(drawerState.selectedSection) {
                drawerState.selectedSection = .dashboard
            }
        }
        .onChange(of: authViewModel.teamAccess) { _, _ in
            if !drawerSections.contains(drawerState.selectedSection) {
                drawerState.selectedSection = drawerSections.first ?? .dashboard
            }
        }
        .task(id: sessionTaskId) {
            if authViewModel.isAuthenticated, authViewModel.currentUserUid != nil {
                let sessionChanged = sessionStore.prepareForSession(
                    uid: authViewModel.currentUserUid,
                    isDemoMode: authViewModel.isDemoMode,
                    demoPersona: authViewModel.demoPersona
                )
                if sessionChanged, authViewModel.isDemoMode {
                    dashboardMetrics.resetForNewSession()
                }
                async let bootstrap: () = sessionStore.bootstrap(
                    isDemoMode: authViewModel.isDemoMode,
                    demoPersona: authViewModel.demoPersona
                )
                async let metrics: () = dashboardMetrics.loadData(
                    sessionStore: sessionStore,
                    isDemoMode: authViewModel.isDemoMode,
                    teamAccess: authViewModel.teamAccess,
                    currentUserUid: authViewModel.currentUserUid
                )
                _ = await (bootstrap, metrics)
            } else if !authViewModel.isAuthenticated {
                sessionStore.reset()
                appTour.skipTour(onComplete: {})
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
            if let url = note.userInfo?["logoUrl"] as? String {
                authViewModel.applyTenantLogoCache(url)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushOpenMessagesThread)) { note in
            let threadId = (note.userInfo?["threadId"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !threadId.isEmpty else { return }
            drawerState.isOpen = false
            drawerState.isActivityOpen = false
            drawerState.messagesShouldOpenCompose = false
            drawerState.messagesOpenThreadId = threadId
            drawerState.selectedSection = .messages
            visitedSections.insert(.messages)
        }
        .onReceive(NotificationCenter.default.publisher(for: .tenantBusinessNameDidChange)) { _ in
            Task {
                await sessionStore.refreshProfileAndTenant()
                await dashboardMetrics.loadData(
                    sessionStore: sessionStore,
                    isDemoMode: authViewModel.isDemoMode,
                    teamAccess: authViewModel.teamAccess,
                    currentUserUid: authViewModel.currentUserUid
                )
            }
        }
    }

    /// Thin left-edge strip: swipe right opens the drawer without stealing scroll/keyboard elsewhere.
    @ViewBuilder
    private var drawerEdgeOpenHitArea: some View {
        if !drawerState.isOpen, !drawerState.suppressDrawerEdgeOpen {
            Color.clear
                .frame(width: 24)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .highPriorityGesture(
                    DragGesture(minimumDistance: 16, coordinateSpace: .local)
                        .onEnded { value in
                            let dx = value.translation.width
                            let dy = abs(value.translation.height)
                            guard dx > 56, dx > dy * 1.15 else { return }
                            withAnimation(.easeInOut(duration: 0.2)) {
                                drawerState.isOpen = true
                            }
                        }
                )
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        ZStack {
            if visitedSections.contains(.dashboard) {
                DashboardView(
                    viewModel: dashboardMetrics,
                    drawerState: drawerState
                )
                .sectionVisible(drawerState.selectedSection == .dashboard)
            }
            if visitedSections.contains(.requests) {
                RequestsView(drawerState: drawerState, sectionTitle: AdminSection.requests.title)
                    .sectionVisible(drawerState.selectedSection == .requests)
            }
            if visitedSections.contains(.calendar) {
                CalendarView(drawerState: drawerState, sectionTitle: AdminSection.calendar.title)
                    .sectionVisible(drawerState.selectedSection == .calendar)
            }
            if visitedSections.contains(.messages) {
                MessagesView(drawerState: drawerState, sectionTitle: AdminSection.messages.title)
                    .sectionVisible(drawerState.selectedSection == .messages)
            }
            if visitedSections.contains(.clients) {
                ClientsView(drawerState: drawerState, sectionTitle: AdminSection.clients.title)
                    .sectionVisible(drawerState.selectedSection == .clients)
            }
            if visitedSections.contains(.team) {
                TeamView(drawerState: drawerState, sectionTitle: AdminSection.team.title)
                    .sectionVisible(drawerState.selectedSection == .team)
            }
            if visitedSections.contains(.design) {
                DesignView(drawerState: drawerState, sectionTitle: AdminSection.design.title)
                    .sectionVisible(drawerState.selectedSection == .design)
            }
            if visitedSections.contains(.websiteProfile) {
                ArtistWebsiteProfileView(
                    drawerState: drawerState,
                    sectionTitle: AdminSection.websiteProfile.title
                )
                .sectionVisible(drawerState.selectedSection == .websiteProfile)
            }
            if visitedSections.contains(.shop) {
                ShopManagerView(drawerState: drawerState, sectionTitle: AdminSection.shop.title)
                    .sectionVisible(drawerState.selectedSection == .shop)
            }
            if visitedSections.contains(.insights) {
                InsightsView(drawerState: drawerState, sectionTitle: AdminSection.insights.title)
                    .sectionVisible(drawerState.selectedSection == .insights)
            }
            if visitedSections.contains(.payments) {
                PaymentsView(drawerState: drawerState, sectionTitle: AdminSection.payments.title)
                    .sectionVisible(drawerState.selectedSection == .payments)
            }
            if visitedSections.contains(.settings) {
                SettingsView(drawerState: drawerState, sectionTitle: AdminSection.settings.title)
                    .sectionVisible(drawerState.selectedSection == .settings)
            }
        }
    }

    private var demoBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "play.circle.fill")
                .foregroundStyle(AppDesign.linkAccent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Demo mode")
                    .font(.caption.weight(.semibold))
                if let err = sessionStore.demoLoadError, !err.isEmpty {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.red)
                } else if sessionStore.isDemoLoading {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading sample data…")
                    }
                    .font(.caption2)
                    .foregroundStyle(AppDesign.textSecondary)
                } else {
                    Text("Nothing is saved · explore freely")
                        .font(.caption2)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            Spacer()
            Button("Exit") {
                sessionStore.reset()
                authViewModel.exitDemo()
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(AppDesign.linkAccent)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(AppDesign.searchBackground)
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    private var drawerBusinessSubtitle: String {
        let industry = sessionStore.tenantIndustryDisplayName
        let plan = authViewModel.tenantSubscriptionPlan.displayName
        return "\(industry) · \(plan)"
    }

    private var drawerDisplayName: String {
        if !authViewModel.teamAccess.isOwner {
            return authViewModel.currentUserDisplayName ?? "Team member"
        }
        let business = sessionStore.businessDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !business.isEmpty { return business }
        return authViewModel.currentUserDisplayName ?? "Your business"
    }

    /// Team members see their own avatar at the top; owners see the studio logo.
    private var drawerHeaderTenantLogoURL: String? {
        authViewModel.teamAccess.isOwner ? authViewModel.tenantLogoUrl : nil
    }

    private func badgeCount(for section: AdminSection) -> Int {
        switch section {
        case .requests:
            let scoped = sessionStore.newBookingRequests.scopedForTeamAccess(
                authViewModel.teamAccess,
                currentUserUid: authViewModel.currentUserUid,
                roster: sessionStore.teamMembers
            )
            return scoped.filter { $0.readAt == nil }.count
        default: return 0
        }
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                AppAvatarView(
                    tenantLogoURL: drawerHeaderTenantLogoURL,
                    accountPhotoURL: authViewModel.accountPhotoUrl,
                    displayNameFallback: drawerDisplayName,
                    size: 48
                )
                VStack(alignment: .leading, spacing: 4) {
                    Text(drawerDisplayName)
                        .font(.headline)
                        .foregroundStyle(AppDesign.textPrimary)
                }
                .frame(height: 48, alignment: .center)
                Spacer(minLength: 0)
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        drawerState.isOpen = false
                    }
                }) {
                    Image(systemName: "xmark")
                        .font(.body.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 16)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(AdminSection.drawerGroupOrder, id: \.self) { group in
                        let items = drawerSections.filter { $0.drawerGroup == group }
                        if !items.isEmpty {
                            AppSectionHeader(title: group.rawValue)
                            VStack(spacing: 4) {
                                ForEach(items) { section in
                                    drawerRow(section)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
            }

            Divider()
                .padding(.top, 8)

            HStack(spacing: 12) {
                AppAvatarView(
                    tenantLogoURL: authViewModel.tenantLogoUrl,
                    accountPhotoURL: authViewModel.accountPhotoUrl,
                    displayNameFallback: authViewModel.currentUserDisplayName,
                    size: 40
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(authViewModel.currentUserDisplayName ?? "Owner")
                        .font(.subheadline.weight(.semibold))
                    Text(authViewModel.teamAccess.isOwner ? "Owner" : "Team member")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer()
            }
            .padding(16)
        }
    }

    private func drawerRow(_ section: AdminSection) -> some View {
        let selected = drawerState.selectedSection == section
        return Button {
            drawerState.selectedSection = section
            withAnimation(.easeInOut(duration: 0.2)) {
                drawerState.isOpen = false
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: section.icon)
                    .frame(width: 22, alignment: .center)
                    .font(.system(size: 15, weight: .medium))
                Text(section.shortTitle)
                    .font(.subheadline.weight(selected ? .semibold : .regular))
                Spacer()
                AppDrawerBadge(count: badgeCount(for: section))
                    .id(section == .requests ? sessionStore.unreadRequestsCount : 0)
            }
            .foregroundStyle(selected ? Color.white : AppDesign.textPrimary)
            .padding(.vertical, 11)
            .padding(.horizontal, 14)
            .background(selected ? AppDesign.brandDark : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private extension View {
    func sectionVisible(_ visible: Bool) -> some View {
        opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
    }
}

// MARK: - Placeholder for unimplemented sections
struct PlaceholderSectionView: View {
    var drawerState: DrawerState
    let title: String
    let message: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(message)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .appScreenBackground()
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
        }
        .navigationViewStyle(.stack)
    }
}
