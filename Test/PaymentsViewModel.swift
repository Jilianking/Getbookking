//
//  PaymentsViewModel.swift
//
//  Manages payments, balance, and Stripe Connect for providers.
//

import Foundation
import Combine
import UIKit
import FirebaseAuth
import FirebaseFunctions

struct PaymentTransaction: Identifiable {
    let id: String
    let type: String // charge, payout, refund, etc.
    let amount: Double
    let customerName: String?
    let createdAt: Date?
    let status: String
    /// Stripe charge ID when type is "charge"; used for receipt and refund.
    let chargeId: String?
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
    @Published var needsStripeConnect: Bool = true
    @Published var stripeStatusHint: String?
    @Published var tenantId: String?
    @Published var isTenantOwner = false
    @Published var canTakePayments = true
    @Published var usesOwnPayments = false
    @Published var isStudioPayroll = false
    @Published var paymentStripeScope = "tenant"
    @Published var isEnsuringTapToPayLocation = false
    @Published var isLoading = false
    @Published var isConnectingStripe = false
    @Published var errorMessage: String?
    @Published var transactions: [PaymentTransaction] = []
    @Published var depositLinkUrl: String?
    @Published var isCreatingDepositLink = false
    @Published var isCreatingPayout = false
    @Published var isRefunding = false

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

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
                transactions = payments.transactions.compactMap { t -> PaymentTransaction? in
                    guard let id = t["id"] as? String else { return nil }
                    let typeStr = t["type"] as? String ?? "unknown"
                    let amountCents = (t["net"] as? NSNumber)?.intValue
                        ?? (t["amountCents"] as? NSNumber)?.intValue
                        ?? (t["amount"] as? NSNumber)?.intValue
                        ?? 0
                    let amount = Double(amountCents) / 100
                    let description = t["description"] as? String
                    let created = (t["created"] as? NSNumber)?.intValue ?? 0
                    let createdAt = created > 0 ? Date(timeIntervalSince1970: TimeInterval(created)) : nil
                    let sourceId = t["sourceId"] as? String
                    let chargeId = (typeStr == "charge" && sourceId?.hasPrefix("ch_") == true) ? sourceId : nil
                    return PaymentTransaction(
                        id: id,
                        type: typeStr,
                        amount: abs(amount),
                        customerName: description,
                        createdAt: createdAt,
                        status: "completed",
                        chargeId: chargeId
                    )
                }
                isLoading = false
                return
            }
            stripeConnected = false
            stripeHasAccount = false
            stripeDetailsSubmitted = false
            needsStripeConnect = true
            stripeStatusHint = "Sign in with a real account to connect Stripe."
            isLoading = false
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            stripeConnected = false
            stripeHasAccount = false
            stripeDetailsSubmitted = false
            needsStripeConnect = true
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
            if let loc = data?["terminalLocationId"] as? String {
                TapToPayLocationStore.shared.applyConnectStatus(
                    terminalLocationId: loc,
                    paymentScope: data?["paymentScope"] as? String
                )
            }
            if let scope = data?["paymentScope"] as? String, !scope.isEmpty {
                paymentStripeScope = scope
            }
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
            let txns = list.compactMap { t -> PaymentTransaction? in
                guard let id = t["id"] as? String else { return nil }
                let typeStr = t["type"] as? String ?? "unknown"
                let amountCents = (t["net"] as? NSNumber)?.intValue ?? (t["amount"] as? NSNumber)?.intValue ?? 0
                let amount = Double(amountCents) / 100
                let description = t["description"] as? String
                let created = (t["created"] as? NSNumber)?.intValue ?? 0
                let createdAt = created > 0 ? Date(timeIntervalSince1970: TimeInterval(created)) : nil
                let sourceId = t["sourceId"] as? String
                let chargeId = (typeStr == "charge" && sourceId?.hasPrefix("ch_") == true) ? sourceId : nil
                return PaymentTransaction(
                    id: id,
                    type: typeStr,
                    amount: abs(amount),
                    customerName: description,
                    createdAt: createdAt,
                    status: "completed",
                    chargeId: chargeId
                )
            }
            transactions = txns
        } catch {
            transactions = []
        }
    }

    func createConnectAccountLink(isDemoMode: Bool = false) async {
        if isDemoMode {
            errorMessage = "Stripe Connect isn't available in demo mode. Sign in with a real account."
            return
        }
        guard Auth.auth().currentUser != nil else {
            errorMessage = "You must be signed in to connect Stripe."
            return
        }
        if stripeConnected {
            stripeStatusHint = nil
            return
        }
        isConnectingStripe = true
        errorMessage = nil
        do {
            let base = Constants.Hosting.marketingWebOrigin
            let result = try await functions.httpsCallable("createConnectAccountLink").call([
                "returnBaseUrl": base,
                "returnUrl": "\(base)/account.html?stripe=success",
                "refreshUrl": "\(base)/account.html?stripe=refresh",
            ])
            let data = result.data as? [String: Any]
            isConnectingStripe = false

            if data?["alreadyConnected"] as? Bool == true {
                await refreshStripeConnectStatus(isDemoMode: false)
                stripeStatusHint = nil
                return
            }

            if data?["pendingReview"] as? Bool == true {
                stripeHasAccount = true
                stripeDetailsSubmitted = true
                needsStripeConnect = true
                stripeStatusHint = "Stripe is reviewing your account. You'll be notified when charges are enabled."
                await refreshStripeConnectStatus(isDemoMode: false)
                return
            }

            guard let urlString = data?["url"] as? String,
                  let url = URL(string: urlString) else {
                throw NSError(
                    domain: "Payments",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid response from server"]
                )
            }
            let opened = await UIApplication.shared.open(url)
            if !opened {
                errorMessage = "Could not open Stripe. Check that Safari is available."
            }
        } catch {
            isConnectingStripe = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
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
        errorMessage = nil
        do {
            let result = try await functions.httpsCallable("getReceiptUrl").call(["chargeId": chargeId])
            let data = result.data as? [String: Any]
            guard let urlString = data?["url"] as? String, let url = URL(string: urlString) else { return }
            await UIApplication.shared.open(url)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    /// Refund a charge. Pass nil amountCents for full refund.
    func createRefund(chargeId: String, amountCents: Int? = nil, reason: String = "requested_by_customer") async {
        isRefunding = true
        errorMessage = nil
        do {
            var params: [String: Any] = ["chargeId": chargeId, "reason": reason]
            if let amount = amountCents, amount > 0 { params["amountCents"] = amount }
            _ = try await functions.httpsCallable("createRefund").call(params)
            isRefunding = false
            await loadBalance()
            await loadTransactions()
        } catch {
            isRefunding = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }
}
