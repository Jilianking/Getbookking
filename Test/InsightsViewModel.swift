//
//  InsightsViewModel.swift
//
//  Cross-system snapshot: bookings, customers, catalog, Stripe, tenant profile.
//  Excludes messages and web analytics (no data model yet).
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

final class InsightsViewModel: ObservableObject {
    @Published var useTenantData = false
    @Published var tenantId: String?
    @Published var isLoading = false
    @Published var loadError: String?

    // Bookings (tenant: bookingRequests; legacy: requests)
    @Published var bookingTotal = 0
    @Published var bookingNew = 0
    @Published var bookingUnreadNew = 0
    @Published var bookingConfirmed = 0
    @Published var bookingCancelledOrDeclined = 0
    @Published var bookingOther = 0
    @Published var bookingsLast30Days = 0
    @Published var topServiceLabels: [(label: String, count: Int)] = []

    // People & catalog (tenant)
    @Published var customerCount = 0
    @Published var customersNewLast30Days = 0
    @Published var serviceCount = 0
    @Published var productCount = 0
    @Published var shopEnabled = false

    // Web / tenant profile (no traffic analytics)
    @Published var businessDisplayName: String?
    @Published var industryLabel: String?
    @Published var webThemeLabel: String?

    // Legacy-only extras
    @Published var legacyMonthlyRevenue: Double = 0
    @Published var calendarEventsLast30Days = 0

    // Stripe (tenant with Connect only)
    @Published var stripeConnected = false
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    @Published var paymentChargesLast30Days = 0
    @Published var paymentVolumeLast30Days: Double = 0
    @Published var paymentTransactionsReturned = 0

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run {
            isLoading = true
            loadError = nil
        }

        if isDemoMode {
            await MainActor.run { resetForDemo(); isLoading = false }
            return
        }

        guard let uid = Auth.auth().currentUser?.uid else {
            await MainActor.run { isLoading = false }
            return
        }

        let since30 = Self.startOfRollingDays(30)

        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)

            if let tid = profile?.tenantId {
                async let bookingReqs = firebaseService.fetchTenantBookingRequests(tenantId: tid)
                async let customers = firebaseService.fetchTenantCustomers(tenantId: tid)
                async let services = firebaseService.fetchTenantServices(tenantId: tid)
                async let products = firebaseService.fetchTenantProducts(tenantId: tid)
                async let tenantData = firebaseService.fetchTenant(tenantId: tid)

                let (reqs, custs, svcs, prods, tenant) = try await (bookingReqs, customers, services, products, tenantData)

                let stripeAccountId = try await firebaseService.fetchTenantStripeAccountId(tenantId: tid)
                let connected = stripeAccountId != nil && !(stripeAccountId ?? "").isEmpty

                var avail: Double = 0
                var pend: Double = 0
                var charges30 = 0
                var volume30: Double = 0
                var txnReturned = 0

                if connected {
                    (avail, pend, charges30, volume30, txnReturned) = await loadStripeSnapshot(since30: since30)
                }

                let bookingStats = Self.aggregateTenantBookings(reqs, since30: since30)
                let topSvc = Self.topServices(from: reqs, limit: 5)
                let newCust30 = custs.filter { $0.createdAt >= since30 }.count

                await MainActor.run {
                    useTenantData = true
                    self.tenantId = tid
                    applyTenantBookingStats(bookingStats)
                    topServiceLabels = topSvc
                    customerCount = custs.count
                    customersNewLast30Days = newCust30
                    serviceCount = svcs.count
                    productCount = prods.count
                    shopEnabled = (tenant?["shopEnabled"] as? Bool) ?? false
                    businessDisplayName = tenant?["displayName"] as? String
                    let ind = (tenant?["industry"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    industryLabel = ind.isEmpty ? nil : ind
                    let rawTheme = (tenant?["webThemeId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if let w = WebTheme(rawValue: rawTheme) {
                        webThemeLabel = w.displayName
                    } else if rawTheme.isEmpty {
                        webThemeLabel = nil
                    } else {
                        webThemeLabel = rawTheme
                    }
                    legacyMonthlyRevenue = 0
                    calendarEventsLast30Days = 0
                    stripeConnected = connected
                    availableBalance = avail
                    pendingBalance = pend
                    paymentChargesLast30Days = charges30
                    paymentVolumeLast30Days = volume30
                    paymentTransactionsReturned = txnReturned
                    isLoading = false
                }
            } else {
                async let requests = firebaseService.fetchRequests()
                async let clients = firebaseService.fetchClients()
                let (reqs, cls) = try await (requests, clients)

                let cal = Calendar.current
                let now = Date()
                let startOfMonth = cal.date(from: cal.dateComponents([.year, .month], from: now))!
                let monthlyDone = reqs.filter {
                    if let d = $0.completedAt {
                        return d >= startOfMonth && $0.status == .completed
                    }
                    return false
                }
                let revenue = monthlyDone.reduce(0.0) { $0 + ($1.price ?? 0) + ($1.cashTips ?? 0) }

                let end = Date()
                let events = try await firebaseService.fetchEvents(startDate: since30, endDate: end)

                let legacyStats = Self.aggregateLegacyRequests(reqs, since30: since30)

                await MainActor.run {
                    useTenantData = false
                    tenantId = nil
                    applyLegacyBookingStats(legacyStats)
                    topServiceLabels = Self.topLegacyServices(from: reqs, limit: 5)
                    customerCount = cls.count
                    customersNewLast30Days = cls.filter { $0.createdAt >= since30 }.count
                    serviceCount = 0
                    productCount = 0
                    shopEnabled = false
                    businessDisplayName = nil
                    industryLabel = nil
                    webThemeLabel = nil
                    legacyMonthlyRevenue = revenue
                    calendarEventsLast30Days = events.count
                    stripeConnected = false
                    availableBalance = 0
                    pendingBalance = 0
                    paymentChargesLast30Days = 0
                    paymentVolumeLast30Days = 0
                    paymentTransactionsReturned = 0
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run {
                loadError = error.localizedDescription
                isLoading = false
            }
        }
    }

    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
    }

    // MARK: - Private

    private func resetForDemo() {
        useTenantData = false
        tenantId = nil
        bookingTotal = 0
        bookingNew = 0
        bookingUnreadNew = 0
        bookingConfirmed = 0
        bookingCancelledOrDeclined = 0
        bookingOther = 0
        bookingsLast30Days = 0
        topServiceLabels = []
        customerCount = 0
        customersNewLast30Days = 0
        serviceCount = 0
        productCount = 0
        shopEnabled = false
        businessDisplayName = nil
        industryLabel = nil
        webThemeLabel = nil
        legacyMonthlyRevenue = 0
        calendarEventsLast30Days = 0
        stripeConnected = false
        availableBalance = 0
        pendingBalance = 0
        paymentChargesLast30Days = 0
        paymentVolumeLast30Days = 0
        paymentTransactionsReturned = 0
    }

    private func applyTenantBookingStats(_ s: TenantBookingStats) {
        bookingTotal = s.total
        bookingNew = s.newCount
        bookingUnreadNew = s.unreadNew
        bookingConfirmed = s.confirmed
        bookingCancelledOrDeclined = s.cancelledOrDeclined
        bookingOther = s.other
        bookingsLast30Days = s.last30
    }

    private func applyLegacyBookingStats(_ s: LegacyBookingStats) {
        bookingTotal = s.total
        bookingNew = s.pending
        bookingUnreadNew = s.unreadPending
        bookingConfirmed = s.confirmed
        bookingCancelledOrDeclined = s.cancelledOrDeclined
        bookingOther = s.other
        bookingsLast30Days = s.last30
    }

    private func loadStripeSnapshot(since30: Date) async -> (Double, Double, Int, Double, Int) {
        do {
            let bal = try await functions.httpsCallable("getConnectBalance").call()
            let balData = bal.data as? [String: Any]
            let availCents = (balData?["availableCents"] as? NSNumber)?.intValue ?? 0
            let pendCents = (balData?["pendingCents"] as? NSNumber)?.intValue ?? 0
            let avail = Double(availCents) / 100
            let pend = Double(pendCents) / 100

            let tx = try await functions.httpsCallable("getConnectBalanceTransactions").call()
            let txData = tx.data as? [String: Any]
            let list = txData?["transactions"] as? [[String: Any]] ?? []
            var charges30 = 0
            var volume30: Double = 0
            for t in list {
                let typeStr = (t["type"] as? String ?? "").lowercased()
                guard typeStr == "charge" else { continue }
                let created = (t["created"] as? NSNumber)?.intValue ?? 0
                let createdAt = created > 0 ? Date(timeIntervalSince1970: TimeInterval(created)) : nil
                guard let d = createdAt, d >= since30 else { continue }
                let amountCents = (t["net"] as? NSNumber)?.intValue ?? (t["amount"] as? NSNumber)?.intValue ?? 0
                charges30 += 1
                volume30 += Double(abs(amountCents)) / 100
            }
            return (avail, pend, charges30, volume30, list.count)
        } catch {
            return (0, 0, 0, 0, 0)
        }
    }

    private static func startOfRollingDays(_ days: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
    }

    private struct TenantBookingStats {
        var total = 0
        var newCount = 0
        var unreadNew = 0
        var confirmed = 0
        var cancelledOrDeclined = 0
        var other = 0
        var last30 = 0
    }

    private static func aggregateTenantBookings(_ reqs: [BookingRequest], since30: Date) -> TenantBookingStats {
        var s = TenantBookingStats()
        s.total = reqs.count
        for r in reqs {
            let st = r.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            switch st {
            case "new":
                s.newCount += 1
                if r.readAt == nil { s.unreadNew += 1 }
            case "confirmed":
                s.confirmed += 1
            case "cancelled", "declined":
                s.cancelledOrDeclined += 1
            default:
                s.other += 1
            }
            if let c = r.createdAt, c >= since30 {
                s.last30 += 1
            }
        }
        return s
    }

    private struct LegacyBookingStats {
        var total = 0
        var pending = 0
        var unreadPending = 0
        var confirmed = 0
        var cancelledOrDeclined = 0
        var other = 0
        var last30 = 0
    }

    private static func aggregateLegacyRequests(_ reqs: [Request], since30: Date) -> LegacyBookingStats {
        var s = LegacyBookingStats()
        s.total = reqs.count
        for r in reqs {
            switch r.status {
            case .pending:
                s.pending += 1
                if r.reviewedAt == nil { s.unreadPending += 1 }
            case .confirmed:
                s.confirmed += 1
            case .cancelled, .declined:
                s.cancelledOrDeclined += 1
            default:
                s.other += 1
            }
            if r.submittedAt >= since30 {
                s.last30 += 1
            }
        }
        return s
    }

    private static func topServices(from reqs: [BookingRequest], limit: Int) -> [(label: String, count: Int)] {
        var counts: [String: Int] = [:]
        for r in reqs {
            let name = r.serviceName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let slug = r.serviceSlug?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label: String
            if let n = name, !n.isEmpty {
                label = n
            } else if let sl = slug, !sl.isEmpty {
                label = sl
            } else {
                label = "Unspecified"
            }
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
