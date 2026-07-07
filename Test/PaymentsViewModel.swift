//
//  PaymentsViewModel.swift
//
//  Manages payments, balance, and Stripe Connect for the business and team members.
//

import Foundation
import Combine
import UIKit
import FirebaseAuth
import FirebaseFunctions

struct PaymentTransaction: Identifiable, Hashable {
    let id: String
    let type: String // charge, payment, payout, refund, adjustment, etc.
    let amount: Double
    let grossAmount: Double
    let feeAmount: Double
    let isCredit: Bool
    let customerName: String?
    let createdAt: Date?
    let status: String
    let reportingCategory: String?
    /// Stripe charge ID when available; used for receipt and refund.
    let chargeId: String?

    /// Platform fee credits from partial/full refunds — not customer-facing activity.
    var isApplicationFeeRefundLine: Bool {
        let desc = (customerName ?? "").lowercased()
        if desc.contains("application fee refund") { return true }
        let category = (reportingCategory ?? "").lowercased()
        return type == "adjustment" && isCredit && category == "fee"
    }

    var showsInActivityFeed: Bool { !isApplicationFeeRefundLine }

    var displayTitle: String {
        if type == "refund" || isCustomerRefundLine {
            return "Refund"
        }
        let trimmed = (customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed.lowercased() != "payment" { return trimmed }
        return channelLabel
    }

    private var isCustomerRefundLine: Bool {
        !isCredit && (type == "refund" || (customerName ?? "").lowercased().contains("refund"))
    }

    var channelLabel: String {
        if type == "refund" || isCustomerRefundLine {
            return "Refund"
        }
        let desc = (customerName ?? "").lowercased()
        if desc.contains("deposit") { return "Deposit" }
        if desc.contains("tap to pay") || desc.contains("terminal") { return "Tap to Pay" }
        switch type {
        case "charge", "payment": return "Payment"
        case "payout": return "Payout"
        default:
            if type == "adjustment" { return "Adjustment" }
            return type.capitalized
        }
    }

    var subtitleText: String {
        guard let createdAt else { return channelLabel }
        let datePart = Self.relativeDateString(for: createdAt)
        return "\(channelLabel) · \(datePart)"
    }

    var initials: String {
        Self.initials(from: displayTitle)
    }

    var isPaid: Bool { isCredit && status != "pending" }

    static func fromFirestoreDict(_ t: [String: Any]) -> PaymentTransaction? {
        guard let id = t["id"] as? String else { return nil }
        let typeStr = t["type"] as? String ?? "unknown"
        let netCents = (t["net"] as? NSNumber)?.intValue
            ?? (t["netCents"] as? NSNumber)?.intValue
        let grossCents = (t["amount"] as? NSNumber)?.intValue
            ?? (t["amountCents"] as? NSNumber)?.intValue
        let feeCents = (t["fee"] as? NSNumber)?.intValue
            ?? (t["feeCents"] as? NSNumber)?.intValue
            ?? 0
        let resolvedNet = netCents ?? grossCents ?? 0
        let isCredit = (t["isCredit"] as? Bool) ?? (resolvedNet > 0)
        let displayCents = abs(netCents ?? grossCents ?? 0)
        let amount = Double(displayCents) / 100
        let grossAmount = Double(abs(grossCents ?? displayCents)) / 100
        let feeAmount = Double(abs(feeCents)) / 100
        let description = t["description"] as? String
        let reportingCategory = (t["reportingCategory"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let created = (t["created"] as? NSNumber)?.intValue ?? 0
        let createdAt = created > 0 ? Date(timeIntervalSince1970: TimeInterval(created)) : nil
        let statusRaw = (t["status"] as? String)?.lowercased() ?? "completed"
        let chargeIdRaw = (t["chargeId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceId = (t["sourceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let chargeId: String? = {
            if let chargeIdRaw, chargeIdRaw.hasPrefix("ch_") { return chargeIdRaw }
            if let sourceId, sourceId.hasPrefix("ch_") { return sourceId }
            if typeStr == "charge", let sourceId, !sourceId.isEmpty { return sourceId }
            return nil
        }()
        return PaymentTransaction(
            id: id,
            type: typeStr,
            amount: amount,
            grossAmount: grossAmount,
            feeAmount: feeAmount,
            isCredit: isCredit,
            customerName: description,
            createdAt: createdAt,
            status: statusRaw,
            reportingCategory: reportingCategory?.isEmpty == false ? reportingCategory : nil,
            chargeId: chargeId
        )
    }

    private static func relativeDateString(for date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "Today, \(date.formatted(date: .omitted, time: .shortened))"
        }
        if calendar.isDateInYesterday(date) {
            return "Yesterday, \(date.formatted(date: .omitted, time: .shortened))"
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    private static func initials(from name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace || $0 == "·" || $0 == "-" })
            .map(String.init)
            .filter { !$0.isEmpty }
        if parts.isEmpty { return "?" }
        if parts.count == 1 {
            let word = parts[0]
            return String(word.prefix(2)).uppercased()
        }
        return parts.prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
    }
}

#if TAP_TO_PAY_ENABLED
struct TapToPayPaymentIntent {
    let clientSecret: String
    let paymentIntentId: String
    let checkout: CardCheckoutBreakdown
}
#endif

@MainActor
class PaymentsViewModel: ObservableObject {
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    /// True when Stripe Connect can accept charges (not just when an account id exists).
    @Published var stripeConnected: Bool = false
    /// Tenant has a saved Connect account id (setup was started or completed).
    @Published var stripeHasAccount: Bool = false
    @Published var stripeDetailsSubmitted: Bool = false
    /// Show Connect / complete-setup banner when onboarding isn't finished.
    @Published var needsStripeConnect: Bool = false
    /// False until the first Stripe Connect status fetch completes (avoids connect banner flash while loading).
    @Published var hasLoadedStripeStatus: Bool = false
    @Published var stripeStatusHint: String?
    @Published var tenantId: String?
    @Published var isTenantOwner = false
    @Published var canTakePayments = true
    @Published var usesOwnPayments = false
    @Published var isStudioPayroll = false
    @Published var paymentStripeScope = "tenant"
    @Published var isEnsuringTapToPayLocation = false
    @Published var isEnsuringTapToPayTerms = false
    @Published var tapToPayDisplayNameDraft: String = ""
    @Published var tapToPayDisplayNamePlaceholder: String = "Studio"
    @Published var canEditTapToPayDisplayName = false
    @Published var isSavingTapToPayDisplayName = false
    @Published var tapToPayDisplayNameSaveSuccess = false
    @Published var tapToPayRequireSignature = false
    @Published var tapToPayReceiptPreferences = TapToPayReceiptPreferences()
    @Published var isSavingTapToPaySettings = false
    @Published var tapToPaySettingsSaveSuccess = false
    @Published var isLoading = false
    @Published var isConnectingStripe = false
    /// True from tap until Tap to Pay checkout, Safari, or alert finishes launching.
    @Published var isLaunchingTapToPay = false
    @Published var errorMessage: String?
    @Published var transactions: [PaymentTransaction] = []
    @Published var depositLinkUrl: String?
    @Published var isCreatingDepositLink = false
    @Published var isCreatingManualCheckoutLink = false
    @Published var isCreatingPayout = false
    @Published var isRefunding = false
    @Published var selectedTransaction: PaymentTransaction?

    var monthEarnings: Double {
        let calendar = Calendar.current
        let now = Date()
        guard let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) else {
            return 0
        }
        return transactions
            .filter {
                $0.isCredit
                    && $0.showsInActivityFeed
                    && ($0.createdAt ?? .distantPast) >= monthStart
            }
            .reduce(0) { $0 + $1.amount }
    }

    var averageWeeklyEarnings: Double {
        let calendar = Calendar.current
        let now = Date()
        guard let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) else {
            return 0
        }
        let days = max(1, calendar.dateComponents([.day], from: monthStart, to: now).day ?? 1)
        let weeks = max(1.0, Double(days) / 7.0)
        return monthEarnings / weeks
    }

    var displayTransactions: [PaymentTransaction] {
        transactions.filter { $0.showsInActivityFeed }
    }

    var recentDisplayTransactions: [PaymentTransaction] {
        Array(displayTransactions.prefix(5))
    }

    /// Kept for callers that only want inbound payments.
    var recentCreditTransactions: [PaymentTransaction] {
        Array(transactions.filter { $0.isCredit && $0.showsInActivityFeed }.prefix(5))
    }

    static func formatUSD(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = value.truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        return formatter.string(from: NSNumber(value: value)) ?? "$0"
    }

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    private var prefetchedConnectURL: URL?
    private var prefetchedConnectFetchedAt: Date?
    private let connectLinkPrefetchTTL: TimeInterval = 120

    /// Settings row / banner title for current Connect state.
    var stripeConnectStatusLabel: String {
        if stripeConnected { return "Connected" }
        if stripeHasAccount && stripeDetailsSubmitted { return "In review" }
        if stripeHasAccount { return "Finish setup" }
        return "Setup"
    }

    /// Alert when payments are blocked from Messages or similar.
    var stripePaymentsBlockedMessage: String {
        if stripeConnected { return "" }
        if stripeHasAccount && stripeDetailsSubmitted {
            return "Stripe is reviewing your payout account. Pull to refresh on Payments, or check back soon."
        }
        if stripeHasAccount {
            return "Finish Stripe setup in Payments to accept deposits and payment links."
        }
        return "Connect Stripe in Payments to accept deposits and payment links."
    }

    var stripeConnectBannerTitle: String {
        if stripeHasAccount && stripeDetailsSubmitted {
            return "Stripe account in review"
        }
        if stripeHasAccount {
            return "Finish Stripe setup"
        }
        return "Connect Stripe to accept payments"
    }

    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
    }

    /// Lightweight refresh after returning from Safari (skips full profile load when tenant is known).
    func refreshStripeConnectStatus(isDemoMode: Bool = false) async {
        if isDemoMode { return }
        guard Auth.auth().currentUser != nil else { return }
        if tenantId == nil {
            await loadData(isDemoMode: false)
            return
        }
        await refreshStripeStatus()
        if stripeConnected {
            await loadBalance()
            await loadTransactions()
        }
    }

    enum ConnectAccountLinkOutcome {
        case alreadyConnected
        case pendingReview
        case openedInSafari
        case noAction
    }

    /// Fetches a Stripe Connect onboarding URL in the background so Take payment opens Safari faster.
    func prewarmConnectLinkIfNeeded(isDemoMode: Bool = false) async {
        if isDemoMode { return }
        guard Auth.auth().currentUser != nil else { return }
        guard canTakePayments, !stripeConnected, needsStripeConnect else { return }
        guard !(stripeHasAccount && stripeDetailsSubmitted) else { return }
        if let fetchedAt = prefetchedConnectFetchedAt,
           prefetchedConnectURL != nil,
           Date().timeIntervalSince(fetchedAt) < connectLinkPrefetchTTL {
            return
        }
        _ = await fetchConnectAccountLink(openInSafari: false, isDemoMode: isDemoMode)
    }

    func invalidateConnectLinkPrefetch() {
        prefetchedConnectURL = nil
        prefetchedConnectFetchedAt = nil
    }

    #if TAP_TO_PAY_ENABLED
    enum TapToPayLaunchResult {
        case showCheckout
        case showAlert(String)
        case openedConnectInSafari
        case showMerchantEducation
    }

    var tapToPayLaunchOverlayMessage: String {
        if isEnsuringTapToPayTerms { return "Preparing Tap to Pay terms…" }
        if isConnectingStripe { return "Opening Stripe…" }
        if isEnsuringTapToPayLocation { return "Connecting Tap to Pay…" }
        return "Loading…"
    }

    /// Prepares Terminal location on launch; connects reader only after Apple T&C is accepted.
    func prewarmTapToPayOnLaunch(isDemoMode: Bool = false) async {
        guard !isDemoMode, canTakePayments else { return }
        if TapToPayEligibility.blockingMessage() != nil { return }

        if let prepareData = await TapToPayAppLifecycle.prewarm() {
            applyPrepareTapToPayResponse(prepareData)
        } else if stripeConnected, resolvedTapToPayLocationId.isEmpty {
            try? await ensureTapToPayLocation()
        }
    }

    private func applyPrepareTapToPayResponse(_ data: [String: Any]) {
        stripeHasAccount = data["hasAccount"] as? Bool ?? stripeHasAccount
        if let detailsSubmitted = data["detailsSubmitted"] as? Bool {
            stripeDetailsSubmitted = detailsSubmitted
        }
        if let chargesEnabled = data["chargesEnabled"] as? Bool {
            stripeConnected = chargesEnabled
            needsStripeConnect = canTakePayments && !chargesEnabled
        }
        hasLoadedStripeStatus = true
        if let scope = data["paymentScope"] as? String, !scope.isEmpty {
            paymentStripeScope = scope
        }

        let locationId = (data["locationId"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = (data["displayName"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !locationId.isEmpty else { return }

        TapToPayLocationStore.shared.applyConnectStatus(
            terminalLocationId: locationId,
            paymentScope: data["paymentScope"] as? String
        )
        if !displayName.isEmpty {
            TapToPayLocationStore.shared.updateMerchantDisplayName(displayName)
        }
    }

    /// Connects the Tap to Pay reader so Apple Terms & Conditions appear before Stripe onboarding.
    private func ensureTapToPayAppleTermsAccepted(isDemoMode: Bool) async throws {
        if isDemoMode { return }
        if TapToPayReaderSession.shared.termsAcceptedOnDevice { return }

        TapToPayTerminalManager.shared.prepareTerminalSDK()

        let locationId: String
        let displayName: String

        if !resolvedTapToPayLocationId.isEmpty {
            locationId = resolvedTapToPayLocationId
            let cachedName = TapToPayLocationStore.shared.merchantDisplayName
                .trimmingCharacters(in: .whitespacesAndNewlines)
            displayName = cachedName.isEmpty ? effectiveTapToPayDisplayName : cachedName
        } else {
            isEnsuringTapToPayTerms = true
            defer { isEnsuringTapToPayTerms = false }

            let result = try await functions.httpsCallable("prepareTapToPayTermsAcceptance").call([:])
            guard let data = result.data as? [String: Any] else {
                throw NSError(
                    domain: "TapToPay",
                    code: 11,
                    userInfo: [NSLocalizedDescriptionKey: "Tap to Pay could not be set up. Try again."]
                )
            }
            applyPrepareTapToPayResponse(data)
            locationId = resolvedTapToPayLocationId
            displayName = (data["displayName"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            guard !locationId.isEmpty else {
                throw NSError(
                    domain: "TapToPay",
                    code: 11,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Tap to Pay could not be set up. Add your business address under Website Design, then try again.",
                    ]
                )
            }
        }

        isEnsuringTapToPayLocation = true
        defer { isEnsuringTapToPayLocation = false }

        do {
            try await TapToPayTerminalManager.shared.connectReaderForTermsAcceptance(
                locationId: locationId,
                merchantDisplayName: displayName.isEmpty ? nil : displayName
            )
            guard TapToPayReaderSession.shared.termsAcceptedOnDevice else {
                throw NSError(
                    domain: "TapToPay",
                    code: 12,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Accept Tap to Pay on iPhone terms to continue.",
                    ]
                )
            }
        } catch {
            await TapToPayTerminalManager.shared.releaseReaderConnection()
            throw error
        }
    }

    /// Opens checkout, Safari Connect, merchant education, or an in-review alert. Apple T&C always runs before Stripe.
    func launchTapToPayFlow(isDemoMode: Bool) async -> TapToPayLaunchResult {
        if isDemoMode {
            return .showAlert("Tap to Pay isn't available in demo mode.")
        }
        if !canTakePayments {
            return .showAlert("Your studio collects payments for you. Ask your admin to enable independent payouts.")
        }
        if let block = TapToPayEligibility.blockingMessage() {
            return .showAlert(block)
        }

        TapToPayTerminalManager.shared.prepareTerminalSDK()

        let termsWereAcceptedBefore = TapToPayReaderSession.shared.termsAcceptedOnDevice
        isLaunchingTapToPay = true

        if !TapToPayReaderSession.shared.termsAcceptedOnDevice {
            do {
                try await ensureTapToPayAppleTermsAccepted(isDemoMode: isDemoMode)
            } catch {
                isLaunchingTapToPay = false
                return .showAlert(FirebaseFunctionsErrorHelper.message(from: error))
            }
        }

        isLaunchingTapToPay = false

        guard TapToPayReaderSession.shared.termsAcceptedOnDevice else {
            return .showAlert("Accept Tap to Pay on iPhone terms to continue.")
        }

        let termsJustAccepted = !termsWereAcceptedBefore
        if termsJustAccepted, TapToPayMerchantEducationStore.shouldShowAfterTermsAcceptance {
            return .showMerchantEducation
        }

        return await continueTapToPayLaunchAfterEducation(isDemoMode: isDemoMode)
    }

    /// Stripe Connect + checkout after Apple T&C and merchant education.
    func continueTapToPayLaunchAfterEducation(isDemoMode: Bool) async -> TapToPayLaunchResult {
        if !stripeConnected,
           hasLoadedStripeStatus,
           stripeHasAccount,
           stripeDetailsSubmitted {
            return .showAlert(stripePaymentsBlockedMessage)
        }

        if stripeConnected, !resolvedTapToPayLocationId.isEmpty {
            return .showCheckout
        }

        if !stripeConnected {
            if !hasLoadedStripeStatus {
                await refreshStripeConnectStatus(isDemoMode: isDemoMode)
                if stripeHasAccount && stripeDetailsSubmitted && !stripeConnected {
                    return .showAlert(stripePaymentsBlockedMessage)
                }
            }
        }

        if !stripeConnected {
            let connectOutcome = await createConnectAccountLink(isDemoMode: isDemoMode)
            switch connectOutcome {
            case .alreadyConnected:
                break
            case .pendingReview:
                return .showAlert(stripePaymentsBlockedMessage)
            case .openedInSafari:
                return .openedConnectInSafari
            case .noAction:
                if let err = errorMessage, !err.isEmpty {
                    return .showAlert(err)
                }
                if stripeHasAccount && stripeDetailsSubmitted {
                    return .showAlert(stripePaymentsBlockedMessage)
                }
                return .openedConnectInSafari
            }
        }

        guard stripeConnected else {
            if stripeHasAccount && stripeDetailsSubmitted {
                return .showAlert(stripePaymentsBlockedMessage)
            }
            return .openedConnectInSafari
        }

        if resolvedTapToPayLocationId.isEmpty {
            do {
                try await ensureTapToPayLocation()
            } catch {
                return .showAlert(FirebaseFunctionsErrorHelper.message(from: error))
            }
        }
        if resolvedTapToPayLocationId.isEmpty {
            return .showAlert("Tap to Pay could not be set up. Add your business address under Website Design, then try again.")
        }
        return .showCheckout
    }

    @MainActor
    func applyTapToPayLaunchResult(
        _ result: TapToPayLaunchResult,
        isDemoMode: Bool,
        showCheckout: () -> Void,
        showAlert: (String) -> Void,
        showEducation: () -> Void
    ) {
        switch result {
        case .showCheckout:
            showCheckout()
        case .showAlert(let message):
            showAlert(message)
        case .openedConnectInSafari:
            break
        case .showMerchantEducation:
            showEducation()
        }
    }

    @MainActor
    func finishMerchantEducationAndContinueTapToPay(
        isDemoMode: Bool,
        showCheckout: () -> Void,
        showAlert: (String) -> Void
    ) async {
        TapToPayMerchantEducationStore.markEducationSeen()
        let result = await continueTapToPayLaunchAfterEducation(isDemoMode: isDemoMode)
        applyTapToPayLaunchResult(
            result,
            isDemoMode: isDemoMode,
            showCheckout: showCheckout,
            showAlert: showAlert,
            showEducation: {}
        )
    }
    #endif

    private func applyConnectStatusFromResponse(_ data: [String: Any]?) {
        guard let data else { return }
        if let hasAccount = data["hasAccount"] as? Bool {
            stripeHasAccount = hasAccount
        }
        if let detailsSubmitted = data["detailsSubmitted"] as? Bool {
            stripeDetailsSubmitted = detailsSubmitted
        }
        if let chargesEnabled = data["chargesEnabled"] as? Bool {
            stripeConnected = chargesEnabled
            needsStripeConnect = canTakePayments && !chargesEnabled
            if chargesEnabled {
                stripeStatusHint = nil
                invalidateConnectLinkPrefetch()
            } else if stripeHasAccount && stripeDetailsSubmitted {
                stripeStatusHint = "Stripe is reviewing your account. Return to the app after setup — status updates automatically."
            }
        }
        hasLoadedStripeStatus = true
    }

    func loadData(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        isLoading = true
        errorMessage = nil
        if isDemoMode {
            if let payments = sessionStore?.demoPayments {
                stripeConnected = true
                stripeHasAccount = true
                stripeDetailsSubmitted = true
                needsStripeConnect = false
                stripeStatusHint = nil
                tenantId = sessionStore?.tenantId
                isTenantOwner = true
                canTakePayments = true
                usesOwnPayments = true
                availableBalance = Double(payments.availableBalanceCents) / 100
                pendingBalance = Double(payments.pendingBalanceCents) / 100
                transactions = payments.transactions.compactMap { PaymentTransaction.fromFirestoreDict($0) }
                hasLoadedStripeStatus = true
                isLoading = false
                return
            }
            stripeConnected = false
            stripeHasAccount = false
            stripeDetailsSubmitted = false
            needsStripeConnect = true
            stripeStatusHint = "Sign in with a real account to connect Stripe."
            hasLoadedStripeStatus = true
            isLoading = false
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            stripeConnected = false
            stripeHasAccount = false
            stripeDetailsSubmitted = false
            needsStripeConnect = true
            hasLoadedStripeStatus = true
            isLoading = false
            return
        }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                tenantId = nil
                stripeConnected = false
                stripeHasAccount = false
                stripeDetailsSubmitted = false
                needsStripeConnect = true
                stripeStatusHint = "Complete business setup before connecting payments."
                hasLoadedStripeStatus = true
                isLoading = false
                return
            }
            tenantId = tid
            let teamAccess = await TenantTeamAccessService.fetchCurrentAccess(isDemoMode: false)
            canTakePayments = teamAccess.canTakePayments
            usesOwnPayments = teamAccess.usesOwnPayments
            isStudioPayroll = !teamAccess.isOwner && teamAccess.payoutMode == .studioPayroll
            if let tenant = try? await firebaseService.fetchTenant(tenantId: tid) {
                if let ownerUid = tenant["ownerUid"] as? String, !ownerUid.isEmpty {
                    isTenantOwner = (ownerUid == uid)
                } else {
                    isTenantOwner = false
                }
            } else {
                isTenantOwner = false
            }
            await refreshStripeStatus()
            await reloadTapToPayLocationFromTenant()
            await loadTapToPaySettings(uid: uid)
            if stripeConnected {
                await loadBalance()
                await loadTransactions()
            } else {
                availableBalance = 0
                pendingBalance = 0
                transactions = []
            }
            isLoading = false
        } catch {
            isLoading = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    private func refreshStripeStatus() async {
        do {
            let result = try await functions.httpsCallable("getConnectAccountStatus").call()
            let data = result.data as? [String: Any]
            let hasAccount = data?["hasAccount"] as? Bool ?? false
            let chargesEnabled = data?["chargesEnabled"] as? Bool ?? false
            let detailsSubmitted = data?["detailsSubmitted"] as? Bool ?? false
            let payoutsEnabled = data?["payoutsEnabled"] as? Bool ?? false

            stripeHasAccount = hasAccount
            stripeDetailsSubmitted = detailsSubmitted
            stripeConnected = chargesEnabled
            needsStripeConnect = canTakePayments && !chargesEnabled
            if chargesEnabled {
                invalidateConnectLinkPrefetch()
            }
            if let loc = data?["terminalLocationId"] as? String {
                TapToPayLocationStore.shared.applyConnectStatus(
                    terminalLocationId: loc,
                    paymentScope: data?["paymentScope"] as? String
                )
            }
            if let scope = data?["paymentScope"] as? String, !scope.isEmpty {
                paymentStripeScope = scope
            }
            if let tapName = data?["tapToPayDisplayName"] as? String, !tapName.isEmpty {
                TapToPayLocationStore.shared.updateMerchantDisplayName(tapName)
            } else {
                applyTapToPayMerchantDisplayNameToStore()
            }
            if let requireSig = data?["tapToPayRequireSignature"] as? Bool {
                tapToPayRequireSignature = requireSig
            }
            applyTapToPayReceiptPreferences(from: data)
            if data?["studioPayroll"] as? Bool == true {
                isStudioPayroll = true
                canTakePayments = false
                needsStripeConnect = false
            }
            if let canTake = data?["canTakePayments"] as? Bool {
                canTakePayments = canTake
                if !canTake {
                    needsStripeConnect = false
                }
            }
            if let own = data?["usesOwnPayments"] as? Bool {
                usesOwnPayments = own
            }
            if chargesEnabled {
                stripeStatusHint = nil
            } else if hasAccount && detailsSubmitted {
                stripeStatusHint = "Stripe is reviewing your account. Return to the app after setup — status updates automatically."
            } else if hasAccount {
                stripeStatusHint = "Tap to continue where you left off."
            } else {
                stripeStatusHint = "Deposits, tips, and service payments"
            }
            _ = payoutsEnabled
        } catch {
            let stripeAccountId = try? await firebaseService.fetchTenantStripeAccountId(tenantId: tenantId ?? "")
            let hasId = !(stripeAccountId ?? "").isEmpty
            stripeHasAccount = hasId
            stripeDetailsSubmitted = false
            stripeConnected = false
            needsStripeConnect = true
            stripeStatusHint = hasId ? "Finish Stripe setup to accept payments." : nil
        }
        hasLoadedStripeStatus = true
    }

    private func loadBalance() async {
        do {
            let result = try await functions.httpsCallable("getConnectBalance").call()
            let data = result.data as? [String: Any]
            let availableCents = (data?["availableCents"] as? NSNumber)?.intValue ?? 0
            let pendingCents = (data?["pendingCents"] as? NSNumber)?.intValue ?? 0
            availableBalance = Double(availableCents) / 100
            pendingBalance = Double(pendingCents) / 100
        } catch {
            availableBalance = 0
            pendingBalance = 0
        }
    }

    private func loadTransactions() async {
        do {
            let result = try await functions.httpsCallable("getConnectBalanceTransactions").call()
            let data = result.data as? [String: Any]
            let list = data?["transactions"] as? [[String: Any]] ?? []
            transactions = list.compactMap { PaymentTransaction.fromFirestoreDict($0) }
        } catch {
            transactions = []
        }
    }

    @discardableResult
    func createConnectAccountLink(isDemoMode: Bool = false) async -> ConnectAccountLinkOutcome {
        if isDemoMode {
            errorMessage = "Stripe Connect isn't available in demo mode. Sign in with a real account."
            return .noAction
        }
        guard Auth.auth().currentUser != nil else {
            errorMessage = "You must be signed in to connect Stripe."
            return .noAction
        }
        if stripeConnected {
            stripeStatusHint = nil
            invalidateConnectLinkPrefetch()
            return .alreadyConnected
        }

        if let fetchedAt = prefetchedConnectFetchedAt,
           let cached = prefetchedConnectURL,
           Date().timeIntervalSince(fetchedAt) < connectLinkPrefetchTTL {
            invalidateConnectLinkPrefetch()
            isConnectingStripe = true
            defer { isConnectingStripe = false }
            let opened = await UIApplication.shared.open(cached)
            if !opened {
                errorMessage = "Could not open Stripe. Check that Safari is available."
                return .noAction
            }
            return .openedInSafari
        }

        return await fetchConnectAccountLink(openInSafari: true, isDemoMode: isDemoMode)
    }

    @discardableResult
    private func fetchConnectAccountLink(openInSafari: Bool, isDemoMode: Bool) async -> ConnectAccountLinkOutcome {
        if isDemoMode {
            errorMessage = "Stripe Connect isn't available in demo mode. Sign in with a real account."
            return .noAction
        }
        guard Auth.auth().currentUser != nil else {
            errorMessage = "You must be signed in to connect Stripe."
            return .noAction
        }
        if stripeConnected {
            stripeStatusHint = nil
            invalidateConnectLinkPrefetch()
            return .alreadyConnected
        }
        isConnectingStripe = true
        errorMessage = nil
        defer { isConnectingStripe = false }
        do {
            let base = Constants.Hosting.marketingWebOrigin
            let result = try await functions.httpsCallable("createConnectAccountLink").call([
                "returnBaseUrl": base,
                "returnUrl": "\(base)/account.html?stripe=success",
                "refreshUrl": "\(base)/account.html?stripe=refresh",
            ])
            let data = result.data as? [String: Any]

            if data?["alreadyConnected"] as? Bool == true {
                applyConnectStatusFromResponse([
                    "hasAccount": true,
                    "detailsSubmitted": data?["detailsSubmitted"] as? Bool ?? true,
                    "chargesEnabled": true,
                ] as [String: Any])
                invalidateConnectLinkPrefetch()
                return .alreadyConnected
            }

            if data?["pendingReview"] as? Bool == true {
                applyConnectStatusFromResponse([
                    "hasAccount": true,
                    "detailsSubmitted": true,
                    "chargesEnabled": false,
                ] as [String: Any])
                stripeStatusHint = "Stripe is reviewing your account. You'll be notified when charges are enabled."
                invalidateConnectLinkPrefetch()
                return .pendingReview
            }

            guard let urlString = data?["url"] as? String,
                  let url = URL(string: urlString) else {
                throw NSError(
                    domain: "Payments",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid response from server"]
                )
            }

            if openInSafari {
                invalidateConnectLinkPrefetch()
                let opened = await UIApplication.shared.open(url)
                if !opened {
                    errorMessage = "Could not open Stripe. Check that Safari is available."
                    return .noAction
                }
                return .openedInSafari
            }

            prefetchedConnectURL = url
            prefetchedConnectFetchedAt = Date()
            stripeHasAccount = true
            hasLoadedStripeStatus = true
            return .noAction
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            invalidateConnectLinkPrefetch()
            return .noAction
        }
    }

    func checkoutBreakdown(serviceCents: Int, channel: CardCheckoutChannel = .online) -> CardCheckoutBreakdown {
        CardCheckoutPricing.breakdown(serviceCents: serviceCents, channel: channel)
    }

    /// Creates a Stripe Payment Link for the service/deposit amount (fees grossed up server-side).
    func createDepositLink(serviceAmountCents: Int, bookingRequestId: String? = nil) async {
        guard serviceAmountCents >= 50 else { return }
        isCreatingDepositLink = true
        errorMessage = nil
        depositLinkUrl = nil
        do {
            var payload: [String: Any] = ["serviceAmountCents": serviceAmountCents]
            if let bookingRequestId, !bookingRequestId.isEmpty {
                payload["bookingRequestId"] = bookingRequestId
            }
            let result = try await functions.httpsCallable("createDepositLink").call(payload)
            let data = result.data as? [String: Any]
            let urlString = data?["url"] as? String
            isCreatingDepositLink = false
            depositLinkUrl = urlString
            if urlString == nil { errorMessage = "Invalid response from server" }
        } catch {
            isCreatingDepositLink = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    /// Stripe Payment Link for online card entry when Tap to Pay fails (PCI handled by Stripe checkout).
    func createManualCheckoutLink(
        serviceAmountCents: Int,
        bookingRequestId: String? = nil
    ) async throws -> URL {
        guard serviceAmountCents >= 50 else {
            throw NSError(
                domain: "Payments",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Amount must be at least $0.50"]
            )
        }
        isCreatingManualCheckoutLink = true
        defer { isCreatingManualCheckoutLink = false }
        var payload: [String: Any] = [
            "serviceAmountCents": serviceAmountCents,
            "productName": "Payment",
            "productDescription": "Secure online card entry",
            "paymentKind": "service",
        ]
        if let bookingRequestId, !bookingRequestId.isEmpty {
            payload["bookingRequestId"] = bookingRequestId
        }
        let result = try await functions.httpsCallable("createDepositLink").call(payload)
        let data = result.data as? [String: Any]
        guard let urlString = data?["url"] as? String, let url = URL(string: urlString) else {
            throw NSError(
                domain: "Payments",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Invalid response from server"]
            )
        }
        return url
    }

    func recordTenantPayment(paymentIntentId: String, bookingRequestId: String? = nil) async {
        guard !paymentIntentId.isEmpty else { return }
        do {
            var payload: [String: Any] = ["paymentIntentId": paymentIntentId]
            if let bookingRequestId, !bookingRequestId.isEmpty {
                payload["bookingRequestId"] = bookingRequestId
            }
            _ = try await functions.httpsCallable("recordTenantPayment").call(payload)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    /// Withdraw to bank. amountCents in USD cents.
    func createPayout(amountCents: Int) async {
        guard amountCents >= 50 else { return }
        isCreatingPayout = true
        errorMessage = nil
        do {
            _ = try await functions.httpsCallable("createPayout").call(["amountCents": amountCents])
            isCreatingPayout = false
            await loadBalance()
            await loadTransactions()
        } catch {
            isCreatingPayout = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    var resolvedTapToPayLocationId: String {
        TapToPayLocationStore.shared.resolvedLocationId
    }

    func reloadTapToPayLocationFromTenant() async {
        guard let tid = tenantId else {
            TapToPayLocationStore.shared.updateTenantLocationId("")
            return
        }
        guard let tenant = try? await firebaseService.fetchTenant(tenantId: tid) else { return }
        let loc = (tenant["stripeTerminalLocationId"] as? String) ?? ""
        TapToPayLocationStore.shared.updateTenantLocationId(loc)
    }

    /// Resolved customer-facing Tap to Pay label (draft or business-name fallback).
    var effectiveTapToPayDisplayName: String {
        let trimmed = tapToPayDisplayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        let fallback = tapToPayDisplayNamePlaceholder.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? "Studio" : fallback
    }

    private func loadTapToPaySettings(uid: String) async {
        guard canTakePayments else {
            canEditTapToPayDisplayName = false
            tapToPayDisplayNameDraft = ""
            tapToPayRequireSignature = false
            tapToPayReceiptPreferences = TapToPayReceiptPreferences()
            return
        }
        guard let tid = tenantId else {
            canEditTapToPayDisplayName = false
            return
        }
        let tenant = try? await firebaseService.fetchTenant(tenantId: tid)
        let businessName = (tenant?["businessName"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        tapToPayDisplayNamePlaceholder = businessName.isEmpty ? "Studio" : businessName

        if paymentStripeScope == "user" {
            canEditTapToPayDisplayName = usesOwnPayments
            guard usesOwnPayments else {
                tapToPayDisplayNameDraft = ""
                return
            }
            let userData = try? await firebaseService.fetchUserDocument(uid: uid)
            tapToPayDisplayNameDraft = (userData?["tapToPayDisplayName"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            tapToPayRequireSignature = userData?["tapToPayRequireSignature"] as? Bool ?? false
            tapToPayReceiptPreferences = TapToPayReceiptPreferences.fromFirestore(userData)
        } else {
            canEditTapToPayDisplayName = isTenantOwner
            guard isTenantOwner else {
                tapToPayDisplayNameDraft = ""
                return
            }
            tapToPayDisplayNameDraft = (tenant?["tapToPayDisplayName"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            tapToPayRequireSignature = tenant?["tapToPayRequireSignature"] as? Bool ?? false
            tapToPayReceiptPreferences = TapToPayReceiptPreferences.fromFirestore(tenant)
        }
        applyTapToPayMerchantDisplayNameToStore()
    }

    private func applyTapToPayReceiptPreferences(from data: [String: Any]?) {
        if let parsed = TapToPayReceiptPreferences.fromCallableResponse(data) {
            tapToPayReceiptPreferences = parsed
            return
        }
        tapToPayReceiptPreferences = TapToPayReceiptPreferences.fromFirestore(data)
    }

    func saveTapToPayReceiptPreferences(_ preferences: TapToPayReceiptPreferences) async {
        guard canEditTapToPayDisplayName else { return }
        isSavingTapToPaySettings = true
        tapToPaySettingsSaveSuccess = false
        errorMessage = nil
        defer { isSavingTapToPaySettings = false }
        do {
            let result = try await functions.httpsCallable("updateTapToPayDisplayName").call([
                "receiptPreferences": [
                    "delivery": preferences.delivery.rawValue,
                    "showBusinessName": preferences.showBusinessName,
                    "itemized": preferences.itemized,
                    "customFooter": preferences.customFooter,
                    "footerMessage": preferences.footerMessage,
                ] as [String: Any]
            ])
            let data = result.data as? [String: Any]
            applyTapToPayReceiptPreferences(from: data)
            tapToPaySettingsSaveSuccess = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                tapToPaySettingsSaveSuccess = false
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func tapToPayReceiptBody(
        amountCents: Int,
        includesSignature: Bool = false,
        clientName: String? = nil,
        note: String? = nil
    ) -> String {
        let amount = Self.formatUSD(Double(amountCents) / 100)
        var lines: [String] = []
        if tapToPayReceiptPreferences.showBusinessName {
            let name = effectiveTapToPayDisplayName
            if !name.isEmpty { lines.append(name) }
        }
        lines.append("Payment receipt — \(amount)")
        lines.append("Paid via Tap to Pay on iPhone.")
        if tapToPayReceiptPreferences.itemized {
            lines.append("Amount: \(amount)")
        }
        let trimmedClient = (clientName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedClient.isEmpty {
            lines.append("Client: \(trimmedClient)")
        }
        let trimmedNote = (note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedNote.isEmpty {
            lines.append(trimmedNote)
        }
        if includesSignature {
            lines.append("Customer signature: on file")
        }
        if tapToPayReceiptPreferences.customFooter {
            let footer = tapToPayReceiptPreferences.footerMessage
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !footer.isEmpty { lines.append(footer) }
        }
        lines.append("Thank you for your business.")
        return lines.joined(separator: "\n")
    }

    private func applyTapToPayMerchantDisplayNameToStore(forceReconnect: Bool = false) {
        TapToPayLocationStore.shared.updateMerchantDisplayName(
            effectiveTapToPayDisplayName,
            forceReconnect: forceReconnect
        )
    }

    func saveTapToPayDisplayName() async {
        guard canEditTapToPayDisplayName else { return }
        let trimmed = tapToPayDisplayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        isSavingTapToPayDisplayName = true
        tapToPayDisplayNameSaveSuccess = false
        errorMessage = nil
        defer { isSavingTapToPayDisplayName = false }
        do {
            let result = try await functions.httpsCallable("updateTapToPayDisplayName").call([
                "displayName": trimmed
            ])
            let data = result.data as? [String: Any]
            if let loc = data?["locationId"] as? String, !loc.isEmpty {
                TapToPayLocationStore.shared.applyConnectStatus(
                    terminalLocationId: loc,
                    paymentScope: data?["paymentScope"] as? String ?? paymentStripeScope
                )
            }
            if let resolved = data?["displayName"] as? String, !resolved.isEmpty {
                TapToPayLocationStore.shared.updateMerchantDisplayName(resolved, forceReconnect: true)
            } else {
                applyTapToPayMerchantDisplayNameToStore(forceReconnect: true)
            }
            tapToPayDisplayNameSaveSuccess = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                tapToPayDisplayNameSaveSuccess = false
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func saveTapToPayPaymentSettings(requireSignature: Bool? = nil) async {
        guard canEditTapToPayDisplayName else { return }
        isSavingTapToPaySettings = true
        tapToPaySettingsSaveSuccess = false
        errorMessage = nil
        defer { isSavingTapToPaySettings = false }
        var payload: [String: Any] = [:]
        if let requireSignature {
            payload["requireSignature"] = requireSignature
        }
        guard !payload.isEmpty else { return }
        do {
            let result = try await functions.httpsCallable("updateTapToPayDisplayName").call(payload)
            let data = result.data as? [String: Any]
            if let sig = data?["requireSignature"] as? Bool {
                tapToPayRequireSignature = sig
            }
            applyTapToPayReceiptPreferences(from: data)
            tapToPaySettingsSaveSuccess = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                tapToPaySettingsSaveSuccess = false
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    #if TAP_TO_PAY_ENABLED
    /// Creates Stripe Terminal Location on the connected account if missing; returns `tml_…` id.
    @discardableResult
    func ensureTapToPayLocation() async throws -> String {
        isEnsuringTapToPayLocation = true
        defer { isEnsuringTapToPayLocation = false }
        if !resolvedTapToPayLocationId.isEmpty {
            return resolvedTapToPayLocationId
        }
        let result = try await functions.httpsCallable("ensureTapToPayTerminalLocation").call([:])
        let data = result.data as? [String: Any]
        let locationId = (data?["locationId"] as? String) ?? ""
        if !locationId.isEmpty {
            TapToPayLocationStore.shared.applyConnectStatus(
                terminalLocationId: locationId,
                paymentScope: data?["paymentScope"] as? String ?? paymentStripeScope
            )
        }
        if let resolved = data?["displayName"] as? String, !resolved.isEmpty {
            TapToPayLocationStore.shared.updateMerchantDisplayName(resolved)
        }
        guard !resolvedTapToPayLocationId.isEmpty else {
            throw NSError(
                domain: "TapToPay",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "Could not set up Tap to Pay. Add your business address in Website Design, then try again."]
            )
        }
        return resolvedTapToPayLocationId
    }

    /// Creates a Stripe PaymentIntent for Tap to Pay (fees grossed up server-side).
    func createPaymentIntentForTapToPay(
        serviceAmountCents: Int,
        bookingRequestId: String? = nil
    ) async throws -> TapToPayPaymentIntent {
        guard serviceAmountCents >= 50 else {
            throw NSError(
                domain: "TapToPay",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Amount must be at least $0.50"]
            )
        }
        var payload: [String: Any] = ["serviceAmountCents": serviceAmountCents]
        if let bookingRequestId, !bookingRequestId.isEmpty {
            payload["bookingRequestId"] = bookingRequestId
        }
        let result = try await functions.httpsCallable("createPaymentIntentForTapToPay").call(payload)
        let data = result.data as? [String: Any]
        guard let clientSecret = data?["clientSecret"] as? String, !clientSecret.isEmpty else {
            throw NSError(
                domain: "TapToPay",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid response from server (missing clientSecret)"]
            )
        }
        let paymentIntentId = (data?["paymentIntentId"] as? String) ?? ""
        let service = (data?["serviceCents"] as? Int) ?? serviceAmountCents
        let passThrough = (data?["surchargeCents"] as? Int) ?? 0
        let total = (data?["totalCents"] as? Int) ?? (service + passThrough)
        let platformFee = (data?["platformFeeCents"] as? Int)
            ?? CardCheckoutPricing.platformFeeCents(totalCents: total)
        let checkout = CardCheckoutBreakdown(
            serviceCents: service,
            passThroughFeeCents: passThrough,
            platformFeeCents: platformFee,
            totalCents: total,
            channel: .tapToPay
        )
        return TapToPayPaymentIntent(
            clientSecret: clientSecret,
            paymentIntentId: paymentIntentId,
            checkout: checkout
        )
    }
    #endif

    /// Opens Stripe receipt for a charge in Safari.
    func openReceipt(chargeId: String) async {
        guard let url = await fetchReceiptUrl(chargeId: chargeId) else { return }
        await UIApplication.shared.open(url)
    }

    func fetchReceiptDetail(
        chargeId: String,
        fallbackTransaction: PaymentTransaction? = nil,
        businessName: String = "Receipt"
    ) async -> PaymentReceiptDetail? {
        errorMessage = nil
        do {
            let result = try await functions.httpsCallable("getPaymentReceiptDetail").call(["chargeId": chargeId])
            guard let data = result.data as? [String: Any],
                  let detail = PaymentReceiptDetail.fromFirestoreDict(data) else {
                if let txn = fallbackTransaction {
                    return PaymentReceiptDetail.fallback(from: txn, businessName: businessName)
                }
                return nil
            }
            return detail
        } catch {
            if let txn = fallbackTransaction {
                return PaymentReceiptDetail.fallback(from: txn, businessName: businessName)
            }
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return nil
        }
    }

    @MainActor
    func receiptPDFURL(for detail: PaymentReceiptDetail) -> URL? {
        PaymentReceiptPDFExporter.writePDF(detail: detail)
    }

    func fetchReceiptUrl(chargeId: String) async -> URL? {
        errorMessage = nil
        do {
            let result = try await functions.httpsCallable("getReceiptUrl").call(["chargeId": chargeId])
            let data = result.data as? [String: Any]
            guard let urlString = data?["url"] as? String, let url = URL(string: urlString) else { return nil }
            return url
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return nil
        }
    }

    /// Refund a charge. Pass nil amountCents for full refund. Returns true on success.
    @discardableResult
    func createRefund(chargeId: String, amountCents: Int? = nil, reason: String = "requested_by_customer") async -> Bool {
        isRefunding = true
        errorMessage = nil
        defer { isRefunding = false }
        do {
            var params: [String: Any] = ["chargeId": chargeId, "reason": reason]
            if let amount = amountCents, amount > 0 { params["amountCents"] = amount }
            _ = try await functions.httpsCallable("createRefund").call(params)
            await loadBalance()
            await loadTransactions()
            return true
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            return false
        }
    }
}
