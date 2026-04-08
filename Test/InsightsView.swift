//
//  InsightsView.swift
//
//  Admin snapshot across bookings, customers, catalog, Stripe, and tenant profile.
//

import SwiftUI

struct InsightsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = InsightsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    private var currencyFormatter: NumberFormatter {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Bookings, customers, catalog, and payments at a glance")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    if let err = viewModel.loadError {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    if viewModel.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        bookingsSection
                        customersCatalogSection
                        if viewModel.useTenantData {
                            webProfileSection
                            paymentsSection
                        } else {
                            legacyExtrasSection
                        }
                    }
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
    }

    // MARK: - Sections

    private var bookingsSection: some View {
        insightCard(title: "Bookings", subtitle: viewModel.useTenantData ? "Tenant booking requests" : "Legacy requests") {
            HStack {
                Button("Open requests") {
                    drawerState.selectedSection = .requests
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundColor(.blue)
                Spacer()
            }
            insightRow("Total", value: "\(viewModel.bookingTotal)")
            insightRow("New / unread", value: "\(viewModel.bookingNew) · \(viewModel.bookingUnreadNew) unread")
            insightRow("Confirmed", value: "\(viewModel.bookingConfirmed)")
            insightRow("Cancelled / declined", value: "\(viewModel.bookingCancelledOrDeclined)")
            insightRow("Other status", value: "\(viewModel.bookingOther)")
            insightRow("Created (last 30 days)", value: "\(viewModel.bookingsLast30Days)")
            if !viewModel.topServiceLabels.isEmpty {
                Divider().padding(.vertical, 4)
                Text("Top services")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { _, item in
                    HStack {
                        Text(item.label)
                            .font(.subheadline)
                        Spacer()
                        Text("\(item.count)")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
    }

    private var customersCatalogSection: some View {
        insightCard(title: "Customers & catalog", subtitle: viewModel.useTenantData ? "Tenant-scoped" : "Legacy clients only") {
            if viewModel.useTenantData {
                Button("Open customers") {
                    drawerState.selectedSection = .clients
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundColor(.blue)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            insightRow("Customers", value: "\(viewModel.customerCount)")
            insightRow("New customers (30 days)", value: "\(viewModel.customersNewLast30Days)")
            if viewModel.useTenantData {
                insightRow("Services listed", value: "\(viewModel.serviceCount)")
                insightRow("Products", value: "\(viewModel.productCount)")
                insightRow("Shop enabled", value: viewModel.shopEnabled ? "Yes" : "No")
            }
        }
    }

    private var webProfileSection: some View {
        insightCard(title: "Web & profile", subtitle: "Tenant settings (no traffic stats)") {
            Button("Edit in Design") {
                drawerState.selectedSection = .design
                drawerState.isOpen = false
            }
            .font(.subheadline.weight(.medium))
            .foregroundColor(.purple)
            .frame(maxWidth: .infinity, alignment: .leading)
            insightRow("Business name", value: viewModel.businessDisplayName ?? "—")
            insightRow("Industry", value: viewModel.industryLabel ?? "—")
            insightRow("Web theme", value: viewModel.webThemeLabel ?? "—")
        }
    }

    private var paymentsSection: some View {
        insightCard(title: "Payments", subtitle: "Stripe Connect") {
            HStack {
                Button("Open payments") {
                    drawerState.selectedSection = .payments
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundColor(.green)
                Spacer()
            }
            if viewModel.stripeConnected {
                insightRow("Available", value: currencyFormatter.string(from: NSNumber(value: viewModel.availableBalance)) ?? "—")
                insightRow("Pending", value: currencyFormatter.string(from: NSNumber(value: viewModel.pendingBalance)) ?? "—")
                insightRow("Charges (30 days)", value: "\(viewModel.paymentChargesLast30Days)")
                insightRow("Charge volume (30 days)", value: currencyFormatter.string(from: NSNumber(value: viewModel.paymentVolumeLast30Days)) ?? "—")
                insightRow("Transactions in feed", value: "\(viewModel.paymentTransactionsReturned)")
            } else {
                Text("Connect Stripe in Payments to see balances and recent charges.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    private var legacyExtrasSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            insightCard(title: "Revenue (this month)", subtitle: "Completed legacy requests") {
                insightRow("MTD (price + cash tips)", value: currencyFormatter.string(from: NSNumber(value: viewModel.legacyMonthlyRevenue)) ?? "—")
            }
            insightCard(title: "Calendar", subtitle: "Events in last 30 days") {
                Button("Open calendar") {
                    drawerState.selectedSection = .calendar
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundColor(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
                insightRow("Events", value: "\(viewModel.calendarEventsLast30Days)")
            }
        }
    }

    @ViewBuilder
    private func insightCard<Content: View>(title: String, subtitle: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.title3.weight(.bold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal)
            VStack(alignment: .leading, spacing: 10) {
                content()
            }
            .padding(.horizontal)
            .padding(.bottom, 12)
        }
        .padding(.vertical, 12)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
        .padding(.horizontal)
    }

    private func insightRow(_ label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium))
                .multilineTextAlignment(.trailing)
        }
    }
}
