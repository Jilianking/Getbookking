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
    case insights
    case settings

    var title: String {
        switch self {
        case .dashboard: return "Management Dashboard"
        case .requests: return "Booking Requests"
        case .calendar: return "Calendar"
        case .messages: return "Messages"
        case .clients: return "Customers"
        case .design: return "Web Page Design"
        case .insights: return "Insights"
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
        case .insights: return "chart.bar.fill"
        case .settings: return "gear"
        }
    }
}

@Observable
final class DrawerState {
    var isOpen = false
    var selectedSection: AdminSection = .dashboard
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
        case .insights:
            PlaceholderSectionView(drawerState: drawerState, title: AdminSection.insights.title, message: "Payments and insights coming soon.")
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

            // User block
            HStack(spacing: 12) {
                Circle()
                    .fill(Color.green.opacity(0.8))
                    .frame(width: 44, height: 44)
                    .overlay(
                        Text((authViewModel.currentUserDisplayName ?? "A").prefix(1).uppercased())
                            .font(.headline)
                            .foregroundColor(.white)
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
