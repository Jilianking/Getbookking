//
//  InsightsView.swift
//
//  Analytics dashboard: range chips, KPI grid, bookings breakdown, top services, clients, payments.
//

import SwiftUI

struct InsightsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = InsightsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    private let kpiColumns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    private var currencyFormatter: NumberFormatter {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = revenueShowsCents ? 2 : 0
        return f
    }

    private var revenueShowsCents: Bool {
        viewModel.revenueInRange < 1000 && viewModel.revenueInRange.truncatingRemainder(dividingBy: 1) > 0.01
    }

    private var rangeChipFilters: [(filter: InsightsTimeRange, title: String)] {
        InsightsTimeRange.allCases.map { ($0, $0.chipLabel) }
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppFilterChipBar(filters: rangeChipFilters, selection: $viewModel.selectedRange)
                        .padding(.top, 4)

                    if let err = viewModel.loadError {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal, 16)
                    }

                    if viewModel.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(32)
                    } else {
                        kpiGrid
                        bookingsBreakdownCard
                        if !viewModel.topServiceLabels.isEmpty {
                            topServicesCard
                        }
                        clientsCard
                        if viewModel.useTenantData {
                            paymentsCard
                        } else if viewModel.revenueInRange > 0 {
                            legacyRevenueCard
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .appScreenBackground()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task { await viewModel.refresh(isDemoMode: authViewModel.isDemoMode) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
            .onChange(of: viewModel.selectedRange) { _, _ in
                viewModel.recomputeForSelectedRange()
            }
        }
        .navigationViewStyle(.stack)
        .task {
            await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
        }
    }

    // MARK: - KPI grid

    private var kpiGrid: some View {
        LazyVGrid(columns: kpiColumns, spacing: 12) {
            InsightMetricTile(
                icon: "calendar",
                iconColor: AppDesign.accentBlue,
                iconBackground: AppDesign.accentBlue.opacity(0.12),
                value: "\(viewModel.bookingsInRange)",
                label: "Bookings",
                trend: viewModel.bookingsTrendText,
                trendPositive: viewModel.bookingsTrendText.contains("+")
            )
            InsightMetricTile(
                icon: "dollarsign",
                iconColor: AppDesign.accentGreen,
                iconBackground: AppDesign.accentGreen.opacity(0.14),
                value: formatRevenue(viewModel.revenueInRange),
                label: "Revenue",
                trend: viewModel.revenueTrendText,
                trendPositive: !viewModel.revenueTrendText.contains("↘")
            )
            InsightMetricTile(
                icon: "person.2.fill",
                iconColor: Color(red: 0.55, green: 0.35, blue: 0.85),
                iconBackground: Color(red: 0.55, green: 0.35, blue: 0.85).opacity(0.12),
                value: "\(viewModel.clientsTotal)",
                label: "Clients",
                trend: viewModel.clientsTrendText,
                trendPositive: true
            )
            InsightMetricTile(
                icon: "xmark.circle.fill",
                iconColor: AppDesign.accentRed,
                iconBackground: AppDesign.declineBackground,
                value: "\(viewModel.noShowsInRange)",
                label: "No-shows",
                trend: viewModel.noShowsTrendText,
                trendPositive: viewModel.noShowsInRange == 0
            )
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Bookings breakdown

    private var bookingsBreakdownCard: some View {
        let b = viewModel.bookingBreakdown
        let total = max(b.total, 1)
        return InsightCardContainer {
            InsightCardHeader(
                icon: "doc.text.fill",
                iconColor: AppDesign.accentBlue,
                title: "Bookings",
                trailing: {
                    Button("View all") {
                        drawerState.selectedSection = .requests
                        drawerState.isOpen = false
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.accentBlue)
                }
            )
            VStack(spacing: 0) {
                breakdownRow(dot: AppDesign.accentBlue, label: "New", count: b.newCount, percent: b.percent(b.newCount, total: total))
                InsightDivider()
                breakdownRow(dot: AppDesign.accentGreen, label: "Confirmed", count: b.confirmed, percent: b.percent(b.confirmed, total: total))
                InsightDivider()
                breakdownRow(dot: AppDesign.accentRed, label: "Cancelled", count: b.cancelledOrDeclined, percent: b.percent(b.cancelledOrDeclined, total: total))
                if b.other > 0 {
                    InsightDivider()
                    breakdownRow(dot: AppDesign.textSecondary, label: "Other", count: b.other, percent: b.percent(b.other, total: total))
                }
            }
        }
    }

    private func breakdownRow(dot: Color, label: String, count: Int, percent: Int) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dot)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textPrimary)
            Spacer()
            Text("\(count)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
            Text("\(percent)%")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .frame(width: 36, alignment: .trailing)
        }
        .padding(.vertical, 12)
    }

    // MARK: - Top services

    private var topServicesCard: some View {
        let maxCount = viewModel.topServiceLabels.map(\.count).max() ?? 1
        return InsightCardContainer {
            InsightCardHeader(
                icon: "chart.bar.fill",
                iconColor: AppDesign.accentBlue,
                title: "Top services",
                trailing: {
                    Text(viewModel.selectedRange.periodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                }
            )
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { _, item in
                    InsightBarRow(label: item.label, value: item.count, maxValue: maxCount)
                }
            }
        }
    }

    // MARK: - Clients

    private var clientsCard: some View {
        InsightCardContainer {
            InsightCardHeader(
                icon: "person.2.fill",
                iconColor: Color(red: 0.55, green: 0.35, blue: 0.85),
                title: "Clients",
                trailing: {
                    Button("View all") {
                        drawerState.selectedSection = .clients
                        drawerState.isOpen = false
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.accentBlue)
                }
            )
            VStack(spacing: 0) {
                metricListRow(label: "Total clients", value: "\(viewModel.clientsTotal)", valueColor: AppDesign.textPrimary)
                InsightDivider()
                metricListRow(
                    label: "New (\(viewModel.selectedRange.periodLabel))",
                    value: "\(viewModel.clientsNewInRange)",
                    valueColor: viewModel.clientsNewInRange > 0 ? AppDesign.accentGreen : AppDesign.textPrimary,
                    prefix: viewModel.clientsNewInRange > 0 ? "+" : nil
                )
            }
        }
    }

    // MARK: - Payments

    private var paymentsCard: some View {
        InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "creditcard.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.accentGreen)
                    .frame(width: 28, alignment: .center)
                Text("Payments")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer(minLength: 8)
                if viewModel.stripeConnected {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                        Text("Stripe connected")
                            .font(.caption2.weight(.semibold))
                    }
                    .foregroundStyle(AppDesign.accentGreen)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(AppDesign.accentGreen.opacity(0.12))
                    .clipShape(Capsule())
                }
            }
            if viewModel.stripeConnected {
                VStack(spacing: 0) {
                    metricListRow(
                        label: "Available balance",
                        value: formatCurrency(viewModel.availableBalance),
                        valueColor: AppDesign.accentGreen
                    )
                    InsightDivider()
                    metricListRow(label: "Pending", value: formatCurrency(viewModel.pendingBalance))
                    InsightDivider()
                    metricListRow(
                        label: "Charges (\(viewModel.selectedRange.periodLabel))",
                        value: "\(viewModel.paymentChargesInRange)"
                    )
                    InsightDivider()
                    metricListRow(
                        label: "Volume (\(viewModel.selectedRange.periodLabel))",
                        value: formatVolume(viewModel.paymentVolumeInRange)
                    )
                }
            } else {
                Text("Connect Stripe in Payments to see balances and charges.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
        }
    }

    private var legacyRevenueCard: some View {
        InsightCardContainer {
            InsightCardHeader(
                icon: "dollarsign.circle.fill",
                iconColor: AppDesign.accentGreen,
                title: "Revenue",
                trailing: {
                    Text(viewModel.selectedRange.periodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                }
            )
            metricListRow(
                label: "Completed bookings",
                value: formatRevenue(viewModel.revenueInRange),
                valueColor: AppDesign.accentGreen
            )
        }
    }

    // MARK: - Helpers

    private func metricListRow(
        label: String,
        value: String,
        valueColor: Color = AppDesign.textPrimary,
        prefix: String? = nil
    ) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            Spacer()
            if let prefix {
                Text(prefix)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(valueColor)
            }
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(valueColor)
        }
        .padding(.vertical, 12)
    }

    private func formatRevenue(_ value: Double) -> String {
        if value >= 1000 {
            return formatVolume(value)
        }
        return currencyFormatter.string(from: NSNumber(value: value)) ?? "$0"
    }

    private func formatCurrency(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = value >= 100 ? 0 : 2
        return f.string(from: NSNumber(value: value)) ?? "$0"
    }

    private func formatVolume(_ value: Double) -> String {
        if value >= 1000 {
            let k = value / 1000
            if k >= 10 {
                return String(format: "$%.0fK", k)
            }
            return String(format: "$%.1fK", k)
        }
        return formatCurrency(value)
    }
}

// MARK: - Card chrome

private struct InsightCardContainer<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(16)
        .appCard()
        .padding(.horizontal, 16)
    }
}

private struct InsightCardHeader<Trailing: View>: View {
    let icon: String
    let iconColor: Color
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(iconColor)
                .frame(width: 28, alignment: .center)
            Text(title)
                .font(.headline.weight(.bold))
                .foregroundStyle(AppDesign.textPrimary)
            Spacer(minLength: 8)
            trailing()
        }
    }
}

private struct InsightDivider: View {
    var body: some View {
        Divider()
            .overlay(AppDesign.chipBorder.opacity(0.5))
    }
}

private struct InsightBarRow: View {
    let label: String
    let value: Int
    let maxValue: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineLimit(1)
                Spacer()
                Text("\(value)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
            }
            GeometryReader { geo in
                let width = maxValue > 0 ? geo.size.width * CGFloat(value) / CGFloat(maxValue) : 0
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(AppDesign.searchBackground)
                        .frame(height: 8)
                    Capsule()
                        .fill(AppDesign.accentBlue)
                        .frame(width: max(width, value > 0 ? 8 : 0), height: 8)
                }
            }
            .frame(height: 8)
        }
    }
}
