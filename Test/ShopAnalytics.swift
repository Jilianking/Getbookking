//
//  ShopAnalytics.swift
//
//  Shop analytics computed from tenant shop orders.
//

import Foundation

enum ShopAnalyticsRange: String, CaseIterable, Identifiable {
    case days7
    case days30
    case days90
    case allTime

    var id: String { rawValue }

    var chipLabel: String {
        switch self {
        case .days7: return "7 days"
        case .days30: return "30 days"
        case .days90: return "90 days"
        case .allTime: return "All time"
        }
    }

    func startDate(relativeTo now: Date = Date()) -> Date? {
        let calendar = Calendar.current
        switch self {
        case .days7:
            return calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))
        case .days30:
            return calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: now))
        case .days90:
            return calendar.date(byAdding: .day, value: -89, to: calendar.startOfDay(for: now))
        case .allTime:
            return nil
        }
    }

    var chartDayCount: Int {
        switch self {
        case .days7: return 7
        case .days30: return 14
        case .days90: return 12
        case .allTime: return 12
        }
    }
}

struct ShopTopProductRow: Identifiable, Equatable {
    var id: String { productId }
    var productId: String
    var name: String
    var quantitySold: Int
    var revenueCents: Int

    var formattedRevenue: String {
        String(format: "$%.2f", Double(revenueCents) / 100.0)
    }
}

struct ShopDailyRevenueRow: Identifiable, Equatable {
    var id: String { dayKey }
    var day: Date
    var dayKey: String
    var label: String
    var revenueCents: Int
    var orderCount: Int

    var formattedRevenue: String {
        String(format: "$%.0f", Double(revenueCents) / 100.0)
    }
}

struct ShopAnalyticsSnapshot {
    var range: ShopAnalyticsRange
    var totalRevenueCents: Int
    var orderCount: Int
    var fulfilledCount: Int
    var pendingCount: Int
    var cancelledCount: Int
    var averageOrderCents: Int
    var fulfillmentRate: Double
    var dailyRevenue: [ShopDailyRevenueRow]
    var topProducts: [ShopTopProductRow]

    var formattedTotalRevenue: String {
        String(format: "$%.2f", Double(totalRevenueCents) / 100.0)
    }

    var formattedAverageOrder: String {
        String(format: "$%.2f", Double(averageOrderCents) / 100.0)
    }

    var formattedFulfillmentRate: String {
        guard orderCount > 0 else { return "—" }
        return String(format: "%.0f%%", fulfillmentRate * 100)
    }

    static func build(orders: [ShopOrder], range: ShopAnalyticsRange, now: Date = Date()) -> ShopAnalyticsSnapshot {
        let calendar = Calendar.current
        let start = range.startDate(relativeTo: now)
        let filtered = orders.filter { order in
            guard let created = order.createdAt else { return range == .allTime }
            if let start { return created >= start }
            return true
        }

        let active = filtered.filter { $0.statusLower != ShopOrderStatus.cancelled }
        let totalRevenueCents = active.reduce(0) { $0 + $1.subtotalCents }
        let fulfilledCount = filtered.filter { $0.statusLower == ShopOrderStatus.fulfilled }.count
        let pendingCount = filtered.filter { $0.statusLower == ShopOrderStatus.pending }.count
        let cancelledCount = filtered.filter { $0.statusLower == ShopOrderStatus.cancelled }.count
        let countableForRate = fulfilledCount + pendingCount
        let fulfillmentRate = countableForRate > 0 ? Double(fulfilledCount) / Double(countableForRate) : 0
        let averageOrderCents = active.isEmpty ? 0 : totalRevenueCents / active.count

        let dailyRevenue = dailyBuckets(
            orders: active,
            range: range,
            calendar: calendar,
            now: now
        )

        var productMap: [String: ShopTopProductRow] = [:]
        for order in active {
            for item in order.lineItems {
                var row = productMap[item.productId] ?? ShopTopProductRow(
                    productId: item.productId,
                    name: item.name,
                    quantitySold: 0,
                    revenueCents: 0
                )
                row.quantitySold += max(1, item.qty)
                row.revenueCents += item.lineTotalCents
                if row.name.isEmpty { row.name = item.name }
                productMap[item.productId] = row
            }
        }
        let topProducts = productMap.values
            .sorted { $0.revenueCents > $1.revenueCents }
            .prefix(5)
            .map { $0 }

        return ShopAnalyticsSnapshot(
            range: range,
            totalRevenueCents: totalRevenueCents,
            orderCount: filtered.count,
            fulfilledCount: fulfilledCount,
            pendingCount: pendingCount,
            cancelledCount: cancelledCount,
            averageOrderCents: averageOrderCents,
            fulfillmentRate: fulfillmentRate,
            dailyRevenue: dailyRevenue,
            topProducts: topProducts
        )
    }

    func exportCSV(orders: [ShopOrder]) -> String {
        let start = range.startDate()
        let filtered = orders.filter { order in
            guard let created = order.createdAt else { return range == .allTime }
            if let start { return created >= start }
            return true
        }
        var lines = ["Date,Customer,Status,Total,Items"]
        let formatter = ISO8601DateFormatter()
        for order in filtered.sorted(by: { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }) {
            let date = order.createdAt.map { formatter.string(from: $0) } ?? ""
            let customer = order.displayCustomerName.replacingOccurrences(of: ",", with: " ")
            let items = order.lineItems.map { "\($0.name) x\($0.qty)" }.joined(separator: "; ")
            lines.append("\(date),\(customer),\(order.status),\(order.formattedSubtotal),\"\(items)\"")
        }
        return lines.joined(separator: "\n")
    }

    private static func dailyBuckets(
        orders: [ShopOrder],
        range: ShopAnalyticsRange,
        calendar: Calendar,
        now: Date
    ) -> [ShopDailyRevenueRow] {
        let bucketCount = range.chartDayCount
        let endDay = calendar.startOfDay(for: now)
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "MMM d"

        if range == .allTime {
            let dated = orders.compactMap { order -> (Date, ShopOrder)? in
                guard let created = order.createdAt else { return nil }
                return (calendar.startOfDay(for: created), order)
            }
            guard !dated.isEmpty else { return [] }
            let minDay = dated.map(\.0).min() ?? endDay
            let totalDays = max(1, calendar.dateComponents([.day], from: minDay, to: endDay).day ?? 0) + 1
            let step = max(1, Int(ceil(Double(totalDays) / Double(bucketCount))))
            var buckets: [ShopDailyRevenueRow] = []
            var cursor = minDay
            while cursor <= endDay {
                let next = calendar.date(byAdding: .day, value: step, to: cursor) ?? endDay
                let windowEnd = min(next, calendar.date(byAdding: .day, value: 1, to: endDay) ?? endDay)
                let inWindow = dated.filter { $0.0 >= cursor && $0.0 < windowEnd }
                let cents = inWindow.reduce(0) { $0 + $1.1.subtotalCents }
                let key = formatterDayKey(cursor, calendar: calendar)
                buckets.append(ShopDailyRevenueRow(
                    day: cursor,
                    dayKey: key,
                    label: dayFormatter.string(from: cursor),
                    revenueCents: cents,
                    orderCount: inWindow.count
                ))
                guard let advanced = calendar.date(byAdding: .day, value: step, to: cursor) else { break }
                cursor = advanced
                if buckets.count >= bucketCount { break }
            }
            return buckets
        }

        var rows: [ShopDailyRevenueRow] = []
        for offset in stride(from: bucketCount - 1, through: 0, by: -1) {
            guard let day = calendar.date(byAdding: .day, value: -offset, to: endDay) else { continue }
            let next = calendar.date(byAdding: .day, value: 1, to: day) ?? day
            let dayOrders = orders.filter { order in
                guard let created = order.createdAt else { return false }
                return created >= day && created < next
            }
            let cents = dayOrders.reduce(0) { $0 + $1.subtotalCents }
            let key = formatterDayKey(day, calendar: calendar)
            rows.append(ShopDailyRevenueRow(
                day: day,
                dayKey: key,
                label: dayFormatter.string(from: day),
                revenueCents: cents,
                orderCount: dayOrders.count
            ))
        }
        return rows
    }

    private static func formatterDayKey(_ day: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
