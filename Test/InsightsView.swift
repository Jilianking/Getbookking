//
//  InsightsView.swift
//
//  Analytics dashboard: period menu, revenue chart, bookings, services, clients.
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

    private enum TopServicesDisplayStyle: String, CaseIterable, Identifiable {
        case bars
        case rankedList

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .bars: return "Bars"
            case .rankedList: return "Ranked list"
            }
        }
    }

    @State private var topServicesDisplayStyle: TopServicesDisplayStyle = .bars

    private var topServicesCard: some View {
        let maxCount = viewModel.topServiceLabels.map(\.count).max() ?? 1
        return InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "chart.bar.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Top services")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(viewModel.displayPeriodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 8)
                topServicesStyleMenu
            }

            switch topServicesDisplayStyle {
            case .bars:
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { _, item in
                        InsightBarRow(label: item.label, value: item.count, maxValue: maxCount)
                    }
                }
            case .rankedList:
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { index, item in
                        if index > 0 { InsightDivider() }
                        topServiceRankedRow(rank: index + 1, label: item.label, count: item.count)
                    }
                }
            }
        }
    }

    private var topServicesStyleMenu: some View {
        Menu {
            ForEach(TopServicesDisplayStyle.allCases) { style in
                Button {
                    topServicesDisplayStyle = style
                } label: {
                    if topServicesDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(topServicesDisplayStyle.menuLabel)
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

    private func topServiceRankedRow(rank: Int, label: String, count: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(AppDesign.textSecondary)
                .frame(width: 20, alignment: .leading)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 8)
            Text("\(count)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
        }
        .padding(.vertical, 12)
    }

    // MARK: - Clients

    private enum ClientsDisplayStyle: String, CaseIterable, Identifiable {
        case donut
        case bar
        case line

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .donut: return "Donut chart"
            case .bar: return "Bar chart"
            case .line: return "Line chart"
            }
        }
    }

    @State private var clientsDisplayStyle: ClientsDisplayStyle = .donut

    private struct ClientDonutSlice: Identifiable {
        let id: String
        let label: String
        let count: Int
        let color: Color
    }

    private var clientsCard: some View {
        InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "person.2.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Clients")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(viewModel.displayPeriodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 8)
                clientsStyleMenu
            }

            switch clientsDisplayStyle {
            case .donut:
                clientsDonutView
            case .bar:
                clientsBarChart
            case .line:
                clientsLineChart
            }
        }
    }

    private var clientsStyleMenu: some View {
        Menu {
            ForEach(ClientsDisplayStyle.allCases) { style in
                Button {
                    clientsDisplayStyle = style
                } label: {
                    if clientsDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(clientsDisplayStyle.menuLabel)
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

    private var clientsDonutView: some View {
        let slices = [
            ClientDonutSlice(id: "new", label: "New", count: viewModel.clientsNewInRange, color: AppDesign.brandWarm),
            ClientDonutSlice(id: "existing", label: "Existing", count: viewModel.clientsExistingInRange, color: AppDesign.brandDark),
        ]
        let chartSlices = slices.filter { $0.count > 0 }
        let total = max(viewModel.clientsTotal, 1)

        return Group {
            if viewModel.clientsTotal == 0 {
                Text("No clients yet")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            } else {
                HStack(alignment: .center, spacing: 20) {
                    Chart(chartSlices) { slice in
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
                        ForEach(slices) { slice in
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(slice.color)
                                    .frame(width: 8, height: 8)
                                Text(slice.label)
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.textPrimary)
                                Spacer(minLength: 4)
                                Text("\(slice.count)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AppDesign.textPrimary)
                                Text("\(Int((Double(slice.count) / Double(total) * 100).rounded()))%")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AppDesign.textSecondary)
                                    .frame(width: 36, alignment: .trailing)
                            }
                        }
                        Text("Total \(viewModel.clientsTotal)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AppDesign.textSecondary)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 4)
            }
        }
    }

    private var clientsUsesMonthlySeries: Bool {
        viewModel.selectedRange == .thisYear || viewModel.clientsSeriesPoints.count > 45
    }

    private var clientsBarChart: some View {
        let points = viewModel.clientsSeriesPoints
        return Group {
            if points.isEmpty || points.allSatisfy({ $0.count == 0 }) {
                Text("No new clients in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
            } else {
                Chart(points) { point in
                    BarMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.chartBarFill)
                    .cornerRadius(4)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                        AxisValueLabel {
                            if let n = value.as(Int.self) {
                                Text("\(n)")
                                    .font(.caption2)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(
                                    date,
                                    format: clientsUsesMonthlySeries
                                        ? .dateTime.month(.abbreviated)
                                        : .dateTime.month(.abbreviated).day()
                                )
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .frame(height: 160)
                .padding(.top, 4)
            }
        }
    }

    private var clientsLineChart: some View {
        let points = viewModel.clientsSeriesPoints
        return Group {
            if points.isEmpty || points.allSatisfy({ $0.count == 0 }) {
                Text("No new clients in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
            } else {
                Chart(points) { point in
                    AreaMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                AppDesign.chartBarFill.opacity(0.22),
                                AppDesign.chartBarFill.opacity(0),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)

                    LineMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)

                    PointMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.textPrimary)
                    .symbolSize(36)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                        AxisValueLabel {
                            if let n = value.as(Int.self) {
                                Text("\(n)")
                                    .font(.caption2)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(
                                    date,
                                    format: clientsUsesMonthlySeries
                                        ? .dateTime.month(.abbreviated)
                                        : .dateTime.month(.abbreviated).day()
                                )
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .frame(height: 160)
                .padding(.top, 4)
            }
        }
    }

    // MARK: - Helpers
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
