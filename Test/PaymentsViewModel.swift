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
    let type: String // deposit, service_payment, payout, refund
    let amount: Double
    let customerName: String?
    let createdAt: Date?
    let status: String
}

class PaymentsViewModel: ObservableObject {
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    @Published var stripeConnected: Bool = false
    @Published var tenantId: String?
    @Published var isLoading = false
    @Published var isConnectingStripe = false
    @Published var errorMessage: String?
    @Published var transactions: [PaymentTransaction] = []
    @Published var depositLinkUrl: String?
    @Published var isCreatingDepositLink = false

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions()

    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true; errorMessage = nil }
        if isDemoMode {
            await MainActor.run { isLoading = false }
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            await MainActor.run { isLoading = false }
            return
        }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                await MainActor.run {
                    tenantId = nil
                    stripeConnected = false
                    isLoading = false
                }
                return
            }
            let stripeAccountId = try await firebaseService.fetchTenantStripeAccountId(tenantId: tid)
            await MainActor.run {
                tenantId = tid
                stripeConnected = stripeAccountId != nil && !(stripeAccountId ?? "").isEmpty
                isLoading = false
            }
        } catch {
            await MainActor.run { isLoading = false }
        }
    }

    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
    }

    func createConnectAccountLink() async {
        await MainActor.run { isConnectingStripe = true; errorMessage = nil }
        do {
            let result = try await functions.httpsCallable("createConnectAccountLink").call()
            let data = result.data as? [String: Any]
            let urlString = data?["url"] as? String
            guard let url = urlString.flatMap({ URL(string: $0) }) else {
                throw NSError(domain: "Payments", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response from server"])
            }
            await MainActor.run { isConnectingStripe = false }
            await UIApplication.shared.open(url)
            await loadData()
        } catch {
            await MainActor.run {
                isConnectingStripe = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Creates a Stripe Payment Link for the given amount. amountCents in USD cents (e.g. 2500 = $25).
    func createDepositLink(amountCents: Int) async {
        guard amountCents >= 50 else { return }
        await MainActor.run { isCreatingDepositLink = true; errorMessage = nil; depositLinkUrl = nil }
        do {
            let result = try await functions.httpsCallable("createDepositLink").call(["amountCents": amountCents])
            let data = result.data as? [String: Any]
            let urlString = data?["url"] as? String
            await MainActor.run {
                isCreatingDepositLink = false
                depositLinkUrl = urlString
                if urlString == nil { errorMessage = "Invalid response from server" }
            }
        } catch {
            await MainActor.run {
                isCreatingDepositLink = false
                errorMessage = error.localizedDescription
            }
        }
    }
}
