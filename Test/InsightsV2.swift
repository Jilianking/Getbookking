//
//  InsightsV2.swift
//  Insights redesign (matches the web): summary tiles with "vs last period", then Money,
//  Schedule, and Clients. Same rules as web/marketing/assets/app-insights.js.
//

import SwiftUI
import Charts

// MARK: - Range

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

    /// Months when the period is longer than ~4 months, otherwise weeks.
    static func usesMonths(from: Date, to: Date) -> Bool { to.timeIntervalSince(from) / 86400 > 120 }
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

struct InsightsSnapshot {
    var revenue: Double?
    var revenueChangePct: Int?
    var bookings = 0
    var bookingsChangePct: Int?
    var avgTicket: Double = 0
    var avgTicketChangePct: Int?
    var utilization: Int?
    var utilizationChangePct: Int?
    var bookedHours = 0
    var openHours = 0
    var returningPct: Int?
    var returningChangePct: Int?
    var newClients = 0
    var upcoming7Value: Double = 0
    var upcoming7Count = 0
    var upcoming30Value: Double = 0
    var upcoming30Count = 0
    /// Deposits already paid on upcoming appointments (7 / 30 days).
    var upcoming7Deposits: Double = 0
    var upcoming30Deposits: Double = 0
    var tipsTotal: Double = 0
    var tipsAvgPct = 0
    var tipsCount = 0
    var tipsByStaff: [(name: String, cents: Int)] = []
    var revenueBuckets: [InsightsBucket] = []
    var bookingBuckets: [InsightsBucket] = []
    /// [weekday 0=Sun][hourIndex] booking counts, plus the hours shown.
    var heat: [[Int]] = []
    var heatHours: [Int] = []
    var rebook: [Int: Int?] = [:]
    var winBack: [InsightsWinBack] = []
    var winBackMore = 0
    var topServices: [(label: String, count: Int)] = []
    var team: [(name: String, count: Int, valueCents: Int)] = []
}

enum InsightsEngine {
    static let bookedStatuses: Set<String> = ["confirmed", "pending_deposit", "pending_payment", "pending_consultation", "completed"]
    static let dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

    private struct B {
        let start: Date
        let status: String
        let service: String
        let serviceId: String
        let staff: String
        let name: String
        let phone: String
        let client: String
        let minutes: Int
        let valueCents: Int
        let paidCents: Int
    }

    static func pct(_ cur: Double, _ prev: Double) -> Int? {
        guard prev > 0 else { return nil }
        return Int(((cur - prev) / prev * 100).rounded())
    }

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
        today: Date = Date()
    ) -> InsightsSnapshot {
        let cal = Calendar.current
        // Everything about the period uses [from, periodEnd); "now" below means the end of the period.
        let now = periodEnd
        let length = max(86400, periodEnd.timeIntervalSince(from))
        let prevFrom = from.addingTimeInterval(-length)

        let list: [B] = raw.compactMap { r in
            guard let start = r.departureStart else { return nil }
            let status = BookingRequestStatus.normalized(r.status)
            let phone = String(PhoneFormatting.digits(from: r.customerPhone ?? "").suffix(10))
            let service = (r.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let sid = r.serviceId ?? ""
            let value = servicePrices[sid] ?? servicePrices["name:" + service.lowercased()] ?? (r.paidCents ?? 0)
            let client = phone.isEmpty ? (r.customerEmail ?? r.customerName ?? "").lowercased() : phone
            return B(
                start: start, status: status, service: service.isEmpty ? "Other" : service, serviceId: sid,
                staff: (r.assignedMemberName ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                name: (r.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Client" : (r.customerName ?? ""),
                phone: phone, client: client,
                minutes: (r.durationMinutes ?? 0) > 0 ? (r.durationMinutes ?? 60) : 60,
                valueCents: value,
                paidCents: max(0, r.paidCents ?? 0)
            )
        }
        let booked = list.filter { bookedStatuses.contains($0.status) }

        var first: [String: Date] = [:]
        for b in booked where !b.client.isEmpty {
            if let f = first[b.client], f <= b.start { continue }
            first[b.client] = b.start
        }

        func period(_ a: Date, _ z: Date) -> (list: [B], count: Int, avg: Double, util: Int?, bh: Int, oh: Int, ret: Int?) {
            let inP = booked.filter { $0.start >= a && $0.start < z }
            let priced = inP.filter { $0.valueCents > 0 }
            let avg = priced.isEmpty ? 0 : Double(priced.reduce(0) { $0 + $1.valueCents }) / Double(priced.count) / 100
            let minutes = inP.reduce(0) { $0 + $1.minutes }
            let open = openMinutes(from: a, to: z, tenant: tenant) * max(1, staffCount)
            let util = open > 0 ? min(100, Int((Double(minutes) / Double(open) * 100).rounded())) : nil
            let returning = inP.filter { !$0.client.isEmpty && (first[$0.client] ?? .distantFuture) < a }.count
            let ret = inP.isEmpty ? nil : Int((Double(returning) / Double(inP.count) * 100).rounded())
            return (inP, inP.count, avg, util, Int((Double(minutes) / 60).rounded()), Int((Double(open) / 60).rounded()), ret)
        }
        let cur = period(from, now)
        let prev = period(prevFrom, from)

        var s = InsightsSnapshot()
        s.bookings = cur.count
        s.bookingsChangePct = pct(Double(cur.count), Double(prev.count))
        s.avgTicket = cur.avg
        s.avgTicketChangePct = cur.avg > 0 ? pct(cur.avg, prev.avg) : nil
        s.utilization = cur.util
        s.utilizationChangePct = cur.util.flatMap { c in prev.util.flatMap { pct(Double(c), Double($0)) } }
        s.bookedHours = cur.bh
        s.openHours = cur.oh
        s.returningPct = cur.ret
        s.returningChangePct = cur.ret.flatMap { c in prev.ret.flatMap { pct(Double(c), Double($0)) } }
        s.newClients = first.values.filter { $0 >= from && $0 < now }.count

        if let charges {
            let r = charges.filter { $0.date >= from }.reduce(0) { $0 + $1.amount }
            let p = charges.filter { $0.date >= prevFrom && $0.date < from }.reduce(0) { $0 + $1.amount }
            s.revenue = r
            s.revenueChangePct = pct(r, p)
        }

        // Upcoming is always the next 7 / 30 days from today.
        let in7 = today.addingTimeInterval(7 * 86400)
        let in30 = today.addingTimeInterval(30 * 86400)
        let upcoming = booked.filter { $0.status != "completed" && $0.start > today }
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
            let t = tips.filter { $0.date >= from && $0.tipCents > 0 }
            let total = t.reduce(0) { $0 + $1.tipCents }
            let base = t.reduce(0) { $0 + $1.serviceCents }
            s.tipsTotal = Double(total) / 100
            s.tipsCount = t.count
            s.tipsAvgPct = base > 0 ? Int((Double(total) / Double(base) * 100).rounded()) : 0
            var byStaff: [String: Int] = [:]
            for e in t { byStaff[memberNames[e.staffUid] ?? "Shop", default: 0] += e.tipCents }
            s.tipsByStaff = byStaff.sorted { $0.value > $1.value }.prefix(3).map { ($0.key, $0.value) }
        }

        // Charts.
        let buckets = makeBuckets(from: from, to: periodEnd)
        if let charges {
            s.revenueBuckets = fill(buckets, charges.filter { $0.date >= from }.map { ($0.date, $0.amount) })
        }
        s.bookingBuckets = fill(buckets, cur.list.map { ($0.start, 1.0) })

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
        for b in cur.list {
            let h = cal.component(.hour, from: b.start)
            lo = min(lo, h); hi = max(hi, h + 1)
        }
        if lo >= hi { lo = 9; hi = 18 }
        s.heatHours = Array(lo..<hi)
        var heat = Array(repeating: Array(repeating: 0, count: s.heatHours.count), count: 7)
        for b in cur.list {
            let d = cal.component(.weekday, from: b.start) - 1
            let h = cal.component(.hour, from: b.start) - lo
            if h >= 0 && h < s.heatHours.count { heat[d][h] += 1 }
        }
        s.heat = heat

        // Rebook rates: of visits in the range, the share with another booking within N days.
        var byClient: [String: [Date]] = [:]
        for b in booked where !b.client.isEmpty { byClient[b.client, default: []].append(b.start) }
        for k in byClient.keys { byClient[k]?.sort() }
        for n in [30, 60, 90] {
            var eligible = 0, hit = 0
            for b in cur.list where !b.client.isEmpty {
                let next = (byClient[b.client] ?? []).first { $0 > b.start }
                let measurable = today.timeIntervalSince(b.start) / 86400 >= Double(n) || next != nil
                guard measurable else { continue }
                eligible += 1
                if let next, next.timeIntervalSince(b.start) / 86400 <= Double(n) { hit += 1 }
            }
            s.rebook[n] = eligible > 0 ? Int((Double(hit) / Double(eligible) * 100).rounded()) : nil
        }

        // Clients to win back: last visit 60+ days ago, nothing booked.
        struct C { var name: String; var phone: String; var last: Date?; var visits = 0; var upcoming = false }
        var clients: [String: C] = [:]
        for b in booked where !b.client.isEmpty {
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
        for b in cur.list { svc[b.service, default: 0] += 1 }
        s.topServices = svc.sorted { $0.value > $1.value }.prefix(5).map { ($0.key, $0.value) }

        if teamMode {
            var n: [String: Int] = [:], v: [String: Int] = [:]
            for b in cur.list where !b.staff.isEmpty {
                n[b.staff, default: 0] += 1
                v[b.staff, default: 0] += b.valueCents
            }
            s.team = n.sorted { $0.value > $1.value }.prefix(6).map { ($0.key, $0.value, v[$0.key] ?? 0) }
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

    /// Week buckets (or months for long periods) covering [from, to).
    static func makeBuckets(from: Date, to: Date) -> [InsightsBucket] {
        let cal = Calendar.current
        var out: [InsightsBucket] = []
        if InsightsWindow.usesMonths(from: from, to: to) {
            var s = cal.date(from: cal.dateComponents([.year, .month], from: from)) ?? from
            while s < to && out.count < 36 {
                let e = cal.date(byAdding: .month, value: 1, to: s) ?? to
                out.append(InsightsBucket(start: s, end: e, label: s.formatted(.dateTime.month(.abbreviated)), value: 0))
                s = e
            }
            return out
        }
        let startDay = cal.startOfDay(for: from)
        var s = cal.date(byAdding: .day, value: -(cal.component(.weekday, from: startDay) - 1), to: startDay) ?? startDay
        while s < to && out.count < 30 {
            let e = cal.date(byAdding: .day, value: 7, to: s) ?? to
            out.append(InsightsBucket(start: s, end: e, label: s.formatted(.dateTime.month(.abbreviated).day()), value: 0))
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
    var body: some View {
        if let pct {
            Text("\(pct >= 0 ? "▲" : "▼") \(abs(pct))%")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(pct >= 0 ? AppDesign.accentGreen : Color.red)
        }
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

struct InsightsBarChart: View {
    let buckets: [InsightsBucket]
    let color: Color
    let format: (Double) -> String

    private var monthly: Bool {
        guard let f = buckets.first else { return false }
        return f.end.timeIntervalSince(f.start) > 20 * 86400
    }

    /// At most ~5 date labels so they never overlap.
    private var labelDates: [Date] {
        guard !buckets.isEmpty else { return [] }
        let step = max(1, Int(ceil(Double(buckets.count) / 5)))
        return stride(from: 0, to: buckets.count, by: step).map { buckets[$0].start }
    }

    var body: some View {
        Chart(buckets) { b in
            BarMark(
                x: .value("Period", b.start, unit: monthly ? .month : .weekOfYear),
                y: .value("Value", b.value)
            )
            .foregroundStyle(color)
            .cornerRadius(3)
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                AxisGridLine().foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                AxisValueLabel { if let d = v.as(Double.self) { Text(format(d)).font(.caption2) } }
            }
        }
        .chartXAxis {
            AxisMarks(values: labelDates) { v in
                AxisValueLabel {
                    if let d = v.as(Date.self) {
                        Text(monthly ? d.formatted(.dateTime.month(.abbreviated)) : d.formatted(.dateTime.month(.abbreviated).day()))
                            .font(.caption2)
                    }
                }
            }
        }
        .frame(height: 150)
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
