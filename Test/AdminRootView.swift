//
//  AdminRootView.swift
//
//  Root admin UI: sidebar drawer + main content.
//

import SwiftUI
import Observation

enum AdminSection: String, CaseIterable {
    case dashboard
    case requests
    case calendar
    case messages
    case clients
    case design
    case shop
    case aiTools
    case insights
    case payments
    case settings

    var title: String {
        switch self {
        case .dashboard: return "Management Dashboard"
        case .requests: return "Booking Requests"
        case .calendar: return "Calendar"
        case .messages: return "Messages"
        case .clients: return "Customers"
        case .design: return "Web Page Design"
        case .shop: return "Shop"
        case .aiTools: return "AI Tools"
        case .insights: return "Insights"
        case .payments: return "Payments"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2.fill"
        case .requests: return "doc.text"
        case .calendar: return "calendar"
        case .messages: return "message"
        case .clients: return "person.2.fill"
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
}

/// Initials always visible; profile photo preferred, then tenant logo; fades in when loaded.
private struct DrawerTenantLogoView: View {
    let tenantLogoURL: String?
    let accountPhotoURL: String?
    let displayNameFallback: String?
    private let side: CGFloat = 44
    @State private var logoOpaque = false
    @State private var imageRetryCount = 0

    private var resolvedImageURL: URL? {
        let a = accountPhotoURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !a.isEmpty, let u = URL(string: a) { return u }
        let t = tenantLogoURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !t.isEmpty, let u = URL(string: t) { return u }
        return nil
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.green.opacity(0.8))
                .frame(width: side, height: side)
                .overlay(
                    Text((displayNameFallback ?? "A").prefix(1).uppercased())
                        .font(.headline)
                        .foregroundColor(.white)
                )
            if let url = resolvedImageURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                            .onAppear {
                                withAnimation(.easeIn(duration: 0.22)) {
                                    logoOpaque = true
                                }
                            }
                    case .failure:
                        Color.clear
                            .onAppear {
                                guard imageRetryCount < 3 else { return }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                                    imageRetryCount += 1
                                }
                            }
                    default:
                        Color.clear
                    }
                }
                .id("\(url.absoluteString)-\(imageRetryCount)")
                .frame(width: side, height: side)
                .clipShape(Circle())
                .opacity(logoOpaque ? 1 : 0)
                .animation(.easeIn(duration: 0.22), value: logoOpaque)
            }
        }
        .frame(width: side, height: side)
        .onChange(of: tenantLogoURL) { _, _ in
            logoOpaque = false
            imageRetryCount = 0
        }
        .onChange(of: accountPhotoURL) { _, _ in
            logoOpaque = false
            imageRetryCount = 0
        }
    }
}

struct AdminRootView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var drawerState = DrawerState()

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
                    .frame(width: 280)
                    .background(Color(.systemBackground))
                    .shadow(radius: 8)
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: drawerState.isOpen)
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

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Admin App")
                    .font(.headline)
                Spacer()
                Button(action: { drawerState.isOpen = false }) {
                    Image(systemName: "xmark")
                        .font(.body.weight(.medium))
                }
            }
            .padding()

            Divider()

            // Menu
            VStack(alignment: .leading, spacing: 0) {
                ForEach(AdminSection.allCases, id: \.self) { section in
                    Button(action: {
                        drawerState.selectedSection = section
                        drawerState.isOpen = false
                    }) {
                        HStack(spacing: 12) {
                            Image(systemName: section.icon)
                                .frame(width: 24, alignment: .center)
                            Text(section.title)
                                .font(.subheadline)
                        }
                        .foregroundColor(drawerState.selectedSection == section ? .white : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 16)
                        .background(drawerState.selectedSection == section ? Color.black : Color.clear)
                        .cornerRadius(8)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 2)
                }
            }
            .padding(.vertical, 8)

            Spacer()

            // User block (avatar = business logo when set in Web Page Design)
            HStack(spacing: 12) {
                DrawerTenantLogoView(
                    tenantLogoURL: authViewModel.tenantLogoUrl,
                    accountPhotoURL: authViewModel.accountPhotoUrl,
                    displayNameFallback: authViewModel.currentUserDisplayName
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(authViewModel.currentUserDisplayName ?? "Admin User")
                        .font(.subheadline.weight(.semibold))
                    Text(authViewModel.currentUserEmail ?? "admin@adminapp.com")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
            .padding()
        }
        .padding(.top, 8)
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
            .background(Color.gray.opacity(0.06))
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
