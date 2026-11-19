//
//  InsightsView.swift
//
//  Analytics dashboard: period menu, revenue chart, bookings, services, clients.
//

import SwiftUI
import Charts

struct InsightsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = InsightsViewModel()
    var drawerState: DrawerState
    let sectionTitle: String
    /// Booked ahead: 0 = deposits + services, 1 = deposits paid, 2 = services still due.
    @State private var aheadMode = 0
    @State private var showReport = false

    // MARK: Redesign helpers

    private var access: EffectiveTeamAccess { authViewModel.teamAccess }

    /// Revenue, tips, and team $ are for the owner and managers allowed to see earnings.
    private var canSeeMoney: Bool {
        access.isOwner || (access.accessRole == .manager && access.permissions.viewEarningsReports)
    }

    private var teamMode: Bool { sessionStore.teamMembers.count > 1 }
    private var seesWholeTeam: Bool { teamMode && (access.isOwner || access.canViewAllBookings) }

    private func recompute() {
        var names: [String: String] = [:]
        for m in sessionStore.teamMembers { names[m.uid] = m.displayName }
        viewModel.recomputeSnapshot(
            tenant: sessionStore.tenant,
            staffCount: seesWholeTeam ? sessionStore.teamMembers.count : 1,
            memberNames: names,
            teamMode: seesWholeTeam,
            canSeeMoney: canSeeMoney
        )
    }

    private func usd(_ v: Double, compact: Bool = true) -> String {
        v.formatted(.currency(code: "USD").precision(.fractionLength(compact ? 0 : 2)))
    }

    /// Axis labels: cents for small amounts so they never read "$0 $0 $1".
    private func axisUsd(_ v: Double) -> String {
        let top = max(viewModel.snapshot.revenueBuckets.map(\.value).max() ?? 0, viewModel.snapshot.revenueCompare?.max() ?? 0)
        return usd(v, compact: top >= 20)
    }

    private func filterChip(_ text: String, icon: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.caption2)
            Text(text).font(.caption.weight(.medium)).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .foregroundStyle(AppDesign.textPrimary)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(Capsule().fill(AppDesign.cardBackground))
        .overlay(Capsule().stroke(AppDesign.chipBorder, lineWidth: 1))
    }

    @ViewBuilder
    private var windowPicker: some View {
        HStack(spacing: 0) {
            ForEach(InsightsWindow.allCases) { w in
                let on = viewModel.window == w
                Button {
                    withAnimation(.snappy) {
                        viewModel.grain = nil
                        viewModel.window = w
                    }
                } label: {
                    Text(w.label)
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(on ? AppDesign.brandCream : AppDesign.textPrimary)
                        .background(Capsule().fill(on ? AppDesign.brandDark : Color.clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(Capsule().fill(AppDesign.chipBorder.opacity(0.45)))
        .padding(.horizontal, 16)
        if viewModel.window == .custom {
            HStack(spacing: 10) {
                DatePicker("From", selection: $viewModel.customRangeStart, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                Text("to").font(.subheadline).foregroundStyle(AppDesign.textSecondary)
                DatePicker("To", selection: $viewModel.customRangeEnd, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                Spacer()
            }
            .padding(.horizontal, 16)
        }
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    Picker("Compare", selection: $viewModel.compare) {
                        ForEach(InsightsCompare.allCases) { c in Text(c.label).tag(c) }
                    }
                } label: {
                    filterChip(viewModel.compare.label, icon: "arrow.left.arrow.right")
                }
                if seesWholeTeam {
                    Menu {
                        Picker("Team member", selection: $viewModel.staffFilter) {
                            Text("All team").tag("")
                            ForEach(sessionStore.teamMembers, id: \.uid) { m in Text(m.displayName).tag(m.uid) }
                        }
                    } label: {
                        let name = sessionStore.teamMembers.first { $0.uid == viewModel.staffFilter }?.displayName
                        filterChip(name ?? "All team", icon: "person")
                    }
                }
                Menu {
                    Picker("Service", selection: $viewModel.serviceFilter) {
                        Text("All services").tag("")
                        ForEach(viewModel.snapshot.serviceNames, id: \.self) { n in Text(n).tag(n) }
                    }
                } label: {
                    filterChip(viewModel.serviceFilter.isEmpty ? "All services" : viewModel.serviceFilter, icon: "scissors")
                }
            }
            .padding(.horizontal, 16)
        }
        if viewModel.compare == .custom {
            HStack(spacing: 10) {
                Text("Compare with").font(.caption).foregroundStyle(AppDesign.textSecondary)
                DatePicker("Compare from", selection: $viewModel.compareStart, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                Text("to").font(.caption).foregroundStyle(AppDesign.textSecondary)
                DatePicker("Compare to", selection: $viewModel.compareEnd, in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
        HStack(alignment: .center) {
            Text(viewModel.periodLine)
                .font(.caption2)
                .foregroundStyle(AppDesign.textSecondary)
            Spacer(minLength: 8)
            Button {
                showReport = true
            } label: {
                Label("Build report", systemImage: "doc.text")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .foregroundStyle(AppDesign.brandCream)
                    .background(Capsule().fill(AppDesign.brandDark))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isLoading)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
    }

    private var shopName: String {
        let t = sessionStore.tenant ?? [:]
        let n = ((t["businessName"] as? String) ?? (t["displayName"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Your shop" : n
    }

    private var reportSheet: some View {
        var names: [String: String] = [:]
        for m in sessionStore.teamMembers { names[m.uid] = m.displayName }
        let tenant = sessionStore.tenant
        let staffCount = seesWholeTeam ? sessionStore.teamMembers.count : 1
        let team = seesWholeTeam
        let money = canSeeMoney
        let vm = viewModel
        return InsightsReportSheet(
            viewModel: viewModel, shopName: shopName, teamMembers: sessionStore.teamMembers,
            seesWholeTeam: seesWholeTeam, canSeeMoney: canSeeMoney
        ) { from, to, compare, cmpStart, cmpEnd, staff, service in
            vm.reportSnapshot(
                from: from, to: to, compare: compare, compareStart: cmpStart, compareEnd: cmpEnd,
                staffFilter: staff, serviceFilter: service,
                tenant: tenant, staffCount: staff.isEmpty ? staffCount : 1, memberNames: names, teamMode: team, canSeeMoney: money
            )
        }
    }

    private var grainPicker: some View {
        Picker("Group by", selection: Binding(
            get: { viewModel.snapshot.grain },
            set: { viewModel.grain = $0 }
        )) {
            ForEach(InsightsGrain.allCases) { g in Text(g.label).tag(g) }
        }
        .pickerStyle(.segmented)
        .controlSize(.mini)
        .frame(maxWidth: 200)
    }

    private struct Tile: Identifiable {
        let id: String; let label: String; let value: String
        var change: Int? = nil; var points: Int? = nil; var lowerIsBetter = false
        var sub: String? = nil; let anchor: String
    }

    private var tiles: [Tile] {
        let s = viewModel.snapshot
        var t: [Tile] = []
        if canSeeMoney {
            t.append(Tile(id: "rev", label: s.revenueIsServiceValue ? "Service value" : "Revenue", value: s.revenue.map { usd($0) } ?? "—", change: s.revenueChangePct, anchor: "money"))
        }
        t.append(Tile(id: "book", label: "Visits", value: "\(s.bookings)", change: s.bookingsChangePct, anchor: "schedule"))
        if canSeeMoney {
            t.append(Tile(id: "avg", label: "Avg ticket", value: s.avgTicket > 0 ? usd(s.avgTicket) : "—", change: s.avgTicketChangePct, anchor: "money"))
        }
        t.append(Tile(id: "noshow", label: "No-shows", value: s.noShowPct.map { "\($0)%" } ?? "—", points: s.noShowChangePts, lowerIsBetter: true, anchor: "appointments"))
        t.append(Tile(id: "util", label: "Booked time", value: s.utilization.map { "\($0)%" } ?? "—", points: s.utilizationChangePts, anchor: "schedule"))
        t.append(Tile(id: "ret", label: "Returning", value: s.returningPct.map { "\($0)%" } ?? "—", points: s.returningChangePts, anchor: "clients"))
        t.append(Tile(id: "up", label: "Upcoming · 7 days", value: canSeeMoney ? usd(s.upcoming7Value) : "\(s.upcoming7Count)",
                      sub: "\(s.upcoming7Count) \(s.upcoming7Count == 1 ? "appt" : "appts") · from today", anchor: canSeeMoney ? "money" : "schedule"))
        return t
    }

    private func row(_ label: String, _ value: String, dot: Color? = nil, points: Int? = nil, lowerIsBetter: Bool = false, change: Int? = nil) -> some View {
        HStack(spacing: 8) {
            if let dot { Circle().fill(dot).frame(width: 8, height: 8) }
            Text(label).font(.subheadline)
            Spacer()
            Text(value).font(.subheadline.weight(.semibold))
            InsightsPointsLabel(pts: points, lowerIsBetter: lowerIsBetter)
            InsightsChangeLabel(pct: change)
        }
    }

    private let doneColor = AppDesign.accentGreen
    private let cancelColor = Color(hex: "#C9B8A0")
    private let noShowColor = Color(hex: "#A3432F")

    @ViewBuilder
    private var insightsContent: some View {
        let s = viewModel.snapshot
        let cmpLabel = viewModel.compare.shortLabel
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 12) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(tiles) { t in
                            Button {
                                withAnimation { proxy.scrollTo(t.anchor, anchor: .top) }
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(t.label).font(.caption).foregroundStyle(AppDesign.textSecondary)
                                    Text(t.value).font(.title3.weight(.bold)).foregroundStyle(AppDesign.textPrimary)
                                    if let sub = t.sub {
                                        Text(sub).font(.caption2).foregroundStyle(AppDesign.textSecondary)
                                    } else if t.points != nil {
                                        InsightsPointsLabel(pts: t.points, lowerIsBetter: t.lowerIsBetter)
                                    } else {
                                        InsightsChangeLabel(pct: t.change, lowerIsBetter: t.lowerIsBetter)
                                    }
                                }
                                .frame(minWidth: 104, alignment: .leading)
                                .padding(12)
                                .appCard()
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                }

                if canSeeMoney {
                    InsightsSectionLabel(text: "Money").id("money")
                    InsightsCard(title: s.revenueIsServiceValue ? "Service value" : "Revenue") {
                        if viewModel.stripeConnected || s.revenueIsServiceValue {
                            grainPicker
                            InsightsBarChart(buckets: s.revenueBuckets, compare: s.revenueCompare, compareLabel: cmpLabel, color: AppDesign.brandWarm) { axisUsd($0) }
                            if s.revenueIsServiceValue {
                                Text("Card payments can't be split by team member or service, so this shows the price of those visits.")
                                    .font(.caption2).foregroundStyle(AppDesign.textSecondary)
                            }
                        } else {
                            Text("Revenue shows here once card payments are set up in Payments.")
                                .font(.caption).foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                    .padding(.horizontal, 16)
                    HStack(alignment: .top, spacing: 10) {
                        InsightsCard(title: "Booked ahead") {
                            Menu {
                                Picker("Show", selection: $aheadMode) {
                                    Text("Deposits + services").tag(0)
                                    Text("Deposits only").tag(1)
                                    Text("Services only").tag(2)
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Text(aheadMode == 1 ? "Deposits only" : aheadMode == 2 ? "Services only" : "Deposits + services")
                                        .font(.caption.weight(.semibold))
                                        .lineLimit(1)
                                        .minimumScaleFactor(0.85)
                                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                                }
                                .foregroundStyle(AppDesign.textPrimary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(AppDesign.chipBorder.opacity(0.45)))
                            }
                            let v7 = aheadMode == 1 ? s.upcoming7Deposits : aheadMode == 2 ? max(0, s.upcoming7Value - s.upcoming7Deposits) : s.upcoming7Value
                            let v30 = aheadMode == 1 ? s.upcoming30Deposits : aheadMode == 2 ? max(0, s.upcoming30Value - s.upcoming30Deposits) : s.upcoming30Value
                            Text(usd(v7)).font(.title3.weight(.bold))
                            Text("Next 7 days · \(s.upcoming7Count) \(s.upcoming7Count == 1 ? "appt" : "appts")").font(.caption).foregroundStyle(AppDesign.textSecondary)
                            Text("Next 30 days · \(usd(v30))").font(.caption).foregroundStyle(AppDesign.textSecondary)
                            Text(aheadMode == 1 ? "Deposits already paid" : aheadMode == 2 ? "Still due at appointments" : "Deposits + services")
                                .font(.caption2).foregroundStyle(AppDesign.textSecondary)
                            Text("From today").font(.caption2).foregroundStyle(AppDesign.textSecondary)
                        }
                        InsightsCard(title: "Tips") {
                            HStack(spacing: 6) {
                                Text(usd(s.tipsTotal)).font(.title3.weight(.bold))
                                InsightsChangeLabel(pct: s.tipsChangePct)
                            }
                            Text(s.tipsCount > 0 ? "Avg \(s.tipsAvgPct)% · \(s.tipsCount) \(s.tipsCount == 1 ? "tip" : "tips")" : "Shows as clients tip")
                                .font(.caption).foregroundStyle(AppDesign.textSecondary)
                            if seesWholeTeam, viewModel.staffFilter.isEmpty, !s.tipsByStaff.isEmpty {
                                Text(s.tipsByStaff.map { "\($0.name) \(usd(Double($0.cents) / 100))" }.joined(separator: " · "))
                                    .font(.caption2).foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }

                InsightsSectionLabel(text: "Appointments").id("appointments")
                InsightsCard(title: "Completed, canceled, no-show") {
                    let total = s.completed + s.cancelled + s.noShows
                    if total == 0 {
                        Text("No past appointments in this range.").font(.caption).foregroundStyle(AppDesign.textSecondary)
                    } else {
                        let p = { (n: Int) in Int((Double(n) / Double(total) * 100).rounded()) }
                        InsightsStackBar(parts: [(Double(s.completed), doneColor), (Double(s.cancelled), cancelColor), (Double(s.noShows), noShowColor)])
                        row("Completed", "\(s.completed) · \(p(s.completed))%", dot: doneColor)
                        Divider()
                        row("Canceled", "\(s.cancelled) · \(p(s.cancelled))%", dot: cancelColor, points: s.cancelChangePts, lowerIsBetter: true)
                        Divider()
                        row("No-show", "\(s.noShows) · \(p(s.noShows))%", dot: noShowColor, points: s.noShowChangePts, lowerIsBetter: true)
                        InsightsHealthyHint(text: "Healthy: no-shows under \(InsightsHealthy.noShow)%", ok: (s.noShowPct ?? 100) < InsightsHealthy.noShow)
                        Text("Mark a no-show from the appointment's details.").font(.caption2).foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(.horizontal, 16)
                InsightsCard(title: "Pre-booked") {
                    if let pb = s.prebookPct {
                        HStack(spacing: 6) {
                            Text("\(pb)%").font(.title3.weight(.bold))
                            InsightsPointsLabel(pts: s.prebookChangePts)
                        }
                        Text("Booked their next visit before leaving").font(.caption).foregroundStyle(AppDesign.textSecondary)
                        InsightsHealthyHint(text: "Healthy is \(InsightsHealthy.prebook)%+", ok: pb >= InsightsHealthy.prebook)
                    } else {
                        Text("No past visits in this range yet.").font(.caption).foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(.horizontal, 16)

                InsightsSectionLabel(text: "Schedule").id("schedule")
                InsightsCard(title: "Booked vs open") {
                    if let u = s.utilization {
                        HStack(spacing: 16) {
                            InsightsGauge(pct: u)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(s.bookedHours) of \(s.openHours) open hours").font(.subheadline)
                                InsightsPointsLabel(pts: s.utilizationChangePts)
                                InsightsHealthyHint(text: "Healthy is \(InsightsHealthy.booked)%+", ok: u >= InsightsHealthy.booked)
                            }
                        }
                        .padding(.bottom, 6)
                    } else {
                        Text("Set your weekly hours in Scheduling & hours to see this.")
                            .font(.caption).foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(.horizontal, 16)
                InsightsCard(title: "Busiest times") {
                    if s.bookings > 0 {
                        InsightsHeatmap(heat: s.heat, hours: s.heatHours)
                    } else {
                        Text("Nothing in this range yet.").font(.caption).foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(.horizontal, 16)
                InsightsCard(title: "Visits") {
                    grainPicker
                    InsightsBarChart(buckets: s.bookingBuckets, compare: s.bookingCompare, compareLabel: cmpLabel, color: Color(hex: "#C9B8A0")) { "\(Int($0))" }
                }
                .padding(.horizontal, 16)

                InsightsSectionLabel(text: "Clients").id("clients")
                InsightsCard(title: "Coming back") {
                    let ret = s.returningPct ?? 0
                    InsightsStackBar(parts: [(Double(ret), AppDesign.brandWarm), (Double(100 - ret), AppDesign.brandCream)])
                    Text("\(ret)% returning · \(s.newClients) new \(s.newClients == 1 ? "client" : "clients")")
                        .font(.caption).foregroundStyle(AppDesign.textSecondary)
                    if let r = s.returningPct {
                        InsightsHealthyHint(text: "Healthy is \(InsightsHealthy.returning)%+ returning", ok: r >= InsightsHealthy.returning)
                    }
                    ForEach([30, 60, 90], id: \.self) { n in
                        row("Rebooked within \(n) days", (s.rebook[n] ?? nil).map { "\($0)%" } ?? "—")
                        if n != 90 { Divider() }
                    }
                }
                .padding(.horizontal, 16)
                InsightsCard(title: "Clients to win back", trailing: "60+ days · from today") {
                    if s.winBack.isEmpty {
                        Text("Everyone's been in within the last 60 days.").font(.caption).foregroundStyle(AppDesign.textSecondary)
                    } else {
                        ForEach(s.winBack) { w in
                            HStack {
                                Text(w.name).font(.subheadline)
                                Text("· \(w.daysAway) days").font(.caption).foregroundStyle(AppDesign.textSecondary)
                                Spacer()
                                if !w.phone.isEmpty {
                                    // Opens the client's conversation in the app's Messages (shop's texting number).
                                    Button("Text ›") {
                                        drawerState.openExistingMessagesThread(phone: w.phone, clientName: w.name, bookingRequestId: nil)
                                    }
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AppDesign.brandWarm)
                                    .buttonStyle(.plain)
                                }
                            }
                            Divider()
                        }
                        if s.winBackMore > 0 {
                            Text("+ \(s.winBackMore) more").font(.caption).foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                }
                .padding(.horizontal, 16)
                if !s.topServices.isEmpty {
                    InsightsCard(title: "Top services") {
                        ForEach(Array(s.topServices.enumerated()), id: \.offset) { i, item in
                            row(item.label, "\(item.count)")
                            if i < s.topServices.count - 1 { Divider() }
                        }
                    }
                    .padding(.horizontal, 16)
                }
                if seesWholeTeam, viewModel.staffFilter.isEmpty, !s.team.isEmpty {
                    InsightsSectionLabel(text: "Team")
                    InsightsCard(title: "Team members") {
                        ForEach(Array(s.team.enumerated()), id: \.offset) { i, r in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(r.name).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    if canSeeMoney { Text(usd(Double(r.valueCents) / 100)).font(.subheadline.weight(.semibold)) }
                                }
                                Text("\(r.visits) \(r.visits == 1 ? "visit" : "visits") · \(r.busyPct.map { "\($0)% booked" } ?? "—") · \(r.prebookPct.map { "\($0)% pre-booked" } ?? "pre-booked —")")
                                    .font(.caption).foregroundStyle(AppDesign.textSecondary)
                            }
                            if i < s.team.count - 1 { Divider() }
                        }
                    }
                    .padding(.horizontal, 16)
                }

                InsightsSectionLabel(text: "Online bookings")
                InsightsCard(title: "From your website") {
                    if s.apptTotal == 0 {
                        Text("No appointments in this range yet.").font(.caption).foregroundStyle(AppDesign.textSecondary)
                    } else {
                        let pctOnline = Int((Double(s.onlineCount) / Double(s.apptTotal) * 100).rounded())
                        InsightsStackBar(parts: [(Double(s.onlineCount), AppDesign.brandWarm), (Double(s.apptTotal - s.onlineCount), cancelColor)])
                        row("From your website", "\(s.onlineCount) · \(pctOnline)%", dot: AppDesign.brandWarm, change: s.onlineChangePct)
                        Divider()
                        row("Booked by you", "\(s.apptTotal - s.onlineCount) · \(100 - pctOnline)%", dot: cancelColor)
                        Divider()
                        row("New clients who booked online", "\(s.onlineNewClients)")
                        Divider()
                        row("Online no-shows · cancels", "\(s.onlineNoShows) · \(s.onlineCancels)")
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    AppScreenTitle(title: sectionTitle)
                    windowPicker

                    if let err = viewModel.loadError {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal, 16)
                    }

                    if viewModel.isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(32)
                    } else {
                        insightsContent
                    }
                }
                .padding(.bottom, 24)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            await viewModel.refresh(
                                isDemoMode: authViewModel.isDemoMode,
                                sessionStore: sessionStore
                            )
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .refreshable {
                await viewModel.refresh(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            .onChange(of: viewModel.selectedRange) { _, _ in
                viewModel.recomputeForSelectedRange()
            }
            .onChange(of: viewModel.window) { _, _ in recompute() }
            .onChange(of: viewModel.compare) { _, _ in recompute() }
            .onChange(of: viewModel.compareStart) { _, _ in if viewModel.compare == .custom { recompute() } }
            .onChange(of: viewModel.compareEnd) { _, _ in if viewModel.compare == .custom { recompute() } }
            .onChange(of: viewModel.grain) { _, _ in recompute() }
            .onChange(of: viewModel.staffFilter) { _, _ in recompute() }
            .onChange(of: viewModel.serviceFilter) { _, _ in recompute() }
            .onChange(of: viewModel.customRangeStart) { _, _ in if viewModel.window == .custom { recompute() } }
            .onChange(of: viewModel.customRangeEnd) { _, _ in if viewModel.window == .custom { recompute() } }
            .onChange(of: viewModel.isLoading) { _, loading in if !loading { recompute() } }
            .onChange(of: viewModel.customRangeStart) { _, _ in
                guard viewModel.selectedRange == .custom else { return }
                viewModel.recomputeForSelectedRange()
            }
            .onChange(of: viewModel.customRangeEnd) { _, _ in
                guard viewModel.selectedRange == .custom else { return }
                viewModel.recomputeForSelectedRange()
            }
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $showReport) { reportSheet }
        .task {
            await viewModel.loadData(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
    }

    // MARK: - Range picker

    private var insightsRangePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Menu {
                ForEach(InsightsTimeRange.allCases) { range in
                    Button {
                        viewModel.selectedRange = range
                    } label: {
                        if viewModel.selectedRange == range {
                            Label(range.menuLabel, systemImage: "checkmark")
                        } else {
                            Text(range.menuLabel)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(viewModel.selectedRange.menuLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppDesign.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AppDesign.cardBackground)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(AppDesign.chipBorder, lineWidth: 1)
                )
            }

            if viewModel.selectedRange == .custom {
                HStack(spacing: 10) {
                    customDateField(date: $viewModel.customRangeStart)
                    Text("to")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                    customDateField(date: $viewModel.customRangeEnd)
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private func customDateField(date: Binding<Date>) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "calendar")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            DatePicker(
                "",
                selection: date,
                displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(AppDesign.chipBorder, lineWidth: 1)
        )
    }

    // MARK: - Bookings breakdown

    private enum BookingsDisplayStyle: String, CaseIterable, Identifiable {
        case list
        case donut

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .list: return "List"
            case .donut: return "Donut chart"
            }
        }
    }

    @State private var bookingsDisplayStyle: BookingsDisplayStyle = .donut

    private struct BookingSlice: Identifiable {
        let id: String
        let label: String
        let count: Int
        let percent: Int
        let color: Color
    }

    private var bookingSlices: [BookingSlice] {
        let b = viewModel.bookingBreakdown
        let total = max(b.total, 1)
        var slices: [BookingSlice] = [
            BookingSlice(id: "new", label: "New", count: b.newCount, percent: b.percent(b.newCount, total: total), color: AppDesign.brandWarm),
            BookingSlice(id: "confirmed", label: "Confirmed", count: b.confirmed, percent: b.percent(b.confirmed, total: total), color: AppDesign.brandDark),
            BookingSlice(id: "cancelled", label: "Cancelled", count: b.cancelledOrDeclined, percent: b.percent(b.cancelledOrDeclined, total: total), color: AppDesign.statusCancelled),
        ]
        if b.other > 0 {
            slices.append(
                BookingSlice(id: "other", label: "Other", count: b.other, percent: b.percent(b.other, total: total), color: AppDesign.textSecondary)
            )
        }
        return slices
    }

    private var bookingsBreakdownCard: some View {
        InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "doc.text.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                Text("Bookings")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer(minLength: 8)
                bookingsStyleMenu
            }

            if viewModel.bookingBreakdown.total == 0 {
                Text("No bookings in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            } else {
                switch bookingsDisplayStyle {
                case .list:
                    bookingsListView
                case .donut:
                    bookingsDonutView
                }
            }
        }
    }

    private var bookingsStyleMenu: some View {
        Menu {
            ForEach(BookingsDisplayStyle.allCases) { style in
                Button {
                    bookingsDisplayStyle = style
                } label: {
                    if bookingsDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(bookingsDisplayStyle.menuLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppDesign.searchBackground)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(AppDesign.chipBorder.opacity(0.7), lineWidth: 1)
            )
        }
    }

    private var bookingsListView: some View {
        VStack(spacing: 0) {
            ForEach(Array(bookingSlices.enumerated()), id: \.element.id) { index, slice in
                if index > 0 { InsightDivider() }
                breakdownRow(dot: slice.color, label: slice.label, count: slice.count, percent: slice.percent)
            }
        }
    }

    private var bookingsDonutView: some View {
        HStack(alignment: .center, spacing: 20) {
            Chart(bookingSlices.filter { $0.count > 0 }) { slice in
                SectorMark(
                    angle: .value("Count", slice.count),
                    innerRadius: .ratio(0.58),
                    angularInset: 1.5
                )
                .foregroundStyle(slice.color)
                .cornerRadius(3)
            }
            .frame(width: 132, height: 132)

            VStack(alignment: .leading, spacing: 10) {
                ForEach(bookingSlices) { slice in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(slice.color)
                            .frame(width: 8, height: 8)
                        Text(slice.label)
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textPrimary)
                        Spacer(minLength: 4)
                        Text("\(slice.percent)%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 4)
    }

    private func breakdownRow(dot: Color, label: String, count: Int, percent: Int) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dot)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textPrimary)
            Spacer()
            Text("\(count)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
            Text("\(percent)%")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .frame(width: 36, alignment: .trailing)
        }
        .padding(.vertical, 12)
    }

    // MARK: - Top services

    private enum TopServicesDisplayStyle: String, CaseIterable, Identifiable {
        case bars
        case rankedList

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .bars: return "Bars"
            case .rankedList: return "Ranked list"
            }
        }
    }

    @State private var topServicesDisplayStyle: TopServicesDisplayStyle = .bars

    private var topServicesCard: some View {
        let maxCount = viewModel.topServiceLabels.map(\.count).max() ?? 1
        return InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "chart.bar.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Top services")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(viewModel.displayPeriodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 8)
                topServicesStyleMenu
            }

            switch topServicesDisplayStyle {
            case .bars:
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { _, item in
                        InsightBarRow(label: item.label, value: item.count, maxValue: maxCount)
                    }
                }
            case .rankedList:
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.topServiceLabels.enumerated()), id: \.offset) { index, item in
                        if index > 0 { InsightDivider() }
                        topServiceRankedRow(rank: index + 1, label: item.label, count: item.count)
                    }
                }
            }
        }
    }

    private var topServicesStyleMenu: some View {
        Menu {
            ForEach(TopServicesDisplayStyle.allCases) { style in
                Button {
                    topServicesDisplayStyle = style
                } label: {
                    if topServicesDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(topServicesDisplayStyle.menuLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppDesign.searchBackground)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(AppDesign.chipBorder.opacity(0.7), lineWidth: 1)
            )
        }
    }

    private func topServiceRankedRow(rank: Int, label: String, count: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(AppDesign.textSecondary)
                .frame(width: 20, alignment: .leading)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 8)
            Text("\(count)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
        }
        .padding(.vertical, 12)
    }

    // MARK: - Clients

    private enum ClientsDisplayStyle: String, CaseIterable, Identifiable {
        case donut
        case bar
        case line

        var id: String { rawValue }

        var menuLabel: String {
            switch self {
            case .donut: return "Donut chart"
            case .bar: return "Bar chart"
            case .line: return "Line chart"
            }
        }
    }

    @State private var clientsDisplayStyle: ClientsDisplayStyle = .donut

    private struct ClientDonutSlice: Identifiable {
        let id: String
        let label: String
        let count: Int
        let color: Color
    }

    private var clientsCard: some View {
        InsightCardContainer {
            HStack(spacing: 10) {
                Image(systemName: "person.2.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.iconTileForeground)
                    .frame(width: 28, alignment: .center)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Clients")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(viewModel.displayPeriodLabel)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 8)
                clientsStyleMenu
            }

            switch clientsDisplayStyle {
            case .donut:
                clientsDonutView
            case .bar:
                clientsBarChart
            case .line:
                clientsLineChart
            }
        }
    }

    private var clientsStyleMenu: some View {
        Menu {
            ForEach(ClientsDisplayStyle.allCases) { style in
                Button {
                    clientsDisplayStyle = style
                } label: {
                    if clientsDisplayStyle == style {
                        Label(style.menuLabel, systemImage: "checkmark")
                    } else {
                        Text(style.menuLabel)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(clientsDisplayStyle.menuLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(AppDesign.searchBackground)
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(AppDesign.chipBorder.opacity(0.7), lineWidth: 1)
            )
        }
    }

    private var clientsDonutView: some View {
        let slices = [
            ClientDonutSlice(id: "new", label: "New", count: viewModel.clientsNewInRange, color: AppDesign.brandWarm),
            ClientDonutSlice(id: "existing", label: "Existing", count: viewModel.clientsExistingInRange, color: AppDesign.brandDark),
        ]
        let chartSlices = slices.filter { $0.count > 0 }
        let total = max(viewModel.clientsTotal, 1)

        return Group {
            if viewModel.clientsTotal == 0 {
                Text("No clients yet")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            } else {
                HStack(alignment: .center, spacing: 20) {
                    Chart(chartSlices) { slice in
                        SectorMark(
                            angle: .value("Count", slice.count),
                            innerRadius: .ratio(0.58),
                            angularInset: 1.5
                        )
                        .foregroundStyle(slice.color)
                        .cornerRadius(3)
                    }
                    .frame(width: 132, height: 132)

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(slices) { slice in
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(slice.color)
                                    .frame(width: 8, height: 8)
                                Text(slice.label)
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.textPrimary)
                                Spacer(minLength: 4)
                                Text("\(slice.count)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AppDesign.textPrimary)
                                Text("\(Int((Double(slice.count) / Double(total) * 100).rounded()))%")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AppDesign.textSecondary)
                                    .frame(width: 36, alignment: .trailing)
                            }
                        }
                        Text("Total \(viewModel.clientsTotal)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AppDesign.textSecondary)
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 4)
            }
        }
    }

    private var clientsUsesMonthlySeries: Bool {
        viewModel.selectedRange == .thisYear || viewModel.clientsSeriesPoints.count > 45
    }

    private var clientsBarChart: some View {
        let points = viewModel.clientsSeriesPoints
        return Group {
            if points.isEmpty || points.allSatisfy({ $0.count == 0 }) {
                Text("No new clients in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
            } else {
                Chart(points) { point in
                    BarMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.chartBarFill)
                    .cornerRadius(4)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                        AxisValueLabel {
                            if let n = value.as(Int.self) {
                                Text("\(n)")
                                    .font(.caption2)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(
                                    date,
                                    format: clientsUsesMonthlySeries
                                        ? .dateTime.month(.abbreviated)
                                        : .dateTime.month(.abbreviated).day()
                                )
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .frame(height: 160)
                .padding(.top, 4)
            }
        }
    }

    private var clientsLineChart: some View {
        let points = viewModel.clientsSeriesPoints
        return Group {
            if points.isEmpty || points.allSatisfy({ $0.count == 0 }) {
                Text("No new clients in this period")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
            } else {
                Chart(points) { point in
                    AreaMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
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
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)

                    PointMark(
                        x: .value("Period", point.date, unit: clientsUsesMonthlySeries ? .month : .day),
                        y: .value("New clients", point.count)
                    )
                    .foregroundStyle(AppDesign.textPrimary)
                    .symbolSize(36)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(AppDesign.chipBorder.opacity(0.6))
                        AxisValueLabel {
                            if let n = value.as(Int.self) {
                                Text("\(n)")
                                    .font(.caption2)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { value in
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(
                                    date,
                                    format: clientsUsesMonthlySeries
                                        ? .dateTime.month(.abbreviated)
                                        : .dateTime.month(.abbreviated).day()
                                )
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
                .frame(height: 160)
                .padding(.top, 4)
            }
        }
    }

    // MARK: - Helpers
}

// MARK: - Card chrome

private struct InsightCardContainer<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(16)
        .appCard()
        .padding(.horizontal, 16)
    }
}

private struct InsightCardHeader<Trailing: View>: View {
    let icon: String
    let iconColor: Color
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(iconColor)
                .frame(width: 28, alignment: .center)
            Text(title)
                .font(.headline.weight(.bold))
                .foregroundStyle(AppDesign.textPrimary)
            Spacer(minLength: 8)
            trailing()
        }
    }
}

private struct InsightDivider: View {
    var body: some View {
        Divider()
            .overlay(AppDesign.chipBorder.opacity(0.5))
    }
}

private struct InsightBarRow: View {
    let label: String
    let value: Int
    let maxValue: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineLimit(1)
                Spacer()
                Text("\(value)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
            }
            GeometryReader { geo in
                let width = maxValue > 0 ? geo.size.width * CGFloat(value) / CGFloat(maxValue) : 0
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(AppDesign.searchBackground)
                        .frame(height: 8)
                    Capsule()
                        .fill(AppDesign.chartBarFill)
                        .frame(width: max(width, value > 0 ? 8 : 0), height: 8)
                }
            }
            .frame(height: 8)
        }
    }
}
