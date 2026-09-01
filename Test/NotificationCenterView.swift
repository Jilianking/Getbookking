//
//  NotificationCenterView.swift
//
//  Dashboard activity bell + right-side activity drawer. Booking requests,
//  SMS, shop orders, and deposit/remote payments. Session store owns the
//  underlying data so this panel never spins up screen view models.
//

import SwiftUI

// MARK: - Seen watermarks (SMS + payments have no per-item readAt)

enum ActivitySeenStore {
    static let smsKey = "activitySmsSeenAt"
    static let paymentsKey = "activityPaymentsSeenAt"

    static func date(forKey key: String) -> Date {
        let interval = UserDefaults.standard.double(forKey: key)
        guard interval > 0 else { return .distantPast }
        return Date(timeIntervalSince1970: interval)
    }

    static func markSeen(key: String, at date: Date = Date()) {
        UserDefaults.standard.set(date.timeIntervalSince1970, forKey: key)
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
    init?(bookingRequest request: BookingRequest) {
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
            isUnread: request.readAt == nil,
            route: .bookingRequest(id: documentId)
        )
    }

    init(smsThread summary: SmsThreadSummary, isUnread: Bool) {
        let name = summary.clientName.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = summary.lastMessageBody.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            id: "sms-\(summary.threadId)",
            kind: .sms,
            title: name.isEmpty ? "New message" : name,
            subtitle: body.isEmpty ? "Text message" : body,
            date: summary.lastMessageAt,
            isUnread: isUnread,
            route: .smsThread(id: summary.threadId)
        )
    }

    init?(shopOrder order: ShopOrder) {
        let status = order.statusLower
        guard status == ShopOrderStatus.pending || status == ShopOrderStatus.paid else { return nil }
        let total = order.formattedTotal
        self.init(
            id: "shop-\(order.id)",
            kind: .shopOrder,
            title: order.displayCustomerName,
            subtitle: "Order · \(total)",
            date: order.createdAt,
            isUnread: order.isUnread,
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
        smsSeenAt: Date,
        paymentsSeenAt: Date
    ) -> [ActivityItem] {
        var rows: [ActivityItem] = []

        let requests = sessionStore.newBookingRequests
            .scopedForTeamAccess(
                teamAccess,
                currentUserUid: currentUserUid,
                roster: sessionStore.teamMembers
            )
            .compactMap { ActivityItem(bookingRequest: $0) }
        rows.append(contentsOf: requests)

        let sms = sessionStore.visibleSmsThreads(
            teamAccess: teamAccess,
            currentUserUid: currentUserUid
        )
        .filter { ($0.lastMessageAt ?? .distantPast) > smsSeenAt }
        .map { ActivityItem(smsThread: $0, isUnread: true) }
        rows.append(contentsOf: sms)

        if sessionStore.isShopEnabled || !sessionStore.shopOrders.isEmpty {
            let shop = sessionStore.shopOrders
                .compactMap { ActivityItem(shopOrder: $0) }
                .filter(\.isUnread)
            rows.append(contentsOf: shop)
        }

        if teamAccess.isOwner || teamAccess.canTakePayments {
            let payments = sessionStore.recentPayments
                .filter { ($0.createdAt ?? .distantPast) > paymentsSeenAt }
                .compactMap { ActivityItem(payment: $0, isUnread: true) }
            rows.append(contentsOf: payments)
        }

        return rows.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }
}

// MARK: - Bell

struct NotificationCenterBell: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    var drawerState: DrawerState

    private var unreadCount: Int {
        ActivityFeed.items(
            from: sessionStore,
            teamAccess: authViewModel.teamAccess,
            currentUserUid: authViewModel.currentUserUid,
            smsSeenAt: ActivitySeenStore.date(forKey: ActivitySeenStore.smsKey),
            paymentsSeenAt: ActivitySeenStore.date(forKey: ActivitySeenStore.paymentsKey)
        )
        .filter(\.isUnread)
        .count
    }

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                drawerState.openActivityDrawer()
            }
        } label: {
            // Badge stays inside a reserved frame so the nav bar cannot clip it.
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                    .foregroundStyle(AppDesign.textPrimary)
                    .frame(width: 30, height: 24)
                AppDrawerBadge(count: unreadCount)
                    .scaleEffect(0.8)
            }
            .frame(width: 30, height: 24)
        }
        .accessibilityLabel(
            unreadCount > 0 ? "Activity, \(unreadCount) unread" : "Activity"
        )
    }
}

// MARK: - Right drawer panel

struct ActivityDrawerPanel: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    var drawerState: DrawerState
    /// Watermarks frozen when the panel opens so unread dots stay visible during this visit.
    @State private var displaySmsSeenAt: Date = ActivitySeenStore.date(forKey: ActivitySeenStore.smsKey)
    @State private var displayPaymentsSeenAt: Date = ActivitySeenStore.date(forKey: ActivitySeenStore.paymentsKey)

    private var items: [ActivityItem] {
        ActivityFeed.items(
            from: sessionStore,
            teamAccess: authViewModel.teamAccess,
            currentUserUid: authViewModel.currentUserUid,
            smsSeenAt: displaySmsSeenAt,
            paymentsSeenAt: displayPaymentsSeenAt
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Text("Activity")
                    .font(.headline)
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer(minLength: 0)
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        drawerState.closeActivityDrawer()
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.medium))
                        .foregroundStyle(AppDesign.textSecondary)
                }
                .accessibilityLabel("Close activity")
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 16)

            if items.isEmpty {
                emptyState
                Spacer(minLength: 0)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            ActivityRow(
                                item: item,
                                showsDivider: index < items.count - 1
                            ) {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    item.route.apply(to: drawerState)
                                }
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(AppDesign.cardBackground)
        .onAppear {
            displaySmsSeenAt = ActivitySeenStore.date(forKey: ActivitySeenStore.smsKey)
            displayPaymentsSeenAt = ActivitySeenStore.date(forKey: ActivitySeenStore.paymentsKey)
            ActivitySeenStore.markSeen(key: ActivitySeenStore.smsKey)
            ActivitySeenStore.markSeen(key: ActivitySeenStore.paymentsKey)
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
    let showsDivider: Bool
    var onTap: () -> Void

    var body: some View {
        VStack(spacing: 0) {
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

            if showsDivider {
                Divider()
                    .overlay(AppDesign.chipBorder.opacity(0.5))
                    .padding(.leading, 64)
            }
        }
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
