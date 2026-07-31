//
//  InsightsViewModel.swift
//
//  Dashboard metrics with configurable time range and period-over-period trends.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

enum InsightsTimeRange: String, Hashable, CaseIterable, Identifiable {
    case thisWeek
    case thisMonth
    case thisYear
    case custom

    var id: String { rawValue }

    var menuLabel: String {
        switch self {
        case .thisWeek: return "This week"
        case .thisMonth: return "This month"
        case .thisYear: return "This year"
        case .custom: return "Custom range"
        }
    }

    /// Short label for chart subtitles and card trails.
    var periodLabel: String {
        switch self {
        case .thisWeek: return "this week"
        case .thisMonth: return "this month"
        case .thisYear: return "this year"
        case .custom: return "custom range"
        }
    }

    /// Inclusive period `[start, end]` for metrics and charts.
    func resolvedBounds(
        customStart: Date,
        customEnd: Date,
        relativeTo now: Date = Date()
    ) -> (start: Date, end: Date) {
        let cal = Calendar.current
        let endOfToday = cal.date(bySettingHour: 23, minute: 59, second: 59, of: now) ?? now
        switch self {
        case .thisWeek:
            let start = cal.date(from: cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)) ?? now
            return (start, endOfToday)
        case .thisMonth:
            let start = cal.date(from: cal.dateComponents([.year, .month], from: now)) ?? now
            return (start, endOfToday)
        case .thisYear:
            let start = cal.date(from: cal.dateComponents([.year], from: now)) ?? now
            return (start, endOfToday)
        case .custom:
            let start = cal.startOfDay(for: min(customStart, customEnd))
            let endDay = cal.startOfDay(for: max(customStart, customEnd))
            let end = cal.date(bySettingHour: 23, minute: 59, second: 59, of: endDay) ?? endDay
            return (start, end)
        }
    }

    /// Prior period of equal duration ending at current start (for trends).
    func priorPeriodBounds(
        customStart: Date,
        customEnd: Date,
        relativeTo now: Date = Date()
    ) -> (start: Date, end: Date) {
        let cal = Calendar.current
        let current = resolvedBounds(customStart: customStart, customEnd: customEnd, relativeTo: now)
        let duration = current.end.timeIntervalSince(current.start)
        let priorEnd = current.start
        let priorStart = priorEnd.addingTimeInterval(-max(duration, 24 * 60 * 60))
        return (cal.startOfDay(for: priorStart), priorEnd)
    }

    func suggestedWeeklyMaxWeeks(
        customStart: Date,
        customEnd: Date,
        relativeTo now: Date = Date()
    ) -> Int {
        let bounds = resolvedBounds(customStart: customStart, customEnd: customEnd, relativeTo: now)
        let cal = Calendar.current
        let weeks = (cal.dateComponents([.weekOfYear], from: bounds.start, to: bounds.end).weekOfYear ?? 0) + 1
        return min(16, max(1, weeks))
    }
}

struct InsightsBookingBreakdown {
    var newCount = 0
    var confirmed = 0
    var cancelledOrDeclined = 0
    var other = 0

    var total: Int { newCount + confirmed + cancelledOrDeclined + other }

    func percent(_ value: Int, total: Int) -> Int {
        guard total > 0 else { return 0 }
        return Int((Double(value) / Double(total) * 100).rounded())
    }
}

final class InsightsViewModel: ObservableObject {
    @Published var selectedRange: InsightsTimeRange = .thisMonth
    @Published var customRangeStart: Date = Calendar.current.date(byAdding: .day, value: -29, to: Date()) ?? Date()
    @Published var customRangeEnd: Date = Date()
    @Published var useTenantData = false
    @Published var tenantId: String?
    @Published var isLoading = false
    @Published var loadError: String?

    // KPI tiles
    @Published var bookingsInRange = 0
    @Published var bookingsTrendText = ""
    @Published var revenueInRange: Double = 0
    @Published var revenueTrendText = ""
    @Published var clientsTotal = 0
    @Published var clientsNewInRange = 0
    @Published var clientsTrendText = ""
    @Published var noShowsInRange = 0
    @Published var noShowsTrendText = ""

    @Published var bookingBreakdown = InsightsBookingBreakdown()
    @Published var topServiceLabels: [(label: String, count: Int)] = []

    // Clients & payments rows
    @Published var stripeConnected = false
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    @Published var paymentChargesInRange = 0
    @Published var paymentVolumeInRange: Double = 0

    // Revenue chart (real Stripe / legacy booking revenue only)
    @Published var revenueWeeklyPoints: [WeeklyRevenuePoint] = []
    @Published var revenueDailyPoints: [DailyRevenuePoint] = []
    @Published var revenueMonthlyPoints: [MonthlyRevenuePoint] = []

    private var cachedTenantBookings: [BookingRequest] = []
    private var cachedLegacyRequests: [Request] = []
    private var cachedCustomerDates: [Date] = []
    private var cachedStripeCharges: [(date: Date, amount: Double)] = []
    private var cachedLegacyRevenueEntries: [(date: Date, amount: Double)] = []

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    /// Label for chart/card trails (uses formatted dates when custom).
    var displayPeriodLabel: String {
        guard selectedRange == .custom else { return selectedRange.periodLabel }
        let start = customRangeStart.formatted(.dateTime.month(.abbreviated).day().year())
        let end = customRangeEnd.formatted(.dateTime.month(.abbreviated).day().year())
        return "\(start) – \(end)"
    }

    private var currentPeriodBounds: (start: Date, end: Date) {
        selectedRange.resolvedBounds(
            customStart: customRangeStart,
            customEnd: customRangeEnd
        )
    }

    func loadData(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        await MainActor.run {
            isLoading = true
            loadError = nil
        }

        if isDemoMode {
            if let sessionStore, sessionStore.isDemoSession, let tid = sessionStore.tenantId {
                let reqs = sessionStore.bookingRequests
                let custs = sessionStore.customers
                let payments = sessionStore.demoPayments
                let charges: [(Date, Double)] = (payments?.transactions ?? []).compactMap { item in
                    let typeStr = (item["type"] as? String ?? "").lowercased()
                    guard typeStr == "charge" else { return nil }
                    let created = (item["created"] as? NSNumber)?.intValue ?? 0
                    guard created > 0 else { return nil }
                    let amountCents = (item["net"] as? NSNumber)?.intValue
                        ?? (item["amountCents"] as? NSNumber)?.intValue
                        ?? 0
                    return (Date(timeIntervalSince1970: TimeInterval(created)), Double(abs(amountCents)) / 100)
                }
                await MainActor.run {
                    useTenantData = true
                    tenantId = tid
                    cachedTenantBookings = reqs
                    cachedLegacyRequests = []
                    cachedCustomerDates = custs.map(\.createdAt)
                    cachedStripeCharges = charges
                    cachedLegacyRevenueEntries = []
                    stripeConnected = true
                    availableBalance = Double(payments?.availableBalanceCents ?? 0) / 100
                    pendingBalance = Double(payments?.pendingBalanceCents ?? 0) / 100
                    isLoading = false
                    recomputeForSelectedRange()
                }
                return
            }
            await MainActor.run {
                applyDemoSnapshot()
                isLoading = false
            }
            return
        }

        guard let uid = Auth.auth().currentUser?.uid else {
            await MainActor.run { isLoading = false }
            return
        }

        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)

            if let tid = profile?.tenantId {
                async let bookingReqs = firebaseService.fetchTenantBookingRequests(tenantId: tid)
                async let customers = firebaseService.fetchTenantCustomers(tenantId: tid)
                let reqs = try await bookingReqs
                let custs = try await customers

                let stripeAccountId = try await firebaseService.fetchTenantStripeAccountId(tenantId: tid)
                let connected = stripeAccountId != nil && !(stripeAccountId ?? "").isEmpty

                var charges: [(Date, Double)] = []
                var avail: Double = 0
                var pend: Double = 0
                if connected {
                    (avail, pend, charges) = await loadStripeCharges()
                }

                await MainActor.run {
                    useTenantData = true
                    tenantId = tid
                    cachedTenantBookings = reqs
                    cachedLegacyRequests = []
                    cachedCustomerDates = custs.map(\.createdAt)
                    cachedStripeCharges = charges
                    cachedLegacyRevenueEntries = []
                    stripeConnected = connected
                    availableBalance = avail
                    pendingBalance = pend
                    isLoading = false
                    recomputeForSelectedRange()
                }
            } else {
                async let requests = firebaseService.fetchRequests()
                async let clients = firebaseService.fetchClients()
                let reqs = try await requests
                let cls = try await clients

                let since90 = Self.startOfRollingDays(90)
                let end = Date()
                let events = try await firebaseService.fetchEvents(startDate: since90, endDate: end)
                _ = events

                let revenueEntries: [(Date, Double)] = reqs.compactMap { r in
                    guard r.status == .completed else { return nil }
                    let d = r.completedAt ?? r.submittedAt
                    let amt = (r.price ?? 0) + (r.cashTips ?? 0)
                    guard amt > 0 else { return nil }
                    return (d, amt)
                }

                await MainActor.run {
                    useTenantData = false
                    tenantId = nil
                    cachedTenantBookings = []
                    cachedLegacyRequests = reqs
                    cachedCustomerDates = cls.map(\.createdAt)
                    cachedStripeCharges = []
                    cachedLegacyRevenueEntries = revenueEntries
                    stripeConnected = false
                    availableBalance = 0
                    pendingBalance = 0
                    isLoading = false
                    recomputeForSelectedRange()
                }
            }
        } catch {
            await MainActor.run {
                loadError = error.localizedDescription
                isLoading = false
            }
        }
    }

    func refresh(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        await loadData(isDemoMode: isDemoMode, sessionStore: sessionStore)
    }

    func recomputeForSelectedRange() {
        let bounds = currentPeriodBounds
        let priorBounds = selectedRange.priorPeriodBounds(
            customStart: customRangeStart,
            customEnd: customRangeEnd
        )

        if useTenantData {
            applyTenantMetrics(periodStart: bounds.start, periodEnd: bounds.end, priorBounds: priorBounds)
        } else {
            applyLegacyMetrics(periodStart: bounds.start, periodEnd: bounds.end, priorBounds: priorBounds)
        }
    }

    // MARK: - Private

    private func applyDemoSnapshot() {
        useTenantData = true
        tenantId = "demo"
        stripeConnected = true
        availableBalance = 420
        pendingBalance = 85
        bookingsInRange = 12
        bookingsTrendText = "↗ +4 vs last period"
        revenueInRange = 840
        revenueTrendText = "↗ +12% vs last period"
        clientsTotal = 24
        clientsNewInRange = 3
        clientsTrendText = "↗ 3 new"
        noShowsInRange = 1
        noShowsTrendText = "↗ same as prior"
        bookingBreakdown = InsightsBookingBreakdown(newCount: 4, confirmed: 7, cancelledOrDeclined: 1, other: 0)
        topServiceLabels = [
            ("Haircut", 7),
            ("Color", 3),
            ("Beard trim", 2)
        ]
        paymentChargesInRange = 14
        paymentVolumeInRange = 1200
        revenueWeeklyPoints = []
        revenueDailyPoints = []
        revenueMonthlyPoints = []
    }

    private func applyTenantMetrics(
        periodStart: Date,
        periodEnd: Date,
        priorBounds: (start: Date, end: Date)
    ) {
        let inPeriod = cachedTenantBookings.filter { bookingInPeriod($0, start: periodStart, end: periodEnd) }
        let priorPeriod = cachedTenantBookings.filter {
            bookingInPeriod($0, start: priorBounds.start, end: priorBounds.end)
        }

        bookingsInRange = inPeriod.count
        bookingsTrendText = trendText(current: inPeriod.count, prior: priorPeriod.count)

        bookingBreakdown = breakdownTenant(inPeriod)

        topServiceLabels = Self.topServices(from: inPeriod, limit: 5)

        clientsTotal = cachedCustomerDates.count
        clientsNewInRange = countDatesInPeriod(cachedCustomerDates, start: periodStart, end: periodEnd)
        let priorNew = countDatesInPeriod(cachedCustomerDates, start: priorBounds.start, end: priorBounds.end)
        clientsTrendText = clientsNewInRange > 0
            ? "↗ \(clientsNewInRange) new"
            : trendText(current: clientsNewInRange, prior: priorNew, sameLabel: "same as prior")

        noShowsInRange = 0
        noShowsTrendText = "↗ same as prior"

        let chargesCurrent = filterCharges(start: periodStart, end: periodEnd)
        let chargesPrior = filterCharges(start: priorBounds.start, end: priorBounds.end)
        revenueInRange = chargesCurrent.reduce(0) { $0 + $1.amount }
        let priorRevenue = chargesPrior.reduce(0) { $0 + $1.amount }
        revenueTrendText = trendTextDouble(current: revenueInRange, prior: priorRevenue)

        paymentChargesInRange = chargesCurrent.count
        paymentVolumeInRange = revenueInRange

        applyRevenueChart(periodStart: periodStart, periodEnd: periodEnd)
    }

    private func applyLegacyMetrics(
        periodStart: Date,
        periodEnd: Date,
        priorBounds: (start: Date, end: Date)
    ) {
        let inPeriod = cachedLegacyRequests.filter { legacyInPeriod($0, start: periodStart, end: periodEnd) }
        let priorPeriod = cachedLegacyRequests.filter {
            legacyInPeriod($0, start: priorBounds.start, end: priorBounds.end)
        }

        bookingsInRange = inPeriod.count
        bookingsTrendText = trendText(current: inPeriod.count, prior: priorPeriod.count)
        bookingBreakdown = breakdownLegacy(inPeriod)
        topServiceLabels = Self.topLegacyServices(from: inPeriod, limit: 5)

        clientsTotal = cachedCustomerDates.count
        clientsNewInRange = countDatesInPeriod(cachedCustomerDates, start: periodStart, end: periodEnd)
        let priorNew = countDatesInPeriod(cachedCustomerDates, start: priorBounds.start, end: priorBounds.end)
        clientsTrendText = clientsNewInRange > 0
            ? "↗ \(clientsNewInRange) new"
            : trendText(current: clientsNewInRange, prior: priorNew, sameLabel: "same as prior")

        noShowsInRange = 0
        noShowsTrendText = "↗ same as prior"

        let revenueCurrent = filterLegacyRevenue(start: periodStart, end: periodEnd)
        let revenuePrior = filterLegacyRevenue(start: priorBounds.start, end: priorBounds.end)
        revenueInRange = revenueCurrent.reduce(0) { $0 + $1.amount }
        let priorRev = revenuePrior.reduce(0) { $0 + $1.amount }
        revenueTrendText = trendTextDouble(current: revenueInRange, prior: priorRev)

        paymentChargesInRange = 0
        paymentVolumeInRange = 0

        applyRevenueChart(periodStart: periodStart, periodEnd: periodEnd)
    }

    private func applyRevenueChart(periodStart: Date, periodEnd: Date) {
        let entries = revenueEntriesForChart()
        let filtered = RevenueChartMath.filterEntries(entries, start: periodStart, end: periodEnd)
        let maxWeeks = selectedRange.suggestedWeeklyMaxWeeks(
            customStart: customRangeStart,
            customEnd: customRangeEnd
        )
        revenueWeeklyPoints = RevenueChartMath.bucketWeekly(
            filtered,
            maxWeeks: maxWeeks,
            now: periodEnd,
            periodStart: periodStart
        )
        revenueDailyPoints = RevenueChartMath.bucketDaily(
            filtered,
            now: periodEnd,
            periodStart: periodStart
        )
        revenueMonthlyPoints = RevenueChartMath.bucketMonthly(
            filtered,
            now: periodEnd,
            periodStart: periodStart,
            maxMonths: selectedRange == .thisYear ? 12 : 24
        )
    }

    private func revenueEntriesForChart() -> [(date: Date, amount: Double)] {
        if useTenantData {
            return cachedStripeCharges.map { (date: $0.date, amount: $0.amount) }
        }
        return cachedLegacyRevenueEntries.map { (date: $0.date, amount: $0.amount) }
    }

    private func bookingInPeriod(_ r: BookingRequest, start: Date?, end: Date) -> Bool {
        guard let created = r.createdAt else { return start == nil }
        if let start { return created >= start && created <= end }
        return created <= end
    }

    private func legacyInPeriod(_ r: Request, start: Date?, end: Date) -> Bool {
        let d = r.submittedAt
        if let start { return d >= start && d <= end }
        return d <= end
    }

    private func countDatesInPeriod(_ dates: [Date], start: Date?, end: Date) -> Int {
        dates.filter { d in
            if let start { return d >= start && d <= end }
            return d <= end
        }.count
    }

    private func filterCharges(start: Date?, end: Date) -> [(date: Date, amount: Double)] {
        cachedStripeCharges.filter { c in
            if let start { return c.date >= start && c.date <= end }
            return c.date <= end
        }
    }

    private func filterLegacyRevenue(start: Date?, end: Date) -> [(date: Date, amount: Double)] {
        cachedLegacyRevenueEntries.filter { e in
            if let start { return e.date >= start && e.date <= end }
            return e.date <= end
        }
    }

    private func breakdownTenant(_ reqs: [BookingRequest]) -> InsightsBookingBreakdown {
        var b = InsightsBookingBreakdown()
        for r in reqs {
            let st = r.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            switch st {
            case "new": b.newCount += 1
            case "pending", "pending_deposit", "pending_consultation": b.other += 1
            case "confirmed": b.confirmed += 1
            case "cancelled", "declined": b.cancelledOrDeclined += 1
            default: b.other += 1
            }
        }
        return b
    }

    private func breakdownLegacy(_ reqs: [Request]) -> InsightsBookingBreakdown {
        var b = InsightsBookingBreakdown()
        for r in reqs {
            switch r.status {
            case .pending, .discussed: b.newCount += 1
            case .confirmed: b.confirmed += 1
            case .cancelled, .declined: b.cancelledOrDeclined += 1
            default: b.other += 1
            }
        }
        return b
    }

    private func trendText(current: Int, prior: Int, sameLabel: String = "same as prior") -> String {
        let delta = current - prior
        if delta > 0 { return "↗ +\(delta) vs last period" }
        if delta < 0 { return "↘ \(delta) vs last period" }
        return "↗ \(sameLabel)"
    }

    private func trendTextDouble(current: Double, prior: Double) -> String {
        if prior <= 0 {
            return current > 0 ? "↗ new activity" : "↗ same as prior"
        }
        let pct = ((current - prior) / prior) * 100
        if abs(pct) < 0.5 { return "↗ same as prior" }
        let sign = pct >= 0 ? "+" : ""
        return "↗ \(sign)\(Int(pct.rounded()))% vs last period"
    }

    private func loadStripeCharges() async -> (Double, Double, [(Date, Double)]) {
        do {
            let bal = try await functions.httpsCallable("getConnectBalance").call()
            let balData = bal.data as? [String: Any]
            let avail = Double((balData?["availableCents"] as? NSNumber)?.intValue ?? 0) / 100
            let pend = Double((balData?["pendingCents"] as? NSNumber)?.intValue ?? 0) / 100

            let start = Calendar.current.date(byAdding: .day, value: -365, to: Date()) ?? Date()
            let payload: [String: Any] = [
                "startTimestampSeconds": Int(start.timeIntervalSince1970),
                "limit": 100,
            ]
            let tx = try await functions.httpsCallable("getConnectBalanceTransactions").call(payload)
            let txData = tx.data as? [String: Any]
            let list = txData?["transactions"] as? [[String: Any]] ?? []
            var charges: [(Date, Double)] = []
            for t in list {
                let typeStr = (t["type"] as? String ?? "").lowercased()
                guard typeStr == "charge" else { continue }
                let created = (t["created"] as? NSNumber)?.intValue ?? 0
                guard created > 0 else { continue }
                let d = Date(timeIntervalSince1970: TimeInterval(created))
                let amountCents = (t["net"] as? NSNumber)?.intValue ?? (t["amount"] as? NSNumber)?.intValue ?? 0
                charges.append((d, Double(abs(amountCents)) / 100))
            }
            return (avail, pend, charges)
        } catch {
            return (0, 0, [])
        }
    }

    private static func startOfRollingDays(_ days: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
    }

    private static func topServices(from reqs: [BookingRequest], limit: Int) -> [(label: String, count: Int)] {
        var counts: [String: Int] = [:]
        for r in reqs {
            let name = r.serviceName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let slug = r.serviceSlug?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label: String
            if let n = name, !n.isEmpty { label = n }
            else if let sl = slug, !sl.isEmpty { label = sl }
            else { label = "Unspecified" }
            counts[label, default: 0] += 1
        }
        return counts.sorted { $0.value > $1.value }.prefix(limit).map { ($0.key, $0.value) }
    }

    private static func topLegacyServices(from reqs: [Request], limit: Int) -> [(label: String, count: Int)] {
        var counts: [String: Int] = [:]
        for r in reqs {
            let label = r.service.rawValue.replacingOccurrences(of: "_", with: " ")
            counts[label, default: 0] += 1
        }
        return counts.sorted { $0.value > $1.value }.prefix(limit).map { ($0.key, $0.value) }
    }
}
