import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

class DashboardViewModel: ObservableObject {
    @Published var pendingRequestsCount = 0
    @Published var unreadRequestsCount = 0
    @Published var upcomingBookingsCount = 0
    @Published var confirmedThisMonthCount = 0
    @Published var totalClientsCount = 0
    @Published var monthlyRevenue: Double = 0
    @Published var businessDisplayName: String = ""
    @Published var tenantIndustry: String = BookingTemplate.custom.rawValue
    @Published var recentRequests: [Request] = []
    @Published var recentBookingRequests: [BookingRequest] = []
    @Published var useTenantData = false
    @Published var isLoading = false

    @Published var weeklyRevenue: [WeeklyRevenuePoint] = []
    @Published var revenueThisWeek: Double = 0
    @Published var revenueWeekOverWeekPct: Double?
    @Published var revenueThisMonth: Double = 0
    @Published var revenueMonthOverMonthPct: Double?
    @Published var revenueAvgPerWeek: Double = 0
    
    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    
    func loadData(sessionStore: TenantSessionStore, isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run { isLoading = true }
            if sessionStore.isDemoSession {
                let bookingReqs = sessionStore.bookingRequests
                let upcoming = bookingReqs.filter { $0.status.lowercased() == "confirmed" }
                let monthStart = Calendar.current.date(
                    from: Calendar.current.dateComponents([.year, .month], from: Date())
                ) ?? Date()
                let confirmedMonth = bookingReqs.filter { req in
                    guard req.status.lowercased() == "confirmed" else { return false }
                    guard let created = req.createdAt else { return false }
                    return created >= monthStart
                }
                let revenueSnapshot = Self.makeRevenueSnapshotFromDemoPayments(sessionStore.demoPayments)
                await MainActor.run {
                    useTenantData = true
                    pendingRequestsCount = sessionStore.pendingRequestsCount
                    unreadRequestsCount = sessionStore.unreadRequestsCount
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = confirmedMonth.count
                    totalClientsCount = sessionStore.customers.count
                    monthlyRevenue = revenueSnapshot.thisMonth
                    businessDisplayName = sessionStore.businessDisplayName
                    tenantIndustry = sessionStore.tenantIndustry
                    recentBookingRequests = Array(bookingReqs.prefix(10))
                    recentRequests = []
                    if Self.shouldUseDemoRevenueFallback(revenueSnapshot, payments: sessionStore.demoPayments) {
                        applyDemoRevenueChart()
                    } else {
                        applyRevenueSnapshot(revenueSnapshot)
                    }
                    isLoading = false
                }
                return
            }
            await MainActor.run {
                pendingRequestsCount = 0
                unreadRequestsCount = 0
                upcomingBookingsCount = 0
                confirmedThisMonthCount = 0
                totalClientsCount = 0
                monthlyRevenue = 0
                businessDisplayName = ""
                tenantIndustry = BookingTemplate.custom.rawValue
                recentRequests = []
                recentBookingRequests = []
                useTenantData = false
                applyDemoRevenueChart()
                isLoading = false
            }
            return
        }
        
        do {
            guard Auth.auth().currentUser?.uid != nil else {
                await MainActor.run { isLoading = false }
                return
            }
            await sessionStore.ensureSessionLoaded(isDemoMode: false)
            async let dashboardBookings: () = sessionStore.loadDashboardBookingsIfNeeded(isDemoMode: false)
            async let newBookings: () = sessionStore.loadNewBookingsIfNeeded(isDemoMode: false)
            async let customerTotal = sessionStore.customerCount(isDemoMode: false)
            _ = await (dashboardBookings, newBookings)
            let clientsCount = await customerTotal
            
            if sessionStore.tenantId != nil {
                let bookingReqs = sessionStore.bookingRequests
                let upcoming = bookingReqs.filter { $0.status.lowercased() == "confirmed" }
                let monthStart = Calendar.current.date(
                    from: Calendar.current.dateComponents([.year, .month], from: Date())
                ) ?? Date()
                let confirmedMonth = bookingReqs.filter { req in
                    guard req.status.lowercased() == "confirmed" else { return false }
                    guard let created = req.createdAt else { return false }
                    return created >= monthStart
                }
                let revenueEntries = await loadStripeRevenueEntries()
                let revenueSnapshot = Self.makeRevenueSnapshot(from: revenueEntries)

                await MainActor.run {
                    useTenantData = true
                    pendingRequestsCount = sessionStore.pendingRequestsCount
                    unreadRequestsCount = sessionStore.unreadRequestsCount
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = confirmedMonth.count
                    totalClientsCount = clientsCount
                    monthlyRevenue = revenueSnapshot.thisMonth
                    businessDisplayName = sessionStore.businessDisplayName
                    tenantIndustry = sessionStore.tenantIndustry
                    recentBookingRequests = Array(bookingReqs.prefix(10))
                    recentRequests = []
                    if sessionStore.tenant?["isDemoAccount"] as? Bool == true,
                       Self.shouldUseDemoRevenueFallback(revenueSnapshot, payments: nil) {
                        applyDemoRevenueChart()
                    } else {
                        applyRevenueSnapshot(revenueSnapshot)
                    }
                    isLoading = false
                }
            } else {
                let requests = try await firebaseService.fetchRequests()
                let clients = try await firebaseService.fetchClients()
                let pending = requests.filter { $0.status == .pending }
                let upcoming = requests.filter {
                    if let date = $0.appointmentDate {
                        return date >= Date() && $0.status == .confirmed
                    }
                    return false
                }
                let calendar = Calendar.current
                let now = Date()
                let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
                let monthlyRequests = requests.filter {
                    if let date = $0.completedAt {
                        return date >= startOfMonth && $0.status == .completed
                    }
                    return false
                }
                let revenue = monthlyRequests.reduce(0.0) { total, request in
                    total + (request.price ?? 0) + (request.cashTips ?? 0)
                }
                let revenueEntries = legacyRevenueEntries(from: requests)
                let revenueSnapshot = Self.makeRevenueSnapshot(from: revenueEntries)
                await MainActor.run {
                    useTenantData = false
                    pendingRequestsCount = pending.count
                    unreadRequestsCount = pending.filter { $0.reviewedAt == nil }.count
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = upcoming.count
                    totalClientsCount = clients.count
                    monthlyRevenue = revenue
                    businessDisplayName = sessionStore.businessDisplayName
                    tenantIndustry = sessionStore.tenantIndustry
                    recentRequests = Array(requests.prefix(10))
                    recentBookingRequests = []
                    applyRevenueSnapshot(revenueSnapshot)
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading dashboard data: \(error)")
        }
    }
    
    func refresh(sessionStore: TenantSessionStore, isDemoMode: Bool = false) async {
        sessionStore.invalidateBookings()
        await loadData(sessionStore: sessionStore, isDemoMode: isDemoMode)
    }

    // MARK: - Revenue chart

    private struct RevenueSnapshot {
        var weekly: [WeeklyRevenuePoint]
        var thisWeek: Double
        var weekOverWeekPct: Double?
        var thisMonth: Double
        var monthOverMonthPct: Double?
        var avgPerWeek: Double
    }

    @MainActor
    private func applyRevenueSnapshot(_ snapshot: RevenueSnapshot) {
        weeklyRevenue = snapshot.weekly
        revenueThisWeek = snapshot.thisWeek
        revenueWeekOverWeekPct = snapshot.weekOverWeekPct
        revenueThisMonth = snapshot.thisMonth
        revenueMonthOverMonthPct = snapshot.monthOverMonthPct
        revenueAvgPerWeek = snapshot.avgPerWeek
    }

    @MainActor
    private func applyDemoRevenueChart() {
        let demoAmounts = [820.0, 940, 880, 1020, 960, 1100, 1050, 1280]
        let thisWeek = demoAmounts.last ?? 0
        let lastWeek = demoAmounts.count >= 2 ? demoAmounts[demoAmounts.count - 2] : 0
        let weekOverWeekPct = Self.percentChange(current: thisWeek, prior: lastWeek)
        let points = demoAmounts.enumerated().map { index, amount in
            WeeklyRevenuePoint(id: index + 1, label: "Wk \(index + 1)", amount: amount)
        }
        applyRevenueSnapshot(
            RevenueSnapshot(
                weekly: points,
                thisWeek: thisWeek,
                weekOverWeekPct: weekOverWeekPct,
                thisMonth: demoAmounts.reduce(0, +),
                monthOverMonthPct: 12,
                avgPerWeek: demoAmounts.reduce(0, +) / Double(demoAmounts.count)
            )
        )
    }

    /// Use baked-in positive chart when seeded payments bucket poorly (stale session or week boundary drift).
    private static func shouldUseDemoRevenueFallback(
        _ snapshot: RevenueSnapshot,
        payments: DemoPaymentsSnapshot?
    ) -> Bool {
        if let payments, !payments.transactions.isEmpty, snapshot.weekly.isEmpty {
            return true
        }
        if snapshot.thisWeek <= 0 {
            let priorWeek = snapshot.weekly.count >= 2
                ? snapshot.weekly[snapshot.weekly.count - 2].amount
                : 0
            if priorWeek > 0 { return true }
        }
        if let pct = snapshot.weekOverWeekPct, pct < 0 { return true }
        return false
    }

    private static func chargeAmountCents(from item: [String: Any]) -> Int {
        (item["netCents"] as? NSNumber)?.intValue
            ?? (item["net"] as? NSNumber)?.intValue
            ?? (item["amountCents"] as? NSNumber)?.intValue
            ?? (item["amount"] as? NSNumber)?.intValue
            ?? 0
    }

    private static func chargeCreatedDate(from item: [String: Any]) -> Date? {
        let created = (item["created"] as? NSNumber)?.intValue ?? 0
        if created > 0 {
            return Date(timeIntervalSince1970: TimeInterval(created))
        }
        return DemoSnapshotParser.parseDate(item["createdAt"])
    }

    private static func makeRevenueSnapshotFromDemoPayments(_ payments: DemoPaymentsSnapshot?) -> RevenueSnapshot {
        guard let payments else {
            return RevenueSnapshot(
                weekly: [],
                thisWeek: 0,
                weekOverWeekPct: nil,
                thisMonth: 0,
                monthOverMonthPct: nil,
                avgPerWeek: 0
            )
        }
        let entries: [(date: Date, amount: Double)] = payments.transactions.compactMap { item in
            let typeStr = (item["type"] as? String ?? "").lowercased()
            guard typeStr == "charge" else { return nil }
            guard let date = chargeCreatedDate(from: item) else { return nil }
            let amountCents = chargeAmountCents(from: item)
            guard amountCents > 0 else { return nil }
            return (date, Double(amountCents) / 100)
        }
        return makeRevenueSnapshot(from: entries)
    }

    private func loadStripeRevenueEntries() async -> [(date: Date, amount: Double)] {
        do {
            let start = Calendar.current.date(byAdding: .day, value: -70, to: Date()) ?? Date()
            let payload: [String: Any] = [
                "startTimestampSeconds": Int(start.timeIntervalSince1970),
                "limit": 100,
            ]
            let tx = try await functions.httpsCallable("getConnectBalanceTransactions").call(payload)
            let txData = tx.data as? [String: Any]
            let list = txData?["transactions"] as? [[String: Any]] ?? []
            var charges: [(Date, Double)] = []
            for item in list {
                let typeStr = (item["type"] as? String ?? "").lowercased()
                guard typeStr == "charge" else { continue }
                let created = (item["created"] as? NSNumber)?.intValue ?? 0
                guard created > 0 else { continue }
                let date = Date(timeIntervalSince1970: TimeInterval(created))
                let amountCents = (item["net"] as? NSNumber)?.intValue
                    ?? (item["amount"] as? NSNumber)?.intValue
                    ?? 0
                charges.append((date, Double(abs(amountCents)) / 100))
            }
            return charges
        } catch {
            return []
        }
    }

    private func legacyRevenueEntries(from requests: [Request]) -> [(date: Date, amount: Double)] {
        requests.compactMap { request in
            guard request.status == .completed else { return nil }
            let date = request.completedAt ?? request.submittedAt
            let amount = (request.price ?? 0) + (request.cashTips ?? 0)
            guard amount > 0 else { return nil }
            return (date, amount)
        }
    }

    private static func makeRevenueSnapshot(from entries: [(date: Date, amount: Double)], now: Date = Date()) -> RevenueSnapshot {
        let weekly = bucketWeeklyRevenue(entries, weeks: 8, now: now)
        let thisWeek = weekly.last?.amount ?? 0
        let lastWeek = weekly.count >= 2 ? weekly[weekly.count - 2].amount : 0
        let weekOverWeekPct = percentChange(current: thisWeek, prior: lastWeek)

        let cal = Calendar.current
        let monthStart = cal.date(from: cal.dateComponents([.year, .month], from: now)) ?? now
        let priorMonthStart = cal.date(byAdding: .month, value: -1, to: monthStart) ?? monthStart
        let thisMonth = sumEntries(entries, start: monthStart, end: now)
        let lastMonth = sumEntries(entries, start: priorMonthStart, end: monthStart)
        let monthOverMonthPct = percentChange(current: thisMonth, prior: lastMonth)

        let avgPerWeek = weekly.isEmpty
            ? 0
            : weekly.reduce(0) { $0 + $1.amount } / Double(weekly.count)

        return RevenueSnapshot(
            weekly: weekly,
            thisWeek: thisWeek,
            weekOverWeekPct: weekOverWeekPct,
            thisMonth: thisMonth,
            monthOverMonthPct: monthOverMonthPct,
            avgPerWeek: avgPerWeek
        )
    }

    private static func bucketWeeklyRevenue(
        _ entries: [(date: Date, amount: Double)],
        weeks: Int,
        now: Date
    ) -> [WeeklyRevenuePoint] {
        let cal = Calendar.current
        return (0..<weeks).map { index in
            let weeksAgo = weeks - 1 - index
            let anchor = cal.date(byAdding: .weekOfYear, value: -weeksAgo, to: now) ?? now
            let weekStart = cal.date(from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: anchor)) ?? anchor
            let weekEnd = cal.date(byAdding: .weekOfYear, value: 1, to: weekStart) ?? weekStart
            let total = entries
                .filter { $0.date >= weekStart && $0.date < weekEnd }
                .reduce(0) { $0 + $1.amount }
            return WeeklyRevenuePoint(id: index + 1, label: "Wk \(index + 1)", amount: total)
        }
    }

    private static func sumEntries(_ entries: [(date: Date, amount: Double)], start: Date, end: Date) -> Double {
        entries
            .filter { $0.date >= start && $0.date < end }
            .reduce(0) { $0 + $1.amount }
    }

    private static func percentChange(current: Double, prior: Double) -> Double? {
        guard prior > 0 else { return current > 0 ? nil : 0 }
        return ((current - prior) / prior) * 100
    }
}
