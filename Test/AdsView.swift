//
//  AdsView.swift
//
//  Meta ads for the business: connect an ad account, see results, and publish
//  a campaign, ad set, and ad. Owner only. Insights is unchanged.
//

import SwiftUI
import UIKit
import FirebaseFunctions

struct AdsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var viewModel = AdsViewModel()
    @State private var showEditor = false
    @State private var showDisconnect = false
    var drawerState: DrawerState
    let sectionTitle: String

    private var paid: Bool { AdsViewModel.isPaid(sessionStore.tenant) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if authViewModel.isDemoMode {
                        Text("Meta ads are unavailable on the demo account.")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                    } else if sessionStore.tenant == nil {
                        ProgressView("Loading ads…")
                    } else if !paid {
                        Text("Your free trial includes the website builder. Start your paid Get Bookking plan to connect Meta ads.")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                    } else if viewModel.isLoading && viewModel.status == "off" {
                        ProgressView("Loading ads…")
                    } else if !viewModel.isConnected {
                        connectCard
                    } else if viewModel.status == "choose_account" {
                        accountRow
                    } else {
                        connectedBody
                    }
                    if let error = viewModel.errorMessage, !error.isEmpty {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(16)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .refreshable {
                await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, viewModel.waitingForBrowser else { return }
                Task { await viewModel.reloadAfterBrowser() }
            }
            .navigationDestination(isPresented: $showEditor) {
                AdsEditorView(viewModel: viewModel)
            }
            .confirmationDialog("Disconnect Meta ads?", isPresented: $showDisconnect, titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) {
                    Task { await viewModel.disconnect() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var connectCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect the Meta ad account you already run. New campaign, then Campaign, Ad set, and Ad.")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            if viewModel.status == "failed" || viewModel.status == "expired" {
                Text(viewModel.provisionError.isEmpty ? "Meta ads could not be connected." : viewModel.provisionError)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if viewModel.status == "connecting" || viewModel.isWorking {
                HStack {
                    ProgressView()
                    Text("Connecting Meta ads…")
                        .font(.subheadline)
                }
            }
            Button {
                Task { await viewModel.connect() }
            } label: {
                Text(viewModel.status == "off" ? "Connect Meta ads" : "Connect again")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppDesign.brandDark)
            .disabled(viewModel.isWorking)
        }
        .padding(16)
        .appCard()
    }

    private var connectedBody: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button {
                showEditor = true
            } label: {
                Text("New campaign")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppDesign.brandDark)

            accountRow

            Picker("Range", selection: $viewModel.range) {
                ForEach(AdsRange.allCases) { range in
                    Text(range.label).tag(range)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: viewModel.range) { _, _ in
                Task { await viewModel.loadNumbers() }
            }

            totals

            Text("Campaigns")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
            if viewModel.campaigns.isEmpty {
                Text("No campaigns yet.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            } else {
                ForEach(viewModel.campaigns) { campaign in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(campaign.name).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(campaign.deliveryLabel).font(.caption).foregroundStyle(AppDesign.textSecondary)
                        }
                        Text(campaign.subtitle(currency: viewModel.currency))
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    .padding(14)
                    .appCard()
                }
            }
        }
    }

    private var accountRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            if viewModel.accounts.count > 1 {
                Picker("Ad account", selection: Binding(
                    get: { viewModel.accountId },
                    set: { id in Task { await viewModel.selectAccount(id) } }
                )) {
                    ForEach(viewModel.accounts) { account in
                        Text(account.name).tag(account.id)
                    }
                }
            } else {
                Text(viewModel.accountName.isEmpty ? "Ad account" : viewModel.accountName)
                    .font(.subheadline.weight(.semibold))
            }
            Button("Disconnect", role: .destructive) { showDisconnect = true }
                .font(.caption)
                .disabled(viewModel.isWorking)
        }
    }

    private var totals: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            total("Spend", viewModel.money(viewModel.spend))
            total("Impressions", AdsViewModel.compact(viewModel.impressions))
            total("Clicks", AdsViewModel.compact(viewModel.clicks))
            total("Results", "\(viewModel.results)")
        }
    }

    private func total(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(AppDesign.textSecondary)
            Text(value).font(.title3.weight(.bold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .appCard()
    }
}

struct AdsEditorView: View {
    @ObservedObject var viewModel: AdsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var step = 0
    @State private var draft = AdsDraft()
    @State private var publishing = false
    @State private var error = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                stepLine
                if step == 0 { campaignStep }
                if step == 1 { adSetStep }
                if step == 2 { adStep }
                if !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                HStack {
                    if step > 0 {
                        Button("Back") { step -= 1 }
                    }
                    Spacer()
                    if step < 2 {
                        Button("Next") { step += 1 }
                            .buttonStyle(.borderedProminent)
                            .tint(AppDesign.brandDark)
                    }
                }
            }
            .padding(16)
        }
        .appScreenBackground()
        .navigationTitle("Create campaign")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(publishing ? "Publishing…" : "Publish") {
                    Task { await publish(active: true) }
                }
                .disabled(publishing || !draft.canPublish)
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Save paused") { Task { await publish(active: false) } }
                    .disabled(publishing || !draft.canPublish)
            }
        }
        .onAppear {
            if draft.pageId.isEmpty { draft.pageId = viewModel.pages.first?.id ?? "" }
            if draft.pixelId.isEmpty { draft.pixelId = viewModel.pixels.first?.id ?? "" }
            if draft.instagramUserId.isEmpty {
                draft.instagramUserId = viewModel.pages.first(where: { $0.id == draft.pageId })?.instagramUserId ?? ""
            }
        }
    }

    private var stepLine: some View {
        HStack {
            stepLabel("Campaign", 0)
            stepLabel("Ad set", 1)
            stepLabel("Ad", 2)
        }
    }

    private func stepLabel(_ title: String, _ index: Int) -> some View {
        Text(title)
            .font(.caption.weight(step == index ? .bold : .regular))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Capsule().fill(step == index ? AppDesign.brandDark : AppDesign.chipBorder.opacity(0.45)))
            .foregroundStyle(step == index ? AppDesign.brandCream : AppDesign.textPrimary)
    }

    private var campaignStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Campaign name", text: $draft.name)
            Picker("Special ad category", selection: $draft.specialAdCategory) {
                Text("None").tag("none")
                Text("Housing").tag("housing")
                Text("Employment").tag("employment")
                Text("Credit").tag("credit")
                Text("Financial products").tag("financial")
            }
            Text("Campaign objective").font(.caption).foregroundStyle(AppDesign.textSecondary)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(AdsObjective.allCases) { objective in
                    Button(objective.label) { draft.objective = objective }
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(draft.objective == objective ? AppDesign.brandDark : AppDesign.cardBackground))
                        .foregroundStyle(draft.objective == objective ? AppDesign.brandCream : AppDesign.textPrimary)
                }
            }
            Toggle("Advantage+ campaign budget", isOn: $draft.advantageBudget)
            Picker("Budget", selection: $draft.budgetType) {
                Text("Daily").tag("daily")
                Text("Lifetime").tag("lifetime")
            }
            .pickerStyle(.segmented)
            field(draft.budgetType == "lifetime" ? "Lifetime budget" : "Daily budget", text: $draft.budget, keyboard: .decimalPad)
            if draft.budgetType == "lifetime" {
                field("End date (YYYY-MM-DD)", text: $draft.endDate)
            }
            Picker("Bid strategy", selection: $draft.bidStrategy) {
                Text("Highest volume").tag("highest_volume")
                Text("Cost per result goal").tag("cost_per_result")
                Text("Bid cap").tag("bid_cap")
            }
            if draft.bidStrategy != "highest_volume" {
                field("Bid amount", text: $draft.bidAmount, keyboard: .decimalPad)
            }
        }
    }

    private var adSetStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Ad set name", text: $draft.adSetName)
            Picker("Conversion location", selection: $draft.conversionLocation) {
                Text("Website").tag("website")
                Text("Messenger").tag("messenger")
                Text("Instagram").tag("instagram")
            }
            if draft.objective == .traffic {
                Picker("Performance goal", selection: $draft.performanceGoal) {
                    Text("Maximize link clicks").tag("link_clicks")
                    Text("Maximize landing page views").tag("landing_page_views")
                }
            } else if draft.objective == .sales || draft.objective == .leads {
                Text("Performance goal: Maximize number of conversions")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            if draft.needsPixel {
                Picker("Dataset", selection: $draft.pixelId) {
                    Text("Choose a dataset").tag("")
                    ForEach(viewModel.pixels) { pixel in
                        Text(pixel.name).tag(pixel.id)
                    }
                }
                if draft.objective == .sales {
                    Picker("Conversion event", selection: $draft.customEventType) {
                        Text("Schedule").tag("SCHEDULE")
                        Text("Purchase").tag("PURCHASE")
                        Text("Lead").tag("LEAD")
                    }
                }
            }
            if draft.objective == .app {
                field("App id", text: $draft.applicationId)
                field("Store link", text: $draft.storeUrl)
            }
            Picker("Facebook Page", selection: $draft.pageId) {
                Text("Choose a Page").tag("")
                ForEach(viewModel.pages) { page in
                    Text(page.name).tag(page.id)
                }
            }
            .onChange(of: draft.pageId) { _, id in
                draft.instagramUserId = viewModel.pages.first(where: { $0.id == id })?.instagramUserId ?? ""
            }
            Toggle("Advantage+ audience", isOn: $draft.advantageAudience)
            Text("Location uses the country unless you add a point.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            field("Country", text: $draft.country)
            field("Latitude (optional)", text: $draft.latitude, keyboard: .decimalPad)
            field("Longitude (optional)", text: $draft.longitude, keyboard: .decimalPad)
            field("Radius in miles", text: $draft.radiusMiles, keyboard: .decimalPad)
            field("Minimum age", text: $draft.ageMin, keyboard: .numberPad)
            Toggle("Advantage+ placements", isOn: $draft.advantagePlacements)
        }
    }

    private var adStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Ad name", text: $draft.adName)
            Picker("Ad setup", selection: $draft.useExistingPost) {
                Text("Create ad").tag(false)
                Text("Use existing post").tag(true)
            }
            .pickerStyle(.segmented)
            if draft.useExistingPost {
                field("Post id", text: $draft.postId)
            } else {
                field("Photo URL", text: $draft.imageUrl)
                field("Primary text", text: $draft.message, axis: .vertical)
                field("Headline", text: $draft.headline)
                field("Description", text: $draft.description)
                Picker("Call to action", selection: $draft.callToAction) {
                    Text("Book now").tag("book_now")
                    Text("Learn more").tag("learn_more")
                    Text("Sign up").tag("sign_up")
                    Text("Shop now").tag("shop_now")
                    Text("Send message").tag("send_message")
                }
                field("Website URL", text: $draft.link)
            }
            if !draft.instagramUserId.isEmpty {
                Text("Shown as the Instagram account on \(draft.pageName(in: viewModel.pages))")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            Toggle("Advantage+ creative", isOn: $draft.advantageCreative)
            preview
        }
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Preview").font(.caption.weight(.semibold)).foregroundStyle(AppDesign.textSecondary)
            VStack(alignment: .leading, spacing: 6) {
                Text(draft.headline.isEmpty ? "Headline" : draft.headline).font(.subheadline.weight(.semibold))
                Text(draft.message.isEmpty ? "Primary text" : draft.message).font(.caption).foregroundStyle(AppDesign.textSecondary)
                Text(draft.callToAction.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .appCard()
        }
    }

    private func field(_ title: String, text: Binding<String>, axis: Axis = .horizontal, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(AppDesign.textSecondary)
            TextField(title, text: text, axis: axis)
                .textFieldStyle(.roundedBorder)
                .keyboardType(keyboard)
        }
    }

    private func publish(active: Bool) async {
        publishing = true
        error = ""
        do {
            try await viewModel.publish(draft, active: active)
            dismiss()
        } catch {
            self.error = FirebaseFunctionsErrorHelper.message(from: error)
        }
        publishing = false
    }
}

enum AdsRange: String, CaseIterable, Identifiable {
    case days30, days90, days365
    var id: String { rawValue }
    var label: String {
        switch self {
        case .days30: return "30 days"
        case .days90: return "90 days"
        case .days365: return "12 months"
        }
    }
    var days: Int {
        switch self {
        case .days30: return 30
        case .days90: return 90
        case .days365: return 365
        }
    }
}

enum AdsObjective: String, CaseIterable, Identifiable {
    case awareness, traffic, engagement, leads, app, sales
    var id: String { rawValue }
    var label: String {
        switch self {
        case .awareness: return "Awareness"
        case .traffic: return "Traffic"
        case .engagement: return "Engagement"
        case .leads: return "Leads"
        case .app: return "App"
        case .sales: return "Sales"
        }
    }
}

struct AdsDraft {
    var name = ""
    var objective: AdsObjective = .sales
    var specialAdCategory = "none"
    var advantageBudget = true
    var budgetType = "daily"
    var budget = "20"
    var endDate = ""
    var bidStrategy = "highest_volume"
    var bidAmount = ""
    var adSetName = "People near the shop"
    var conversionLocation = "website"
    var performanceGoal = "link_clicks"
    var customEventType = "SCHEDULE"
    var pixelId = ""
    var applicationId = ""
    var storeUrl = ""
    var pageId = ""
    var country = "US"
    var latitude = ""
    var longitude = ""
    var radiusMiles = "15"
    var ageMin = "18"
    var advantageAudience = true
    var advantagePlacements = true
    var adName = ""
    var useExistingPost = false
    var postId = ""
    var imageUrl = ""
    var message = ""
    var headline = ""
    var description = ""
    var callToAction = "book_now"
    var link = ""
    var instagramUserId = ""
    var advantageCreative = true

    var needsPixel: Bool {
        objective == .sales || objective == .leads || (objective == .traffic && performanceGoal == "landing_page_views")
    }

    var canPublish: Bool {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        if Double(budget) == nil { return false }
        if budgetType == "lifetime" && !Self.isDay(endDate) { return false }
        if pageId.isEmpty { return false }
        if needsPixel && pixelId.isEmpty { return false }
        if objective == .app {
            if applicationId.trimmingCharacters(in: .whitespaces).isEmpty { return false }
            if !storeUrl.hasPrefix("https://") { return false }
        }
        if useExistingPost { return !postId.trimmingCharacters(in: .whitespaces).isEmpty }
        return !message.trimmingCharacters(in: .whitespaces).isEmpty
            && !headline.trimmingCharacters(in: .whitespaces).isEmpty
            && link.hasPrefix("https://")
            && imageUrl.hasPrefix("https://")
    }

    func pageName(in pages: [AdsPage]) -> String {
        pages.first(where: { $0.id == pageId })?.name ?? "this Page"
    }

    func payload(active: Bool) -> [String: Any] {
        var adSet: [String: Any] = [
            "name": adSetName,
            "conversionLocation": conversionLocation,
            "pageId": pageId,
            "countries": [country.trimmingCharacters(in: .whitespaces).uppercased()],
            "ageMin": Int(ageMin) ?? 18,
            "advantageAudience": advantageAudience,
            "advantagePlacements": advantagePlacements,
        ]
        if needsPixel {
            adSet["pixelId"] = pixelId
            if objective == .sales { adSet["customEventType"] = customEventType }
        }
        if objective == .traffic { adSet["performanceGoal"] = performanceGoal }
        if objective == .app {
            adSet["applicationId"] = applicationId.trimmingCharacters(in: .whitespaces)
            adSet["storeUrl"] = storeUrl.trimmingCharacters(in: .whitespaces)
        }
        let lat = Double(latitude)
        let lng = Double(longitude)
        if let lat, let lng {
            adSet["latitude"] = lat
            adSet["longitude"] = lng
            adSet["radiusMiles"] = Double(radiusMiles) ?? 15
        }
        var ad: [String: Any] = [
            "name": adName.isEmpty ? name : adName,
            "pageId": pageId,
            "callToAction": callToAction,
        ]
        if !instagramUserId.isEmpty { ad["instagramUserId"] = instagramUserId }
        if useExistingPost {
            ad["postId"] = postId.trimmingCharacters(in: .whitespaces)
        } else {
            ad["message"] = message
            ad["headline"] = headline
            ad["description"] = description
            ad["link"] = link.trimmingCharacters(in: .whitespaces)
            ad["imageUrl"] = imageUrl.trimmingCharacters(in: .whitespaces)
        }
        var body: [String: Any] = [
            "name": name,
            "objective": objective.rawValue,
            "specialAdCategory": specialAdCategory,
            "advantageCampaignBudget": advantageBudget,
            "budgetType": budgetType,
            "budget": Double(budget) ?? 0,
            "bidStrategy": bidStrategy,
            "status": active ? "active" : "paused",
            "adSet": adSet,
            "ad": ad,
        ]
        if budgetType == "lifetime" { body["endTime"] = endDate.trimmingCharacters(in: .whitespaces) + "T23:59:59Z" }
        if bidStrategy != "highest_volume", let amount = Double(bidAmount) {
            body["bidAmount"] = amount
        }
        ad["advantageCreative"] = advantageCreative
        body["ad"] = ad
        return body
    }

    private static func isDay(_ value: String) -> Bool {
        let raw = value.trimmingCharacters(in: .whitespaces)
        guard raw.count == 10 else { return false }
        let parts = raw.split(separator: "-")
        return parts.count == 3 && parts.allSatisfy { Int($0) != nil }
    }
}

struct AdsAccount: Identifiable, Hashable {
    let id: String
    let name: String
    let currency: String
}

struct AdsPage: Identifiable, Hashable {
    let id: String
    let name: String
    let instagramUserId: String
}

struct AdsPixel: Identifiable, Hashable {
    let id: String
    let name: String
}

struct AdsCampaign: Identifiable, Hashable {
    let id: String
    let name: String
    let delivery: String
    let dailyBudget: Double?
    let results: Int
    let costPerResult: Double?

    var deliveryLabel: String {
        let raw = delivery.replacingOccurrences(of: "_", with: " ").lowercased()
        return raw.prefix(1).uppercased() + raw.dropFirst()
    }

    func subtitle(currency: String) -> String {
        let budget = dailyBudget.map { AdsViewModel.money($0, code: currency) + "/day" } ?? "Budget on the ad set"
        let cost = costPerResult.map { AdsViewModel.money($0, code: currency) } ?? "—"
        return "\(budget) · \(results) results · \(cost)"
    }
}

@MainActor
final class AdsViewModel: ObservableObject {
    @Published var status = "off"
    @Published var provisionError = ""
    @Published var errorMessage: String?
    @Published var accountName = ""
    @Published var accountId = ""
    @Published var currency = "USD"
    @Published var accounts: [AdsAccount] = []
    @Published var pages: [AdsPage] = []
    @Published var pixels: [AdsPixel] = []
    @Published var campaigns: [AdsCampaign] = []
    @Published var spend = 0.0
    @Published var impressions = 0
    @Published var clicks = 0
    @Published var results = 0
    @Published var isLoading = false
    @Published var isWorking = false
    @Published var waitingForBrowser = false
    @Published var range: AdsRange = .days30

    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    var isConnected: Bool { status == "connected" || status == "choose_account" }

    static func isPaid(_ tenant: [String: Any]?) -> Bool {
        if tenant?["complimentaryPaidAccess"] as? Bool == true { return true }
        let stripe = (tenant?["stripeCustomerId"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let billing = (tenant?["billingSource"] as? String ?? "")
        let hasBilling = !stripe.isEmpty || billing == "apple"
        let status = (tenant?["subscriptionStatus"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return hasBilling && status == "active"
    }

    func money(_ value: Double) -> String { Self.money(value, code: currency) }

    static func money(_ value: Double, code: String) -> String {
        value.formatted(.currency(code: code).precision(.fractionLength(value >= 100 ? 0 : 2)))
    }

    static func compact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000).replacingOccurrences(of: ".0k", with: "k") }
        return "\(value)"
    }

    func load(isDemoMode: Bool) async {
        if isDemoMode {
            status = "off"
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let data = try await call("getMetaAdsConnection")
            applyConnection(data)
            if status == "connected" { await loadNumbers() }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func loadNumbers() async {
        guard status == "connected" else { return }
        let bounds = dateBounds()
        do {
            let insights = try await call("getMetaAdsInsights", [
                "since": bounds.since,
                "until": bounds.until,
            ])
            spend = double(insights["spend"])
            impressions = int(insights["impressions"])
            clicks = int(insights["clicks"])
            results = int(insights["results"])
            let listed = try await call("listMetaCampaigns", [
                "since": bounds.since,
                "until": bounds.until,
            ])
            let rows = listed["campaigns"] as? [[String: Any]] ?? []
            campaigns = rows.map { row in
                AdsCampaign(
                    id: string(row["id"]),
                    name: string(row["name"]),
                    delivery: string(row["delivery"]),
                    dailyBudget: row["dailyBudget"] as? Double ?? (row["dailyBudget"] as? NSNumber)?.doubleValue,
                    results: int(row["results"]),
                    costPerResult: row["costPerResult"] as? Double ?? (row["costPerResult"] as? NSNumber)?.doubleValue
                )
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func connect() async {
        isWorking = true
        errorMessage = nil
        do {
            let data = try await call("startMetaAdsConnect")
            guard let url = URL(string: string(data["authorizeUrl"])) else {
                throw NSError(domain: "Ads", code: 1, userInfo: [NSLocalizedDescriptionKey: "Meta did not return a connect link."])
            }
            waitingForBrowser = true
            status = "connecting"
            if await InAppSafari.openInSystemBrowser(url) == false {
                waitingForBrowser = false
                errorMessage = "Couldn’t open Meta. Try again."
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isWorking = false
    }

    func reloadAfterBrowser() async {
        waitingForBrowser = false
        await load(isDemoMode: false)
    }

    func disconnect() async {
        isWorking = true
        errorMessage = nil
        do {
            _ = try await call("disconnectMetaAds")
            status = "off"
            accounts = []
            campaigns = []
            accountName = ""
            accountId = ""
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isWorking = false
    }

    func selectAccount(_ id: String) async {
        guard id != accountId else { return }
        isWorking = true
        errorMessage = nil
        do {
            _ = try await call("selectMetaAdAccount", ["accountId": id])
            await load(isDemoMode: false)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isWorking = false
    }

    func publish(_ draft: AdsDraft, active: Bool) async throws {
        _ = try await call("publishMetaCampaign", draft.payload(active: active))
        await loadNumbers()
    }

    private func applyConnection(_ data: [String: Any]) {
        status = string(data["status"]).isEmpty ? "off" : string(data["status"])
        provisionError = string(data["error"])
        accountId = string(data["accountId"])
        accountName = string(data["accountName"])
        if !string(data["currency"]).isEmpty { currency = string(data["currency"]) }
        accounts = (data["adAccounts"] as? [[String: Any]] ?? []).map {
            AdsAccount(id: string($0["id"]), name: string($0["name"]), currency: string($0["currency"]))
        }
        pages = (data["pages"] as? [[String: Any]] ?? []).map {
            AdsPage(id: string($0["id"]), name: string($0["name"]), instagramUserId: string($0["instagramUserId"]))
        }
        pixels = (data["pixels"] as? [[String: Any]] ?? []).map {
            AdsPixel(id: string($0["id"]), name: string($0["name"]))
        }
    }

    private func dateBounds() -> (since: String, until: String) {
        let cal = Calendar.current
        let end = cal.startOfDay(for: Date())
        let start = cal.date(byAdding: .day, value: -(range.days - 1), to: end) ?? end
        return (Self.dayString(start), Self.dayString(end))
    }

    private static func dayString(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private func call(_ name: String, _ data: [String: Any] = [:]) async throws -> [String: Any] {
        let result = try await functions.httpsCallable(name).call(data)
        return result.data as? [String: Any] ?? [:]
    }

    private func string(_ value: Any?) -> String { (value as? String) ?? "" }
    private func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? (value as? Int) ?? 0 }
    private func double(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? (value as? Double) ?? 0 }
}
