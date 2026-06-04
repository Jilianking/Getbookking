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
    case aiTools
    case insights
    case payments
    case settings

    var id: String { rawValue }

    /// Drawer order (Team before Settings).
    static var drawerOrder: [AdminSection] {
        [
            .dashboard, .requests, .calendar, .messages, .clients,
            .team, .design, .shop, .aiTools, .insights, .payments, .settings,
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
        case .aiTools: return "AI tools"
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
        case .shop, .aiTools, .settings: return .more
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
        case .aiTools: return "sparkles"
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
    /// Opens a specific customer profile in Customers (Firestore doc id).
    var customersDetailClientId: String?
    /// Prefill Messages compose from customer profile.
    var messagesComposePhone: String?
    var messagesComposeClientName: String?
    var messagesShouldOpenCompose = false
}

struct AdminRootView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var drawerState = DrawerState()
    @StateObject private var dashboardMetrics = DashboardViewModel()

    /// Solo owners use Business settings only; hide Team from the drawer.
    private var drawerSections: [AdminSection] {
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
        .onChange(of: drawerState.isOpen) { _, isOpen in
            if isOpen, authViewModel.isAuthenticated {
                Task { await dashboardMetrics.loadData(isDemoMode: authViewModel.isDemoMode) }
            }
        }
        .onChange(of: authViewModel.tenantSubscriptionPlan) { _, _ in
            if !drawerSections.contains(drawerState.selectedSection) {
                drawerState.selectedSection = .dashboard
            }
        }
        .task(id: authViewModel.isAuthenticated) {
            if authViewModel.isAuthenticated {
                await authViewModel.refreshTeamAccess()
                await dashboardMetrics.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
            if let url = note.userInfo?["logoUrl"] as? String {
                authViewModel.applyTenantLogoCache(url)
            }
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        switch drawerState.selectedSection {
        case .dashboard:
            DashboardView(drawerState: drawerState, sectionTitle: AdminSection.dashboard.title)
        case .requests:
            RequestsView(drawerState: drawerState, sectionTitle: AdminSection.requests.title)
        case .calendar:
            CalendarView(drawerState: drawerState, sectionTitle: AdminSection.calendar.title)
        case .messages:
            MessagesView(drawerState: drawerState, sectionTitle: AdminSection.messages.title)
        case .clients:
            ClientsView(drawerState: drawerState, sectionTitle: AdminSection.clients.title)
        case .team:
            TeamView(drawerState: drawerState, sectionTitle: AdminSection.team.title)
        case .design:
            DesignView(drawerState: drawerState, sectionTitle: AdminSection.design.title)
        case .shop:
            ShopManagerView(drawerState: drawerState, sectionTitle: AdminSection.shop.title)
        case .aiTools:
            AILogoGeneratorView(drawerState: drawerState, sectionTitle: AdminSection.aiTools.title)
        case .insights:
            InsightsView(drawerState: drawerState, sectionTitle: AdminSection.insights.title)
        case .payments:
            PaymentsView(drawerState: drawerState, sectionTitle: AdminSection.payments.title)
        case .settings:
            SettingsView(drawerState: drawerState, sectionTitle: AdminSection.settings.title)
        }
    }

    private var drawerBusinessSubtitle: String {
        let industry = BookingTemplate(rawValue: dashboardMetrics.tenantIndustry)?.displayName ?? "Business"
        let plan = authViewModel.tenantSubscriptionPlan.displayName
        return "\(industry) · \(plan)"
    }

    private var drawerDisplayName: String {
        let business = dashboardMetrics.businessDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !business.isEmpty { return business }
        return authViewModel.currentUserDisplayName ?? "Your business"
    }

    private func badgeCount(for section: AdminSection) -> Int {
        switch section {
        case .requests: return dashboardMetrics.unreadRequestsCount
        default: return 0
        }
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                AppAvatarView(
                    tenantLogoURL: authViewModel.tenantLogoUrl,
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
