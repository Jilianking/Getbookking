//
//  NotificationCenterView.swift
//
//  Dashboard activity bell + right-side activity drawer. Booking requests,
//  SMS, shop orders, deposit/remote payments, and account setup checklist.
//  Session store owns activity data; setup reads existing payment/team/settings state.
//
//  Opening the panel marks items seen (clears blue dots / badge) but keeps
//  rows until the user swipes Clear or taps Clear all.
//

import SwiftUI
import Combine

// MARK: - Inbox persistence (seen ≠ cleared)

enum ActivityInboxStore {
    static let clearedWatermarksKey = "activityClearedWatermarks"
    static let clearedIdsKey = "activityClearedIds"
    static let smsSeenKey = "activitySmsSeenAt"
    static let paymentsSeenKey = "activityPaymentsSeenAt"
    static let requestsSeenKey = "activityRequestsSeenAt"
    static let shopSeenKey = "activityShopSeenAt"
    /// How long uncleared rows stay after their event date.
    static let retentionInterval: TimeInterval = 14 * 24 * 60 * 60
    private static let maxClearedEntries = 500

    static func date(forKey key: String) -> Date {
        let interval = UserDefaults.standard.double(forKey: key)
        guard interval > 0 else { return .distantPast }
        return Date(timeIntervalSince1970: interval)
    }

    static func markSeen(key: String, at date: Date = Date()) {
        UserDefaults.standard.set(date.timeIntervalSince1970, forKey: key)
    }

    static func markAllSeen(at date: Date = Date()) {
        markSeen(key: smsSeenKey, at: date)
        markSeen(key: paymentsSeenKey, at: date)
        markSeen(key: requestsSeenKey, at: date)
        markSeen(key: shopSeenKey, at: date)
    }

    /// Cleared rows reappear when a newer event arrives (date > watermark).
    static var clearedWatermarks: [String: Date] {
        get {
            migrateLegacyClearedIdsIfNeeded()
            guard let raw = UserDefaults.standard.dictionary(forKey: clearedWatermarksKey) else {
                return [:]
            }
            var out: [String: Date] = [:]
            for (key, value) in raw {
                if let interval = value as? Double, interval > 0 {
                    out[key] = Date(timeIntervalSince1970: interval)
                }
            }
            return out
        }
        set {
            var trimmed = newValue
            if trimmed.count > maxClearedEntries {
                let sorted = trimmed.sorted { $0.value > $1.value }
                trimmed = Dictionary(uniqueKeysWithValues: sorted.prefix(maxClearedEntries).map { ($0.key, $0.value) })
            }
            let encoded = trimmed.mapValues { $0.timeIntervalSince1970 }
            UserDefaults.standard.set(encoded, forKey: clearedWatermarksKey)
        }
    }

    static func isHidden(id: String, activityDate: Date?) -> Bool {
        guard let watermark = clearedWatermarks[id] else { return false }
        guard let activityDate else { return true }
        return activityDate <= watermark
    }

    static func clear(id: String, activityDate: Date?) {
        var marks = clearedWatermarks
        marks[id] = activityDate ?? Date()
        clearedWatermarks = marks
    }

    static func clearAll(_ entries: [(id: String, date: Date?)]) {
        var marks = clearedWatermarks
        let fallback = Date()
        for entry in entries {
            marks[entry.id] = entry.date ?? fallback
        }
        clearedWatermarks = marks
    }

    private static func migrateLegacyClearedIdsIfNeeded() {
        guard UserDefaults.standard.object(forKey: clearedWatermarksKey) == nil else { return }
        let legacy = UserDefaults.standard.stringArray(forKey: clearedIdsKey) ?? []
        guard !legacy.isEmpty else { return }
        let now = Date()
        var marks: [String: Date] = [:]
        for id in legacy {
            marks[id] = now
        }
        clearedWatermarks = marks
        UserDefaults.standard.removeObject(forKey: clearedIdsKey)
    }

    static func isWithinRetention(_ date: Date?) -> Bool {
        guard let date else { return true }
        return date >= Date().addingTimeInterval(-retentionInterval)
    }
}

// MARK: - Activity model

enum ActivityKind {
    case bookingRequest
    case sms
    case shopOrder
    case payment

    var icon: String {
        switch self {
        case .bookingRequest: return "tray.full.fill"
        case .sms: return "message.fill"
        case .shopOrder: return "bag.fill"
        case .payment: return "dollarsign.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .bookingRequest: return AppDesign.accentBlue
        case .sms: return AppDesign.accentGreen
        case .shopOrder: return AppDesign.brandWarm
        case .payment: return AppDesign.accentBlue
        }
    }
}

enum ActivityRoute {
    case bookingRequest(id: String)
    case smsThread(id: String)
    case shopOrder(id: String)
    case payments

    func apply(to drawerState: DrawerState) {
        switch self {
        case .bookingRequest(let id):
            drawerState.requestsOpenRequestId = id
            drawerState.selectedSection = .requests
        case .smsThread(let id):
            drawerState.messagesShouldOpenCompose = false
            drawerState.messagesOpenThreadId = id
            drawerState.selectedSection = .messages
        case .shopOrder(let id):
            drawerState.shopOpenOrderId = id
            drawerState.selectedSection = .shop
        case .payments:
            drawerState.selectedSection = .payments
        }
        drawerState.isOpen = false
        drawerState.isActivityOpen = false
    }
}

struct ActivityItem: Identifiable {
    let id: String
    let kind: ActivityKind
    let title: String
    let subtitle: String
    let date: Date?
    let isUnread: Bool
    let route: ActivityRoute
}

extension ActivityItem {
    /// Nil when the request has no Firestore id — without one there is nothing to route to.
    init?(bookingRequest request: BookingRequest, isUnread: Bool) {
        guard let documentId = request.documentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !documentId.isEmpty else { return nil }
        let name = (request.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let service = (request.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            id: "bookingRequest-\(documentId)",
            kind: .bookingRequest,
            title: name.isEmpty ? "New booking request" : name,
            subtitle: service.isEmpty ? "Booking request" : service,
            date: request.createdAt,
            isUnread: isUnread,
            route: .bookingRequest(id: documentId)
        )
    }

    init(smsThread summary: SmsThreadSummary, isUnread: Bool) {
        let name = ClientsViewModel.displayName(
            stored: summary.clientName,
            phone: summary.clientPhoneForSend,
            clients: []
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        let rawBody = summary.lastMessageBody
        let trimmedBody = rawBody.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle: String = {
            if !trimmedBody.isEmpty { return trimmedBody }
            if !rawBody.isEmpty { return "Message" }
            return "Text message"
        }()
        self.init(
            id: "sms-\(summary.threadId)",
            kind: .sms,
            title: name.isEmpty ? "New message" : name,
            subtitle: subtitle,
            date: summary.lastMessageAt,
            isUnread: isUnread,
            route: .smsThread(id: summary.threadId)
        )
    }

    init?(shopOrder order: ShopOrder, isUnread: Bool) {
        let status = order.statusLower
        guard status == ShopOrderStatus.pending || status == ShopOrderStatus.paid else { return nil }
        let total = order.formattedTotal
        self.init(
            id: "shop-\(order.id)",
            kind: .shopOrder,
            title: order.displayCustomerName,
            subtitle: "Order · \(total)",
            date: order.createdAt,
            isUnread: isUnread,
            route: .shopOrder(id: order.id)
        )
    }

    init?(payment tx: PaymentTransaction, isUnread: Bool) {
        guard tx.showsInNotificationActivity else { return nil }
        let amount = String(format: "$%.2f", tx.amount)
        self.init(
            id: "payment-\(tx.id)",
            kind: .payment,
            title: tx.displayTitle,
            subtitle: "\(tx.channelLabel) · \(amount)",
            date: tx.createdAt,
            isUnread: isUnread,
            route: .payments
        )
    }
}

enum ActivityFeed {
    static func items(
        from sessionStore: TenantSessionStore,
        teamAccess: EffectiveTeamAccess,
        currentUserUid: String?,
        requestsSeenAt: Date,
        smsSeenAt: Date,
        shopSeenAt: Date,
        paymentsSeenAt: Date
    ) -> [ActivityItem] {
        var rows: [ActivityItem] = []

        let requests = sessionStore.newBookingRequests
            .scopedForTeamAccess(
                teamAccess,
                currentUserUid: currentUserUid,
                roster: sessionStore.teamMembers
            )
            .compactMap { request -> ActivityItem? in
                let unread = (request.createdAt ?? .distantPast) > requestsSeenAt
                return ActivityItem(bookingRequest: request, isUnread: unread)
            }
        rows.append(contentsOf: requests)

        let sms = sessionStore.visibleSmsThreads(
            teamAccess: teamAccess,
            currentUserUid: currentUserUid
        )
        .filter { ActivityInboxStore.isWithinRetention($0.lastMessageAt) }
        .map { summary in
            let unread = (summary.lastMessageAt ?? .distantPast) > smsSeenAt
            return ActivityItem(smsThread: summary, isUnread: unread)
        }
        rows.append(contentsOf: sms)

        if sessionStore.isShopEnabled || !sessionStore.shopOrders.isEmpty {
            let shop = sessionStore.shopOrders.compactMap { order -> ActivityItem? in
                let unread = (order.createdAt ?? .distantPast) > shopSeenAt
                return ActivityItem(shopOrder: order, isUnread: unread)
            }
            rows.append(contentsOf: shop)
        }

        if teamAccess.isOwner || teamAccess.canTakePayments {
            let payments = sessionStore.recentPayments
                .filter { ActivityInboxStore.isWithinRetention($0.createdAt) }
                .compactMap { tx -> ActivityItem? in
                    let unread = (tx.createdAt ?? .distantPast) > paymentsSeenAt
                    return ActivityItem(payment: tx, isUnread: unread)
                }
            rows.append(contentsOf: payments)
        }

        return rows
            .filter { !ActivityInboxStore.isHidden(id: $0.id, activityDate: $0.date) }
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }
}

// MARK: - Setup checklist

enum SetupChecklistStore {
    static let tourCompletedKey = "setupChecklistTourCompleted"

    static var hasCompletedTour: Bool {
        UserDefaults.standard.bool(forKey: tourCompletedKey)
    }

    static func markTourCompleted() {
        UserDefaults.standard.set(true, forKey: tourCompletedKey)
    }
}

enum SetupSettingsDestination: String, Identifiable, Equatable {
    case messaging
    case services
    case boats
    case accountBilling

    var id: String { rawValue }
}

enum SetupRoute {
    case openStripeConnect
    case dashboard
    case settings(SetupSettingsDestination)
    case startAppTour

    func apply(to drawerState: DrawerState) {
        drawerState.isOpen = false
        drawerState.isActivityOpen = false
        drawerState.setupSettingsDestination = nil
        switch self {
        case .openStripeConnect:
            break
        case .dashboard:
            drawerState.selectedSection = .dashboard
        case .settings(let destination):
            drawerState.selectedSection = .settings
            drawerState.setupSettingsDestination = destination
        case .startAppTour:
            drawerState.selectedSection = .dashboard
            drawerState.shouldStartAppTour = true
        }
    }
}

enum SetupTaskKind {
    case stripe
    case messaging
    case teamRequest
    case content
    case tour

    var icon: String {
        switch self {
        case .stripe: return "creditcard.fill"
        case .messaging: return "message.fill"
        case .teamRequest: return "person.badge.clock"
        case .content: return "list.bullet.rectangle"
        case .tour: return "map.fill"
        }
    }

    var tint: Color {
        switch self {
        case .stripe: return AppDesign.accentBlue
        case .messaging: return AppDesign.accentGreen
        case .teamRequest: return AppDesign.accentBlue
        case .content: return AppDesign.brandWarm
        case .tour: return AppDesign.textSecondary
        }
    }
}

struct SetupTask: Identifiable {
    let id: String
    let kind: SetupTaskKind
    let title: String
    let subtitle: String
    let isComplete: Bool
    let route: SetupRoute
}

struct SetupChecklistProgress: Equatable {
    let completed: Int
    let total: Int

    var fraction: Double {
        guard total > 0 else { return 1 }
        return Double(completed) / Double(total)
    }

    var percent: Int {
        Int((fraction * 100).rounded())
    }

    var isComplete: Bool {
        total > 0 && completed >= total
    }
}

struct SetupChecklistContext {
    let isDemoMode: Bool
    let teamAccess: EffectiveTeamAccess
    let subscriptionPlan: SubscriptionPlan
    let hasLoadedStripeStatus: Bool
    let canTakePayments: Bool
    let stripeConnected: Bool
    let stripeHasAccount: Bool
    let stripeDetailsSubmitted: Bool
    let needsStripeConnect: Bool
    let subscriptionPaid: Bool
    let subscriptionTrialing: Bool
    let isOwner: Bool
    let smsStatus: String
    let smsPhoneNumber: String
    let memberSmsStatus: String
    let memberSmsPhone: String
    let usesOwnSms: Bool
    let pendingLineRequests: [TenantTeamMember]
    let charterBoats: [CharterBoat]
    let services: [TenantService]
    let tourCompleted: Bool
}

enum SetupChecklistFeed {
    static func tasks(from context: SetupChecklistContext) -> [SetupTask] {
        if context.isDemoMode { return [] }

        var rows: [SetupTask] = []
        let studioSmsActive = context.smsStatus.lowercased() == "active"
            && !context.smsPhoneNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let memberSmsActive = context.memberSmsStatus.lowercased() == "active"
            && !context.memberSmsPhone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let isCharter = context.subscriptionPlan.isCharterPlan

        if context.isOwner {
            if context.canTakePayments, context.hasLoadedStripeStatus {
                let inReview = context.stripeHasAccount && context.stripeDetailsSubmitted
                let isComplete = context.stripeConnected || inReview
                rows.append(
                    SetupTask(
                        id: "stripe-connect",
                        kind: .stripe,
                        title: "Set up Stripe",
                        subtitle: isComplete
                            ? (inReview
                                ? "Stripe is reviewing your payout account"
                                : "Connected — deposits and payment links")
                            : "Connect in Stripe to accept deposits and payment links",
                        isComplete: isComplete,
                        route: .openStripeConnect
                    )
                )
            }

            let needsPaidPlan = !context.subscriptionPaid && !context.subscriptionTrialing
            rows.append(
                SetupTask(
                    id: "sms-studio",
                    kind: .messaging,
                    title: "Set up client texting",
                    subtitle: studioSmsActive
                        ? "Dedicated number for appointment texts"
                        : (needsPaidPlan
                            ? Constants.App.paidFeatureUpgradeMessage
                            : "Get a dedicated number for appointment texts"),
                    isComplete: studioSmsActive,
                    route: .settings(.messaging)
                )
            )

            for member in context.pendingLineRequests {
                let name = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                rows.append(
                    SetupTask(
                        id: "sms-request-\(member.uid)",
                        kind: .teamRequest,
                        title: "Approve texting line request",
                        subtitle: name.isEmpty ? "A teammate requested a personal line" : "\(name) requested a personal line",
                        isComplete: false,
                        route: .settings(.messaging)
                    )
                )
            }

            if isCharter {
                rows.append(
                    SetupTask(
                        id: "charter-boats",
                        kind: .content,
                        title: "Add a boat",
                        subtitle: "Guests choose a vessel when they book",
                        isComplete: !context.charterBoats.isEmpty,
                        route: .settings(.boats)
                    )
                )
                let activeServices = context.services.filter(\.isActive)
                rows.append(
                    SetupTask(
                        id: "charter-trips",
                        kind: .content,
                        title: "Add a charter trip",
                        subtitle: "Trips appear on your site and booking flow",
                        isComplete: !activeServices.isEmpty,
                        route: .settings(.services)
                    )
                )
                rows.append(
                    SetupTask(
                        id: "charter-itinerary",
                        kind: .content,
                        title: "Add trip itineraries",
                        subtitle: "Clock times follow the guest’s departure",
                        isComplete: !activeServices.isEmpty
                            && !activeServices.contains(where: { !$0.hasConfiguredItinerary }),
                        route: .settings(.services)
                    )
                )
            } else {
                rows.append(
                    SetupTask(
                        id: "services",
                        kind: .content,
                        title: "Add services",
                        subtitle: "Clients need at least one bookable service",
                        isComplete: !context.services.filter(\.isActive).isEmpty,
                        route: .settings(.services)
                    )
                )
            }

            rows.append(
                SetupTask(
                    id: "app-tour",
                    kind: .tour,
                    title: "Take a quick tour",
                    subtitle: "Dashboard, requests, messages, and payments",
                    isComplete: context.tourCompleted,
                    route: .startAppTour
                )
            )
        } else {
            if context.canTakePayments, context.hasLoadedStripeStatus {
                let inReview = context.stripeHasAccount && context.stripeDetailsSubmitted
                let isComplete = context.stripeConnected || inReview
                rows.append(
                    SetupTask(
                        id: "stripe-connect",
                        kind: .stripe,
                        title: "Set up Stripe",
                        subtitle: isComplete
                            ? "Connected for your bookings and payouts"
                            : "Connect in Stripe for your bookings and payouts",
                        isComplete: isComplete,
                        route: .openStripeConnect
                    )
                )
            }

            if context.usesOwnSms {
                rows.append(
                    SetupTask(
                        id: "sms-member",
                        kind: .messaging,
                        title: "Set up your texting number",
                        subtitle: "Text clients from your own line in Messages",
                        isComplete: memberSmsActive,
                        route: .settings(.messaging)
                    )
                )
            }
        }

        return rows
    }

    static func progress(from tasks: [SetupTask]) -> SetupChecklistProgress {
        let total = tasks.count
        let completed = tasks.filter(\.isComplete).count
        return SetupChecklistProgress(completed: completed, total: total)
    }

    static func incompleteTasks(from tasks: [SetupTask]) -> [SetupTask] {
        tasks.filter { !$0.isComplete }
    }
}

@MainActor
final class SetupChecklistViewModel: ObservableObject {
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var revision = 0
    @Published var stripeSetupAlertMessage: String?

    private let paymentsViewModel = PaymentsViewModel()
    private let settingsViewModel = SettingsViewModel()
    private var lastRefreshAt: Date?
    private let refreshTTL: TimeInterval = 90

    /// Stripe snapshot + Connect link prewarm only — never blocked by services/team TTL skip.
    func refreshStripeAndPrewarmOnly(
        isDemoMode: Bool,
        sessionStore: TenantSessionStore,
        teamAccess: EffectiveTeamAccess
    ) async {
        if isDemoMode { return }
        await sessionStore.ensureSessionLoaded(isDemoMode: false)
        await loadStripeForSetup(sessionStore: sessionStore, teamAccess: teamAccess)
        revision += 1
    }

    func refresh(
        isDemoMode: Bool,
        sessionStore: TenantSessionStore,
        teamAccess: EffectiveTeamAccess,
        subscriptionPlan: SubscriptionPlan,
        force: Bool = false
    ) async {
        if isDemoMode {
            hasLoaded = true
            revision += 1
            return
        }

        if !force,
           hasLoaded,
           let lastRefreshAt,
           Date().timeIntervalSince(lastRefreshAt) < refreshTTL {
            await refreshStripeAndPrewarmOnly(
                isDemoMode: isDemoMode,
                sessionStore: sessionStore,
                teamAccess: teamAccess
            )
            return
        }

        let firstLoad = !hasLoaded
        if firstLoad {
            isLoading = true
        }
        defer {
            isLoading = false
            hasLoaded = true
            lastRefreshAt = Date()
            revision += 1
        }

        await sessionStore.ensureSessionLoaded(isDemoMode: false)
        revision += 1

        if teamAccess.isOwner, let tid = sessionStore.tenantId {
            settingsViewModel.tenantId = tid
            async let stripe: () = loadStripeForSetup(
                sessionStore: sessionStore,
                teamAccess: teamAccess
            )
            async let members: () = sessionStore.loadTeamMembersIfNeeded(isDemoMode: false)
            async let services: () = settingsViewModel.reloadServices()
            _ = await (stripe, members, services)
        } else {
            async let stripe: () = loadStripeForSetup(
                sessionStore: sessionStore,
                teamAccess: teamAccess
            )
            async let members: () = sessionStore.loadTeamMembersIfNeeded(isDemoMode: false)
            _ = await (stripe, members)
        }
    }

    private func loadStripeForSetup(
        sessionStore: TenantSessionStore,
        teamAccess: EffectiveTeamAccess
    ) async {
        await paymentsViewModel.refreshSetupStripeSnapshot(
            sessionStore: sessionStore,
            teamAccess: teamAccess
        )
        await paymentsViewModel.prewarmConnectLinkIfNeeded(isDemoMode: false)
    }

    func tasks(
        isDemoMode: Bool,
        teamAccess: EffectiveTeamAccess,
        subscriptionPlan: SubscriptionPlan,
        sessionStore: TenantSessionStore
    ) -> [SetupTask] {
        _ = revision
        let tenant = sessionStore.tenant ?? [:]
        let smsStatus = (tenant["smsStatus"] as? String) ?? "off"
        let smsPhoneNumber = (tenant["smsPhoneNumber"] as? String) ?? ""
        let charterBoats = CharterBoat.parseList(tenant["charterBoats"])
        let pendingLineRequests = sessionStore.teamMembers.filter {
            $0.smsLineRequestPending && $0.accessRole != .owner
        }
        let tenantSubscriptionStatus = (tenant["subscriptionStatus"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let subscriptionPaid = paymentsViewModel.subscriptionPaid || tenantSubscriptionStatus == "active"
        let subscriptionTrialing = paymentsViewModel.subscriptionTrialing || tenantSubscriptionStatus == "trialing"

        let context = SetupChecklistContext(
            isDemoMode: isDemoMode,
            teamAccess: teamAccess,
            subscriptionPlan: subscriptionPlan,
            hasLoadedStripeStatus: paymentsViewModel.hasLoadedStripeStatus,
            canTakePayments: paymentsViewModel.canTakePayments,
            stripeConnected: paymentsViewModel.stripeConnected,
            stripeHasAccount: paymentsViewModel.stripeHasAccount,
            stripeDetailsSubmitted: paymentsViewModel.stripeDetailsSubmitted,
            needsStripeConnect: paymentsViewModel.needsStripeConnect,
            subscriptionPaid: subscriptionPaid,
            subscriptionTrialing: subscriptionTrialing,
            isOwner: teamAccess.isOwner,
            smsStatus: smsStatus,
            smsPhoneNumber: smsPhoneNumber,
            memberSmsStatus: teamAccess.memberSmsStatus,
            memberSmsPhone: teamAccess.memberSmsPhoneNumber,
            usesOwnSms: teamAccess.usesOwnSms,
            pendingLineRequests: pendingLineRequests,
            charterBoats: charterBoats,
            services: settingsViewModel.services,
            tourCompleted: SetupChecklistStore.hasCompletedTour
        )
        return SetupChecklistFeed.tasks(from: context)
    }

    func progress(
        isDemoMode: Bool,
        teamAccess: EffectiveTeamAccess,
        subscriptionPlan: SubscriptionPlan,
        sessionStore: TenantSessionStore
    ) -> SetupChecklistProgress {
        SetupChecklistFeed.progress(from: tasks(
            isDemoMode: isDemoMode,
            teamAccess: teamAccess,
            subscriptionPlan: subscriptionPlan,
            sessionStore: sessionStore
        ))
    }

    func incompleteCount(
        isDemoMode: Bool,
        teamAccess: EffectiveTeamAccess,
        subscriptionPlan: SubscriptionPlan,
        sessionStore: TenantSessionStore
    ) -> Int {
        SetupChecklistFeed.incompleteTasks(from: tasks(
            isDemoMode: isDemoMode,
            teamAccess: teamAccess,
            subscriptionPlan: subscriptionPlan,
            sessionStore: sessionStore
        )).count
    }

    func noteExternalChange() {
        revision += 1
    }

    enum StripeSetupChecklistResult {
        case openedInSafari
        case alreadyConnected
        case failed
    }

    func openStripeConnectFromChecklist(
        isDemoMode: Bool,
        launch: StripeConnectLaunchCoordinator
    ) async -> StripeSetupChecklistResult {
        stripeSetupAlertMessage = nil
        launch.prepareOpening()
        let outcome = await launch.openConnect(from: paymentsViewModel, isDemoMode: isDemoMode)
        switch outcome {
        case .openedInSafari:
            return .openedInSafari
        case .alreadyConnected:
            return .alreadyConnected
        case .pendingReview:
            stripeSetupAlertMessage = "Stripe is reviewing your payout account. Check back soon."
            return .failed
        case .noAction:
            let trimmed = paymentsViewModel.errorMessage?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            stripeSetupAlertMessage = trimmed.isEmpty
                ? "Could not open Stripe setup."
                : trimmed
            return .failed
        }
    }
}

struct SetupSettingsDestinationSheet: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    let destination: SetupSettingsDestination

    @StateObject private var teamViewModel = ManagerSettingsViewModel()
    @StateObject private var settingsViewModel = SettingsViewModel()
    @StateObject private var billingViewModel = ManagerSettingsViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch destination {
                case .messaging:
                    TeamClientMessagingSettingsView(viewModel: teamViewModel)
                        .environmentObject(authViewModel)
                case .services:
                    BusinessServicesSettingsView(viewModel: settingsViewModel)
                case .boats:
                    CharterBoatsSettingsView(viewModel: settingsViewModel)
                case .accountBilling:
                    AccountBillingSetupSheetContent(viewModel: billingViewModel)
                        .environmentObject(authViewModel)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            switch destination {
            case .messaging:
                await teamViewModel.load(isDemoMode: authViewModel.isDemoMode)
            case .services, .boats:
                await settingsViewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                if destination == .services {
                    await settingsViewModel.reloadServices()
                }
            case .accountBilling:
                await billingViewModel.load(isDemoMode: authViewModel.isDemoMode)
            }
        }
    }
}

/// Plan & billing rows reused when setup checklist routes to billing.
private struct AccountBillingSetupSheetContent: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @EnvironmentObject var sessionStore: TenantSessionStore

    var body: some View {
        List {
            Section {
                Text(Constants.App.paidFeatureUpgradeMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if authViewModel.teamAccess.isOwner {
                    Button {
                        Task { _ = await paymentsViewModel.startSubscriptionToday() }
                    } label: {
                        HStack {
                            Text("Start paid plan")
                            Spacer()
                            if paymentsViewModel.isStartingSubscription {
                                ProgressView().scaleEffect(0.85)
                            }
                        }
                    }
                    .disabled(paymentsViewModel.isStartingSubscription)
                    Button("Manage billing on web") {
                        Task { await paymentsViewModel.openBillingToStartSubscription() }
                    }
                    .disabled(paymentsViewModel.isOpeningBillingWebsite)
                } else {
                    Text("Ask your business owner to start the paid Get Bookking plan.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Plan & billing")
            }
        }
        .appListSurface()
        .navigationTitle("Start paid plan")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            await paymentsViewModel.loadData(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
        }
    }
}

// MARK: - Bell

struct NotificationCenterBell: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var setupChecklistViewModel: SetupChecklistViewModel
    var drawerState: DrawerState

    private var unreadActivityCount: Int {
        ActivityFeed.items(
            from: sessionStore,
            teamAccess: authViewModel.teamAccess,
            currentUserUid: authViewModel.currentUserUid,
            requestsSeenAt: ActivityInboxStore.date(forKey: ActivityInboxStore.requestsSeenKey),
            smsSeenAt: ActivityInboxStore.date(forKey: ActivityInboxStore.smsSeenKey),
            shopSeenAt: ActivityInboxStore.date(forKey: ActivityInboxStore.shopSeenKey),
            paymentsSeenAt: ActivityInboxStore.date(forKey: ActivityInboxStore.paymentsSeenKey)
        )
        .filter(\.isUnread)
        .count
    }

    private var badgeCount: Int {
        unreadActivityCount + setupChecklistViewModel.incompleteCount(
            isDemoMode: authViewModel.isDemoMode,
            teamAccess: authViewModel.teamAccess,
            subscriptionPlan: authViewModel.tenantSubscriptionPlan,
            sessionStore: sessionStore
        )
    }

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                if drawerState.isActivityOpen {
                    drawerState.closeActivityDrawer()
                } else {
                    drawerState.openActivityDrawer()
                }
            }
        } label: {
            Image(systemName: "bell")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(AppDesign.textPrimary)
                .overlay(alignment: .topTrailing) {
                    if badgeCount > 0 {
                        AppDrawerBadge(count: badgeCount)
                            .offset(x: 10, y: -4)
                    }
                }
                .frame(width: 44, height: 44, alignment: .center)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(
            badgeCount > 0 ? "Activity, \(badgeCount) items need attention" : "Activity"
        )
    }
}

// MARK: - Right drawer panel

struct ActivityDrawerPanel: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var setupChecklistViewModel: SetupChecklistViewModel
    @EnvironmentObject var stripeConnectLaunch: StripeConnectLaunchCoordinator
    var drawerState: DrawerState

    /// Seen watermarks for this open — set to "now" on appear so dots clear while rows stay.
    @State private var requestsSeenAt = ActivityInboxStore.date(forKey: ActivityInboxStore.requestsSeenKey)
    @State private var smsSeenAt = ActivityInboxStore.date(forKey: ActivityInboxStore.smsSeenKey)
    @State private var shopSeenAt = ActivityInboxStore.date(forKey: ActivityInboxStore.shopSeenKey)
    @State private var paymentsSeenAt = ActivityInboxStore.date(forKey: ActivityInboxStore.paymentsSeenKey)
    @State private var clearRevision = 0
    @State private var isSetupExpanded = false

    private var items: [ActivityItem] {
        _ = clearRevision
        return ActivityFeed.items(
            from: sessionStore,
            teamAccess: authViewModel.teamAccess,
            currentUserUid: authViewModel.currentUserUid,
            requestsSeenAt: requestsSeenAt,
            smsSeenAt: smsSeenAt,
            shopSeenAt: shopSeenAt,
            paymentsSeenAt: paymentsSeenAt
        )
    }

    private var setupTasks: [SetupTask] {
        setupChecklistViewModel.tasks(
            isDemoMode: authViewModel.isDemoMode,
            teamAccess: authViewModel.teamAccess,
            subscriptionPlan: authViewModel.tenantSubscriptionPlan,
            sessionStore: sessionStore
        )
    }

    private var setupProgress: SetupChecklistProgress {
        setupChecklistViewModel.progress(
            isDemoMode: authViewModel.isDemoMode,
            teamAccess: authViewModel.teamAccess,
            subscriptionPlan: authViewModel.tenantSubscriptionPlan,
            sessionStore: sessionStore
        )
    }

    private var incompleteSetupTasks: [SetupTask] {
        SetupChecklistFeed.incompleteTasks(from: setupTasks)
    }

    private var showsSetupFooter: Bool {
        !authViewModel.isDemoMode && setupProgress.total > 0 && !setupProgress.isComplete && !incompleteSetupTasks.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Text("Activity")
                    .font(.headline)
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer(minLength: 0)
                if !items.isEmpty {
                    Button("Clear all") {
                        clearAllVisible()
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                    .accessibilityLabel("Clear all activity")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            if items.isEmpty && (!isSetupExpanded || incompleteSetupTasks.isEmpty) {
                emptyState
            }

            if !items.isEmpty || (isSetupExpanded && !incompleteSetupTasks.isEmpty) {
                List {
                    if isSetupExpanded, !incompleteSetupTasks.isEmpty {
                        Section {
                            ForEach(incompleteSetupTasks) { task in
                                SetupTaskRow(task: task) {
                                    handleSetupTaskTap(task)
                                }
                                .listRowInsets(EdgeInsets())
                                .listRowSeparator(.hidden)
                                .listRowBackground(AppDesign.cardBackground)
                            }
                        } header: {
                            Text("Setup")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppDesign.textSecondary)
                                .textCase(nil)
                        }
                    }

                    if !items.isEmpty {
                        Section {
                            ForEach(items) { item in
                                ActivityRow(item: item) {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        item.route.apply(to: drawerState)
                                    }
                                }
                                .listRowInsets(EdgeInsets())
                                .listRowSeparator(.hidden)
                                .listRowBackground(AppDesign.cardBackground)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button("Clear", role: .destructive) {
                                        clearItem(item)
                                    }
                                }
                            }
                        } header: {
                            if isSetupExpanded, !incompleteSetupTasks.isEmpty {
                                Text("Recent")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AppDesign.textSecondary)
                                    .textCase(nil)
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 1)
            } else if showsSetupFooter {
                Spacer(minLength: 0)
            }

            if showsSetupFooter {
                SetupProgressFooter(
                    progress: setupProgress,
                    isLoading: setupChecklistViewModel.isLoading
                        && !setupChecklistViewModel.hasLoaded
                        && setupProgress.total == 0,
                    isExpanded: isSetupExpanded
                ) {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isSetupExpanded.toggle()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppDesign.cardBackground)
        .onAppear {
            // Dots/badge clear immediately; rows remain until swipe / Clear all.
            let now = Date()
            requestsSeenAt = now
            smsSeenAt = now
            shopSeenAt = now
            paymentsSeenAt = now
            ActivityInboxStore.markAllSeen(at: now)
            clearRevision += 1
        }
        .task {
            async let shop: () = sessionStore.loadShopOrdersIfNeeded(
                force: false,
                isDemoMode: authViewModel.isDemoMode
            )
            async let payments: () = sessionStore.loadRecentPaymentsIfNeeded(
                force: false,
                isDemoMode: authViewModel.isDemoMode
            )
            sessionStore.startSmsThreadsListening(isDemoMode: authViewModel.isDemoMode)
            _ = await (shop, payments)
        }
    }

    private func handleSetupTaskTap(_ task: SetupTask) {
        if case .openStripeConnect = task.route {
            Task { @MainActor in
                let result = await setupChecklistViewModel.openStripeConnectFromChecklist(
                    isDemoMode: authViewModel.isDemoMode,
                    launch: stripeConnectLaunch
                )
                switch result {
                case .openedInSafari, .alreadyConnected:
                    withAnimation(.easeInOut(duration: 0.2)) {
                        drawerState.isOpen = false
                        drawerState.isActivityOpen = false
                    }
                case .failed:
                    break
                }
            }
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                task.route.apply(to: drawerState)
            }
        }
    }

    private func clearItem(_ item: ActivityItem) {
        withAnimation(.easeInOut(duration: 0.2)) {
            ActivityInboxStore.clear(id: item.id, activityDate: item.date)
            clearRevision += 1
        }
    }

    private func clearAllVisible() {
        let entries = items.map { (id: $0.id, date: $0.date) }
        withAnimation(.easeInOut(duration: 0.2)) {
            ActivityInboxStore.clearAll(entries)
            clearRevision += 1
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bell.slash")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(AppDesign.textSecondary)
            Text("Nothing new")
                .font(.headline)
                .foregroundStyle(AppDesign.textPrimary)
            Text("Requests, texts, shop orders, and deposits show up here.")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(32)
    }
}

private struct ActivityRow: View {
    let item: ActivityItem
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: item.kind.icon)
                    .font(.system(size: 15))
                    .foregroundStyle(item.kind.tint)
                    .frame(width: 36, height: 36)
                    .background(item.kind.tint.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.subheadline.weight(item.isUnread ? .semibold : .regular))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(item.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 6) {
                    if let date = item.date {
                        Text(Self.timeLabel(date))
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    if item.isUnread {
                        Circle()
                            .fill(AppDesign.accentBlue)
                            .frame(width: 8, height: 8)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private static func timeLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday"
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

private struct SetupTaskRow: View {
    let task: SetupTask
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: task.kind.icon)
                    .font(.system(size: 15))
                    .foregroundStyle(task.kind.tint)
                    .frame(width: 36, height: 36)
                    .background(task.kind.tint.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text(task.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(task.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textSecondary.opacity(0.55))
                    .padding(.top, 4)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct SetupProgressFooter: View {
    let progress: SetupChecklistProgress
    var isLoading: Bool
    var isExpanded: Bool
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Setup")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Spacer(minLength: 8)
                    if isLoading {
                        Text("Checking…")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    } else {
                        Text("\(progress.completed) of \(progress.total)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppDesign.textSecondary)
                        Text("\(progress.percent)%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppDesign.accentBlue)
                    }
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppDesign.textSecondary)
                }

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(AppDesign.textSecondary.opacity(0.15))
                        Capsule()
                            .fill(AppDesign.accentBlue)
                            .frame(width: geo.size.width * (isLoading ? 0 : progress.fraction))
                    }
                }
                .frame(height: 6)
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppDesign.cardBackground)
            .overlay(alignment: .top) {
                Divider()
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Setup progress, \(progress.completed) of \(progress.total) complete")
    }
}
