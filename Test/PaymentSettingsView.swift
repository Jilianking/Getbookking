//
//  PaymentSettingsView.swift
//
//  Stripe Connect, shop sales tax, and tax document links (Settings).
//

import SwiftUI

struct PaymentSettingsView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @EnvironmentObject private var stripeConnectLaunch: StripeConnectLaunchCoordinator
    let isDemoMode: Bool
    #if TAP_TO_PAY_ENABLED
    @State private var showTapToPayEducation = false
    #endif
    @EnvironmentObject private var sessionStore: TenantSessionStore
    @State private var tipsOn = true
    @State private var tipsLoaded = false
    @State private var tipPercentText: [String] = ["15", "20", "25"]
    @State private var tipSaveMessage: String?
    @State private var isSavingTipPercents = false

    private var parsedTipPercents: [Int]? {
        let nums = tipPercentText.map { Int($0.trimmingCharacters(in: .whitespaces)) ?? 0 }
        guard nums.count == 3, nums.allSatisfy({ (1...100).contains($0) }) else { return nil }
        return nums
    }

    private func saveTipPercents(_ values: [Int]) {
        guard !isSavingTipPercents else { return }
        guard let tid = viewModel.tenantId ?? sessionStore.tenantId else {
            tipSaveMessage = "Couldn't find your shop. Close and reopen Payment settings."
            return
        }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        isSavingTipPercents = true
        tipSaveMessage = nil
        Task {
            do {
                try await FirebaseService().updateTenant(tenantId: tid, updates: ["tipPercents": values])
                sessionStore.mergeTenantFields(["tipPercents": values])
                tipPercentText = values.map(String.init)
                tipSaveMessage = "Saved"
            } catch {
                tipSaveMessage = error.localizedDescription
            }
            isSavingTipPercents = false
        }
    }

    @ViewBuilder
    private var tipPercentEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tip choices")
                .font(.subheadline.weight(.medium))
            HStack(spacing: 10) {
                ForEach(0..<3, id: \.self) { i in
                    HStack(spacing: 2) {
                        TextField("", text: $tipPercentText[i])
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.center)
                            .font(.body.weight(.semibold))
                        Text("%").foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 10)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(AppDesign.cardBackground))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(AppDesign.chipBorder, lineWidth: 1))
                }
            }
            HStack {
                Button("Save tip choices") {
                    if let values = parsedTipPercents { saveTipPercents(values) }
                    else { tipSaveMessage = "Use whole numbers from 1 to 100." }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.accentGreen)
                .disabled(isSavingTipPercents || isDemoMode)
                Spacer()
                Button("Reset to 15 / 20 / 25") { saveTipPercents([15, 20, 25]) }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .disabled(isSavingTipPercents || isDemoMode)
            }
            if let msg = tipSaveMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(msg == "Saved" ? AppDesign.accentGreen : .red)
            }
            Text("Clients also get Custom amount and No tip.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var tipsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Tips")
            VStack(alignment: .leading, spacing: 0) {
                Toggle(isOn: $tipsOn) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ask for tips")
                            .font(.body.weight(.medium))
                        Text("Shown on Tap to Pay, manual card payments, and payment links. Tips go 100% to the staff member.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(AppDesign.accentGreen)
                .disabled(isDemoMode || viewModel.tenantId == nil)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                if tipsOn {
                    Divider().padding(.leading, 14)
                    tipPercentEditor
                }
            }
            .appCard()
            .task {
                tipsOn = ShopTipSettings.enabled(sessionStore.tenant)
                tipPercentText = ShopTipSettings.percents(sessionStore.tenant).map(String.init)
                // Read the latest saved values (the in-memory copy can be from earlier in the session).
                if let tid = viewModel.tenantId ?? sessionStore.tenantId,
                   let fresh = try? await FirebaseService().fetchTenant(tenantId: tid) {
                    var latest: [String: Any] = [:]
                    if let on = fresh["tipsEnabled"] { latest["tipsEnabled"] = on }
                    if let pcts = fresh["tipPercents"] { latest["tipPercents"] = pcts }
                    sessionStore.mergeTenantFields(latest)
                    tipsOn = ShopTipSettings.enabled(fresh)
                    tipPercentText = ShopTipSettings.percents(fresh).map(String.init)
                }
                tipsLoaded = true
            }
            .onChange(of: tipsOn) { _, on in
                guard tipsLoaded, let tid = viewModel.tenantId else { return }
                sessionStore.mergeTenantFields(["tipsEnabled": on])
                Task { try? await FirebaseService().updateTenant(tenantId: tid, updates: ["tipsEnabled": on]) }
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                stripeAccountSection
                if viewModel.stripeConnected {
                    #if TAP_TO_PAY_ENABLED
                    if viewModel.canEditTapToPayDisplayName {
                        tapToPayScreenNameSection
                    }
                    #endif
                    if viewModel.canEditStatementDescriptor {
                        statementDescriptorSection
                    }
                    if viewModel.isTenantOwner {
                        tipsSection
                        salesTaxSection
                    }
                    taxReportingSection
                }
                #if TAP_TO_PAY_ENABLED
                // Apple 4.3: merchant education reachable outside onboarding, including before Connect finishes.
                if viewModel.canTakePayments {
                    tapToPayHelpSection
                }
                #endif

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 4)
                }
            }
            .padding(16)
        }
        // Swipe down on the page to slide the keyboard away (tip choices, statement descriptor).
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
            }
        }
        .appScreenBackground()
        .navigationTitle("Payment settings")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await viewModel.refreshStripeConnectStatus(isDemoMode: isDemoMode)
            await viewModel.reloadShopTaxSetting(isDemoMode: isDemoMode)
        }
        .task {
            await viewModel.prewarmConnectLinkIfNeeded(isDemoMode: isDemoMode)
        }
        #if TAP_TO_PAY_ENABLED
        .sheet(isPresented: $showTapToPayEducation) {
            TapToPayMerchantEducationView {
                showTapToPayEducation = false
            }
        }
        #endif
    }

    private var stripeAccountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Stripe account")

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "s.circle.fill")
                        .font(.title3)
                        .foregroundStyle(AppDesign.accentGreen)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Payment processing")
                            .font(.body.weight(.medium))
                        Text(stripeStatusSubtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(stripeStatusLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(stripeStatusColor)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                if !viewModel.stripeConnected {
                    Divider().padding(.leading, 14)
                    Button {
                        Task {
                            stripeConnectLaunch.prepareOpening()
                            _ = await stripeConnectLaunch.openConnect(
                                from: viewModel,
                                isDemoMode: isDemoMode
                            )
                        }
                    } label: {
                        HStack {
                            Text(connectActionTitle)
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            if viewModel.isConnectingStripe {
                                ProgressView().scaleEffect(0.9)
                            } else {
                                Image(systemName: "arrow.up.right")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isConnectingStripe || isDemoMode || stripeConnectLaunch.isOpening)
                }
            }
            .appCard()
        }
    }

    private var statementDescriptorSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Statement descriptor")

            VStack(alignment: .leading, spacing: 12) {
                Text("Shows on your customer’s bank or card statement (not on the Tap to Pay screen).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(
                    "Statement descriptor",
                    text: $viewModel.statementDescriptorDraft,
                    prompt: Text("YOUR BUSINESS")
                )
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .disabled(isDemoMode || viewModel.isSavingStatementDescriptor)
                .onChange(of: viewModel.statementDescriptorDraft) { _, newValue in
                    let filtered = newValue
                        .uppercased()
                        .filter { $0.isLetter || $0.isNumber || $0 == " " }
                    if filtered != newValue {
                        viewModel.statementDescriptorDraft = filtered
                    }
                }

                Button {
                    Task { await viewModel.saveStatementDescriptor(isDemoMode: isDemoMode) }
                } label: {
                    HStack {
                        Text("Save statement descriptor")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.accentGreen)
                        Spacer()
                        if viewModel.isSavingStatementDescriptor {
                            ProgressView().scaleEffect(0.9)
                        }
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isSavingStatementDescriptor)

                if viewModel.statementDescriptorSaveSuccess {
                    Text("Saved — new charges will use this on bank/card statements.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .appCard()

            Text("5–22 characters. Letters, numbers, and spaces only. Must match your business.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
        }
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayScreenNameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Tap to Pay screen name")

            VStack(alignment: .leading, spacing: 12) {
                Text("Customers see “Pay \(viewModel.effectiveTapToPayDisplayName)” on their phone during Tap to Pay. Does not change bank statements.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(
                    "Name on Tap to Pay screen",
                    text: $viewModel.tapToPayDisplayNameDraft,
                    prompt: Text(viewModel.tapToPayDisplayNamePlaceholder)
                )
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .disabled(isDemoMode || viewModel.isSavingTapToPayDisplayName)

                Button {
                    Task { await viewModel.saveTapToPayDisplayName() }
                } label: {
                    HStack {
                        Text("Save Tap to Pay screen name")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.accentGreen)
                        Spacer()
                        if viewModel.isSavingTapToPayDisplayName {
                            ProgressView().scaleEffect(0.9)
                        }
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isSavingTapToPayDisplayName)

                if viewModel.tapToPayDisplayNameSaveSuccess {
                    Text("Saved — Tap to Pay will show Pay \(viewModel.effectiveTapToPayDisplayName).")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .appCard()
        }
    }
    #endif

    private var salesTaxSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Tax settings")

            VStack(alignment: .leading, spacing: 0) {
                Toggle(isOn: onlineTaxBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Online sales tax")
                            .font(.body.weight(.medium))
                        Text("Shop and website checkout. Calculated by Stripe Tax.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(AppDesign.accentGreen)
                .disabled(isDemoMode || viewModel.isSavingShopTax)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                Divider().padding(.leading, 14)

                Toggle(isOn: inPersonTaxBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("In-person sales tax")
                            .font(.body.weight(.medium))
                        Text("Manual payment and Tap to Pay. Shown on checkout and receipts.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(AppDesign.accentGreen)
                .disabled(isDemoMode || viewModel.isSavingInPersonTax)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                Divider().padding(.leading, 14)

                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Set up tax in Stripe",
                        subtitle: "Registrations, rates, and filing",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)
            }
            .appCard()

            Text("Both use your business address. Turn on only after completing Stripe Tax setup.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
        }
    }

    private var taxReportingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Tax & reporting")

            VStack(spacing: 0) {
                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Tax documents (1099-K)",
                        subtitle: "Download forms issued by Stripe",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)

                Divider().padding(.leading, 14)

                Button {
                    Task { await viewModel.openExpressDashboard(isDemoMode: isDemoMode) }
                } label: {
                    paymentSettingsLinkRow(
                        title: "Payouts & Stripe account",
                        subtitle: "Balance, bank account, and account details",
                        isLoading: viewModel.isOpeningStripeDashboard
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDemoMode || viewModel.isOpeningStripeDashboard)
            }
            .appCard()

            Text("Tax forms and payout reports are provided by Stripe, not Bookking.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 4)
        }
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayHelpSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Help")

            Button {
                Task {
                    await TapToPayMerchantEducationFlow.runFromSettings {
                        showTapToPayEducation = true
                    }
                }
            } label: {
                paymentSettingsLinkRow(
                    title: "How to use Tap to Pay",
                    subtitle: "Contactless cards, Apple Pay, and digital wallets"
                )
            }
            .buttonStyle(.plain)
            .appCard()
        }
    }
    #endif

    private var onlineTaxBinding: Binding<Bool> {
        Binding(
            get: { viewModel.shopTaxEnabled },
            set: { newValue in
                viewModel.shopTaxEnabled = newValue
                Task { await viewModel.saveShopTaxEnabled(isDemoMode: isDemoMode) }
            }
        )
    }

    private var inPersonTaxBinding: Binding<Bool> {
        Binding(
            get: { viewModel.inPersonTaxEnabled },
            set: { newValue in
                viewModel.inPersonTaxEnabled = newValue
                Task { await viewModel.saveInPersonTaxEnabled(isDemoMode: isDemoMode) }
            }
        )
    }

    private var stripeStatusLabel: String {
        if viewModel.stripeConnected { return "Connected" }
        if viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted { return "In review" }
        if viewModel.stripeHasAccount { return "Setup" }
        return "Not connected"
    }

    private var stripeStatusColor: Color {
        if viewModel.stripeConnected { return AppDesign.accentGreen }
        if viewModel.stripeHasAccount { return AppDesign.brandWarm }
        return AppDesign.textSecondary
    }

    private var stripeStatusSubtitle: String {
        if viewModel.stripeConnected {
            return "Deposits, shop checkout, Tap to Pay, and payment links"
        }
        return viewModel.stripeStatusHint ?? "Connect to accept payments online and in person"
    }

    private var connectActionTitle: String {
        if viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted {
            return "Check status in Stripe"
        }
        if viewModel.stripeHasAccount {
            return "Finish setup in Stripe"
        }
        return "Connect Stripe"
    }

    private func paymentSettingsLinkRow(
        title: String,
        subtitle: String,
        isLoading: Bool = false
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if isLoading {
                ProgressView().scaleEffect(0.9)
            } else {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}
