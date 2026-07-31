//
//  InsightsView.swift
//
//  Analytics dashboard: period menu, revenue chart, bookings, services, clients, payments.
//

import SwiftUI
import Charts

struct InsightsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = InsightsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppScreenTitle(title: sectionTitle)
                    insightsRangePicker

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
                        InsightsRevenueChartCard(
                            weeklyPoints: viewModel.revenueWeeklyPoints,
                            dailyPoints: viewModel.revenueDailyPoints,
                            monthlyPoints: viewModel.revenueMonthlyPoints,
                            periodTotal: viewModel.revenueInRange,
                            periodLabel: viewModel.displayPeriodLabel,
                            trendText: viewModel.revenueTrendText,
                            prefersMonthlyBuckets: viewModel.selectedRange == .thisYear,
                            prefersDailyBuckets: viewModel.selectedRange == .thisWeek
                                || viewModel.selectedRange == .thisMonth,
                            showsConnectPrompt: viewModel.useTenantData && !viewModel.stripeConnected,
                            usesLegacyRevenue: !viewModel.useTenantData
                        )
                        .padding(.horizontal, 16)
                        bookingsBreakdownCard
                        if !viewModel.topServiceLabels.isEmpty {
                            topServicesCard
                        }
                        clientsCard
                        if viewModel.useTenantData {
                            paymentsCard
                        }
                    }
                }
                .padding(.bottom, 24)
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
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            await viewModel.refresh(
                                isDemoMode: authViewModel.isDemoMode,
                                sessionStore: sessionStore
                            )
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .refreshable {
                await viewModel.refresh(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            .onChange(of: viewModel.selectedRange) { _, _ in
                viewModel.recomputeForSelectedRange()
            }
            .onChange(of: viewModel.customRangeStart) { _, _ in
                guard viewModel.selectedRange == .custom else { return }
                viewModel.recomputeForSelectedRange()
            }
            .onChange(of: viewModel.customRangeEnd) { _, _ in
                guard viewModel.selectedRange == .custom else { return }
                viewModel.recomputeForSelectedRange()
            }
        }
        .navigationViewStyle(.stack)
        .task {
            await viewModel.loadData(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
    }

    // MARK: - Range picker

    private var insightsRangePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Menu {
                ForEach(InsightsTimeRange.allCases) { range in
                    Button {
                        viewModel.selectedRange = range
                    } label: {
                        if viewModel.selectedRange == range {
                            Label(range.menuLabel, systemImage: "checkmark")
                        } else {
                            Text(range.menuLabel)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(viewModel.selectedRange.menuLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppDesign.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AppDesign.cardBackground)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(AppDesign.chipBorder, lineWidth: 1)
                )
            }

            if viewModel.selectedRange == .custom {
                HStack(spacing: 10) {
                    customDateField(date: $viewModel.customRangeStart)
                    Text("to")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                    customDateField(date: $viewModel.customRangeEnd)
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private func customDateField(date: Binding<Date>) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "calendar")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            DatePicker(
                "",
                selection: date,
                displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(AppDesign.chipBorder, lineWidth: 1)
        )
    }

    // MARK: - Bookings breakdown

    private enum BookingsDisplayStyle: String, CaseIterable, Identifiable {
        case list
        case donut

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .list: return "List"
            case .donut: return "Donut chart"
            }
        }
    }

    @State private var bookingsDisplayStyle: BookingsDisplayStyle = .donut

    private struct BookingSlice: Identifiable {
        let id: String
        let label: String
        let count: Int
        let percent: Int
        let color: Color
    }

    private var bookingSlices: [BookingSlice] {
        let b = viewModel.bookingBreakdown
        let total = max(b.total, 1)
        var slices: [BookingSlice] = [
            BookingSlice(id: "new", label: "New", count: b.newCount, percent: b.percent(b.newCount, total: total), color: AppDesign.brandWarm),
            BookingSlice(id: "confirmed", label: "Confirmed", count: b.confirmed, percent: b.percent(b.confirmed, total: total), color: AppDesign.brandDark),
            BookingSlice(id: "cancelled", label: "Cancelled", count: b.cancelledOrDeclined, percent: b.percent(b.cancelledOrDeclined, total: total), color: AppDesign.statusCancelled),
        ]
        if b.other > 0 {
            slices.append(
                BookingSlice(id: "other", label: "Other", count: b.other, percent: b.percent(b.other, total: total), color: AppDesign.textSecondary)
            )
        }
        return slices
    }

    private var bookingsBreakdownCard: some View {
        InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "doc.text.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                Text("Bookings")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer(minLength: 8)
                bookingsStyleMenu
                Button("View all") {
                    drawerState.selectedSection = .requests
                    drawerState.isOpen = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.linkAccent)
            }

            if viewModel.bookingBreakdown.total == 0 {
                Text("No bookings in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            } else {
                switch bookingsDisplayStyle {
                case .list:
                    bookingsListView
                case .donut:
                    bookingsDonutView
                }
            }
        }
    }

    private var bookingsStyleMenu: some View {
        Menu {
            ForEach(BookingsDisplayStyle.allCases) { style in
                Button {
                    bookingsDisplayStyle = style
                } label: {
                    if bookingsDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(bookingsDisplayStyle.menuLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppDesign.searchBackground)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(AppDesign.chipBorder.opacity(0.7), lineWidth: 1)
            )
        }
    }

    private var bookingsListView: some View {
        VStack(spacing: 0) {
            ForEach(Array(bookingSlices.enumerated()), id: \.element.id) { index, slice in
                if index > 0 { InsightDivider() }
                breakdownRow(dot: slice.color, label: slice.label, count: slice.count, percent: slice.percent)
            }
        }
    }

    private var bookingsDonutView: some View {
        HStack(alignment: .center, spacing: 20) {
            Chart(bookingSlices.filter { $0.count > 0 }) { slice in
                SectorMark(
                    angle: .value("Count", slice.count),
                    innerRadius: .ratio(0.58),
                    angularInset: 1.5
                )
                .foregroundStyle(slice.color)
                .cornerRadius(3)
            }
            .frame(width: 132, height: 132)

            VStack(alignment: .leading, spacing: 10) {
                ForEach(bookingSlices) { slice in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(slice.color)
                            .frame(width: 8, height: 8)
                        Text(slice.label)
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textPrimary)
                        Spacer(minLength: 4)
                        Text("\(slice.percent)%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 4)
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
                iconColor: AppDesign.iconTileForeground,
                title: "Top services",
                trailing: {
                    Text(viewModel.displayPeriodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
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
                iconColor: AppDesign.iconTileForeground,
                title: "Clients",
                trailing: {
                    Button("View all") {
                        drawerState.selectedSection = .clients
                        drawerState.isOpen = false
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.linkAccent)
                }
            )
            VStack(spacing: 0) {
                metricListRow(label: "Total clients", value: "\(viewModel.clientsTotal)", valueColor: AppDesign.textPrimary)
                InsightDivider()
                metricListRow(
                    label: "New (\(viewModel.displayPeriodLabel))",
                    value: "\(viewModel.clientsNewInRange)",
                    valueColor: viewModel.clientsNewInRange > 0 ? AppDesign.brandWarm : AppDesign.textPrimary,
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
                    .foregroundStyle(AppDesign.iconTileForeground)
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
                    .foregroundStyle(AppDesign.brandWarm)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(AppDesign.brandCream)
                    .clipShape(Capsule())
                }
            }
            if viewModel.stripeConnected {
                VStack(spacing: 0) {
                    metricListRow(
                        label: "Total balance",
                        value: formatCurrency(viewModel.availableBalance + viewModel.pendingBalance),
                        valueColor: AppDesign.brandWarm
                    )
                    InsightDivider()
                    metricListRow(
                        label: "Ready to withdraw",
                        value: formatCurrency(max(0, viewModel.availableBalance))
                    )
                    InsightDivider()
                    metricListRow(
                        label: "Settling",
                        value: formatCurrency(
                            viewModel.availableBalance < 0
                                ? viewModel.pendingBalance + viewModel.availableBalance
                                : viewModel.pendingBalance
                        )
                    )
                    InsightDivider()
                    metricListRow(
                        label: "Charges (\(viewModel.displayPeriodLabel))",
                        value: "\(viewModel.paymentChargesInRange)"
                    )
                    InsightDivider()
                    metricListRow(
                        label: "Volume (\(viewModel.displayPeriodLabel))",
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
                        .fill(AppDesign.chartBarFill)
                        .frame(width: max(width, value > 0 ? 8 : 0), height: 8)
                }
            }
            .frame(height: 8)
        }
    }
}
