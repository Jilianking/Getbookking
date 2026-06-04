//
//  ShopManagerView.swift
//
//  Shop hub: stats, manage destinations, settings (matches shop manager mockup).
//

import SwiftUI
import PhotosUI
import UIKit

// MARK: - Hub

struct ShopManagerView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DesignViewModel()
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let msg = viewModel.errorMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    statsRow

                    sectionLabel("MANAGE")
                    manageCard

                    sectionLabel("SETTINGS")
                    settingsCard
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .appScreenBackground()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
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
        }
    }

    private var statsRow: some View {
        HStack(spacing: 10) {
            ShopStatTile(value: "—", caption: "This month")
            ShopStatTile(value: "—", caption: "Orders")
            ShopStatTile(value: "\(viewModel.products.count)", caption: "Products")
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .tracking(0.6)
    }

    private var manageCard: some View {
        VStack(spacing: 0) {
            NavigationLink {
                ShopCatalogView(viewModel: viewModel)
            } label: {
                ShopManageRow(
                    icon: "square.grid.2x2.fill",
                    iconColor: .purple,
                    title: "Catalog",
                    subtitle: "Products, variants, visibility",
                    trailing: .count(viewModel.products.count)
                )
            }
            .buttonStyle(.plain)

            Divider().padding(.leading, 54)

            NavigationLink {
                ShopComingSoonView(
                    title: "Orders",
                    tint: .green,
                    bullets: [
                        "Order list (status, date, total)",
                        "Order detail & line items",
                        "Fulfillment & shipping",
                        "Refunds & cancellations",
                    ]
                )
            } label: {
                ShopManageRow(
                    icon: "shippingbox.fill",
                    iconColor: .green,
                    title: "Orders",
                    subtitle: "Fulfillment, refunds",
                    trailing: .badge("2 new", .red)
                )
            }
            .buttonStyle(.plain)

            Divider().padding(.leading, 54)

            Button {
                drawerState.selectedSection = .payments
                drawerState.isOpen = false
            } label: {
                ShopManageRow(
                    icon: "creditcard.fill",
                    iconColor: .orange,
                    title: "Payments",
                    subtitle: "Stripe, payouts, tax",
                    trailing: .badge("Connected", .green)
                )
            }
            .buttonStyle(.plain)

            Divider().padding(.leading, 54)

            Button {
                drawerState.selectedSection = .clients
                drawerState.isOpen = false
            } label: {
                ShopManageRow(
                    icon: "person.2.fill",
                    iconColor: Color(red: 0.85, green: 0.45, blue: 0.35),
                    title: "Customers",
                    subtitle: "Buyers, order history",
                    trailing: .countPlaceholder
                )
            }
            .buttonStyle(.plain)

            Divider().padding(.leading, 54)

            NavigationLink {
                ShopComingSoonView(
                    title: "Marketing",
                    tint: .brown,
                    bullets: [
                        "Discount codes & promos",
                        "Featured products",
                        "Social sharing links",
                        "Abandoned cart follow-up",
                    ]
                )
            } label: {
                ShopManageRow(
                    icon: "megaphone.fill",
                    iconColor: .brown,
                    title: "Marketing",
                    subtitle: "Discounts, promos, featured",
                    trailing: .chevronOnly
                )
            }
            .buttonStyle(.plain)

            Divider().padding(.leading, 54)

            Button {
                drawerState.selectedSection = .insights
                drawerState.isOpen = false
            } label: {
                ShopManageRow(
                    icon: "chart.line.uptrend.xyaxis",
                    iconColor: .blue,
                    title: "Analytics",
                    subtitle: "Revenue, top products",
                    trailing: .chevronOnly
                )
            }
            .buttonStyle(.plain)
        }
        .appCard()
    }

    private var settingsCard: some View {
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
        }
        .appCard()
    }
}

// MARK: - Stat tile

private struct ShopStatTile: View {
    let value: String
    let caption: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.primary)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .appCard()
    }
}

// MARK: - Manage row

private enum ShopManageTrailing {
    case count(Int)
    case countPlaceholder
    case badge(String, Color)
    case chevronOnly
}

private struct ShopManageRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let trailing: ShopManageTrailing

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(iconColor)
                .frame(width: 28, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            trailingView
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var trailingView: some View {
        switch trailing {
        case .count(let n):
            Text("\(n)")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        case .countPlaceholder:
            Text("—")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.tertiary)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        case .badge(let text, let color):
            Text(text)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(color.opacity(0.15))
                .foregroundStyle(color)
                .clipShape(Capsule())
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.leading, 4)
        case .chevronOnly:
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Coming soon detail

private struct ShopComingSoonView: View {
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

// MARK: - Catalog (products)

struct ShopCatalogView: View {
    @ObservedObject var viewModel: DesignViewModel
    @State private var showAddProduct = false
    @State private var newProductName = ""
    @State private var newProductCategory = ""
    @State private var newProductDescription = ""
    @State private var newProductPrice = ""
    @State private var newProductSalePrice = ""
    @State private var newProductVisible = true
    @State private var newProductImageItem: PhotosPickerItem? = nil
    @State private var newProductImageData: Data? = nil
    @State private var newProductCropItem: SingleImageCropSheetItem?

    var body: some View {
        Group {
            if !viewModel.shopEnabled {
                ContentUnavailableView {
                    Label("Shop page is off", systemImage: "bag")
                } description: {
                    Text("Turn on Shop page enabled in Shop settings or Web Page Design → Shop.")
                }
            } else {
                catalogList
            }
        }
        .navigationTitle("Catalog")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAddProduct) {
            addProductSheet
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $newProductCropItem, onDismiss: { newProductCropItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: UploadImageAdvice.product,
                navigationTitle: "Product photo",
                allowedChoices: UploadCropPresetMenu.product,
                defaultChoice: .square,
                onUseJPEGData: { dataList in
                    newProductImageData = dataList.first
                    newProductCropItem = nil
                }
            )
        }
    }

    private var catalogList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Products on your site: name, photo, price, sale price, categories, visibility, and variants (variants coming soon).")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if viewModel.products.isEmpty && !viewModel.isUploadingProduct {
                    VStack(spacing: 12) {
                        Image(systemName: "bag")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text("No products yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 28)
                }

                ForEach(viewModel.products) { product in
                    productRow(product)
                }

                if viewModel.isUploadingProduct {
                    HStack {
                        ProgressView()
                        Text("Adding product…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Button {
                    showAddProduct = true
                } label: {
                    Label("Add Product", systemImage: "plus.circle.fill")
                        .font(.subheadline.weight(.medium))
                }
            }
            .padding(16)
        }
        .appScreenBackground()
    }

    private func productRow(_ product: Product) -> some View {
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
                HStack(spacing: 6) {
                    if let sp = product.salePrice {
                        Text("$\(String(format: "%.2f", sp))").font(.caption.weight(.semibold)).foregroundStyle(.red)
                        Text("$\(String(format: "%.2f", product.price))").font(.caption).strikethrough().foregroundStyle(.secondary)
                    } else {
                        Text("$\(String(format: "%.2f", product.price))").font(.caption.weight(.semibold))
                    }
                }
            }
            Spacer()
            Button(role: .destructive) {
                Task { await viewModel.deleteProduct(product) }
            } label: {
                Image(systemName: "trash").font(.caption).foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var addProductSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(UploadImageAdvice.product)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    PhotosPicker(selection: $newProductImageItem, matching: .images) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color(.secondarySystemGroupedBackground))
                            if let data = newProductImageData, let uiImage = UIImage(data: data) {
                                Image(uiImage: uiImage)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 200)
                                    .clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .padding(8)
                            } else {
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
                        }
                        .frame(height: 200)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onChange(of: newProductImageItem) { _, item in
                        Task {
                            guard let item else { return }
                            guard let data = try? await item.loadTransferable(type: Data.self),
                                  !data.isEmpty,
                                  let uiImage = UIImage(data: data) else {
                                await MainActor.run { newProductImageItem = nil }
                                return
                            }
                            await MainActor.run {
                                newProductCropItem = SingleImageCropSheetItem(image: uiImage)
                                newProductImageItem = nil
                            }
                        }
                    }

                    shopSheetSectionHeader("Product info")
                    VStack(spacing: 0) {
                        shopSheetLabeledField(title: "Name") {
                            TextField("Product name", text: $newProductName)
                                .multilineTextAlignment(.trailing)
                        }
                        Divider().padding(.leading, 16)
                        shopSheetLabeledField(title: "Category") {
                            TextField("e.g. Shampoo", text: $newProductCategory)
                                .multilineTextAlignment(.trailing)
                        }
                        Divider().padding(.leading, 16)
                        shopSheetLabeledField(title: "Description") {
                            TextField("Optional", text: $newProductDescription)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                    .appCard()

                    shopSheetSectionHeader("Pricing")
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("PRICE")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                            HStack(alignment: .firstTextBaseline, spacing: 2) {
                                Text("$")
                                    .font(.title3.weight(.medium))
                                    .foregroundStyle(.secondary)
                                TextField("0.00", text: $newProductPrice)
                                    .keyboardType(.decimalPad)
                                    .font(.title3.weight(.medium))
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .appCard()

                        VStack(alignment: .leading, spacing: 8) {
                            Text("SALE PRICE")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                            HStack(alignment: .firstTextBaseline, spacing: 2) {
                                Text("$")
                                    .font(.title3.weight(.medium))
                                    .foregroundStyle(.secondary)
                                TextField("—", text: $newProductSalePrice)
                                    .keyboardType(.decimalPad)
                                    .font(.title3.weight(.medium))
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .appCard()
                    }

                    Toggle(isOn: $newProductVisible) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Visible on site")
                                .font(.body)
                            Text("Show in your shop section.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tint(.green)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Variants & options")
                                .foregroundStyle(.secondary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity)
                        .appCard()
                        Text("Coming soon")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
            .appScreenBackground()
            .navigationTitle("New product")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        resetAddProductForm()
                        showAddProduct = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let price = Double(newProductPrice.trimmingCharacters(in: .whitespaces)) ?? 0
                        let saleTrim = newProductSalePrice.trimmingCharacters(in: .whitespaces)
                        let salePrice: Double? = saleTrim.isEmpty ? nil : Double(saleTrim)
                        Task {
                            await viewModel.addProduct(
                                name: newProductName,
                                category: newProductCategory,
                                description: newProductDescription,
                                price: price,
                                salePrice: salePrice,
                                imageData: newProductImageData,
                                isActive: newProductVisible
                            )
                            resetAddProductForm()
                            showAddProduct = false
                        }
                    }
                    .disabled(newProductName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func shopSheetSectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shopSheetLabeledField<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center) {
            Text(title)
                .foregroundStyle(Color.primary)
            Spacer(minLength: 12)
            content()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func resetAddProductForm() {
        newProductName = ""
        newProductCategory = ""
        newProductDescription = ""
        newProductPrice = ""
        newProductSalePrice = ""
        newProductVisible = true
        newProductImageItem = nil
        newProductImageData = nil
    }
}
