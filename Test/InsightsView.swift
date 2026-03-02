//
//  InsightsView.swift
//
//  Interactive Insights with payments + bookings analytics.
//

import SwiftUI

struct InsightsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = InsightsViewModel()
    @State private var selectedTransaction: BalanceTransactionItem?
    @State private var selectedBooking: BookingRequest?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Analytics from payments and bookings")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    // Period picker
                    periodPicker
                        .padding(.horizontal)

                    // Tabs
                    Picker("Tab", selection: $viewModel.selectedTab) {
                        ForEach(InsightsTab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .onChange(of: viewModel.selectedTab) { _, _ in
                        viewModel.setFilter(nil)
                    }

                    if viewModel.selectedTab == .payments {
                        paymentsContent
                    } else {
                        bookingsContent
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
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .onChange(of: viewModel.selectedPeriod) { _, _ in
                Task { await viewModel.loadData(isDemoMode: authViewModel.isDemoMode) }
            }
            .sheet(item: $selectedTransaction) { txn in
                TransactionDetailSheet(transaction: txn)
            }
            .sheet(item: $selectedBooking) { br in
                BookingDetailSheet(booking: br)
            }
            .overlay {
                if viewModel.isLoading {
                    Color.black.opacity(0.2)
                        .ignoresSafeArea()
                    ProgressView()
                        .scaleEffect(1.2)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var periodPicker: some View {
        HStack(spacing: 8) {
            ForEach(InsightsPeriod.allCases, id: \.self) { period in
                Button(action: { viewModel.selectedPeriod = period }) {
                    Text(period.rawValue)
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(viewModel.selectedPeriod == period ? Color.black : Color.gray.opacity(0.15))
                        .foregroundColor(viewModel.selectedPeriod == period ? .white : .primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var paymentsContent: some View {
        if let err = viewModel.errorMessage, !err.isEmpty {
            Text(err)
                .font(.caption)
                .foregroundColor(.red)
                .padding(.horizontal)
        }

        if viewModel.tenantId == nil {
            VStack(spacing: 12) {
                Image(systemName: "link.badge.plus")
                    .font(.largeTitle)
                    .foregroundColor(.secondary)
                Text("Connect Stripe to see payment insights")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(32)
        } else {
            // Metric cards
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
            ], spacing: 12) {
                MetricCard(
                    title: "Available",
                    value: formatCurrency(viewModel.availableBalance),
                    icon: "checkmark.circle.fill",
                    color: .green,
                    onTap: { viewModel.setFilter(nil) }
                )
                MetricCard(
                    title: "Pending",
                    value: formatCurrency(viewModel.pendingBalance),
                    icon: "clock.fill",
                    color: .orange,
                    onTap: { viewModel.setFilter(nil) }
                )
                MetricCard(
                    title: "Net revenue",
                    value: formatCurrency(viewModel.periodNetRevenue),
                    icon: "chart.line.uptrend.xyaxis",
                    color: .blue,
                    onTap: { viewModel.setFilter(nil) }
                )
            }
            .padding(.horizontal)

            // Chart: Revenue over time
            if !viewModel.revenueByDay.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Revenue over time")
                        .font(.headline)
                        .padding(.horizontal)
                    SimpleBarChart(
                        data: viewModel.revenueByDay.map { ($0.date, max(0, $0.net)) },
                        label: { d in formatCurrency(d) },
                        dateLabel: { d in d.formatted(.dateTime.day().month(.abbreviated)) }
                    )
                    .frame(height: 160)
                    .padding()
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    .padding(.horizontal)
                }
            }

            // Transaction list
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Transactions")
                        .font(.headline)
                    if let ft = viewModel.filterTransactionType {
                        Button(action: { viewModel.setFilter(nil) }) {
                            Text("Filter: \(ft)")
                                .font(.caption)
                                .foregroundColor(.blue)
                        }
                    }
                }
                .padding(.horizontal)

                let list = viewModel.filteredTransactions
                if list.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.title)
                            .foregroundColor(.secondary)
                        Text("No transactions in this period")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(24)
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    .padding(.horizontal)
                } else {
                    VStack(spacing: 0) {
                        ForEach(list.prefix(20)) { txn in
                            BalanceTransactionRow(transaction: txn)
                                .onTapGesture { selectedTransaction = txn }
                        }
                    }
                    .background(Color(.systemBackground))
                    .cornerRadius(12)
                    .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                    .padding(.horizontal)
                }
            }
        }
    }

    @ViewBuilder
    private var bookingsContent: some View {
        // Metric cards
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible()),
        ], spacing: 12) {
            MetricCard(title: "Total", value: "\(viewModel.totalRequests)", icon: "doc.text.fill", color: .blue, onTap: {})
            MetricCard(title: "Confirmed", value: "\(viewModel.confirmedCount)", icon: "checkmark.circle.fill", color: .green, onTap: {})
            MetricCard(title: "Pending", value: "\(viewModel.pendingCount)", icon: "clock.fill", color: .orange, onTap: {})
            MetricCard(title: "Cancelled", value: "\(viewModel.cancelledCount)", icon: "xmark.circle.fill", color: .red, onTap: {})
            MetricCard(title: "Conversion", value: String(format: "%.0f%%", viewModel.conversionRate), icon: "percent", color: .purple, onTap: {})
        }
        .padding(.horizontal)

        // Chart: Bookings over time
        if !viewModel.bookingsByDay.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Bookings over time")
                    .font(.headline)
                    .padding(.horizontal)
                SimpleBarChart(
                    data: viewModel.bookingsByDay.map { ($0.date, Double($0.total)) },
                    label: { d in "\(Int(d))" },
                    dateLabel: { d in d.formatted(.dateTime.day().month(.abbreviated)) }
                )
                .frame(height: 160)
                .padding()
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                .padding(.horizontal)
            }
        }

        // Recent bookings list
        VStack(alignment: .leading, spacing: 12) {
            Text("Recent bookings")
                .font(.headline)
                .padding(.horizontal)

            if viewModel.bookingRequests.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "calendar.badge.exclamationmark")
                        .font(.title)
                        .foregroundColor(.secondary)
                    Text("No bookings in this period")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(24)
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                .padding(.horizontal)
            } else {
                VStack(spacing: 0) {
                    ForEach(viewModel.bookingRequests.prefix(15)) { br in
                        BookingInsightRow(booking: br)
                            .onTapGesture { selectedBooking = br }
                    }
                }
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
                .padding(.horizontal)
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

// MARK: - Metric Card (tappable)
struct MetricCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color
    var onTap: () -> Void = {}

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: icon)
                        .font(.subheadline)
                        .foregroundColor(color)
                    Spacer()
                }
                Text(value)
                    .font(.title3.weight(.bold))
                Text(title)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.systemBackground))
            .cornerRadius(12)
            .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Simple Bar Chart (SwiftUI)
struct SimpleBarChart: View {
    let data: [(Date, Double)]
    let label: (Double) -> String
    let dateLabel: (Date) -> String

    private var maxVal: Double {
        data.map(\.1).max() ?? 1
    }

    var body: some View {
        if data.isEmpty {
            EmptyView()
        } else {
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(Array(data.enumerated()), id: \.offset) { _, item in
                    VStack(spacing: 4) {
                        Text(label(item.1))
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.blue.opacity(0.7))
                            .frame(height: max(4, (item.1 / max(1, maxVal)) * 100))
                        Text(dateLabel(item.0))
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

// MARK: - Balance Transaction Row
struct BalanceTransactionRow: View {
    let transaction: BalanceTransactionItem

    private var isCredit: Bool {
        transaction.net > 0 || transaction.type == "charge" || transaction.type == "payment"
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(isCredit ? Color.green.opacity(0.2) : Color.orange.opacity(0.2))
                .frame(width: 40, height: 40)
                .overlay(
                    Image(systemName: isCredit ? "arrow.down" : "arrow.up")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(isCredit ? .green : .orange)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(transaction.type.capitalized)
                    .font(.subheadline.weight(.medium))
                Text(transaction.created.formatted(.dateTime))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text("\(isCredit ? "+" : "")\(formatAmount(transaction.net))")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(isCredit ? .green : .primary)
        }
        .padding()
    }

    private func formatAmount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0"
    }
}

// MARK: - Booking Insight Row
struct BookingInsightRow: View {
    let booking: BookingRequest

    private var statusColor: Color {
        let s = booking.status.uppercased()
        if s == "CONFIRMED" || s == "APPROVED" || s == "COMPLETED" { return .green }
        if s == "CANCELLED" || s == "DECLINED" { return .red }
        return .orange
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor.opacity(0.2))
                .frame(width: 40, height: 40)
                .overlay(
                    Text((booking.customerName ?? "?").prefix(1).uppercased())
                        .font(.subheadline.weight(.bold))
                        .foregroundColor(statusColor)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(booking.customerName ?? "Unknown")
                    .font(.subheadline.weight(.medium))
                Text(booking.serviceName ?? booking.status)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text(booking.status)
                .font(.caption.weight(.medium))
                .foregroundColor(statusColor)
        }
        .padding()
    }
}

// MARK: - Transaction Detail Sheet
struct TransactionDetailSheet: View {
    let transaction: BalanceTransactionItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                Section("Transaction") {
                    LabeledContent("Type", value: transaction.type.capitalized)
                    LabeledContent("Date", value: transaction.created.formatted(.dateTime))
                    LabeledContent("Amount", value: formatCurrency(transaction.amount))
                    LabeledContent("Fee", value: formatCurrency(transaction.fee))
                    LabeledContent("Net", value: formatCurrency(transaction.net))
                }
            }
            .navigationTitle("Transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: { dismiss() })
                }
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

// MARK: - Booking Detail Sheet
struct BookingDetailSheet: View {
    let booking: BookingRequest
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                Section("Customer") {
                    LabeledContent("Name", value: booking.customerName ?? "—")
                    LabeledContent("Email", value: booking.customerEmail ?? "—")
                    LabeledContent("Phone", value: booking.customerPhone ?? "—")
                }
                Section("Booking") {
                    LabeledContent("Service", value: booking.serviceName ?? "—")
                    LabeledContent("Status", value: booking.status)
                    LabeledContent("Source", value: booking.source ?? "—")
                    LabeledContent("Mode", value: booking.bookingModeUsed ?? "—")
                    if let d = booking.createdAt {
                        LabeledContent("Created", value: d.formatted(.dateTime))
                    }
                }
            }
            .navigationTitle("Booking")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: { dismiss() })
                }
            }
        }
    }
}

