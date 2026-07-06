//
//  ShopManagerView.swift
//
//  Drawer shop manager: stats, catalog / orders / analytics tabs (shop manager mockup).
//

import SwiftUI
import PhotosUI
import UIKit

// MARK: - Hub

private enum ShopManagerTab: String, CaseIterable, Identifiable {
    case catalog
    case orders
    case analytics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .catalog: return "Catalog"
        case .orders: return "Orders"
        case .analytics: return "Analytics"
        }
    }
}

struct ShopManagerView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DesignViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    @State private var selectedTab: ShopManagerTab = .catalog
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    shopHeader

                    if let msg = viewModel.errorMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    statsRow
                    tabPicker
                    tabContent
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle("")
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
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .onReceive(NotificationCenter.default.publisher(for: .tenantLogoDidChange)) { note in
                if let url = note.userInfo?["logoUrl"] as? String {
                    viewModel.syncLogoUrlFromExternal(url)
                }
            }
            .sheet(isPresented: $showSettings) {
                ShopSettingsSheet(viewModel: viewModel, drawerState: drawerState)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private var shopHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("MY SHOP")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .tracking(0.8)
            Text("My shop")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(AppDesign.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    private var statsRow: some View {
        HStack(spacing: 10) {
            ShopStatTile(
                value: viewModel.shopOrders.isEmpty ? "—" : String(format: "$%.0f", Double(viewModel.shopOrdersRevenueCents) / 100.0),
                caption: "Revenue",
                valueColor: AppDesign.accentBlue
            )
            ShopStatTile(
                value: viewModel.shopOrders.isEmpty ? "—" : "\(viewModel.shopOrders.count)",
                caption: "Orders",
                valueColor: AppDesign.accentRed
            )
            ShopStatTile(
                value: "\(viewModel.products.count)",
                caption: "Products",
                valueColor: AppDesign.textPrimary
            )
        }
    }

    private var tabPicker: some View {
        HStack(spacing: 0) {
            ForEach(ShopManagerTab.allCases) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        selectedTab = tab
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(tab.title)
                        if tab == .orders, viewModel.shopUnreadOrderCount > 0 {
                            Text("\(viewModel.shopUnreadOrderCount)")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(AppDesign.accentRed)
                                .clipShape(Capsule())
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(selectedTab == tab ? AppDesign.textPrimary : AppDesign.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(selectedTab == tab ? AppDesign.cardBackground : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .catalog:
            ShopProductCatalogContent(viewModel: viewModel, style: .hub)
        case .orders:
            ShopOrdersTabContent(viewModel: viewModel, drawerState: drawerState)
        case .analytics:
            ShopAnalyticsTabContent(viewModel: viewModel)
        }
    }
}

// MARK: - Analytics tab

private struct ShopAnalyticsTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var selectedRange: ShopAnalyticsRange = .days30

    private var snapshot: ShopAnalyticsSnapshot {
        ShopAnalyticsSnapshot.build(orders: viewModel.shopOrders, range: selectedRange)
    }

    private var maxDailyRevenue: Int {
        snapshot.dailyRevenue.map(\.revenueCents).max() ?? 0
    }

    private var maxProductRevenue: Int {
        snapshot.topProducts.map(\.revenueCents).max() ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ShopAnalyticsRange.allCases) { range in
                        let selected = selectedRange == range
                        Button {
                            selectedRange = range
                        } label: {
                            Text(range.chipLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(selected ? AppDesign.chipSelectedForeground : AppDesign.textPrimary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(selected ? AppDesign.chipSelectedBackground : AppDesign.cardBackground)
                                .clipShape(Capsule())
                                .overlay(
                                    Capsule()
                                        .stroke(selected ? Color.clear : AppDesign.chipBorder, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if viewModel.shopOrders.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("No shop data yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Analytics appear after your first shop order.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
            } else {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ShopAnalyticsMetricTile(title: "Revenue", value: snapshot.formattedTotalRevenue, tint: AppDesign.accentBlue)
                    ShopAnalyticsMetricTile(title: "Orders", value: "\(snapshot.orderCount)", tint: AppDesign.accentRed)
                    ShopAnalyticsMetricTile(title: "Avg order", value: snapshot.orderCount > 0 ? snapshot.formattedAverageOrder : "—", tint: AppDesign.textPrimary)
                    ShopAnalyticsMetricTile(title: "Fulfilled", value: snapshot.formattedFulfillmentRate, tint: AppDesign.accentGreen)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Revenue")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    if snapshot.dailyRevenue.isEmpty {
                        Text("No revenue in this period.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(snapshot.dailyRevenue) { row in
                            ShopAnalyticsBarRow(
                                label: row.label,
                                valueLabel: row.revenueCents > 0 ? row.formattedRevenue : "—",
                                value: row.revenueCents,
                                maxValue: max(maxDailyRevenue, 1)
                            )
                        }
                    }
                }
                .padding(14)
                .appCard()

                VStack(alignment: .leading, spacing: 12) {
                    Text("Top products")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    if snapshot.topProducts.isEmpty {
                        Text("No product sales in this period.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(snapshot.topProducts) { product in
                            ShopAnalyticsBarRow(
                                label: product.name,
                                valueLabel: product.formattedRevenue,
                                value: product.revenueCents,
                                maxValue: max(maxProductRevenue, 1)
                            )
                        }
                    }
                }
                .padding(14)
                .appCard()

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Order status")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                    }
                    HStack(spacing: 8) {
                        ShopAnalyticsStatusChip(label: "Pending", count: snapshot.pendingCount, color: AppDesign.brandWarm)
                        ShopAnalyticsStatusChip(label: "Fulfilled", count: snapshot.fulfilledCount, color: AppDesign.accentGreen)
                        ShopAnalyticsStatusChip(label: "Cancelled", count: snapshot.cancelledCount, color: AppDesign.textSecondary)
                    }
                }
                .padding(14)
                .appCard()

                ShareLink(item: snapshot.exportCSV(orders: viewModel.shopOrders)) {
                    Label("Export CSV", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.plain)
                .appCard()

                Text("Revenue is estimated from order totals. Paid checkout and site traffic tracking coming in a later update.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct ShopAnalyticsMetricTile: View {
    let title: String
    let value: String
    var tint: Color = AppDesign.textPrimary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .appCard()
    }
}

private struct ShopAnalyticsBarRow: View {
    let label: String
    let valueLabel: String
    let value: Int
    let maxValue: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineLimit(1)
                Spacer()
                Text(valueLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
            GeometryReader { geo in
                let width = maxValue > 0 ? geo.size.width * CGFloat(value) / CGFloat(maxValue) : 0
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(AppDesign.searchBackground)
                        .frame(height: 8)
                    Capsule()
                        .fill(AppDesign.chartBarFill)
                        .frame(width: max(value > 0 ? 8 : 0, width), height: 8)
                }
            }
            .frame(height: 8)
        }
    }
}

private struct ShopAnalyticsStatusChip: View {
    let label: String
    let count: Int
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text("\(count)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(AppDesign.searchBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Orders tab

private enum ShopOrderFilter: String, CaseIterable, Identifiable {
    case all
    case new
    case pending
    case fulfilled
    case cancelled

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .new: return "New"
        case .pending: return "Pending"
        case .fulfilled: return "Fulfilled"
        case .cancelled: return "Cancelled"
        }
    }

    func matches(_ order: ShopOrder) -> Bool {
        switch self {
        case .all: return true
        case .new:
            let s = order.statusLower
            return (s == ShopOrderStatus.pending || s == ShopOrderStatus.paid) && order.readAt == nil
        case .pending:
            let s = order.statusLower
            return s == ShopOrderStatus.pending || s == ShopOrderStatus.paid
        case .fulfilled: return order.statusLower == ShopOrderStatus.fulfilled
        case .cancelled: return order.statusLower == ShopOrderStatus.cancelled
        }
    }
}

private struct ShopOrdersTabContent: View {
    @ObservedObject var viewModel: DesignViewModel
    var drawerState: DrawerState
    @State private var searchText = ""
    @State private var filter: ShopOrderFilter = .all
    @State private var selectedOrder: ShopOrder?

    private var filteredOrders: [ShopOrder] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return viewModel.shopOrders.filter { order in
            guard filter.matches(order) else { return false }
            guard !q.isEmpty else { return true }
            if order.displayCustomerName.lowercased().contains(q) { return true }
            if (order.notes ?? "").lowercased().contains(q) { return true }
            return order.lineItems.contains {
                $0.name.lowercased().contains(q)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AppSearchField(placeholder: "Search orders", text: $searchText)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ShopOrderFilter.allCases) { item in
                        let selected = filter == item
                        Button {
                            filter = item
                        } label: {
                            Text(item.title)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(selected ? AppDesign.chipSelectedForeground : AppDesign.textPrimary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(selected ? AppDesign.chipSelectedBackground : AppDesign.cardBackground)
                                .clipShape(Capsule())
                                .overlay(
                                    Capsule()
                                        .stroke(selected ? Color.clear : AppDesign.chipBorder, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if viewModel.shopOrders.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "shippingbox")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("No orders yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Orders appear when customers checkout from your shop.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
            } else if filteredOrders.isEmpty {
                Text("No orders match your search.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else {
                ForEach(filteredOrders) { order in
                    ShopHubOrderRow(order: order) {
                        selectedOrder = order
                    }
                }
            }

            if !viewModel.shopOrders.isEmpty {
                Text("\(filteredOrders.count) of \(viewModel.shopOrders.count) orders")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 4)
            }
        }
        .sheet(item: $selectedOrder) { order in
            ShopOrderDetailSheet(viewModel: viewModel, order: order, drawerState: drawerState)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct ShopHubOrderRow: View {
    let order: ShopOrder
    let onTap: () -> Void

    private var createdLabel: String {
        guard let created = order.createdAt else { return "" }
        let interval = Date().timeIntervalSince(created)
        if interval < 3600 { return "\(max(1, Int(interval / 60)))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return created.formatted(.dateTime.month(.abbreviated).day())
    }

    private var statusColors: (foreground: Color, background: Color) {
        switch order.statusLower {
        case ShopOrderStatus.pending:
            return (AppDesign.brandWarm, AppDesign.brandCream)
        case ShopOrderStatus.paid:
            return (AppDesign.accentGreen, AppDesign.accentGreen.opacity(0.14))
        case ShopOrderStatus.fulfilled:
            return (AppDesign.accentGreen, AppDesign.accentGreen.opacity(0.14))
        case ShopOrderStatus.cancelled:
            return (AppDesign.textSecondary, AppDesign.searchBackground)
        default:
            return (AppDesign.textSecondary, AppDesign.searchBackground)
        }
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                if order.isUnread && (order.statusLower == ShopOrderStatus.pending || order.statusLower == ShopOrderStatus.paid) {
                    Circle()
                        .fill(AppDesign.accentBlue)
                        .frame(width: 8, height: 8)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(order.displayCustomerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                        .lineLimit(1)
                    Text(order.itemSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !createdLabel.isEmpty {
                        Text(createdLabel)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 8) {
                    Text(order.formattedTotal)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(ShopOrderStatus.displayLabel(for: order.status))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(statusColors.foreground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(statusColors.background)
                        .clipShape(Capsule())
                }
            }
            .padding(12)
            .appCard()
        }
        .buttonStyle(.plain)
    }
}

private struct ShopOrderDetailSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    let order: ShopOrder
    var drawerState: DrawerState
    @Environment(\.dismiss) private var dismiss
    @State private var contactInAddressBook = false
    @State private var contactCheckDone = false
    @State private var contactSaved = false

    private var currentOrder: ShopOrder {
        viewModel.shopOrders.first(where: { $0.id == order.id }) ?? order
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(currentOrder.formattedTotal)
                                .font(.title2.weight(.bold))
                            Spacer()
                            AppStatusPill(
                                text: ShopOrderStatus.displayLabel(for: currentOrder.status),
                                soft: true
                            )
                        }
                        if let created = currentOrder.createdAt {
                            Text(created.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if currentOrder.hasCustomerContact {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("CONTACT")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            if let name = currentOrder.customerName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                                Label(name, systemImage: "person.fill")
                                    .font(.subheadline)
                            }
                            if let email = currentOrder.customerEmail?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty {
                                Label(email, systemImage: "envelope.fill")
                                    .font(.subheadline)
                            }
                            if let phone = currentOrder.customerPhone?.trimmingCharacters(in: .whitespacesAndNewlines), !phone.isEmpty {
                                Label(phone, systemImage: "phone.fill")
                                    .font(.subheadline)
                            }
                            if contactCheckDone && !contactInAddressBook {
                                Button {
                                    Task {
                                        contactSaved = await viewModel.addShopOrderCustomerToContacts(currentOrder)
                                        if contactSaved { contactInAddressBook = true }
                                    }
                                } label: {
                                    Label("Add to contacts", systemImage: "person.crop.circle.badge.plus")
                                        .font(.subheadline.weight(.medium))
                                }
                            } else if contactInAddressBook || contactSaved {
                                Label("Saved to contacts", systemImage: "checkmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.accentGreen)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .appCard()
                    }

                    if !currentOrder.lineItems.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ITEMS")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            ForEach(currentOrder.lineItems) { item in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.name)
                                            .font(.subheadline.weight(.medium))
                                        Text("\(item.qty) × \(item.formattedUnitPrice)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(item.formattedLineTotal)
                                        .font(.subheadline.weight(.semibold))
                                }
                            }
                        }
                        .padding(14)
                        .appCard()
                    }

                    if let notes = currentOrder.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("NOTES")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(notes)
                                .font(.subheadline)
                                .foregroundStyle(AppDesign.textPrimary)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .appCard()
                    }

                    if currentOrder.statusLower == ShopOrderStatus.pending || currentOrder.statusLower == ShopOrderStatus.paid {
                        VStack(spacing: 10) {
                            Button {
                                Task {
                                    await viewModel.updateShopOrderStatus(currentOrder, status: ShopOrderStatus.fulfilled)
                                }
                            } label: {
                                Text("Mark fulfilled")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(AppPrimaryButtonStyle())

                            Button(role: .destructive) {
                                Task {
                                    await viewModel.updateShopOrderStatus(currentOrder, status: ShopOrderStatus.cancelled)
                                }
                            } label: {
                                Text("Cancel order")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .appScreenBackground()
            .navigationTitle("Order")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await viewModel.markShopOrderRead(currentOrder)
                if currentOrder.hasCustomerContact {
                    contactInAddressBook = await viewModel.isShopOrderCustomerInContacts(currentOrder)
                    contactCheckDone = true
                }
            }
        }
    }
}

// MARK: - Settings sheet

private struct ShopSettingsSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    var drawerState: DrawerState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 0) {
                        Toggle(isOn: $viewModel.shopEnabled) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Shop page enabled")
                                    .font(.body.weight(.medium))
                                Text("Visible at /shop on your site")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .tint(.green)
                        .disabled(!viewModel.hasTenant || viewModel.isLoading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .onChange(of: viewModel.shopEnabled) { _, _ in
                            Task { await viewModel.savePublicPageVisibility() }
                        }

                        Divider().padding(.leading, 14)

                        NavigationLink {
                            ShopComingSoonView(
                                title: "Store settings",
                                tint: .gray,
                                bullets: [
                                    "Currency & locale",
                                    "Shipping zones & rates",
                                    "Policies (returns, privacy)",
                                    "Shop URL & branding",
                                ]
                            )
                        } label: {
                            HStack(alignment: .center, spacing: 12) {
                                Image(systemName: "gearshape.fill")
                                    .font(.body)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 28, alignment: .center)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Store settings")
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(Color.primary)
                                    Text("Currency, shipping, policies")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        Divider().padding(.leading, 14)

                        Button {
                            dismiss()
                            drawerState.selectedSection = .payments
                            drawerState.isOpen = false
                        } label: {
                            HStack(alignment: .center, spacing: 12) {
                                Image(systemName: "creditcard.fill")
                                    .font(.body)
                                    .foregroundStyle(.orange)
                                    .frame(width: 28, alignment: .center)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Payments")
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(Color.primary)
                                    Text("Stripe, payouts, tax")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .appCard()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .appScreenBackground()
            .navigationTitle("Shop settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Stat tile

private struct ShopStatTile: View {
    let value: String
    let caption: String
    var valueColor: Color = AppDesign.textPrimary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(valueColor)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .appCard()
    }
}

// MARK: - Inline coming soon (tab content)

private struct ShopInlineComingSoon: View {
    let title: String
    let tint: Color
    let bullets: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "clock.badge.checkmark")
                    .font(.title3)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(title) coming soon")
                        .font(.headline)
                    Text("We're building this next.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(bullets, id: \.self) { line in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(tint.opacity(0.35))
                            .frame(width: 6, height: 6)
                            .padding(.top, 6)
                        Text(line)
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .appCard()
    }
}

// MARK: - Coming soon detail (pushed)

struct ShopComingSoonView: View {
    let title: String
    let tint: Color
    let bullets: [String]

    var body: some View {
        List {
            Section {
                Text("We're building this next. Planned capabilities:")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
            Section("Planned") {
                ForEach(bullets, id: \.self) { line in
                    Label {
                        Text(line)
                    } icon: {
                        Image(systemName: "circle.fill")
                            .font(.caption2)
                    }
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .tint(tint)
    }
}

// MARK: - Catalog presentation

private enum ShopCatalogStyle {
    case hub
    case embeddedManage
    case standalone
}

private struct ShopProductCatalogContent: View {
    @ObservedObject var viewModel: DesignViewModel
    var style: ShopCatalogStyle

    @State private var searchText = ""
    @State private var showProductForm = false
    @State private var editingProduct: Product?

    private var filteredProducts: [Product] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return viewModel.products }
        return viewModel.products.filter {
            $0.name.lowercased().contains(query)
                || $0.category.lowercased().contains(query)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if style == .hub {
                catalogToolbar
            } else if !viewModel.shopEnabled && style == .standalone {
                ContentUnavailableView {
                    Label("Shop page is off", systemImage: "bag")
                } description: {
                    Text("Turn on Shop page enabled in Shop settings or Web Page Design → Shop.")
                }
            } else {
                if style == .embeddedManage {
                    embeddedIntro
                } else {
                    Text("Products on your site: name, photo, price, categories, and visibility.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if style != .standalone || viewModel.shopEnabled {
                productList
            }

            if style == .hub {
                Text("\(filteredProducts.count) of \(viewModel.products.count) products")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 4)
            }
        }
        .sheet(isPresented: $showProductForm) {
            ShopProductFormSheet(
                viewModel: viewModel,
                editingProduct: editingProduct,
                onDismiss: {
                    showProductForm = false
                    editingProduct = nil
                }
            )
            .presentationDetents([.large, .medium])
            .presentationDragIndicator(.visible)
        }
    }

    private var catalogToolbar: some View {
        HStack(spacing: 10) {
            AppSearchField(placeholder: "Search products", text: $searchText)
            Button {
                editingProduct = nil
                showProductForm = true
            } label: {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(shopAccentPurple)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add product")
        }
    }

    @ViewBuilder
    private var embeddedIntro: some View {
        EmptyView()
    }

    @ViewBuilder
    private var productList: some View {
        if viewModel.products.isEmpty && !viewModel.isUploadingProduct {
            VStack(spacing: 12) {
                Image(systemName: "bag")
                    .font(.system(size: style == .embeddedManage ? 28 : 36))
                    .foregroundStyle(.secondary)
                Text("No products yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if style == .hub {
                    Button("Add your first product") {
                        editingProduct = nil
                        showProductForm = true
                    }
                    .font(.subheadline.weight(.medium))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, style == .embeddedManage ? 16 : 28)
        }

        ForEach(filteredProducts) { product in
            if style == .hub {
                ShopHubProductRow(product: product) {
                    editingProduct = product
                    showProductForm = true
                }
            } else {
                ShopManageProductRow(product: product) {
                    Task { await viewModel.deleteProduct(product) }
                }
            }
        }

        if viewModel.isUploadingProduct {
            HStack {
                ProgressView()
                Text("Saving product…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        if style != .hub {
            Button {
                editingProduct = nil
                showProductForm = true
            } label: {
                Label("Add Product", systemImage: "plus.circle.fill")
                    .font(.subheadline.weight(.medium))
            }
        }
    }
}

private let shopAccentPurple = Color(red: 0.52, green: 0.34, blue: 0.84)

// MARK: - Hub product row

private struct ShopHubProductRow: View {
    let product: Product
    let onEdit: () -> Void

    private var statusLabel: String {
        product.isActive ? "Active" : "Hidden"
    }

    private var statusColors: (foreground: Color, background: Color) {
        product.isActive
            ? (AppDesign.accentGreen, AppDesign.accentGreen.opacity(0.14))
            : (AppDesign.textSecondary, AppDesign.searchBackground)
    }

    var body: some View {
        HStack(spacing: 12) {
            productThumb
            VStack(alignment: .leading, spacing: 4) {
                Text(product.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                    .lineLimit(1)
                Text(productSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(formattedPrice)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 8) {
                Text(statusLabel)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(statusColors.foreground)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColors.background)
                    .clipShape(Capsule())
                Button("Edit", action: onEdit)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(shopAccentPurple)
            }
        }
        .padding(12)
        .appCard()
    }

    private var productSubtitle: String {
        if !product.category.isEmpty {
            return product.category
        }
        return product.isActive ? "Listed on your site" : "Not visible on site"
    }

    private var formattedPrice: String {
        if let sale = product.salePrice {
            return "$\(String(format: "%.2f", sale))"
        }
        return "$\(String(format: "%.2f", product.price))"
    }

    @ViewBuilder
    private var productThumb: some View {
        if !product.imageUrl.isEmpty, let url = URL(string: product.imageUrl) {
            AsyncImage(url: url) { img in
                img.resizable().scaledToFill()
            } placeholder: {
                Color(.systemGray5)
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.systemGray5))
                .frame(width: 52, height: 52)
                .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
        }
    }
}

// MARK: - Manage / legacy product row

private struct ShopManageProductRow: View {
    let product: Product
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if !product.imageUrl.isEmpty, let url = URL(string: product.imageUrl) {
                AsyncImage(url: url) { img in
                    img.resizable().scaledToFill()
                } placeholder: {
                    Color(.systemGray5)
                }
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.systemGray5))
                    .frame(width: 56, height: 56)
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(product.name).font(.subheadline.weight(.medium))
                    if !product.isActive {
                        Text("Hidden")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(.systemGray5))
                            .clipShape(Capsule())
                    }
                }
                if !product.category.isEmpty {
                    Text(product.category).font(.caption).foregroundStyle(.secondary)
                }
                Text("$\(String(format: "%.2f", product.price))")
                    .font(.caption.weight(.semibold))
            }
            Spacer()
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "trash").font(.caption).foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Catalog (navigation wrapper)

struct ShopCatalogView: View {
    @ObservedObject var viewModel: DesignViewModel
    var embeddedInDesignManage: Bool = false

    var body: some View {
        Group {
            if embeddedInDesignManage {
                ShopProductCatalogContent(viewModel: viewModel, style: .embeddedManage)
                    .padding(14)
                    .appCard()
            } else if !viewModel.shopEnabled {
                ScrollView {
                    ShopProductCatalogContent(viewModel: viewModel, style: .standalone)
                        .padding(16)
                }
                .appScreenBackground()
            } else {
                ScrollView {
                    ShopProductCatalogContent(viewModel: viewModel, style: .standalone)
                        .padding(16)
                }
                .appScreenBackground()
            }
        }
        .navigationTitle(embeddedInDesignManage ? "" : "Catalog")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Add / edit product sheet

private struct ShopProductFormSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    var editingProduct: Product?
    let onDismiss: () -> Void

    @State private var name = ""
    @State private var category = ""
    @State private var description = ""
    @State private var price = ""
    @State private var isVisible = true
    @State private var imageItem: PhotosPickerItem? = nil
    @State private var imageData: Data? = nil
    @State private var cropItem: SingleImageCropSheetItem?
    @State private var showPhotoLoadError = false
    @State private var showDeleteConfirm = false

    private var isEditing: Bool { editingProduct != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(UploadImageAdvice.product)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    PhotosPicker(selection: $imageItem, matching: .images) {
                        productPhotoPicker
                    }
                    .buttonStyle(.plain)
                    .onChange(of: imageItem) { _, item in
                        Task { await loadPhoto(from: item) }
                    }

                    shopSheetSectionHeader("Product info")
                    VStack(spacing: 0) {
                        shopSheetLabeledField(title: "Name") {
                            TextField("Product name", text: $name)
                                .textInputAutocapitalization(.words)
                        }
                        Divider().padding(.leading, 16)
                        shopSheetLabeledField(title: "Category") {
                            TextField("e.g. Shampoo", text: $category)
                                .textInputAutocapitalization(.words)
                        }
                        Divider().padding(.leading, 16)
                        shopSheetLabeledField(title: "Description") {
                            TextField("Optional", text: $description, axis: .vertical)
                                .lineLimit(2...4)
                                .textInputAutocapitalization(.sentences)
                        }
                    }
                    .appCard()

                    shopSheetSectionHeader("Pricing")
                    VStack(alignment: .leading, spacing: 8) {
                        Text("PRICE")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("$")
                                .font(.title3.weight(.medium))
                                .foregroundStyle(.secondary)
                            TextField("0.00", text: $price)
                                .keyboardType(.decimalPad)
                                .font(.title3.weight(.medium))
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .appCard()

                    Toggle(isOn: $isVisible) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Visible on site")
                                .font(.body)
                            Text("Show in your shop section.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tint(.green)

                    if isEditing {
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Text("Delete product")
                                .frame(maxWidth: .infinity)
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
            .scrollDismissesKeyboard(.interactively)
            .appScreenBackground()
            .navigationTitle(isEditing ? "Edit product" : "New product")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save" : "Add") {
                        Task { await save() }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear(perform: populateFromEditingProduct)
            .sheet(item: $cropItem, onDismiss: { cropItem = nil }) { item in
                UploadImagePreparationSheet(
                    images: [item.image],
                    advice: UploadImageAdvice.product,
                    navigationTitle: "Product photo",
                    allowedChoices: UploadCropPresetMenu.product,
                    defaultChoice: .square,
                    onUseJPEGData: { dataList in
                        imageData = dataList.first
                        cropItem = nil
                    }
                )
            }
            .alert("Couldn't load photo", isPresented: $showPhotoLoadError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Try again or choose a different image from your library.")
            }
            .confirmationDialog(
                "Delete this product?",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    guard let product = editingProduct else { return }
                    Task {
                        await viewModel.deleteProduct(product)
                        onDismiss()
                    }
                }
            }
        }
    }

    private var productPhotoPicker: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
            if let data = imageData, let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .frame(height: 200)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(8)
            } else if let urlString = editingProduct?.imageUrl,
                      !urlString.isEmpty,
                      imageData == nil,
                      let url = URL(string: urlString) {
                AsyncImage(url: url) { img in
                    img.resizable().scaledToFill()
                } placeholder: {
                    ProgressView()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 200)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(8)
            } else {
                dashedPhotoPlaceholder
            }
        }
        .frame(height: 200)
        .contentShape(Rectangle())
    }

    private var dashedPhotoPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color(.systemGray3), style: StrokeStyle(lineWidth: 1.5, dash: [7, 5]))
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                )
            VStack(spacing: 10) {
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Add photo")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func populateFromEditingProduct() {
        guard let product = editingProduct else { return }
        name = product.name
        category = product.category
        description = product.description
        price = String(format: "%.2f", product.price)
        isVisible = product.isActive
    }

    private func loadPhoto(from item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self),
              !data.isEmpty,
              let uiImage = UIImage(data: data) else {
            await MainActor.run {
                imageItem = nil
                showPhotoLoadError = true
            }
            return
        }
        await MainActor.run {
            cropItem = SingleImageCropSheetItem(image: uiImage)
            imageItem = nil
        }
    }

    private func save() async {
        let parsedPrice = Double(price.trimmingCharacters(in: .whitespaces)) ?? 0
        if let product = editingProduct {
            await viewModel.updateProduct(
                product,
                name: name,
                category: category,
                description: description,
                price: parsedPrice,
                salePrice: product.salePrice,
                imageData: imageData,
                isActive: isVisible
            )
        } else {
            await viewModel.addProduct(
                name: name,
                category: category,
                description: description,
                price: parsedPrice,
                salePrice: nil,
                imageData: imageData,
                isActive: isVisible
            )
        }
        onDismiss()
    }

    private func shopSheetSectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shopSheetLabeledField<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(.secondaryLabel))
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
