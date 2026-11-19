//
//  InsightsV2.swift
//  Insights (matches the web): range + compare + team member / service filters, summary tiles,
//  then Money, Appointments, Schedule, Clients, Team, and Online bookings.
//  Same rules as web/marketing/assets/app-insights.js. Every number covers only the chosen dates;
//  Booked ahead and Win back look forward from today.
//

import SwiftUI
import Charts

// MARK: - Range, compare, grouping

enum InsightsWindow: Int, CaseIterable, Identifiable {
    case days30 = 30, days90 = 90, days365 = 365, custom = 0
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .days30: return "30 days"
        case .days90: return "90 days"
        case .days365: return "12 months"
        case .custom: return "Custom"
        }
    }

    /// Period [from, to) for the range; custom uses the picked dates (end day included).
    func bounds(customStart: Date, customEnd: Date, now: Date = Date()) -> (from: Date, to: Date) {
        let cal = Calendar.current
        if self == .custom {
            let a = cal.startOfDay(for: min(customStart, customEnd))
            let z = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: max(customStart, customEnd))) ?? now
            return (a, min(z, now))
        }
        return (cal.date(byAdding: .day, value: -rawValue, to: now) ?? now, now)
    }
}

enum InsightsCompare: String, CaseIterable, Identifiable {
    case previous, lastYear, custom, none
    var id: String { rawValue }
    var label: String {
        switch self {
        case .previous: return "vs previous period"
        case .lastYear: return "vs same time last year"
        case .custom: return "vs custom dates"
        case .none: return "No comparison"
        }
    }
    var shortLabel: String {
        switch self {
        case .previous: return "Previous period"
        case .lastYear: return "Last year"
        case .custom: return "Compared dates"
        case .none: return ""
        }
    }

    /// The period to compare with, or nil for "No comparison".
    func bounds(for p: (from: Date, to: Date), customStart: Date, customEnd: Date) -> (from: Date, to: Date)? {
        let cal = Calendar.current
        switch self {
        case .none: return nil
        case .lastYear:
            return (cal.date(byAdding: .year, value: -1, to: p.from) ?? p.from, cal.date(byAdding: .year, value: -1, to: p.to) ?? p.to)
        case .custom:
            let a = cal.startOfDay(for: min(customStart, customEnd))
            let z = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: max(customStart, customEnd))) ?? a
            return (a, z)
        case .previous:
            let len = p.to.timeIntervalSince(p.from)
            return (p.from.addingTimeInterval(-len), p.from)
        }
    }
}

enum InsightsGrain: String, CaseIterable, Identifiable {
    case day, week, month
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    /// Days up to a month, weeks up to ~4 months, months beyond.
    static func auto(from: Date, to: Date) -> InsightsGrain {
        let days = to.timeIntervalSince(from) / 86400
        return days <= 31 ? .day : days <= 120 ? .week : .month
    }
}

/// Targets shown under rates (common salon / studio benchmarks).
enum InsightsHealthy {
    static let noShow = 5
    static let returning = 60
    static let prebook = 40
    static let booked = 70
}

struct InsightsTipEntry {
    let date: Date
    let tipCents: Int
    let serviceCents: Int
    let staffUid: String
}

// MARK: - Results

struct InsightsBucket: Identifiable {
    let id = UUID()
    let start: Date
    let end: Date
    let label: String
    var value: Double
}

struct InsightsWinBack: Identifiable {
    let id = UUID()
    let name: String
    let phone: String
    let daysAway: Int
}

struct InsightsTeamRow: Identifiable {
    let id = UUID()
    let name: String
    let valueCents: Int
    let visits: Int
    let busyPct: Int?
    let prebookPct: Int?
}

/// One appointment in the report's detail list.
struct InsightsApptRow: Identifiable {
    let id = UUID()
    let start: Date
    let client: String
    let service: String
    let staff: String
    let status: String
    let priceCents: Int
    let paidCents: Int
}

struct InsightsSnapshot {
    var revenue: Double?
    var revenueChangePct: Int?
    /// True when a team member / service filter is on: revenue shows the price of those visits.
    var revenueIsServiceValue = false
    var bookings = 0
    var bookingsChangePct: Int?
    var avgTicket: Double = 0
    var avgTicketChangePct: Int?
    var utilization: Int?
    var utilizationChangePts: Int?
    var bookedHours = 0
    var openHours = 0
    var returningPct: Int?
    var returningChangePts: Int?
    var newClients = 0
    // Appointments (past ones in the range).
    var completed = 0
    var cancelled = 0
    var noShows = 0
    var noShowPct: Int?
    var noShowChangePts: Int?
    var cancelPct: Int?
    var cancelChangePts: Int?
    var prebookPct: Int?
    var prebookChangePts: Int?
    // Upcoming (from today).
    var upcoming7Value: Double = 0
    var upcoming7Count = 0
    var upcoming30Value: Double = 0
    var upcoming30Count = 0
    /// Deposits already paid on upcoming appointments (7 / 30 days).
    var upcoming7Deposits: Double = 0
    var upcoming30Deposits: Double = 0
    var tipsTotal: Double = 0
    var tipsChangePct: Int?
    var tipsAvgPct = 0
    var tipsCount = 0
    var tipsByStaff: [(name: String, cents: Int)] = []
    var grain: InsightsGrain = .week
    var revenueBuckets: [InsightsBucket] = []
    var revenueCompare: [Double]?
    var bookingBuckets: [InsightsBucket] = []
    var bookingCompare: [Double]?
    /// [weekday 0=Sun][hourIndex] booking counts, plus the hours shown.
    var heat: [[Int]] = []
    var heatHours: [Int] = []
    var rebook: [Int: Int?] = [:]
    var winBack: [InsightsWinBack] = []
    var winBackMore = 0
    var topServices: [(label: String, count: Int)] = []
    var team: [InsightsTeamRow] = []
    // Online bookings.
    var apptTotal = 0
    var onlineCount = 0
    var onlineChangePct: Int?
    var onlineNewClients = 0
    var onlineNoShows = 0
    var onlineCancels = 0
    /// Services to offer in the filter, most booked first.
    var serviceNames: [String] = []
    // For reports.
    var busiest: [(label: String, count: Int)] = []
    var appointments: [InsightsApptRow] = []
    var payments: [(date: Date, amount: Double)] = []
    var tipsList: [InsightsTipEntry] = []
}

enum InsightsEngine {
    static let bookedStatuses: Set<String> = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"]
    static let dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    private final class B {
        let start: Date
        let createdAt: Date?
        let status: String
        let noShow: Bool
        let online: Bool
        let service: String
        let staff: String
        let staffUid: String
        let name: String
        let phone: String
        let client: String
        let minutes: Int
        let valueCents: Int
        let paidCents: Int

        init(start: Date, createdAt: Date?, status: String, noShow: Bool, online: Bool, service: String, staff: String, staffUid: String,
             name: String, phone: String, client: String, minutes: Int, valueCents: Int, paidCents: Int) {
            self.start = start; self.createdAt = createdAt; self.status = status; self.noShow = noShow; self.online = online
            self.service = service; self.staff = staff; self.staffUid = staffUid; self.name = name; self.phone = phone
            self.client = client; self.minutes = minutes; self.valueCents = valueCents; self.paidCents = paidCents
        }

        var isBooked: Bool { InsightsEngine.bookedStatuses.contains(status) }
        /// A real visit: booked, not cancelled, and not marked no-show.
        var isVisit: Bool { isBooked && !noShow }
        var isCancelled: Bool { status == "cancelled" }
    }

    static func pct(_ cur: Double, _ prev: Double) -> Int? {
        guard prev > 0 else { return nil }
        return Int(((cur - prev) / prev * 100).rounded())
    }

    private static func pts(_ cur: Int?, _ prev: Int?) -> Int? {
        guard let cur, let prev else { return nil }
        return cur - prev
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    static func compute(
        bookings raw: [BookingRequest],
        charges: [(date: Date, amount: Double)]?,
        tips: [InsightsTipEntry]?,
        servicePrices: [String: Int],
        tenant: [String: Any]?,
        staffCount: Int,
        memberNames: [String: String],
        teamMode: Bool,
        from: Date,
        to periodEnd: Date,
        compare cmp: (from: Date, to: Date)?,
        grain grainChoice: InsightsGrain?,
        staffFilter: String?,
        serviceFilter: String?,
        today: Date = Date()
    ) -> InsightsSnapshot {
        let cal = Calendar.current
        let now = periodEnd

        let all: [B] = raw.compactMap { r in
            guard let start = r.departureStart else { return nil }
            let status = BookingRequestStatus.normalized(r.status)
            let phone = String(PhoneFormatting.digits(from: r.customerPhone ?? "").suffix(10))
            let service = (r.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let sid = r.serviceId ?? ""
            let value = servicePrices[sid] ?? servicePrices["name:" + service.lowercased()] ?? (r.paidCents ?? 0)
            let client = phone.isEmpty ? (r.customerEmail ?? r.customerName ?? "").lowercased() : phone
            let source = (r.source ?? "").lowercased()
            return B(
                start: start, createdAt: r.createdAt, status: status, noShow: r.noShowAt != nil,
                online: source.contains("web") && (r.createdByUid ?? "").isEmpty,
                service: service.isEmpty ? "Other" : service,
                staff: (r.assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                staffUid: r.assignedMemberUid ?? "",
                name: (r.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Client" : (r.customerName ?? ""),
                phone: phone, client: client,
                minutes: (r.durationMinutes ?? 0) > 0 ? (r.durationMinutes ?? 60) : 60,
                valueCents: value,
                paidCents: max(0, r.paidCents ?? 0)
            )
        }
        let staffF = (staffFilter ?? "").isEmpty ? nil : staffFilter
        let serviceF = (serviceFilter ?? "").isEmpty ? nil : serviceFilter
        let filtered = staffF != nil || serviceF != nil
        // What the page counts (after filters). Client history (first visit, rebook, pre-book) uses the whole shop.
        let list = all.filter { b in
            if let staffF, b.staffUid != staffF { return false }
            if let serviceF, b.service != serviceF { return false }
            return true
        }
        let effectiveStaff = staffF != nil ? 1 : max(1, staffCount)

        var first: [String: Date] = [:]
        for b in all where b.isVisit && !b.client.isEmpty {
            if let f = first[b.client], f <= b.start { continue }
            first[b.client] = b.start
        }
        var byClient: [String: [B]] = [:]
        for b in all where !b.client.isEmpty { byClient[b.client, default: []].append(b) }
        for k in byClient.keys { byClient[k]?.sort { $0.start < $1.start } }

        /// Of past visits, the share where the next visit was already booked before the client left.
        func prebook(_ visits: [B]) -> Int? {
            var eligible = 0, hit = 0
            for v in visits where !v.client.isEmpty && v.start <= today {
                eligible += 1
                let leftAt = v.start.addingTimeInterval(Double(v.minutes + 60) * 60)
                let next = (byClient[v.client] ?? []).first { b in
                    b !== v && b.start > v.start && (b.isBooked || b.isCancelled) && (b.createdAt.map { $0 <= leftAt } ?? false)
                }
                if next != nil { hit += 1 }
            }
            return eligible > 0 ? Int((Double(hit) / Double(eligible) * 100).rounded()) : nil
        }

        struct P {
            var rows: [B] = []
            var visits: [B] = []
            var value = 0
            var avg: Double = 0
            var util: Int?
            var bh = 0, oh = 0
            var ret: Int?
            var completed = 0, cancelled = 0, noShows = 0
            var noShowPct: Int?, cancelPct: Int?, prebook: Int?
            var online = 0, onlineNew = 0, onlineNoShows = 0, onlineCancels = 0, appts = 0
        }
        func period(_ a: Date, _ z: Date) -> P {
            var p = P()
            p.rows = list.filter { $0.start >= a && $0.start < z }
            p.visits = p.rows.filter { $0.isVisit }
            p.value = p.visits.reduce(0) { $0 + $1.valueCents }
            let priced = p.visits.filter { $0.valueCents > 0 }
            p.avg = priced.isEmpty ? 0 : Double(priced.reduce(0) { $0 + $1.valueCents }) / Double(priced.count) / 100
            let minutes = p.visits.reduce(0) { $0 + $1.minutes }
            let open = openMinutes(from: a, to: z, tenant: tenant) * effectiveStaff
            p.util = open > 0 ? min(100, Int((Double(minutes) / Double(open) * 100).rounded())) : nil
            p.bh = Int((Double(minutes) / 60).rounded())
            p.oh = Int((Double(open) / 60).rounded())
            let returning = p.visits.filter { !$0.client.isEmpty && (first[$0.client] ?? .distantFuture) < a }.count
            p.ret = p.visits.isEmpty ? nil : Int((Double(returning) / Double(p.visits.count) * 100).rounded())
            let past = p.rows.filter { $0.start <= today }
            p.completed = past.filter { $0.isVisit }.count
            p.cancelled = past.filter { $0.isCancelled }.count
            p.noShows = past.filter { $0.noShow && $0.isBooked }.count
            let appts = p.completed + p.cancelled + p.noShows
            p.noShowPct = appts > 0 ? Int((Double(p.noShows) / Double(appts) * 100).rounded()) : nil
            p.cancelPct = appts > 0 ? Int((Double(p.cancelled) / Double(appts) * 100).rounded()) : nil
            p.prebook = prebook(p.visits)
            let apptRows = p.rows.filter { $0.isBooked || $0.isCancelled }
            p.appts = apptRows.count
            let online = apptRows.filter { $0.online }
            p.online = online.count
            p.onlineNoShows = online.filter { $0.noShow }.count
            p.onlineCancels = online.filter { $0.isCancelled }.count
            var seen = Set<String>()
            for b in online where b.isVisit && !b.client.isEmpty && !seen.contains(b.client) {
                if let f = first[b.client], f >= a, f < z, f == b.start { p.onlineNew += 1; seen.insert(b.client) }
            }
            return p
        }
        let cur = period(from, now)
        let prev = cmp.map { period($0.from, $0.to) }

        var s = InsightsSnapshot()
        s.bookings = cur.visits.count
        s.bookingsChangePct = prev.flatMap { pct(Double(cur.visits.count), Double($0.visits.count)) }
        s.avgTicket = cur.avg
        s.avgTicketChangePct = cur.avg > 0 ? prev.flatMap { pct(cur.avg, $0.avg) } : nil
        s.utilization = cur.util
        s.utilizationChangePts = pts(cur.util, prev?.util)
        s.bookedHours = cur.bh
        s.openHours = cur.oh
        s.returningPct = cur.ret
        s.returningChangePts = pts(cur.ret, prev?.ret)
        s.newClients = first.values.filter { $0 >= from && $0 < now }.count
        s.completed = cur.completed
        s.cancelled = cur.cancelled
        s.noShows = cur.noShows
        s.noShowPct = cur.noShowPct
        s.noShowChangePts = pts(cur.noShowPct, prev?.noShowPct)
        s.cancelPct = cur.cancelPct
        s.cancelChangePts = pts(cur.cancelPct, prev?.cancelPct)
        s.prebookPct = cur.prebook
        s.prebookChangePts = pts(cur.prebook, prev?.prebook)
        s.apptTotal = cur.appts
        s.onlineCount = cur.online
        s.onlineChangePct = prev.flatMap { pct(Double(cur.online), Double($0.online)) }
        s.onlineNewClients = cur.onlineNew
        s.onlineNoShows = cur.onlineNoShows
        s.onlineCancels = cur.onlineCancels

        // Revenue: card payments in [from, to), or the price of the filtered visits.
        var revenueEntries: ((Date, Date) -> [(Date, Double)])?
        if charges != nil, filtered {
            s.revenueIsServiceValue = true
            revenueEntries = { a, z in
                list.filter { $0.isVisit && $0.start >= a && $0.start < z }.map { ($0.start, Double($0.valueCents) / 100) }
            }
        } else if let charges {
            revenueEntries = { a, z in charges.filter { $0.date >= a && $0.date < z }.map { ($0.date, $0.amount) } }
        }
        if let revenueEntries {
            let r = revenueEntries(from, now).reduce(0) { $0 + $1.1 }
            s.revenue = r
            if let cmp { s.revenueChangePct = pct(r, revenueEntries(cmp.from, cmp.to).reduce(0) { $0 + $1.1 }) }
        }

        // Upcoming is always the next 7 / 30 days from today.
        let in7 = today.addingTimeInterval(7 * 86400)
        let in30 = today.addingTimeInterval(30 * 86400)
        let upcoming = list.filter { $0.isVisit && $0.status != "completed" && $0.start > today }
        let u7 = upcoming.filter { $0.start <= in7 }
        let u30 = upcoming.filter { $0.start <= in30 }
        s.upcoming7Count = u7.count
        s.upcoming7Value = Double(u7.reduce(0) { $0 + $1.valueCents }) / 100
        s.upcoming30Count = u30.count
        s.upcoming30Value = Double(u30.reduce(0) { $0 + $1.valueCents }) / 100
        // A deposit counts toward the appointment's total; never more than the service value when it's known.
        func deposits(_ l: [B]) -> Double {
            Double(l.reduce(0) { $0 + ($1.valueCents > 0 ? min($1.paidCents, $1.valueCents) : $1.paidCents) }) / 100
        }
        s.upcoming7Deposits = deposits(u7)
        s.upcoming30Deposits = deposits(u30)

        if let tips {
            func inRange(_ a: Date, _ z: Date) -> [InsightsTipEntry] {
                tips.filter { $0.date >= a && $0.date < z && $0.tipCents > 0 && (staffF == nil || $0.staffUid == staffF) }
            }
            let t = inRange(from, now)
            let total = t.reduce(0) { $0 + $1.tipCents }
            let base = t.reduce(0) { $0 + $1.serviceCents }
            s.tipsTotal = Double(total) / 100
            s.tipsCount = t.count
            s.tipsAvgPct = base > 0 ? Int((Double(total) / Double(base) * 100).rounded()) : 0
            if let cmp { s.tipsChangePct = pct(Double(total), Double(inRange(cmp.from, cmp.to).reduce(0) { $0 + $1.tipCents })) }
            var byStaff: [String: Int] = [:]
            for e in t { byStaff[memberNames[e.staffUid] ?? "Shop", default: 0] += e.tipCents }
            s.tipsByStaff = byStaff.sorted { $0.value > $1.value }.prefix(3).map { ($0.key, $0.value) }
            s.tipsList = t.sorted { $0.date < $1.date }
        }
        if let charges, !filtered {
            s.payments = charges.filter { $0.date >= from && $0.date < now }.sorted { $0.date < $1.date }
        }
        s.appointments = cur.rows.filter { $0.isBooked || $0.isCancelled }.sorted { $0.start < $1.start }.map { b in
            InsightsApptRow(
                start: b.start, client: b.name, service: b.service, staff: b.staff,
                status: b.noShow ? "No-show" : b.isCancelled ? "Canceled" : b.start <= today ? "Completed" : "Upcoming",
                priceCents: b.valueCents, paidCents: b.paidCents
            )
        }

        // Charts: buckets start exactly on the first day of the range.
        let g = grainChoice ?? InsightsGrain.auto(from: from, to: now)
        s.grain = g
        let curBuckets = makeBuckets(from: from, to: now, grain: g)
        func aligned(_ entries: (Date, Date) -> [(Date, Double)]) -> [Double]? {
            guard let cmp else { return nil }
            let cb = fill(makeBuckets(from: cmp.from, to: cmp.to, grain: g), entries(cmp.from, cmp.to))
            return curBuckets.indices.map { $0 < cb.count ? cb[$0].value : 0 }
        }
        if let revenueEntries {
            s.revenueBuckets = fill(curBuckets, revenueEntries(from, now))
            s.revenueCompare = aligned(revenueEntries)
        }
        let visitEntries: (Date, Date) -> [(Date, Double)] = { a, z in
            list.filter { $0.isVisit && $0.start >= a && $0.start < z }.map { ($0.start, 1.0) }
        }
        s.bookingBuckets = fill(curBuckets, visitEntries(from, now))
        s.bookingCompare = aligned(visitEntries)

        // Heatmap.
        var lo = 24, hi = 0
        let weekly = tenant?["businessHoursWeekly"] as? [String: Any] ?? [:]
        for k in dayKeys {
            guard let day = weekly[k] as? [String: Any], (day["closed"] as? Bool) != true,
                  let ranges = day["ranges"] as? [[String: Any]] else { continue }
            for r in ranges {
                lo = min(lo, num(r["openMin"]) / 60)
                hi = max(hi, Int(ceil(Double(num(r["closeMin"])) / 60)))
            }
        }
        for b in cur.visits {
            let h = cal.component(.hour, from: b.start)
            lo = min(lo, h); hi = max(hi, h + 1)
        }
        if lo >= hi { lo = 9; hi = 18 }
        s.heatHours = Array(lo..<hi)
        var heat = Array(repeating: Array(repeating: 0, count: s.heatHours.count), count: 7)
        for b in cur.visits {
            let d = cal.component(.weekday, from: b.start) - 1
            let h = cal.component(.hour, from: b.start) - lo
            if h >= 0 && h < s.heatHours.count { heat[d][h] += 1 }
        }
        s.heat = heat
        var slots: [String: Int] = [:]
        for b in cur.visits {
            let label = b.start.formatted(.dateTime.weekday(.abbreviated)) + " " + b.start.formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)))
            slots[label, default: 0] += 1
        }
        s.busiest = slots.sorted { $0.value > $1.value }.prefix(5).map { ($0.key, $0.value) }

        // Rebook rates: of visits in the range, the share with another visit within N days.
        for n in [30, 60, 90] {
            var eligible = 0, hit = 0
            for b in cur.visits where !b.client.isEmpty {
                let next = (byClient[b.client] ?? []).first { $0.start > b.start && $0.isVisit }
                let measurable = today.timeIntervalSince(b.start) / 86400 >= Double(n) || next != nil
                guard measurable else { continue }
                eligible += 1
                if let next, next.start.timeIntervalSince(b.start) / 86400 <= Double(n) { hit += 1 }
            }
            s.rebook[n] = eligible > 0 ? Int((Double(hit) / Double(eligible) * 100).rounded()) : nil
        }

        // Clients to win back: last visit 60+ days ago, nothing booked.
        struct C { var name: String; var phone: String; var last: Date?; var visits = 0; var upcoming = false }
        var clients: [String: C] = [:]
        for b in list where b.isVisit && !b.client.isEmpty {
            var c = clients[b.client] ?? C(name: b.name, phone: b.phone, last: nil)
            if b.start > today { c.upcoming = true } else {
                c.visits += 1
                if c.last == nil || b.start > c.last! { c.last = b.start; c.name = b.name }
            }
            clients[b.client] = c
        }
        let wb = clients.values.filter { c in
            guard let last = c.last, !c.upcoming else { return false }
            return today.timeIntervalSince(last) / 86400 >= 60
        }.sorted { $0.visits != $1.visits ? $0.visits > $1.visits : ($0.last ?? today) < ($1.last ?? today) }
        s.winBack = wb.prefix(5).map {
            InsightsWinBack(name: $0.name, phone: $0.phone, daysAway: Int(today.timeIntervalSince($0.last ?? today) / 86400))
        }
        s.winBackMore = max(0, wb.count - 5)

        var svc: [String: Int] = [:]
        for b in cur.visits { svc[b.service, default: 0] += 1 }
        s.topServices = svc.sorted { $0.value > $1.value }.prefix(5).map { ($0.key, $0.value) }

        var allSvc: [String: Int] = [:]
        for b in all where b.isBooked { allSvc[b.service, default: 0] += 1 }
        s.serviceNames = allSvc.sorted { $0.value > $1.value }.prefix(40).map(\.key)

        if teamMode && staffF == nil {
            let open = openMinutes(from: from, to: now, tenant: tenant)
            var groups: [String: [B]] = [:]
            for b in cur.visits {
                let key = b.staffUid.isEmpty ? b.staff : b.staffUid
                if !key.isEmpty { groups[key, default: []].append(b) }
            }
            s.team = groups.map { key, visits in
                let minutes = visits.reduce(0) { $0 + $1.minutes }
                return InsightsTeamRow(
                    name: memberNames[key] ?? visits.first?.staff ?? "Team member",
                    valueCents: visits.reduce(0) { $0 + $1.valueCents },
                    visits: visits.count,
                    busyPct: open > 0 ? min(100, Int((Double(minutes) / Double(open) * 100).rounded())) : nil,
                    prebookPct: prebook(visits)
                )
            }.sorted { $0.valueCents != $1.valueCents ? $0.valueCents > $1.valueCents : $0.visits > $1.visits }
        }
        return s
    }

    private static func num(_ any: Any?) -> Int {
        if let n = any as? Int { return n }
        if let n = any as? Double { return Int(n) }
        if let n = any as? NSNumber { return n.intValue }
        return 0
    }

    /// Open minutes from the weekly hours, minus days off and blocked time.
    static func openMinutes(from: Date, to: Date, tenant: [String: Any]?) -> Int {
        let cal = Calendar.current
        let weekly = tenant?["businessHoursWeekly"] as? [String: Any]
        let blockedDays = Set((tenant?["blockedDates"] as? [String]) ?? [])
        let blocks = (tenant?["blockedTimeRanges"] as? [[String: Any]]) ?? []
        let fmt = ShopBlockedTimeStore.ymd
        var total = 0
        var d = cal.startOfDay(for: from)
        while d < to {
            let ymd = fmt.string(from: d)
            if !blockedDays.contains(ymd) {
                let wd = cal.component(.weekday, from: d) - 1
                if let weekly {
                    if let day = weekly[dayKeys[wd]] as? [String: Any], (day["closed"] as? Bool) != true,
                       let ranges = day["ranges"] as? [[String: Any]] {
                        for r in ranges { total += max(0, num(r["closeMin"]) - num(r["openMin"])) }
                    }
                } else if wd >= 1 && wd <= 5 {
                    total += 480
                }
                for bl in blocks where (bl["date"] as? String) == ymd {
                    total -= max(0, num(bl["endMin"]) - num(bl["startMin"]))
                }
            }
            d = cal.date(byAdding: .day, value: 1, to: d) ?? to
        }
        return max(0, total)
    }

    /// Buckets from the first day of [from, to): one per day, per 7 days, or per month.
    static func makeBuckets(from: Date, to: Date, grain: InsightsGrain) -> [InsightsBucket] {
        let cal = Calendar.current
        var out: [InsightsBucket] = []
        var s = cal.startOfDay(for: from)
        while s < to && out.count < 400 {
            let e: Date
            switch grain {
            case .day: e = cal.date(byAdding: .day, value: 1, to: s) ?? to
            case .week: e = cal.date(byAdding: .day, value: 7, to: s) ?? to
            case .month: e = cal.date(byAdding: .month, value: 1, to: cal.date(from: cal.dateComponents([.year, .month], from: s)) ?? s) ?? to
            }
            let label = grain == .month ? s.formatted(.dateTime.month(.abbreviated)) : s.formatted(.dateTime.month(.abbreviated).day())
            out.append(InsightsBucket(start: s, end: e, label: label, value: 0))
            s = e
        }
        return out
    }

    static func fill(_ buckets: [InsightsBucket], _ entries: [(Date, Double)]) -> [InsightsBucket] {
        var b = buckets
        for (d, v) in entries {
            if let i = b.firstIndex(where: { d >= $0.start && d < $0.end }) { b[i].value += v }
        }
        return b
    }
}

// MARK: - Views

struct InsightsChangeLabel: View {
    let pct: Int?
    var lowerIsBetter = false
    var body: some View {
        if let pct {
            let good = lowerIsBetter ? pct <= 0 : pct >= 0
            Text("\(pct >= 0 ? "▲" : "▼") \(abs(pct))%")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(good ? AppDesign.accentGreen : Color.red)
        }
    }
}

/// Change in percentage points, for rates.
struct InsightsPointsLabel: View {
    let pts: Int?
    var lowerIsBetter = false
    var body: some View {
        if let pts {
            if pts == 0 {
                Text("same").font(.caption2.weight(.semibold)).foregroundStyle(AppDesign.textSecondary)
            } else {
                let good = lowerIsBetter ? pts < 0 : pts > 0
                Text("\(pts > 0 ? "▲" : "▼") \(abs(pts)) pt")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(good ? AppDesign.accentGreen : Color.red)
            }
        }
    }
}

/// "Healthy is 60%+" under a rate; green with a check when it's met.
struct InsightsHealthyHint: View {
    let text: String
    let ok: Bool
    var body: some View {
        Text((ok ? "✓ " : "") + text)
            .font(.caption2)
            .foregroundStyle(ok ? AppDesign.accentGreen : AppDesign.textSecondary)
    }
}

struct InsightsCard<Content: View>: View {
    let title: String
    var trailing: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(AppDesign.textPrimary)
                Spacer()
                if let trailing { Text(trailing).font(.caption).foregroundStyle(AppDesign.textSecondary) }
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .appCard()
    }
}

struct InsightsSectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(1)
            .foregroundStyle(AppDesign.textSecondary)
            .padding(.horizontal, 20)
            .padding(.top, 10)
    }
}

/// Stacked bar of parts (value, color).
struct InsightsStackBar: View {
    let parts: [(Double, Color)]
    var body: some View {
        GeometryReader { geo in
            let total = max(1, parts.reduce(0) { $0 + $1.0 })
            HStack(spacing: 0) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                    Rectangle().fill(p.1).frame(width: geo.size.width * CGFloat(p.0 / total))
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 9)
        .background(Capsule().fill(AppDesign.brandCream))
    }
}

struct InsightsBarChart: View {
    let buckets: [InsightsBucket]
    var compare: [Double]? = nil
    var compareLabel = "Before"
    let color: Color
    let format: (Double) -> String

    /// At most ~5 labels so they never overlap.
    private var labelKeys: [String] {
        guard !buckets.isEmpty else { return [] }
        let step = max(1, Int(ceil(Double(buckets.count) / 5)))
        return stride(from: 0, to: buckets.count, by: step).map { String($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Chart {
                ForEach(Array(buckets.enumerated()), id: \.offset) { i, b in
                    BarMark(x: .value("Period", String(i)), y: .value("Value", b.value))
                        .foregroundStyle(color)
                        .cornerRadius(3)
                }
                if let compare, compare.count == buckets.count {
                    ForEach(Array(compare.enumerated()), id: \.offset) { i, v in
                        LineMark(x: .value("Period", String(i)), y: .value("Value", v), series: .value("Series", "compare"))
                            .foregroundStyle(AppDesign.textSecondary)
                            .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                    AxisValueLabel { if let d = v.as(Double.self) { Text(format(d)).font(.caption2) } }
                }
            }
            .chartXAxis {
                AxisMarks(values: labelKeys) { v in
                    AxisValueLabel {
                        if let k = v.as(String.self), let i = Int(k), i < buckets.count {
                            Text(buckets[i].label).font(.caption2)
                        }
                    }
                }
            }
            .frame(height: 150)
            if compare != nil {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 10, height: 10)
                    Text("This period").font(.caption2).foregroundStyle(AppDesign.textSecondary)
                    Rectangle().stroke(style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .foregroundStyle(AppDesign.textSecondary).frame(width: 16, height: 1).padding(.leading, 8)
                    Text(compareLabel).font(.caption2).foregroundStyle(AppDesign.textSecondary)
                }
            }
        }
    }
}

struct InsightsGauge: View {
    let pct: Int
    var body: some View {
        ZStack {
            Circle().trim(from: 0, to: 0.5)
                .stroke(AppDesign.chipBorder, style: StrokeStyle(lineWidth: 11, lineCap: .round))
                .rotationEffect(.degrees(180))
            Circle().trim(from: 0, to: 0.5 * Double(max(0, min(100, pct))) / 100)
                .stroke(AppDesign.brandWarm, style: StrokeStyle(lineWidth: 11, lineCap: .round))
                .rotationEffect(.degrees(180))
            Text("\(pct)%").font(.title3.weight(.bold)).offset(y: -8)
        }
        .frame(width: 104, height: 104)
        .padding(.bottom, -44)
    }
}

struct InsightsHeatmap: View {
    let heat: [[Int]]
    let hours: [Int]
    @State private var selected: String?
    private let order = [1, 2, 3, 4, 5, 6, 0]
    private let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private func hourLabel(_ h: Int) -> String {
        let d = Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: Date()) ?? Date()
        return d.formatted(.dateTime.hour(.defaultDigits(amPM: .narrow))).lowercased().replacingOccurrences(of: " ", with: "")
    }

    private func color(_ v: Int, _ max: Int) -> Color {
        guard v > 0 else { return AppDesign.brandCream.opacity(0.45) }
        let lvl = max <= 1 ? 2 : min(4, 1 + Int(Double(v) / Double(max) * 3.999))
        switch lvl {
        case 1: return AppDesign.brandCream
        case 2: return Color(hex: "#C9B8A0")
        case 3: return AppDesign.brandWarm
        default: return AppDesign.brandDark
        }
    }

    var body: some View {
        let mx = heat.flatMap { $0 }.max() ?? 0
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Text("").frame(width: 30)
                ForEach(Array(hours.enumerated()), id: \.offset) { i, h in
                    Text(i % 2 == 0 ? hourLabel(h) : "")
                        .font(.system(size: 9)).foregroundStyle(AppDesign.textSecondary)
                        .frame(maxWidth: .infinity)
                }
            }
            ForEach(order, id: \.self) { d in
                HStack(spacing: 3) {
                    Text(names[d]).font(.caption2).foregroundStyle(AppDesign.textSecondary).frame(width: 30, alignment: .leading)
                    ForEach(Array(hours.enumerated()), id: \.offset) { i, h in
                        let v = (d < heat.count && i < heat[d].count) ? heat[d][i] : 0
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(color(v, mx))
                            .aspectRatio(1.4, contentMode: .fit)
                            .onTapGesture { selected = "\(names[d]) \(hourLabel(h)): \(v) \(v == 1 ? "booking" : "bookings")" }
                    }
                }
            }
            Text(selected ?? "Tap a square for details")
                .font(.caption2)
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.top, 4)
        }
    }
}
