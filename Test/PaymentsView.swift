//
//  PaymentsView.swift
//
//  Accept payments and manage earnings. Stripe Connect integration.
//

import SwiftUI

struct PaymentsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @EnvironmentObject var appTour: AppTourCoordinator
    @StateObject private var viewModel = PaymentsViewModel()
    @State private var showDepositLinkSheet = false
    @State private var showManualPaymentSheet = false
    #if TAP_TO_PAY_ENABLED
    @State private var showTapToPaySheet = false
    @State private var showTapToPayEducation = false
    @State private var tapToPayAlertMessage: String?
    @State private var launchTapToPayAfterHeroDismissal = false
    #endif
    @State private var showWithdrawSheet = false
    @State private var showAllTransactions = false
    @State private var balanceDetailsExpanded = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if viewModel.isStudioPayroll {
                        studioPayrollBanner
                    } else if viewModel.needsStripeConnect && viewModel.hasLoadedStripeStatus {
                        StripeConnectBanner(
                            viewModel: viewModel,
                            isDemoMode: authViewModel.isDemoMode
                        )
                    } else if let err = viewModel.errorMessage {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    if viewModel.hasLoadedStripeStatus && viewModel.stripeConnected && viewModel.canTakePayments {
                        paymentsBalanceHero
                    }

                    if viewModel.canTakePayments {
                        acceptPaymentsSection
                    }

                    paymentsRecentTransactions
                }
                .padding(.vertical, 16)
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
                #if TAP_TO_PAY_ENABLED
                if viewModel.canTakePayments {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink {
                            PaymentsSettingsView(viewModel: viewModel)
                        } label: {
                            Image(systemName: "gearshape")
                                .foregroundStyle(AppDesign.textPrimary)
                        }
                    }
                }
                #endif
            }
            .refreshable {
                await viewModel.refresh(isDemoMode: authViewModel.isDemoMode)
            }
            .task {
                await viewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                #if TAP_TO_PAY_ENABLED
                await viewModel.prewarmTapToPayOnLaunch(isDemoMode: authViewModel.isDemoMode)
                #endif
            }
            .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
                Task { await viewModel.refreshStripeConnectStatus(isDemoMode: authViewModel.isDemoMode) }
            }
            .sheet(isPresented: $showDepositLinkSheet, onDismiss: { viewModel.depositLinkUrl = nil }) {
                DepositLinkSheet(viewModel: viewModel) {
                    showDepositLinkSheet = false
                }
            }
            .sheet(isPresented: $showManualPaymentSheet) {
                ManualPaymentSheet(viewModel: viewModel) {
                    showManualPaymentSheet = false
                }
            }
            #if TAP_TO_PAY_ENABLED
            .sheet(isPresented: $showTapToPaySheet) {
                TapToPaySheet(viewModel: viewModel, drawerState: drawerState) {
                    showTapToPaySheet = false
                }
            }
            .sheet(isPresented: $showTapToPayEducation) {
                TapToPayMerchantEducationView {
                    viewModel.finishMerchantEducation()
                    showTapToPayEducation = false
                }
            }
            .alert("Tap to Pay", isPresented: Binding(
                get: { tapToPayAlertMessage != nil },
                set: { if !$0 { tapToPayAlertMessage = nil } }
            )) {
                Button("OK", role: .cancel) { tapToPayAlertMessage = nil }
            } message: {
                Text(tapToPayAlertMessage ?? "")
            }
            #endif
            .sheet(isPresented: $showWithdrawSheet) {
                WithdrawSheet(viewModel: viewModel) {
                    showWithdrawSheet = false
                }
            }
            .sheet(item: $viewModel.selectedTransaction) { transaction in
                PaymentTransactionDetailSheet(
                    transaction: transaction,
                    viewModel: viewModel,
                    drawerState: drawerState
                )
            }
            .sheet(isPresented: $showAllTransactions) {
                PaymentsAllTransactionsSheet(viewModel: viewModel)
            }
            #if TAP_TO_PAY_ENABLED
            .overlay {
                if viewModel.isLaunchingTapToPay {
                    TapToPayLaunchOverlay(message: viewModel.tapToPayLaunchOverlayMessage)
                }
            }
            .sheet(
                isPresented: Binding(
                    get: { viewModel.showTapToPayHeroBanner },
                    set: { if !$0 { viewModel.dismissHeroBanner() } }
                ),
                onDismiss: {
                    guard launchTapToPayAfterHeroDismissal else { return }
                    launchTapToPayAfterHeroDismissal = false
                    handleTapToPayTapped()
                }
            ) {
                TapToPayHeroBannerView(
                    onGetStarted: {
                        launchTapToPayAfterHeroDismissal = true
                        viewModel.dismissHeroBanner()
                    },
                    onDismiss: {
                        viewModel.dismissHeroBanner()
                    }
                )
            }
            #endif
        }
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayCardSubtitle: String {
        if !viewModel.stripeConnected {
            return viewModel.usesOwnPayments
                ? "Connect your Stripe account to enable in-person payments"
                : "Set up Stripe to enable in-person payments"
        }
        return TapToPayBranding.featureSubtitle

    }

    private func handleTapToPayTapped() {
        Task {
            let result = await viewModel.launchTapToPayFlow(isDemoMode: authViewModel.isDemoMode)
            switch result {
            case .showMerchantEducation:
                await presentTapToPayMerchantEducationAndContinue()
            default:
                viewModel.applyTapToPayLaunchResult(
                    result,
                    isDemoMode: authViewModel.isDemoMode,
                    showCheckout: { showTapToPaySheet = true },
                    showAlert: { tapToPayAlertMessage = $0 },
                    showEducation: { showTapToPayEducation = true }
                )
            }
        }
    }

    private func presentTapToPayMerchantEducationAndContinue() async {
        await TapToPayMerchantEducationFlow.run(
            showFallbackSheet: { showTapToPayEducation = true },
            onFinished: {
                viewModel.finishMerchantEducation()
            }
        )
    }
    #endif

    private var paymentsBalanceHero: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Available balance")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.white.opacity(0.65))
                    Text(PaymentsViewModel.formatUSD(viewModel.availableBalance))
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
                Spacer(minLength: 12)
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        balanceDetailsExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("View details")
                            .font(.subheadline.weight(.medium))
                        Image(systemName: balanceDetailsExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Color.white.opacity(0.85))
                }
                .buttonStyle(.plain)
            }

            if balanceDetailsExpanded {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 0) {
                        balanceStatItem(
                            title: "Pending",
                            value: PaymentsViewModel.formatUSD(viewModel.pendingBalance),
                            valueColor: .white
                        )
                        balanceStatItem(
                            title: "This month",
                            value: "+\(PaymentsViewModel.formatUSD(viewModel.monthEarnings))",
                            valueColor: .green
                        )
                        balanceStatItem(
                            title: "Avg/week",
                            value: PaymentsViewModel.formatUSD(viewModel.averageWeeklyEarnings),
                            valueColor: .white
                        )
                    }

                    Button {
                        showWithdrawSheet = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "building.columns.fill")
                            Text("Withdraw to bank")
                                .font(.subheadline.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.white.opacity(0.14))
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.availableBalance <= 0)
                    .opacity(viewModel.availableBalance > 0 ? 1 : 0.55)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.12, green: 0.12, blue: 0.14), Color(red: 0.08, green: 0.08, blue: 0.10)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .padding(.horizontal)
    }

    private func balanceStatItem(title: String, value: String, valueColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.55))
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var acceptPaymentsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Accept payments")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            #if TAP_TO_PAY_ENABLED
            TapToPayOniPhoneButton(
                subtitle: tapToPayCardSubtitle,
                showsActivity: viewModel.isLaunchingTapToPay
                    || viewModel.isEnsuringTapToPayLocation
                    || viewModel.isEnsuringTapToPayTerms,
                action: { handleTapToPayTapped() }
            )
            .padding(.horizontal)
            #endif

            VStack(spacing: 0) {
                PaymentCompactActionRow(
                    icon: "creditcard.fill",
                    iconColor: .purple,
                    title: "Manual payment",
                    subtitle: "",
                    action: { showManualPaymentSheet = true },
                    disabled: !viewModel.stripeConnected,
                    showsDivider: true
                )

                PaymentCompactActionRow(
                    icon: "link",
                    iconColor: .green,
                    title: "Deposit link",
                    subtitle: "Request a deposit via text",
                    action: { showDepositLinkSheet = true },
                    disabled: !viewModel.stripeConnected,
                    showsDivider: false
                )
            }
            .appCard()
            .padding(.horizontal)
        }
    }

    private var paymentsRecentTransactions: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent transactions")
                    .font(.title3.weight(.bold))
                Spacer()
                if viewModel.displayTransactions.count > 5 {
                    Button("See all") { showAllTransactions = true }
                        .font(.subheadline.weight(.medium))
                }
            }
            .padding(.horizontal)

            if viewModel.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(24)
                    .appCard()
                    .padding(.horizontal)
            } else if viewModel.displayTransactions.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.largeTitle)
                        .foregroundColor(.secondary)
                    Text("No transactions yet")
                        .font(.subheadline.weight(.medium))
                    Text("When customers pay deposits or for services, they'll appear here")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(32)
                .appCard()
                .padding(.horizontal)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.recentDisplayTransactions.enumerated()), id: \.element.id) { index, txn in
                        PaymentTransactionRow(transaction: txn) {
                            viewModel.selectedTransaction = txn
                        }
                        if index < viewModel.recentDisplayTransactions.count - 1 {
                            Divider().padding(.leading, 68)
                        }
                    }
                }
                .appCard()
                .padding(.horizontal)
            }
        }
        .appTourAnchor(.paymentsHistory, isActive: appTour.isStepActive(.paymentsHistory))
    }

    private var studioPayrollBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "building.2.fill")
                .font(.title2)
                .foregroundColor(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Studio payroll")
                    .font(.subheadline.weight(.semibold))
                Text("Payments go through your studio account. Contact your admin to take your own payments.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(12)
        .padding(.horizontal)
    }
}

private struct StripeConnectBanner: View {
    @ObservedObject var viewModel: PaymentsViewModel
    let isDemoMode: Bool

    private var isPendingReview: Bool {
        viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted && !viewModel.stripeConnected
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                Task {
                    if isPendingReview {
                        await viewModel.refreshStripeConnectStatus(isDemoMode: isDemoMode)
                    } else {
                        await viewModel.refreshStripeConnectStatus(isDemoMode: isDemoMode)
                        guard !viewModel.stripeConnected else { return }
                        if viewModel.stripeHasAccount && viewModel.stripeDetailsSubmitted {
                            return
                        }
                        _ = await viewModel.createConnectAccountLink(isDemoMode: isDemoMode)
                    }
                }
            }) {
                HStack(spacing: 12) {
                    Image(systemName: isPendingReview ? "clock.fill" : "link.circle.fill")
                        .font(.title2)
                        .foregroundColor(isPendingReview ? .orange : .purple)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(viewModel.stripeConnectBannerTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                        Text(viewModel.stripeStatusHint ?? "Deposits, tips, and service payments")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    if viewModel.isConnectingStripe {
                        ProgressView()
                            .scaleEffect(0.9)
                    } else {
                        Image(systemName: isPendingReview ? "arrow.clockwise" : "chevron.right")
                            .foregroundColor(.secondary)
                    }
                }
                .padding()
                .background((isPendingReview ? Color.orange : Color.purple).opacity(0.08))
                .cornerRadius(12)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke((isPendingReview ? Color.orange : Color.purple).opacity(0.3), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isConnectingStripe)

            if let err = viewModel.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
        .padding(.horizontal)
    }
}

struct PaymentActionCard: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let action: () -> Void
    var disabled: Bool = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(iconColor.opacity(0.2))
                    .frame(width: 48, height: 48)
                    .overlay(Image(systemName: icon).foregroundColor(iconColor))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundColor(.secondary)
            }
            .padding(16)
            .appCard()
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .padding(.horizontal)
    }
}

struct PaymentCompactActionRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String
    let action: () -> Void
    var disabled: Bool = false
    var showsDivider: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(iconColor.opacity(0.15))
                        .frame(width: 44, height: 44)
                        .overlay(Image(systemName: icon).foregroundStyle(iconColor))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.textPrimary)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .opacity(disabled ? 0.55 : 1)

            if showsDivider {
                Divider().padding(.leading, 74)
            }
        }
    }
}

struct PaymentTransactionRow: View {
    let transaction: PaymentTransaction
    var onTap: () -> Void

    private var avatarFill: Color {
        if !transaction.isCredit { return Color.orange.opacity(0.15) }
        return Color.orange.opacity(0.15)
    }

    private var amountColor: Color {
        if transaction.isCredit { return .green }
        return Color.orange
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                Circle()
                    .fill(avatarFill)
                    .frame(width: 44, height: 44)
                    .overlay {
                        if transaction.type == "refund" || (!transaction.isCredit && transaction.channelLabel == "Refund") {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.orange)
                        } else {
                            Text(transaction.initials)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.orange)
                        }
                    }
                VStack(alignment: .leading, spacing: 3) {
                    Text(transaction.displayTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                        .lineLimit(1)
                    Text(transaction.subtitleText)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text("\(transaction.isCredit ? "+" : "-")\(PaymentsViewModel.formatUSD(transaction.amount))")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(amountColor)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

struct PaymentsAllTransactionsSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.displayTransactions.enumerated()), id: \.element.id) { index, txn in
                        PaymentTransactionRow(transaction: txn) {
                            viewModel.selectedTransaction = txn
                        }
                        if index < viewModel.displayTransactions.count - 1 {
                            Divider().padding(.leading, 68)
                        }
                    }
                }
                .appCard()
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle("All transactions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Manual Payment Sheet
struct ManualPaymentSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void
    @State private var amountText = ""
    @State private var localError: String?
    @FocusState private var isAmountFocused: Bool

    private static let suggestionAmounts: [(label: String, cents: Int)] = [
        ("$25", 2500),
        ("$50", 5000),
        ("$100", 10_000),
        ("$200", 20_000),
    ]

    private var serviceAmountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var checkout: CardCheckoutBreakdown {
        viewModel.checkoutBreakdown(serviceCents: serviceAmountCents, channel: .online)
    }

    private var canOpen: Bool { serviceAmountCents >= 50 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Text("Enter amount")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)

                TextField("0.00", text: $amountText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .focused($isAmountFocused)
                    .padding(.horizontal, 24)

                CardCheckoutBreakdownView(breakdown: checkout, alwaysShowFeeLines: true)
                    .padding(.horizontal, 24)

                if let localError, !localError.isEmpty {
                    Text(localError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                Button {
                    Task { await openCheckout() }
                } label: {
                    HStack {
                        if viewModel.isCreatingManualCheckoutLink {
                            ProgressView().tint(.white)
                        } else {
                            Text("Open checkout · \(CardCheckoutPricing.formatUSD(cents: checkout.totalCents))")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(canOpen ? AppDesign.brandDark : Color.gray)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .disabled(!canOpen || viewModel.isCreatingManualCheckoutLink)
                .padding(.horizontal, 24)

                Spacer(minLength: 0)
            }
            .padding(.top, 24)
            .navigationTitle("Manual payment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItem(placement: .keyboard) {
                    HStack(spacing: 12) {
                        ForEach(Self.suggestionAmounts, id: \.cents) { item in
                            Button(item.label) {
                                amountText = String(format: "%.2f", Double(item.cents) / 100)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
            .onAppear {
                localError = nil
                viewModel.errorMessage = nil
            }
        }
    }

    private func openCheckout() async {
        localError = nil
        let result = await viewModel.chargeManualCheckoutInApp(serviceAmountCents: serviceAmountCents)
        switch result {
        case .success:
            onDismiss()
        case .canceled:
            break
        case .failed(let message):
            localError = message
        }
    }
}

// MARK: - Deposit Link Sheet
struct DepositLinkSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void
    @State private var amountText = ""
    @FocusState private var isAmountFocused: Bool

    private static let suggestionAmounts: [(label: String, cents: Int)] = [
        ("$25", 2500),
        ("$50", 5000),
        ("$100", 10_000),
        ("$200", 20_000),
    ]

    private var serviceAmountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var checkout: CardCheckoutBreakdown {
        viewModel.checkoutBreakdown(serviceCents: serviceAmountCents, channel: .online)
    }

    private var canCreate: Bool { serviceAmountCents >= 50 }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text("Enter deposit amount")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text("Customers pay the deposit plus a processing fee at checkout. You receive the full deposit amount.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                TextField("0.00", text: $amountText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .focused($isAmountFocused)
                    .padding(.horizontal, 24)

                if canCreate {
                    CardCheckoutBreakdownView(breakdown: checkout)
                        .padding(.horizontal, 24)
                }

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                }

                if let urlString = viewModel.depositLinkUrl, let url = URL(string: urlString) {
                    VStack(spacing: 16) {
                        Text("Link ready")
                            .font(.subheadline.weight(.semibold))
                        Text(urlString)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                            .padding(.horizontal)
                        ShareLink(item: url, subject: Text("Deposit link"), message: Text("Pay your deposit")) {
                            Label("Share", systemImage: "square.and.arrow.up")
                                .font(.body.weight(.medium))
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                } else {
                    Button(action: {
                        Task { await viewModel.createDepositLink(serviceAmountCents: serviceAmountCents) }
                    }) {
                        HStack {
                            if viewModel.isCreatingDepositLink {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text(checkout.hasPassThroughFees
                                    ? "Create link · \(CardCheckoutPricing.formatUSD(cents: checkout.totalCents))"
                                    : "Create link")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(canCreate ? Color.green : Color.gray)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                    }
                    .disabled(!canCreate || viewModel.isCreatingDepositLink)
                }

                Spacer(minLength: 0)
            }
            .padding(.top, 20)
            .navigationTitle("Deposit Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItem(placement: .keyboard) {
                    HStack(spacing: 12) {
                        ForEach(Self.suggestionAmounts, id: \.cents) { item in
                            Button(item.label) {
                                amountText = String(format: "%.2f", Double(item.cents) / 100)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
    }
}

// MARK: - Withdraw Sheet
struct WithdrawSheet: View {
    @ObservedObject var viewModel: PaymentsViewModel
    var onDismiss: () -> Void
    @State private var amountText = ""

    private var amountCents: Int {
        let value = Double(amountText.replacingOccurrences(of: ",", with: "")) ?? 0
        return Int(round(value * 100))
    }

    private var maxCents: Int { Int(viewModel.availableBalance * 100) }
    private var canWithdraw: Bool { amountCents >= 50 && amountCents <= maxCents }

    var body: some View {
        NavigationView {
            VStack(spacing: 24) {
                Text("Available: \(formatCurrency(viewModel.availableBalance))")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                TextField("0", text: $amountText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .font(.title2.monospacedDigit())
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                }
                Button(action: { amountText = String(maxCents / 100) }) {
                    Text("Withdraw full balance")
                        .font(.subheadline)
                }
                .padding(.top, 8)
                Button(action: {
                    Task {
                        await viewModel.createPayout(amountCents: amountCents)
                        if !viewModel.isCreatingPayout && viewModel.errorMessage == nil {
                            onDismiss()
                        }
                    }
                }) {
                    HStack {
                        if viewModel.isCreatingPayout {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Withdraw")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(canWithdraw ? Color.green : Color.gray)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
                .disabled(!canWithdraw || viewModel.isCreatingPayout)
                Spacer(minLength: 0)
            }
            .padding(.top, 24)
            .navigationTitle("Withdraw to bank")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
            }
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

#if TAP_TO_PAY_ENABLED
struct TapToPayLaunchOverlay: View {
    let message: String
    @ObservedObject private var readerSession = TapToPayReaderSession.shared

    private var statusMessage: String {
        readerSession.statusMessage?.isEmpty == false
            ? readerSession.statusMessage!
            : message
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.32)
                .ignoresSafeArea()
            VStack(spacing: 14) {
                if let progress = readerSession.preparationProgress, progress < 1 {
                    ProgressView(value: progress)
                        .tint(.white)
                        .frame(width: 160)
                } else {
                    ProgressView()
                        .tint(.white)
                        .scaleEffect(1.05)
                }
                Text(statusMessage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 22)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .transition(.opacity)
    }
}
#endif
