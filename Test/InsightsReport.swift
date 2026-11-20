//
//  InsightsReport.swift
//  "Build report" on Insights: pick dates, compare, filters, and sections, then make a PDF and share it
//  (Save to Files, AirDrop, Mail, Messages). Same sections as the web report.
//

import SwiftUI
import UIKit
import Charts

enum InsightsReportSection: String, CaseIterable, Identifiable {
    case summary, money, ahead, appointments, schedule, clients, team, online, details
    var id: String { rawValue }
    var label: String {
        switch self {
        case .summary: return "Summary"
        case .money: return "Money"
        case .appointments: return "Appointments"
        case .schedule: return "Schedule"
        case .clients: return "Clients"
        case .team: return "Team members"
        case .online: return "How bookings came in"
        case .ahead: return "Next 30 days (deposits and balances)"
        case .details: return "Detail lists (every appointment, payment, and tip)"
        }
    }
}

struct InsightsReportSheet: View {
    @ObservedObject var viewModel: InsightsViewModel
    let shopName: String
    let teamMembers: [TenantTeamMember]
    let seesWholeTeam: Bool
    let canSeeMoney: Bool
    let makeSnapshot: (_ from: Date, _ to: Date, _ compare: InsightsCompare, _ cmpStart: Date, _ cmpEnd: Date, _ staff: String, _ service: String) -> InsightsSnapshot
    @Environment(\.dismiss) private var dismiss

    @State private var from: Date
    @State private var to: Date
    @State private var compare: InsightsCompare
    @State private var cmpStart: Date
    @State private var cmpEnd: Date
    @State private var staff: String
    @State private var service: String
    @State private var sections: Set<InsightsReportSection>
    @State private var isBuilding = false
    @State private var shareURL: URL?
    @State private var errorText: String?

    init(viewModel: InsightsViewModel, shopName: String, teamMembers: [TenantTeamMember], seesWholeTeam: Bool, canSeeMoney: Bool,
         makeSnapshot: @escaping (Date, Date, InsightsCompare, Date, Date, String, String) -> InsightsSnapshot) {
        self.viewModel = viewModel
        self.shopName = shopName
        self.teamMembers = teamMembers
        self.seesWholeTeam = seesWholeTeam
        self.canSeeMoney = canSeeMoney
        self.makeSnapshot = makeSnapshot
        let b = viewModel.periodBounds
        let c = viewModel.compareBounds ?? (b.from.addingTimeInterval(-b.to.timeIntervalSince(b.from)), b.from)
        _from = State(initialValue: b.from)
        _to = State(initialValue: b.to.addingTimeInterval(-1))
        _compare = State(initialValue: viewModel.compare)
        _cmpStart = State(initialValue: c.from)
        _cmpEnd = State(initialValue: c.to.addingTimeInterval(-1))
        _staff = State(initialValue: viewModel.staffFilter)
        _service = State(initialValue: viewModel.serviceFilter)
        var all = Set(InsightsReportSection.allCases)
        if !canSeeMoney { all.remove(.money) }
        if !seesWholeTeam { all.remove(.team) }
        _sections = State(initialValue: all)
    }

    private var availableSections: [InsightsReportSection] {
        InsightsReportSection.allCases.filter { ($0 != .money || canSeeMoney) && ($0 != .team || seesWholeTeam) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Dates") {
                    DatePicker("From", selection: $from, in: ...Date(), displayedComponents: .date)
                    DatePicker("To", selection: $to, in: ...Date(), displayedComponents: .date)
                    Picker("Compare", selection: $compare) {
                        ForEach(InsightsCompare.allCases) { c in Text(c.label).tag(c) }
                    }
                    if compare == .custom {
                        DatePicker("Compare from", selection: $cmpStart, in: ...Date(), displayedComponents: .date)
                        DatePicker("Compare to", selection: $cmpEnd, in: ...Date(), displayedComponents: .date)
                    }
                }
                Section("Filters") {
                    if seesWholeTeam {
                        Picker("Team member", selection: $staff) {
                            Text("All team").tag("")
                            ForEach(teamMembers, id: \.uid) { m in Text(m.displayName).tag(m.uid) }
                        }
                    }
                    Picker("Service", selection: $service) {
                        Text("All services").tag("")
                        ForEach(viewModel.snapshot.serviceNames, id: \.self) { n in Text(n).tag(n) }
                    }
                }
                Section {
                    ForEach(availableSections) { sec in
                        Toggle(sec.label, isOn: Binding(
                            get: { sections.contains(sec) },
                            set: { on in if on { sections.insert(sec) } else { sections.remove(sec) } }
                        ))
                    }
                } header: {
                    Text("Include")
                } footer: {
                    Text("Makes a PDF you can save to Files, AirDrop, email, or text.")
                }
                if let errorText {
                    Section { Text(errorText).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Build a report")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isBuilding)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isBuilding)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isBuilding {
                        ProgressView()
                    } else {
                        Button("Create PDF") { build() }.fontWeight(.semibold)
                    }
                }
            }
            .sheet(isPresented: Binding(get: { shareURL != nil }, set: { if !$0 { shareURL = nil } })) {
                if let shareURL { InsightsShareSheet(items: [shareURL]) }
            }
        }
    }

    private func build() {
        errorText = nil
        guard !sections.isEmpty else {
            errorText = "Pick at least one section to include."
            return
        }
        isBuilding = true
        let a = min(from, to), z = max(from, to)
        let snap = makeSnapshot(a, z, compare, min(cmpStart, cmpEnd), max(cmpStart, cmpEnd), staff, service)
        let period = InsightsWindow.custom.bounds(customStart: a, customEnd: z)
        let cmp = compare.bounds(for: period, customStart: min(cmpStart, cmpEnd), customEnd: max(cmpStart, cmpEnd))
        var filterParts: [String] = []
        if !staff.isEmpty { filterParts.append(teamMembers.first { $0.uid == staff }?.displayName ?? "Team member") }
        if !service.isEmpty { filterParts.append(service) }
        let info = InsightsReportInfo(
            shopName: shopName, period: period, compare: cmp, compareLabel: compare.shortLabel,
            filters: filterParts.joined(separator: " · "), canSeeMoney: canSeeMoney,
            showTeamColumn: seesWholeTeam && staff.isEmpty
        )
        do {
            shareURL = try InsightsReportPDF.make(snapshot: snap, info: info, sections: sections)
        } catch {
            errorText = "Couldn't make the PDF. Try again."
        }
        isBuilding = false
    }
}

struct InsightsReportInfo {
    let shopName: String
    let period: (from: Date, to: Date)
    let compare: (from: Date, to: Date)?
    let compareLabel: String
    let filters: String
    let canSeeMoney: Bool
    let showTeamColumn: Bool

    static func label(_ b: (from: Date, to: Date)) -> String {
        let last = b.to.addingTimeInterval(-1)
        let f: Date.FormatStyle = .dateTime.month(.abbreviated).day().year()
        return "\(b.from.formatted(f)) – \(last.formatted(f))"
    }
}

// MARK: - PDF

@MainActor
enum InsightsReportPDF {
    static let pageSize = CGSize(width: 612, height: 792)
    static let margin: CGFloat = 40
    static var contentWidth: CGFloat { pageSize.width - margin * 2 }

    /// Lays sections out top to bottom, starting a new page when the next block doesn't fit.
    static func make(snapshot s: InsightsSnapshot, info: InsightsReportInfo, sections: Set<InsightsReportSection>) throws -> URL {
        var blocks: [AnyView] = [AnyView(ReportHeader(info: info))]
        let ordered = InsightsReportSection.allCases.filter { sections.contains($0) }
        for sec in ordered {
            switch sec {
            case .summary: blocks.append(AnyView(ReportSummary(s: s, info: info)))
            case .money: blocks.append(AnyView(ReportMoney(s: s, info: info)))
            case .appointments: blocks.append(AnyView(ReportAppointments(s: s)))
            case .schedule: blocks.append(AnyView(ReportSchedule(s: s, info: info)))
            case .clients: blocks.append(AnyView(ReportClients(s: s)))
            case .team: if !s.team.isEmpty { blocks.append(AnyView(ReportTeam(s: s, info: info))) }
            case .online: blocks.append(AnyView(ReportOnline(s: s)))
            case .ahead: blocks.append(AnyView(ReportTitled(title: "Next 30 days (from today)") {
                InsightsAheadView(s: s, showMoney: info.canSeeMoney, isCharter: false)
            }))
            case .details:
                let rows = s.appointments
                if rows.isEmpty {
                    blocks.append(AnyView(ReportTitled(title: "Appointments list") { ReportHint(text: "No appointments in this range.") }))
                } else {
                    stride(from: 0, to: rows.count, by: 32).forEach { i in
                        let chunk = Array(rows[i..<min(rows.count, i + 32)])
                        blocks.append(AnyView(ReportApptList(rows: chunk, info: info, title: i == 0 ? "Appointments list" : nil)))
                    }
                }
                if info.canSeeMoney && !s.payments.isEmpty {
                    stride(from: 0, to: s.payments.count, by: 40).forEach { i in
                        let chunk = Array(s.payments[i..<min(s.payments.count, i + 40)])
                        let total = i + 40 >= s.payments.count ? s.payments.reduce(0) { $0 + $1.amount } : nil
                        blocks.append(AnyView(ReportPayments(rows: chunk, total: total, title: i == 0 ? "Card payments (after Stripe fees)" : nil)))
                    }
                }
                if info.canSeeMoney && !s.tipsList.isEmpty {
                    stride(from: 0, to: s.tipsList.count, by: 40).forEach { i in
                        let chunk = Array(s.tipsList[i..<min(s.tipsList.count, i + 40)])
                        blocks.append(AnyView(ReportTips(rows: chunk, title: i == 0 ? "Tips" : nil)))
                    }
                }
            }
        }
        blocks.append(AnyView(ReportFooter()))

        let name = "\(info.shopName) Insights \(ShopBlockedTimeStore.ymd.string(from: info.period.from)) to \(ShopBlockedTimeStore.ymd.string(from: info.period.to.addingTimeInterval(-1)))"
            .replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name + ".pdf")
        var box = CGRect(origin: .zero, size: pageSize)
        guard let pdf = CGContext(url as CFURL, mediaBox: &box, nil) else { throw CocoaError(.fileWriteUnknown) }

        let maxHeight = pageSize.height - margin * 2
        var y: CGFloat = 0
        var pageOpen = false
        for block in blocks {
            let renderer = ImageRenderer(content: block.frame(width: contentWidth, alignment: .leading).environment(\.colorScheme, .light))
            renderer.proposedSize = ProposedViewSize(width: contentWidth, height: nil)
            var height: CGFloat = 0
            renderer.render { size, _ in height = size.height }
            if !pageOpen || (y > 0 && y + height > maxHeight) {
                if pageOpen { pdf.endPDFPage() }
                pdf.beginPDFPage(nil)
                pageOpen = true
                y = 0
            }
            renderer.render { size, draw in
                pdf.saveGState()
                // PDF space starts at the bottom left.
                pdf.translateBy(x: margin, y: pageSize.height - margin - y - size.height)
                draw(pdf)
                pdf.restoreGState()
            }
            y += height + 14
        }
        if pageOpen { pdf.endPDFPage() }
        pdf.closePDF()
        return url
    }
}

// MARK: - Report pieces

private let ink = Color(hex: "#2B211B")
private let muted = Color(hex: "#857563")
private let line = Color(hex: "#E8E0D4")
private let good = Color(hex: "#4F7A52")
private let bad = Color(hex: "#A3432F")
private let gold = Color(hex: "#A3752F")

private func usd(_ v: Double, cents: Bool = false) -> String {
    v.formatted(.currency(code: "USD").precision(.fractionLength(cents ? 2 : 0)))
}

private func pctChange(_ p: Int?) -> String? { p.map { "\($0 >= 0 ? "▲" : "▼") \(abs($0))%" } }
private func ptsChange(_ p: Int?) -> String? { p.map { $0 == 0 ? "same" : "\($0 > 0 ? "▲" : "▼") \(abs($0)) pt" } }

private struct ReportChange: View {
    let text: String?
    var lowerIsBetter = false
    var body: some View {
        if let text {
            let up = text.hasPrefix("▲")
            let ok = text == "same" || (lowerIsBetter ? !up : up)
            Text(text).font(.system(size: 9, weight: .semibold)).foregroundStyle(ok ? good : bad)
        }
    }
}

private struct ReportHint: View {
    let text: String
    var ok = false
    var body: some View {
        Text((ok ? "✓ " : "") + text).font(.system(size: 9)).foregroundStyle(ok ? good : muted)
    }
}

private struct ReportTitled<Content: View>: View {
    let title: String?
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(ink)
                Rectangle().fill(line).frame(height: 1)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReportKV: View {
    let label: String
    let value: String
    var change: String? = nil
    var lowerIsBetter = false
    var body: some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.system(size: 10)).foregroundStyle(ink)
                Spacer()
                Text(value).font(.system(size: 10, weight: .semibold)).foregroundStyle(ink)
                ReportChange(text: change, lowerIsBetter: lowerIsBetter)
            }
            Rectangle().fill(line.opacity(0.6)).frame(height: 0.5)
        }
    }
}

private struct ReportHeader: View {
    let info: InsightsReportInfo
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(info.shopName.uppercased()).font(.system(size: 9, weight: .semibold)).tracking(1).foregroundStyle(muted)
            Text("Insights report").font(.system(size: 22, weight: .bold)).foregroundStyle(ink)
            Text([InsightsReportInfo.label(info.period), info.compare.map { "compared with " + InsightsReportInfo.label($0) }, info.filters.isEmpty ? nil : info.filters]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 10)).foregroundStyle(muted)
            Rectangle().fill(ink).frame(height: 1.5).padding(.top, 6)
        }
    }
}

private struct ReportFooter: View {
    var body: some View {
        Text("Made with Get Bookking · \(Date().formatted(.dateTime.month(.abbreviated).day().year()))")
            .font(.system(size: 8)).foregroundStyle(muted)
    }
}

private struct ReportSummary: View {
    let s: InsightsSnapshot
    let info: InsightsReportInfo
    var body: some View {
        ReportTitled(title: "Summary") {
            let tiles: [(String, String, String?, Bool)] = {
                var t: [(String, String, String?, Bool)] = []
                if info.canSeeMoney, let r = s.revenue { t.append((s.revenueIsServiceValue ? "Service value" : "Revenue", usd(r, cents: r < 1000), pctChange(s.revenueChangePct), false)) }
                t.append(("Visits", "\(s.bookings)", pctChange(s.bookingsChangePct), false))
                if info.canSeeMoney { t.append(("Avg ticket", s.avgTicket > 0 ? usd(s.avgTicket) : "—", pctChange(s.avgTicketChangePct), false)) }
                t.append(("No-shows", s.noShowPct.map { "\($0)%" } ?? "—", ptsChange(s.noShowChangePts), true))
                t.append(("Booked time", s.utilization.map { "\($0)%" } ?? "—", ptsChange(s.utilizationChangePts), false))
                t.append(("Returning", s.returningPct.map { "\($0)%" } ?? "—", ptsChange(s.returningChangePts), false))
                return t
            }()
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(Array(tiles.enumerated()), id: \.offset) { _, t in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.0.uppercased()).font(.system(size: 7.5, weight: .semibold)).tracking(0.5).foregroundStyle(muted)
                        Text(t.1).font(.system(size: 15, weight: .bold)).foregroundStyle(ink)
                        ReportChange(text: t.2, lowerIsBetter: t.3)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
                    .padding(7)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(line, lineWidth: 1))
                }
            }
        }
    }
}

private struct ReportChart: View {
    let buckets: [InsightsBucket]
    let compare: [Double]?
    let compareLabel: String
    let color: Color
    let format: (Double) -> String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            InsightsBarChart(buckets: buckets, compare: compare, compareLabel: compareLabel, color: color, format: format)
                .frame(height: compare == nil ? 150 : 172)
        }
    }
}

private struct ReportMoney: View {
    let s: InsightsSnapshot
    let info: InsightsReportInfo
    var body: some View {
        ReportTitled(title: "Money") {
            if !s.revenueBuckets.isEmpty {
                Text("\(s.revenueIsServiceValue ? "Service value" : "Revenue") by \(s.grain.rawValue)").font(.system(size: 10, weight: .semibold)).foregroundStyle(muted)
                let top = max(s.revenueBuckets.map(\.value).max() ?? 0, s.revenueCompare?.max() ?? 0)
                ReportChart(buckets: s.revenueBuckets, compare: s.revenueCompare, compareLabel: info.compareLabel, color: gold) { usd($0, cents: top < 20) }
            }
            if s.revenueIsServiceValue {
                ReportHint(text: "Card payments can't be split by team member or service, so this shows the price of those visits.")
            }
            ReportKV(label: "Tips", value: usd(s.tipsTotal, cents: true) + (s.tipsCount > 0 ? " · avg \(s.tipsAvgPct)% · \(s.tipsCount) tips" : ""), change: pctChange(s.tipsChangePct))
            ReportKV(label: "Booked ahead · next 7 days (from today)", value: "\(usd(s.upcoming7Value)) · \(s.upcoming7Count) appts · \(usd(s.upcoming7Deposits)) deposits paid")
            ReportKV(label: "Booked ahead · next 30 days (from today)", value: "\(usd(s.upcoming30Value)) · \(s.upcoming30Count) appts · \(usd(s.upcoming30Deposits)) deposits paid")
        }
    }
}

private struct ReportAppointments: View {
    let s: InsightsSnapshot
    var body: some View {
        let total = s.completed + s.cancelled + s.noShows
        let p = { (n: Int) in total > 0 ? "\(Int((Double(n) / Double(total) * 100).rounded()))%" : "—" }
        ReportTitled(title: "Appointments") {
            ReportKV(label: "Completed", value: "\(s.completed) · \(p(s.completed))")
            ReportKV(label: "Canceled", value: "\(s.cancelled) · \(p(s.cancelled))", change: ptsChange(s.cancelChangePts), lowerIsBetter: true)
            ReportKV(label: "No-show", value: "\(s.noShows) · \(p(s.noShows))", change: ptsChange(s.noShowChangePts), lowerIsBetter: true)
            ReportKV(label: "Pre-booked (next visit booked before leaving)", value: s.prebookPct.map { "\($0)%" } ?? "—", change: ptsChange(s.prebookChangePts))
            ReportHint(text: "Healthy: no-shows under \(InsightsHealthy.noShow)%", ok: (s.noShowPct ?? 100) < InsightsHealthy.noShow)
            ReportHint(text: "Healthy: pre-booked \(InsightsHealthy.prebook)%+", ok: (s.prebookPct ?? 0) >= InsightsHealthy.prebook)
        }
    }
}

private struct ReportSchedule: View {
    let s: InsightsSnapshot
    let info: InsightsReportInfo
    var body: some View {
        ReportTitled(title: "Schedule") {
            ReportKV(label: "Booked vs open", value: s.utilization.map { "\($0)% · \(s.bookedHours) of \(s.openHours) open hours" } ?? "Set weekly hours to see this",
                     change: ptsChange(s.utilizationChangePts))
            ReportKV(label: "Busiest times", value: s.busiest.isEmpty ? "—" : s.busiest.map { "\($0.label) (\($0.count))" }.joined(separator: ", "))
            if let u = s.utilization { ReportHint(text: "Healthy: \(InsightsHealthy.booked)%+ booked", ok: u >= InsightsHealthy.booked) }
            Text("Visits by \(s.grain.rawValue)").font(.system(size: 10, weight: .semibold)).foregroundStyle(muted).padding(.top, 4)
            ReportChart(buckets: s.bookingBuckets, compare: s.bookingCompare, compareLabel: info.compareLabel, color: Color(hex: "#C9B8A0")) { "\(Int($0))" }
        }
    }
}

private struct ReportClients: View {
    let s: InsightsSnapshot
    var body: some View {
        ReportTitled(title: "Clients") {
            ReportKV(label: "Returning", value: "\(s.returningPct.map { "\($0)%" } ?? "—") · \(s.newClients) new \(s.newClients == 1 ? "client" : "clients")", change: ptsChange(s.returningChangePts))
            ReportKV(label: "Rebooked within 30 / 60 / 90 days", value: [30, 60, 90].map { n in (s.rebook[n] ?? nil).map { "\($0)%" } ?? "—" }.joined(separator: " / "))
            if let r = s.returningPct { ReportHint(text: "Healthy: \(InsightsHealthy.returning)%+ returning", ok: r >= InsightsHealthy.returning) }
            if !s.topServices.isEmpty {
                Text("Top services").font(.system(size: 10, weight: .semibold)).foregroundStyle(muted).padding(.top, 4)
                ForEach(Array(s.topServices.enumerated()), id: \.offset) { _, r in ReportKV(label: r.label, value: "\(r.count)") }
            }
            Text("Clients to win back (60+ days, from today)").font(.system(size: 10, weight: .semibold)).foregroundStyle(muted).padding(.top, 4)
            if s.winBack.isEmpty {
                ReportHint(text: "Everyone's been in within the last 60 days.")
            } else {
                ForEach(s.winBack) { w in ReportKV(label: w.name + (w.phone.isEmpty ? "" : " · " + PhoneFormatting.displayUS(w.phone)), value: "\(w.daysAway) days") }
                if s.winBackMore > 0 { ReportHint(text: "+ \(s.winBackMore) more") }
            }
        }
    }
}

private struct ReportTeam: View {
    let s: InsightsSnapshot
    let info: InsightsReportInfo
    var body: some View {
        ReportTitled(title: "Team members") {
            ForEach(s.team) { r in
                ReportKV(
                    label: r.name,
                    value: [info.canSeeMoney ? usd(Double(r.valueCents) / 100) : nil, "\(r.visits) visits",
                            r.busyPct.map { "\($0)% booked" }, r.prebookPct.map { "\($0)% pre-booked" }].compactMap { $0 }.joined(separator: " · ")
                )
            }
        }
    }
}

private struct ReportOnline: View {
    let s: InsightsSnapshot
    var body: some View {
        let pctOnline = s.apptTotal > 0 ? Int((Double(s.onlineCount) / Double(s.apptTotal) * 100).rounded()) : 0
        ReportTitled(title: "How bookings came in") {
            ReportKV(label: "Clients booked themselves on your site", value: "\(s.onlineCount) · \(pctOnline)%", change: pctChange(s.onlineChangePct))
            ReportKV(label: "You or your team added them", value: "\(s.apptTotal - s.onlineCount) · \(s.apptTotal > 0 ? 100 - pctOnline : 0)%")
            ReportKV(label: "New clients from online booking", value: "\(s.onlineNewClients)")
            ReportKV(label: "Online no-shows · cancels", value: "\(s.onlineNoShows) · \(s.onlineCancels)")
        }
    }
}

private struct ReportTableRow: View {
    let cells: [String]
    let widths: [CGFloat?]
    var header = false
    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 6) {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, c in
                    let right = i > 0 && i == cells.count - 1 || (widths[i] ?? 0) < 0
                    Text(header ? c.uppercased() : c)
                        .font(.system(size: header ? 7.5 : 8.5, weight: header ? .semibold : .regular))
                        .foregroundStyle(header ? muted : ink)
                        .lineLimit(1)
                        .frame(width: widths[i].map { abs($0) }, alignment: right ? .trailing : .leading)
                        .frame(maxWidth: widths[i] == nil ? .infinity : nil, alignment: .leading)
                }
            }
            Rectangle().fill(line.opacity(header ? 1 : 0.5)).frame(height: 0.5)
        }
    }
}

private struct ReportApptList: View {
    let rows: [InsightsApptRow]
    let info: InsightsReportInfo
    let title: String?
    var body: some View {
        ReportTitled(title: title) {
            let cols: [String] = ["Date"] + ["Client", "Service"] + (info.showTeamColumn ? ["Team member"] : []) + ["Status"] + (info.canSeeMoney ? ["Price", "Deposit"] : [])
            let widths: [CGFloat?] = [92, nil, nil] + (info.showTeamColumn ? [nil] : []) + [58] + (info.canSeeMoney ? [-52, -52] : [])
            ReportTableRow(cells: cols, widths: widths, header: true)
            ForEach(rows) { r in
                let cells: [String] = [r.start.formatted(.dateTime.month(.abbreviated).day().hour().minute()), r.client, r.service]
                    + (info.showTeamColumn ? [r.staff] : []) + [r.status]
                    + (info.canSeeMoney ? [usd(Double(r.priceCents) / 100, cents: true), usd(Double(r.paidCents) / 100, cents: true)] : [])
                ReportTableRow(cells: cells, widths: widths)
            }
        }
    }
}

private struct ReportPayments: View {
    let rows: [(date: Date, amount: Double)]
    let total: Double?
    let title: String?
    var body: some View {
        ReportTitled(title: title) {
            ReportTableRow(cells: ["Date", "Amount"], widths: [nil, -80], header: true)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                ReportTableRow(cells: [r.date.formatted(.dateTime.month(.abbreviated).day().year()), usd(r.amount, cents: true)], widths: [nil, -80])
            }
            if let total {
                HStack { Text("Total").font(.system(size: 9, weight: .bold)); Spacer(); Text(usd(total, cents: true)).font(.system(size: 9, weight: .bold)) }
                    .foregroundStyle(ink)
            }
        }
    }
}

private struct ReportTips: View {
    let rows: [InsightsTipEntry]
    let title: String?
    var body: some View {
        ReportTitled(title: title) {
            ReportTableRow(cells: ["Date", "Tip", "Service"], widths: [nil, -70, -70], header: true)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, t in
                ReportTableRow(cells: [t.date.formatted(.dateTime.month(.abbreviated).day().year()), usd(Double(t.tipCents) / 100, cents: true), usd(Double(t.serviceCents) / 100, cents: true)],
                               widths: [nil, -70, -70])
            }
        }
    }
}

/// System share sheet (Save to Files, AirDrop, Mail, Messages).
struct InsightsShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
