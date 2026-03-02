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

enum StripeConnectionStatus {
    case notConnected      // no account
    case pendingApproval   // onboarding done, Stripe reviewing
    case fullyConnected    // charges_enabled, ready to accept payments
}

class PaymentsViewModel: ObservableObject {
    @Published var availableBalance: Double = 0
    @Published var pendingBalance: Double = 0
    @Published var stripeStatus: StripeConnectionStatus = .notConnected
    @Published var stripeConnected: Bool = false
    @Published var tenantId: String?
    @Published var isLoading = false
    @Published var isConnectingStripe = false
    @Published var errorMessage: String?
    @Published var transactions: [PaymentTransaction] = []

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
        var tid: String?
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tenantId = profile?.tenantId else {
                await MainActor.run {
                    self.tenantId = nil
                    stripeStatus = .notConnected
                    stripeConnected = false
                    isLoading = false
                }
                return
            }
            tid = tenantId
            let result = try await functions.httpsCallable("getConnectAccountStatus").call()
            let data = result.data as? [String: Any]
            let hasAccount = data?["hasAccount"] as? Bool ?? false
            let chargesEnabled = data?["chargesEnabled"] as? Bool ?? false
            let detailsSubmitted = data?["detailsSubmitted"] as? Bool ?? false

            let status: StripeConnectionStatus
            if !hasAccount {
                status = .notConnected
            } else if chargesEnabled {
                status = .fullyConnected
            } else if detailsSubmitted {
                status = .pendingApproval
            } else {
                status = .notConnected
            }

            await MainActor.run {
                self.tenantId = tenantId
                stripeStatus = status
                stripeConnected = chargesEnabled
                isLoading = false
            }
        } catch {
            // Fallback: try Firestore-only if Cloud Function fails (e.g. Stripe not configured)
            if let tenantId = tid {
                do {
                    let stripeAccountId = try await firebaseService.fetchTenantStripeAccountId(tenantId: tenantId)
                    await MainActor.run {
                        self.tenantId = tenantId
                        stripeStatus = (stripeAccountId != nil && !(stripeAccountId ?? "").isEmpty) ? .pendingApproval : .notConnected
                        stripeConnected = false
                        isLoading = false
                    }
                } catch {
                    await MainActor.run {
                        self.tenantId = tenantId
                        stripeStatus = .notConnected
                        stripeConnected = false
                        isLoading = false
                    }
                }
            } else {
                await MainActor.run {
                    self.tenantId = nil
                    stripeStatus = .notConnected
                    stripeConnected = false
                    isLoading = false
                }
            }
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
}
