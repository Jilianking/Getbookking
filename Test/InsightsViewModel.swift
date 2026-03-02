//
//  InsightsViewModel.swift
//
//  Fetches balance transactions, booking requests, and computes aggregates for Insights.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

enum InsightsPeriod: String, CaseIterable {
    case seven = "7 days"
    case thirty = "30 days"
    case ninety = "90 days"

    var days: Int {
        switch self {
        case .seven: return 7
        case .thirty: return 30
        case .ninety: return 90
        }
    }
}

enum InsightsTab: String, CaseIterable {
    case payments = "Payments"
    case bookings = "Bookings"
}

struct BalanceTransactionItem: Identifiable {
    let id: String
    let type: String
    let amount: Double  // cents converted to dollars
    let fee: Double
    let net: Double
    let created: Date
    let description: String?
    let reportingCategory: String?
}

struct RevenueByDay: Identifiable {
    let id: String
    let date: Date
    let revenue: Double
    let fee: Double
    let net: Double
}

struct BookingsByDay: Identifiable {
    let id: String
    let date: Date
    let total: Int
    let confirmed: Int
    let pending: Int
    let cancelled: Int
}

@MainActor
class InsightsViewModel: ObservableObject {
    @Published var selectedPeriod: InsightsPeriod = .thirty
    @Published var selectedTab: InsightsTab = .payments
    @Published var isLoading = false
    @Published var errorMessage: String?

    // Stripe / payments
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    @Published var transactions: [BalanceTransactionItem] = []
    @Published var revenueByDay: [RevenueByDay] = []
    @Published var tenantId: String?

    // Aggregates for period
    @Published var periodNetRevenue: Double = 0
    @Published var periodRefunds: Double = 0

    // Bookings
    @Published var bookingRequests: [BookingRequest] = []
    @Published var bookingsByDay: [BookingsByDay] = []
    @Published var totalRequests: Int = 0
    @Published var confirmedCount: Int = 0
    @Published var pendingCount: Int = 0
    @Published var cancelledCount: Int = 0
    @Published var conversionRate: Double = 0

    // Drill-down filter (e.g. tap metric card to filter list)
    @Published var filterTransactionType: String? = nil

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions()

    var filteredTransactions: [BalanceTransactionItem] {
        guard let type = filterTransactionType else { return transactions }
        return transactions.filter { $0.type == type }
    }

    var dateRange: (start: Date, end: Date) {
        let cal = Calendar.current
        let end = cal.startOfDay(for: Date())
        let start = cal.date(byAdding: .day, value: -selectedPeriod.days, to: end) ?? end
        return (start, end)
    }

    func loadData(isDemoMode: Bool = false) async {
        guard !isDemoMode else { return }
        guard let uid = Auth.auth().currentUser?.uid else { return }

        isLoading = true
        errorMessage = nil
        let (rangeStart, rangeEnd) = dateRange
        let startTs = Int(rangeStart.timeIntervalSince1970)
        let endTs = Int(rangeEnd.timeIntervalSince1970)

        do {
            // 1. Provider profile for tenantId
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                tenantId = nil
                isLoading = false
                return
            }
            tenantId = tid

            // 2. Balance (available + pending)
            if let balanceResult = try? await functions.httpsCallable("getConnectBalance").call(),
               let data = balanceResult.data as? [String: Any] {
                let availableCents = data["availableCents"] as? Int ?? 0
                let pendingCents = data["pendingCents"] as? Int ?? 0
                availableBalance = Double(availableCents) / 100
                pendingBalance = Double(pendingCents) / 100
            }

            // 3. Balance transactions
            let txnResult = try await functions.httpsCallable("getConnectBalanceTransactions").call([
                "startTimestampSeconds": startTs,
                "endTimestampSeconds": endTs,
                "limit": 100,
            ])
            let txnData = txnResult.data as? [String: Any]
            let rawTxns = txnData?["transactions"] as? [[String: Any]] ?? []
            transactions = rawTxns.compactMap { raw -> BalanceTransactionItem? in
                guard let id = raw["id"] as? String else { return nil }
                let type = raw["type"] as? String ?? "unknown"
                let amount = (raw["amount"] as? Int ?? 0)
                let fee = (raw["fee"] as? Int ?? 0)
                let net = (raw["net"] as? Int ?? 0)
                let createdTs = raw["created"] as? Int ?? 0
                return BalanceTransactionItem(
                    id: id,
                    type: type,
                    amount: Double(amount) / 100,
                    fee: Double(fee) / 100,
                    net: Double(net) / 100,
                    created: Date(timeIntervalSince1970: TimeInterval(createdTs)),
                    description: raw["description"] as? String,
                    reportingCategory: raw["reportingCategory"] as? String
                )
            }

            // 4. Compute period aggregates and revenue by day
            var netSum: Double = 0
            var refundsSum: Double = 0
            var byDay: [Date: (revenue: Double, fee: Double, net: Double)] = [:]

            for t in transactions {
                netSum += t.net
                if t.type == "refund" || t.type == "payment_refund" {
                    refundsSum += abs(t.amount)
                }
                let dayStart = Calendar.current.startOfDay(for: t.created)
                var existing = byDay[dayStart] ?? (0, 0, 0)
                if t.type == "charge" || t.type == "payment" {
                    existing.0 += t.amount
                }
                existing.1 += t.fee
                existing.2 += t.net
                byDay[dayStart] = existing
            }
            periodNetRevenue = netSum
            periodRefunds = refundsSum

            revenueByDay = byDay.sorted(by: { $0.key < $1.key }).map { date, vals in
                RevenueByDay(
                    id: "rev-\(Int(date.timeIntervalSince1970))",
                    date: date,
                    revenue: vals.revenue,
                    fee: vals.fee,
                    net: vals.net
                )
            }

            // 5. Booking requests
            let requests = try await firebaseService.fetchTenantBookingRequests(tenantId: tid)
            let inRange = requests.filter { r in
                guard let created = r.createdAt else { return false }
                return created >= rangeStart && created <= rangeEnd
            }
            bookingRequests = inRange.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }

            totalRequests = bookingRequests.count
            confirmedCount = bookingRequests.filter { isConfirmed($0.status) }.count
            pendingCount = bookingRequests.filter { isPending($0.status) }.count
            cancelledCount = bookingRequests.filter { isCancelled($0.status) }.count
            let eligible = totalRequests - cancelledCount
            conversionRate = eligible > 0 ? Double(confirmedCount) / Double(eligible) * 100 : 0

            // 6. Bookings by day
            var bookingsByDayDict: [Date: (total: Int, confirmed: Int, pending: Int, cancelled: Int)] = [:]
            for r in bookingRequests {
                guard let created = r.createdAt else { continue }
                let dayStart = Calendar.current.startOfDay(for: created)
                var v = bookingsByDayDict[dayStart] ?? (0, 0, 0, 0)
                v.0 += 1
                if isConfirmed(r.status) { v.1 += 1 }
                else if isPending(r.status) { v.2 += 1 }
                else if isCancelled(r.status) { v.3 += 1 }
                bookingsByDayDict[dayStart] = v
            }
            bookingsByDay = bookingsByDayDict.sorted(by: { $0.key < $1.key }).map { date, vals in
                BookingsByDay(
                    id: "bk-\(Int(date.timeIntervalSince1970))",
                    date: date,
                    total: vals.total,
                    confirmed: vals.confirmed,
                    pending: vals.pending,
                    cancelled: vals.cancelled
                )
            }

        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func isConfirmed(_ status: String) -> Bool {
        let s = status.uppercased()
        return s == "CONFIRMED" || s == "APPROVED" || s == "COMPLETED"
    }

    private func isPending(_ status: String) -> Bool {
        let s = status.uppercased()
        return s == "NEW" || s == "PENDING"
    }

    private func isCancelled(_ status: String) -> Bool {
        let s = status.uppercased()
        return s == "CANCELLED" || s == "DECLINED"
    }

    func setFilter(_ type: String?) {
        filterTransactionType = type
    }

    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
    }
}
