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
    case shop
    case insights
    case payments
    case settings

    var id: String { rawValue }

    /// Drawer order (Team before Settings).
    static var drawerOrder: [AdminSection] {
        [
            .dashboard, .requests, .calendar, .messages, .clients,
            .team, .design, .shop, .insights, .payments, .settings,
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
        case .design: return "Design"
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
        case .clients, .team, .design, .insights, .payments: return .business
        case .shop, .settings: return .more
        }
    }

    static let drawerGroupOrder: [DrawerGroup] = [.main, .business, .more]

    var showsBetaBadge: Bool {
        self == .shop
    }

    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2.fill"
        case .requests: return "doc.text"
        case .calendar: return "calendar"
        case .messages: return "message"
        case .clients: return "person.2.fill"
        case .team: return "person.3.fill"
        case .design: return "paintbrush.fill"
        case .shop: return "bag.fill"
        case .insights: return "chart.bar.fill"
        case .payments: return "dollarsign.circle.fill"
        case .settings: return "gear"
        }
    }
}

@Observable
final class DrawerState {
    var isOpen = false
    var selectedSection: AdminSection = .dashboard
    /// Opens a specific customer profile in Clients (Firestore doc id).
    var customersDetailClientId: String?
    /// Prefill Messages compose from customer profile.
    var messagesComposePhone: String?
    var messagesComposeClientName: String?
    var messagesShouldOpenCompose = false
}

struct AdminRootView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @State private var drawerState = DrawerState()
    @StateObject private var dashboardMetrics = DashboardViewModel()
    @State private var visitedSections: Set<AdminSection> = [.dashboard]

    /// Solo owners use Business settings only; hide Team from the drawer.
    private var drawerSections: [AdminSection] {
        if authViewModel.isDemoMode {
            var sections = AdminSection.drawerOrder.filter { $0 != .team }
            if sessionStore.tenant?["shopEnabled"] as? Bool != true {
                sections = sections.filter { $0 != .shop }
            }
            return sections
        }
        let hideTeam =
            !authViewModel.isDemoMode
            && authViewModel.teamAccess.isOwner
            && authViewModel.tenantSubscriptionPlan.usesBusinessSettingsHub
        if hideTeam {
            return AdminSection.drawerOrder.filter { $0 != .team }
        }
        return AdminSection.drawerOrder
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
                    .onTapGesture { drawerState.isOpen = false }

                drawerContent
                    .frame(width: AppDesign.drawerWidth)
                    .background(AppDesign.cardBackground)
                    .shadow(color: .black.opacity(0.12), radius: 12, x: 4, y: 0)
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: drawerState.isOpen)
        .onChange(of: drawerState.selectedSection) { _, section in
            visitedSections.insert(section)
        }
        .onChange(of: authViewModel.tenantSubscriptionPlan) { _, _ in
            if !drawerSections.contains(drawerState.selectedSection) {
                drawerState.selectedSection = .dashboard
            }
        }
        .task(id: authViewModel.currentUserUid) {
            if authViewModel.isAuthenticated, authViewModel.currentUserUid != nil {
                sessionStore.reset()
                await sessionStore.bootstrap(
                    isDemoMode: authViewModel.isDemoMode,
                    demoPersona: authViewModel.demoPersona
                )
                await dashboardMetrics.loadData(
                    sessionStore: sessionStore,
                    isDemoMode: authViewModel.isDemoMode
                )
            } else if !authViewModel.isAuthenticated {
                sessionStore.reset()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
            if let url = note.userInfo?["logoUrl"] as? String {
                authViewModel.applyTenantLogoCache(url)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .tenantBusinessNameDidChange)) { _ in
            Task {
                await sessionStore.refreshProfileAndTenant()
                await dashboardMetrics.loadData(
                    sessionStore: sessionStore,
                    isDemoMode: authViewModel.isDemoMode
                )
            }
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
        case .requests: return sessionStore.unreadRequestsCount
        default: return 0
        }
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
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
                    Text(drawerBusinessSubtitle)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 0)
                Button(action: { drawerState.isOpen = false }) {
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
            drawerState.isOpen = false
        } label: {
            HStack(spacing: 12) {
                Image(systemName: section.icon)
                    .frame(width: 22, alignment: .center)
                    .font(.system(size: 15, weight: .medium))
                Text(section.shortTitle)
                    .font(.subheadline.weight(selected ? .semibold : .regular))
                if section.showsBetaBadge {
                    Text("Beta")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppDesign.brandWarm)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(AppDesign.brandWarm.opacity(0.12))
                        .clipShape(Capsule())
                }
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
