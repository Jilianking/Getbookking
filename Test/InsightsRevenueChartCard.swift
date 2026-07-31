//
//  InsightsRevenueChartCard.swift
//
//  Insights revenue card: line or bar chart for the selected period (date range is chosen above).
//

import SwiftUI
import Charts

enum InsightsRevenueChartStyle: String, CaseIterable, Identifiable {
    case line
    case bar

    var id: String { rawValue }

    var menuLabel: String {
        switch self {
        case .line: return "Line chart"
        case .bar: return "Bar chart"
        }
    }
}

struct InsightsRevenueChartCard: View {
    let weeklyPoints: [WeeklyRevenuePoint]
    let dailyPoints: [DailyRevenuePoint]
    let monthlyPoints: [MonthlyRevenuePoint]
    let periodTotal: Double
    let periodLabel: String
    let trendText: String
    var prefersMonthlyBuckets: Bool = false
    /// Force day-by-day series (e.g. This week / This month: 1st → today).
    var prefersDailyBuckets: Bool = false
    var showsConnectPrompt: Bool = false
    var usesLegacyRevenue: Bool = false

    @State private var chartStyle: InsightsRevenueChartStyle = .line
    @State private var selectedDate: Date?

    private enum SeriesKind {
        case daily
        case weekly
        case monthly
    }

    private var currencyFormat: FloatingPointFormatStyle<Double>.Currency {
        .currency(code: "USD").precision(.fractionLength(compactCurrency ? 0 : 2))
    }

    private var compactCurrency: Bool {
        max(periodTotal, series.map(\.amount).max() ?? 0) >= 1000
    }

    /// This week/month → daily; year → monthly; long custom → monthly; mid ranges → weekly.
    private var seriesKind: SeriesKind {
        if prefersMonthlyBuckets, !monthlyPoints.isEmpty {
            return .monthly
        }
        if prefersDailyBuckets, !dailyPoints.isEmpty {
            return .daily
        }
        // About a month or less: stay on days so scroll is day-by-day from period start.
        if dailyPoints.count <= 45 || weeklyPoints.count <= 1 {
            return .daily
        }
        if !monthlyPoints.isEmpty && (dailyPoints.count > 60 || (monthlyPoints.count >= 3 && weeklyPoints.count > 10)) {
            return .monthly
        }
        return .weekly
    }

    private struct SeriesPoint: Identifiable {
        let id: Int
        let date: Date
        let amount: Double
        let label: String
    }

    private var series: [SeriesPoint] {
        switch seriesKind {
        case .daily:
            return dailyPoints.map {
                SeriesPoint(
                    id: $0.id,
                    date: $0.date,
                    amount: $0.amount,
                    label: $0.date.formatted(.dateTime.month(.abbreviated).day())
                )
            }
        case .weekly:
            return weeklyPoints.map {
                SeriesPoint(id: $0.id, date: $0.weekStart, amount: $0.amount, label: $0.label)
            }
        case .monthly:
            return monthlyPoints.map {
                SeriesPoint(id: $0.id, date: $0.monthStart, amount: $0.amount, label: $0.label)
            }
        }
    }

    private var hasChartData: Bool {
        !series.isEmpty
    }

    private var selectedCallout: (title: String, amount: Double)? {
        guard let selectedDate, let point = selectedSeriesPoint(for: selectedDate) else { return nil }
        return (point.label, point.amount)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Revenue")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(periodLabel)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 8)
                chartStyleMenu
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(periodTotal, format: currencyFormat)
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                        .foregroundStyle(AppDesign.textPrimary)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    Text("in period")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 12)
                if !trendText.isEmpty {
                    Text(trendText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(trendText.contains("↘") ? AppDesign.accentRed : AppDesign.textSecondary)
                        .multilineTextAlignment(.trailing)
                }
            }

            if let callout = selectedCallout {
                HStack(spacing: 8) {
                    Text(callout.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Spacer(minLength: 8)
                    Text(callout.amount, format: currencyFormat)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(AppDesign.searchBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if !hasChartData {
                emptyState
            } else {
                switch chartStyle {
                case .line:
                    lineChart
                case .bar:
                    barChart
                }
            }

            if showsConnectPrompt {
                Text("Connect Stripe in Payments to track revenue automatically.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            } else if usesLegacyRevenue && hasChartData {
                Text("Based on completed bookings.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
        }
        .padding(16)
        .appCard()
        .animation(.easeInOut(duration: 0.18), value: selectedCallout?.title)
        .onChange(of: chartStyle) { _, _ in
            selectedDate = nil
        }
    }

    private var chartStyleMenu: some View {
        Menu {
            ForEach(InsightsRevenueChartStyle.allCases) { style in
                Button {
                    chartStyle = style
                } label: {
                    if chartStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(chartStyle.menuLabel)
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

    private var emptyState: some View {
        Text(emptyMessage)
            .font(.subheadline)
            .foregroundStyle(AppDesign.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
    }

    private var emptyMessage: String {
        if showsConnectPrompt {
            return "No revenue data yet"
        }
        return "No revenue in this period"
    }

    private var xUnit: Calendar.Component {
        switch seriesKind {
        case .daily: return .day
        case .weekly: return .weekOfYear
        case .monthly: return .month
        }
    }

    private var xDomain: ClosedRange<Date> {
        guard let first = series.first?.date, let last = series.last?.date else {
            let now = Date()
            return now ... now
        }
        let cal = Calendar.current
        switch seriesKind {
        case .monthly:
            let start = cal.date(from: cal.dateComponents([.year, .month], from: first)) ?? first
            let lastMonth = cal.date(from: cal.dateComponents([.year, .month], from: last)) ?? last
            let end = cal.date(byAdding: .month, value: 1, to: lastMonth) ?? last
            return start ... end
        case .daily, .weekly:
            let start = cal.startOfDay(for: first)
            let end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: last)) ?? last
            return start ... end
        }
    }

    private var shouldScrollHorizontally: Bool {
        seriesKind == .daily && series.count > 7
    }

    private var visibleDomainLength: TimeInterval {
        let visible = min(7, max(series.count, 1))
        return TimeInterval(visible) * 24 * 60 * 60
    }

    private var lineChart: some View {
        Chart {
            ForEach(series) { point in
                AreaMark(
                    x: .value("Period", point.date, unit: xUnit),
                    y: .value("Revenue", point.amount)
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
                    x: .value("Period", point.date, unit: xUnit),
                    y: .value("Revenue", point.amount)
                )
                .foregroundStyle(AppDesign.textPrimary)
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)

                PointMark(
                    x: .value("Period", point.date, unit: xUnit),
                    y: .value("Revenue", point.amount)
                )
                .foregroundStyle(AppDesign.textPrimary)
                .symbolSize(isSelected(point.date) ? 64 : 36)
            }

            if let selectedDate, let point = selectedSeriesPoint(for: selectedDate) {
                RuleMark(x: .value("Selected", point.date, unit: xUnit))
                    .foregroundStyle(AppDesign.chartBarFill.opacity(0.55))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .chartXScale(domain: xDomain)
        .chartXSelection(value: $selectedDate)
        .modifier(InsightsChartScrollModifier(
            enabled: shouldScrollHorizontally,
            visibleDomainLength: visibleDomainLength
        ))
        .chartYAxis { revenueYAxis }
        .chartXAxis { revenueXAxis }
        .frame(height: 180)
    }

    private var barChart: some View {
        Chart {
            ForEach(series) { point in
                BarMark(
                    x: .value("Period", point.date, unit: xUnit),
                    y: .value("Revenue", point.amount)
                )
                .foregroundStyle(isSelected(point.date) ? AppDesign.textPrimary : AppDesign.chartBarFill)
                .cornerRadius(4)
            }

            if let selectedDate, let point = selectedSeriesPoint(for: selectedDate) {
                RuleMark(x: .value("Selected", point.date, unit: xUnit))
                    .foregroundStyle(AppDesign.chartBarFill.opacity(0.55))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .chartXScale(domain: xDomain)
        .chartXSelection(value: $selectedDate)
        .modifier(InsightsChartScrollModifier(
            enabled: shouldScrollHorizontally,
            visibleDomainLength: visibleDomainLength
        ))
        .chartYAxis { revenueYAxis }
        .chartXAxis { revenueXAxis }
        .frame(height: 180)
    }

    @AxisContentBuilder
    private var revenueYAxis: some AxisContent {
        AxisMarks(position: .leading) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                .foregroundStyle(AppDesign.chipBorder.opacity(0.6))
            AxisValueLabel {
                if let amount = value.as(Double.self) {
                    Text(amount, format: .currency(code: "USD").precision(.fractionLength(0)))
                        .font(.caption2)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
        }
    }

    @AxisContentBuilder
    private var revenueXAxis: some AxisContent {
        switch seriesKind {
        case .daily:
            AxisMarks(values: .stride(by: .day, count: 1)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        if series.count <= 7 {
                            Text(date, format: .dateTime.weekday(.abbreviated))
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                        } else {
                            Text(date, format: .dateTime.month(.abbreviated).day())
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(AppDesign.textSecondary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                    }
                }
            }
        case .weekly:
            AxisMarks(values: series.map(\.date)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: .dateTime.month(.abbreviated).day())
                            .font(.caption2)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
        case .monthly:
            AxisMarks(values: series.map(\.date)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: .dateTime.month(.abbreviated))
                            .font(.caption2)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
        }
    }

    private var selectionGranularity: Calendar.Component {
        switch seriesKind {
        case .daily: return .day
        case .weekly: return .weekOfYear
        case .monthly: return .month
        }
    }

    private func isSelected(_ date: Date) -> Bool {
        guard let selectedDate else { return false }
        if seriesKind == .daily {
            return Calendar.current.isDate(date, inSameDayAs: selectedDate)
        }
        return Calendar.current.isDate(date, equalTo: selectedDate, toGranularity: selectionGranularity)
    }

    private func selectedSeriesPoint(for date: Date) -> SeriesPoint? {
        if seriesKind == .daily {
            return series.first { Calendar.current.isDate($0.date, inSameDayAs: date) }
        }
        return series.first {
            Calendar.current.isDate($0.date, equalTo: date, toGranularity: selectionGranularity)
        }
    }
}

private struct InsightsChartScrollModifier: ViewModifier {
    let enabled: Bool
    let visibleDomainLength: TimeInterval

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content
                .chartScrollableAxes(.horizontal)
                .chartXVisibleDomain(length: visibleDomainLength)
        } else {
            content
        }
    }
}
