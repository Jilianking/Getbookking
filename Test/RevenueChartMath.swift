//
//  RevenueChartMath.swift
//
//  Shared revenue bucketing for dashboard and insights charts.
//

import Foundation

struct WeeklyRevenuePoint: Identifiable, Equatable {
    let id: Int
    let label: String
    let amount: Double
}

struct DailyRevenuePoint: Identifiable, Equatable {
    let id: Int
    let date: Date
    let amount: Double
}

enum RevenueChartMath {
    static func filterEntries(
        _ entries: [(date: Date, amount: Double)],
        start: Date?,
        end: Date
    ) -> [(date: Date, amount: Double)] {
        entries.filter { entry in
            if let start { return entry.date >= start && entry.date <= end }
            return entry.date <= end
        }
    }

    /// Rolling or in-period weekly buckets (max `maxWeeks` points).
    static func bucketWeekly(
        _ entries: [(date: Date, amount: Double)],
        maxWeeks: Int = 8,
        now: Date = Date(),
        periodStart: Date? = nil
    ) -> [WeeklyRevenuePoint] {
        let cal = Calendar.current
        let endWeekStart = cal.date(
            from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
        ) ?? now

        let weekCount: Int
        let firstWeekStart: Date

        if let periodStart {
            let rangeStartWeek = cal.date(
                from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: periodStart)
            ) ?? periodStart
            let rawWeeks = (cal.dateComponents([.weekOfYear], from: rangeStartWeek, to: endWeekStart).weekOfYear ?? 0) + 1
            weekCount = min(maxWeeks, max(1, rawWeeks))
            firstWeekStart = cal.date(byAdding: .weekOfYear, value: -(weekCount - 1), to: endWeekStart) ?? rangeStartWeek
        } else {
            weekCount = maxWeeks
            firstWeekStart = cal.date(byAdding: .weekOfYear, value: -(maxWeeks - 1), to: endWeekStart) ?? now
        }

        return (0..<weekCount).map { index in
            let weekStart = cal.date(byAdding: .weekOfYear, value: index, to: firstWeekStart) ?? firstWeekStart
            let weekEnd = cal.date(byAdding: .weekOfYear, value: 1, to: weekStart) ?? weekStart
            let total = entries
                .filter { $0.date >= weekStart && $0.date < weekEnd }
                .reduce(0) { $0 + $1.amount }
            return WeeklyRevenuePoint(id: index + 1, label: "Wk \(index + 1)", amount: total)
        }
    }

    /// Daily buckets for the selected insights range (`all` caps at 30 days).
    static func bucketDaily(
        _ entries: [(date: Date, amount: Double)],
        range: InsightsTimeRange,
        now: Date = Date(),
        periodStart: Date? = nil
    ) -> [DailyRevenuePoint] {
        let cal = Calendar.current
        let endDay = cal.startOfDay(for: now)

        let startDay: Date
        if let periodStart {
            startDay = cal.startOfDay(for: periodStart)
        } else {
            startDay = cal.date(byAdding: .day, value: -29, to: endDay) ?? endDay
        }

        let dayCount = max(1, (cal.dateComponents([.day], from: startDay, to: endDay).day ?? 0) + 1)

        return (0..<dayCount).map { offset in
            let dayStart = cal.date(byAdding: .day, value: offset, to: startDay) ?? startDay
            let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
            let total = entries
                .filter { $0.date >= dayStart && $0.date < dayEnd }
                .reduce(0) { $0 + $1.amount }
            return DailyRevenuePoint(id: offset + 1, date: dayStart, amount: total)
        }
    }

    /// X-axis label stride for daily charts (avoids overlapping labels on narrow screens).
    static func dailyAxisStrideDays(dayCount: Int) -> Int {
        switch dayCount {
        case ...7: return 1
        case ...31: return 5
        case ...60: return 7
        default: return 14
        }
    }

    static func sumEntries(
        _ entries: [(date: Date, amount: Double)],
        start: Date,
        end: Date
    ) -> Double {
        entries
            .filter { $0.date >= start && $0.date < end }
            .reduce(0) { $0 + $1.amount }
    }

    static func percentChange(current: Double, prior: Double) -> Double? {
        guard prior > 0 else { return current > 0 ? nil : 0 }
        return ((current - prior) / prior) * 100
    }

    static func makeWeeklySnapshot(
        from entries: [(date: Date, amount: Double)],
        weeks: Int = 8,
        now: Date = Date()
    ) -> (weekly: [WeeklyRevenuePoint], thisWeek: Double, weekOverWeekPct: Double?, avgPerWeek: Double) {
        let weekly = bucketWeekly(entries, maxWeeks: weeks, now: now, periodStart: nil)
        let thisWeek = weekly.last?.amount ?? 0
        let lastWeek = weekly.count >= 2 ? weekly[weekly.count - 2].amount : 0
        let weekOverWeekPct = percentChange(current: thisWeek, prior: lastWeek)
        let avgPerWeek = weekly.isEmpty
            ? 0
            : weekly.reduce(0) { $0 + $1.amount } / Double(weekly.count)
        return (weekly, thisWeek, weekOverWeekPct, avgPerWeek)
    }

}
