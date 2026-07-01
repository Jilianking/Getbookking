//
//  InsightsRevenueChartCard.swift
//
//  Unified revenue chart for Insights: weekly line or daily bars.
//

import SwiftUI
import Charts

enum InsightsRevenueChartMode: String, CaseIterable, Identifiable {
    case weekly
    case daily

    var id: String { rawValue }

    var title: String {
        switch self {
        case .weekly: return "Weekly"
        case .daily: return "Daily"
        }
    }
}

struct InsightsRevenueChartCard: View {
    let weeklyPoints: [WeeklyRevenuePoint]
    let dailyPoints: [DailyRevenuePoint]
    let periodTotal: Double
    let periodLabel: String
    let trendText: String
    var showsConnectPrompt: Bool = false
    var usesLegacyRevenue: Bool = false

    @State private var mode: InsightsRevenueChartMode = .weekly

    private var currencyFormat: FloatingPointFormatStyle<Double>.Currency {
        .currency(code: "USD").precision(.fractionLength(compactCurrency ? 0 : 2))
    }

    private var compactCurrency: Bool {
        max(periodTotal, weeklyPoints.map(\.amount).max() ?? 0, dailyPoints.map(\.amount).max() ?? 0) >= 1000
    }

    private var hasChartData: Bool {
        switch mode {
        case .weekly: return !weeklyPoints.isEmpty
        case .daily: return !dailyPoints.isEmpty
        }
    }

    private var subtitle: String {
        switch mode {
        case .weekly:
            return "Weekly · \(periodLabel)"
        case .daily:
            return "Daily · \(periodLabel)"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Revenue")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 8)
                Picker("View", selection: $mode) {
                    ForEach(InsightsRevenueChartMode.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 180)
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

            if !hasChartData {
                emptyState
            } else {
                switch mode {
                case .weekly:
                    weeklyChart
                case .daily:
                    dailyChart
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

    private var weeklyChart: some View {
        Chart(weeklyPoints) { point in
            AreaMark(
                x: .value("Week", point.label),
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
                x: .value("Week", point.label),
                y: .value("Revenue", point.amount)
            )
            .foregroundStyle(AppDesign.textPrimary)
            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.catmullRom)

            PointMark(
                x: .value("Week", point.label),
                y: .value("Revenue", point.amount)
            )
            .foregroundStyle(AppDesign.textPrimary)
            .symbolSize(36)
        }
        .chartYAxis {
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
        .chartXAxis {
            AxisMarks { value in
                AxisValueLabel {
                    if let label = value.as(String.self) {
                        Text(label)
                            .font(.caption2)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
        }
        .frame(height: 180)
    }

    private var dailyAxisStride: Int {
        RevenueChartMath.dailyAxisStrideDays(dayCount: dailyPoints.count)
    }

    private var dailyUsesWeekdayLabels: Bool {
        dailyPoints.count <= 7
    }

    private var dailyXDomain: ClosedRange<Date> {
        guard let first = dailyPoints.first?.date, let last = dailyPoints.last?.date else {
            let now = Date()
            return now ... now
        }
        let cal = Calendar.current
        let start = cal.startOfDay(for: first)
        let end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: last)) ?? last
        return start ... end
    }

    private var dailyChart: some View {
        Chart(dailyPoints) { point in
            BarMark(
                x: .value("Day", point.date, unit: .day),
                y: .value("Revenue", point.amount)
            )
            .foregroundStyle(AppDesign.chartBarFill)
            .cornerRadius(4)
        }
        .chartXScale(domain: dailyXDomain)
        .chartYAxis {
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
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: dailyAxisStride)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        if dailyUsesWeekdayLabels {
                            Text(date, format: .dateTime.weekday(.abbreviated))
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                        } else {
                            Text(date, format: .dateTime.month(.abbreviated).day())
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                }
            }
        }
        .frame(height: 180)
    }
}
