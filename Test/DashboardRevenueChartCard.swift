//
//  DashboardRevenueChartCard.swift
//
//  Weekly revenue line chart for the dashboard home screen.
//

import SwiftUI
import Charts

struct WeeklyRevenuePoint: Identifiable, Equatable {
    let id: Int
    let label: String
    let amount: Double
}

struct DashboardRevenueChartCard: View {
    let points: [WeeklyRevenuePoint]
    let thisWeek: Double
    let weekOverWeekPct: Double?
    let thisMonth: Double
    let monthOverMonthPct: Double?
    let avgPerWeek: Double
    var showsConnectPrompt: Bool = false

    private var currencyFormat: FloatingPointFormatStyle<Double>.Currency {
        .currency(code: "USD").precision(.fractionLength(compactCurrency ? 0 : 2))
    }

    private var compactCurrency: Bool {
        max(thisWeek, thisMonth, points.map(\.amount).max() ?? 0) >= 1000
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Revenue over time")
                    .font(.headline)
                    .foregroundStyle(AppDesign.textPrimary)
                Text("Weekly · last 8 weeks")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(thisWeek, format: currencyFormat)
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                        .foregroundStyle(AppDesign.textPrimary)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    Text("this week")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 12)
                if let pct = weekOverWeekPct {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(formattedPercent(pct))
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(pct >= 0 ? AppDesign.accentGreen : AppDesign.accentRed)
                        Text("vs last week")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }

            if points.isEmpty {
                Text("No revenue data yet")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
            } else {
                Chart(points) { point in
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

            HStack(spacing: 12) {
                miniStatCard(
                    title: "This month",
                    value: thisMonth,
                    trend: monthOverMonthPct
                )
                miniStatCard(
                    title: "Avg per week",
                    value: avgPerWeek,
                    subtitle: "8 wk avg"
                )
            }

            if showsConnectPrompt {
                Text("Connect Stripe in Payments to track revenue automatically.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
        }
        .padding(16)
        .appCard()
    }

    private func miniStatCard(title: String, value: Double, trend: Double? = nil, subtitle: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(AppDesign.textSecondary)
            Text(value, format: currencyFormat)
                .font(.title3.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
            if let trend {
                Text(formattedPercent(trend))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(trend >= 0 ? AppDesign.accentGreen : AppDesign.accentRed)
            } else if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func formattedPercent(_ value: Double) -> String {
        let sign = value >= 0 ? "+" : ""
        return "\(sign)\(Int(value.rounded()))%"
    }
}
