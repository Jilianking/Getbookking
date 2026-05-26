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

@MainActor
class PaymentsViewModel: ObservableObject {
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    /// True when Stripe Connect can accept charges (not just when an account id exists).
    @Published var stripeConnected: Bool = false
    /// Show Connect / complete-setup banner when onboarding isn't finished.
    @Published var needsStripeConnect: Bool = true
    @Published var stripeStatusHint: String?
    @Published var tenantId: String?
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

    func loadData(isDemoMode: Bool = false) async {
        isLoading = true
        errorMessage = nil
        if isDemoMode {
            stripeConnected = false
            needsStripeConnect = true
            stripeStatusHint = "Sign in with a real account to connect Stripe."
            isLoading = false
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            stripeConnected = false
            needsStripeConnect = true
            isLoading = false
            return
        }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                tenantId = nil
                stripeConnected = false
                needsStripeConnect = true
                stripeStatusHint = "Complete business setup before connecting payments."
                isLoading = false
                return
            }
            tenantId = tid
            await refreshStripeStatus()
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

            stripeConnected = chargesEnabled
            needsStripeConnect = !chargesEnabled
            if chargesEnabled {
                stripeStatusHint = nil
            } else if hasAccount && detailsSubmitted {
                stripeStatusHint = "Stripe is reviewing your account. Pull to refresh."
            } else if hasAccount {
                stripeStatusHint = "Finish Stripe setup to accept payments."
            } else {
                stripeStatusHint = nil
            }
            _ = payoutsEnabled
        } catch {
            let stripeAccountId = try? await firebaseService.fetchTenantStripeAccountId(tenantId: tenantId ?? "")
            let hasId = !(stripeAccountId ?? "").isEmpty
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

    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
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
            let urlString = data?["url"] as? String
            guard let url = urlString.flatMap({ URL(string: $0) }) else {
                throw NSError(
                    domain: "Payments",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid response from server"]
                )
            }
            isConnectingStripe = false
            let opened = await UIApplication.shared.open(url)
            if !opened {
                errorMessage = "Could not open Stripe. Check that Safari is available."
                return
            }
            await loadData(isDemoMode: false)
        } catch {
            isConnectingStripe = false
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    /// Creates a Stripe Payment Link for the given amount. amountCents in USD cents (e.g. 2500 = $25).
    func createDepositLink(amountCents: Int) async {
        guard amountCents >= 50 else { return }
        isCreatingDepositLink = true
        errorMessage = nil
        depositLinkUrl = nil
        do {
            let result = try await functions.httpsCallable("createDepositLink").call(["amountCents": amountCents])
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
