//
//  BookkingSubscriptionStore.swift
//
//  App Store subscriptions for the Get Bookking plan. Texting stays locked
//  while an introductory free period is still running.
//

import Combine
import Foundation
import FirebaseAuth
import FirebaseFunctions
import StoreKit

enum BookkingProductID {
    static let solo = "com.jilianking.getbooking.solo"
    static let studio = "com.jilianking.getbooking.studio"
    static let shop = "com.jilianking.getbooking.shop"
    static let charter = "com.jilianking.getbooking.charter"
    /// Same plan, no free trial, ranked one level higher so Apple charges immediately.
    static let soloNow = "com.jilianking.getbooking.solo.now"
    static let studioNow = "com.jilianking.getbooking.studio.now"
    static let shopNow = "com.jilianking.getbooking.shop.now"
    static let charterNow = "com.jilianking.getbooking.charter.now"
    static let smsExtra = "com.jilianking.getbooking.sms.extra"

    static func subscriptionID(for plan: SubscriptionPlan) -> String {
        switch plan {
        case .solo: return solo
        case .studio: return studio
        case .shop: return shop
        case .charter: return charter
        }
    }

    static func paidSubscriptionID(for plan: SubscriptionPlan) -> String {
        switch plan {
        case .solo: return soloNow
        case .studio: return studioNow
        case .shop: return shopNow
        case .charter: return charterNow
        }
    }

    static func plan(for productID: String) -> SubscriptionPlan? {
        switch productID {
        case solo, soloNow: return .solo
        case studio, studioNow: return .studio
        case shop, shopNow: return .shop
        case charter, charterNow: return .charter
        default: return nil
        }
    }
}

enum BookkingPurchaseError: LocalizedError {
    case cancelled
    case pending
    case unverified
    case productUnavailable
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Purchase cancelled."
        case .pending:
            return "Purchase is pending approval."
        case .unverified:
            return "The App Store could not verify this purchase."
        case .productUnavailable:
            return "This plan is not available in the App Store yet."
        case .notSignedIn:
            return "Sign in before starting a plan."
        }
    }
}

struct BookkingPurchaseRecord: Sendable {
    let productID: String
    let originalTransactionID: UInt64
    let isIntroductory: Bool
    let expiresAt: Date?
    /// Local StoreKit configuration transaction. Never send it to production receipt verification.
    let isXcodeEnvironment: Bool
    /// Apple's signed transaction. The server verifies this and ignores the other fields.
    let signedTransaction: String
}

/// A one-time App Store payment for a texting number, held open until the server records it.
struct BookkingSmsExtraPurchase {
    /// Apple's signed receipt. The server verifies this before it buys a number.
    let signedTransaction: String
    fileprivate let transaction: Transaction
}

@MainActor
final class BookkingSubscriptionStore: ObservableObject {
    static let shared = BookkingSubscriptionStore()

    @Published private(set) var isPurchasing = false
    /// Whether this Apple account can still get the 14-day free trial. Apple gives it once per
    /// account, so a returning customer is charged from day one. True until Apple says otherwise.
    @Published private(set) var isEligibleForFreeTrial = true
    private var productsByID: [String: StoreKit.Product] = [:]
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    private var transactionUpdates: Task<Void, Never>?

    private init() {
        transactionUpdates = observeTransactionUpdates()
    }

    /// Purchases that finish outside the payment sheet: Ask to Buy approvals, renewals, and
    /// purchases interrupted before the app could record them.
    private func observeTransactionUpdates() -> Task<Void, Never> {
        Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { return }
                guard case .verified(let transaction) = update,
                      BookkingProductID.plan(for: transaction.productID) != nil else { continue }
                if await self.syncEntitlement(update, transaction: transaction) {
                    await transaction.finish()
                }
            }
        }
    }

    /// Sends this Apple ID's active plan to the server so a purchase the app never recorded
    /// (new phone, reinstall, lost connection) is applied. Quiet: the server only accepts a
    /// subscription bought by the signed-in account. Returns true when a plan was recorded.
    @discardableResult
    func syncActiveEntitlements() async -> Bool {
        guard Auth.auth().currentUser != nil else { return false }
        var synced = false
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement,
                  transaction.revocationDate == nil,
                  BookkingProductID.plan(for: transaction.productID) != nil else { continue }
            if await syncEntitlement(entitlement, transaction: transaction) {
                synced = true
            }
        }
        return synced
    }

    /// The active plan this login has already bought, if any. Used to finish an interrupted
    /// sign-up without opening the payment sheet again.
    func existingSubscriptionRecord() async -> BookkingPurchaseRecord? {
        guard let accountToken = try? await prepareAccountToken() else { return nil }
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement,
                  transaction.revocationDate == nil,
                  transaction.appAccountToken == accountToken,
                  BookkingProductID.plan(for: transaction.productID) != nil else { continue }
            return BookkingPurchaseRecord(
                productID: transaction.productID,
                originalTransactionID: transaction.originalID,
                isIntroductory: transaction.offerType == Transaction.OfferType.introductory,
                expiresAt: transaction.expirationDate,
                isXcodeEnvironment: transaction.environment == .xcode,
                signedTransaction: entitlement.jwsRepresentation
            )
        }
        return nil
    }

    /// True when this Apple ID has any active Get Bookking plan, whichever account bought it.
    /// Used on the sign-up screen to point someone who already subscribed to logging in.
    func hasActiveSubscriptionOnThisAppleID() async -> Bool {
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement,
                  transaction.revocationDate == nil,
                  BookkingProductID.plan(for: transaction.productID) != nil else { continue }
            return true
        }
        return false
    }

    /// Restore purchases: asks the App Store for this Apple ID's purchases, then records the plan.
    /// Returns false when the Apple ID has no plan that belongs to this account.
    func restorePurchases() async throws -> Bool {
        guard Auth.auth().currentUser != nil else {
            throw BookkingPurchaseError.notSignedIn
        }
        do {
            try await AppStore.sync()
        } catch StoreKitError.userCancelled {
            // Closing the App Store sign-in sheet is not an error worth showing.
            throw BookkingPurchaseError.cancelled
        }
        return await syncActiveEntitlements()
    }

    private func syncEntitlement(
        _ result: VerificationResult<Transaction>,
        transaction: Transaction
    ) async -> Bool {
        // Xcode's local StoreKit receipts are not Apple-signed; the server rejects them.
        guard transaction.environment != .xcode, Auth.auth().currentUser != nil else { return false }
        do {
            _ = try await functions.httpsCallable("syncAppleSubscription").call([
                "signedTransaction": result.jwsRepresentation,
            ])
            return true
        } catch {
            return false
        }
    }

    func loadProducts() async {
        let ids = [
            BookkingProductID.solo,
            BookkingProductID.studio,
            BookkingProductID.shop,
            BookkingProductID.charter,
            BookkingProductID.soloNow,
            BookkingProductID.studioNow,
            BookkingProductID.shopNow,
            BookkingProductID.charterNow,
            BookkingProductID.smsExtra,
        ]
        do {
            let products = try await StoreKit.Product.products(for: ids)
            productsByID = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        } catch {
            productsByID = [:]
        }
    }

    /// Asks Apple whether the free trial is still available to this Apple account.
    func refreshTrialEligibility() async {
        if productsByID[BookkingProductID.solo] == nil {
            await loadProducts()
        }
        let trialProducts = [
            BookkingProductID.solo,
            BookkingProductID.studio,
            BookkingProductID.shop,
            BookkingProductID.charter,
        ]
        guard let subscription = trialProducts.lazy
            .compactMap({ self.productsByID[$0]?.subscription })
            .first(where: { $0.introductoryOffer != nil }) else { return }
        isEligibleForFreeTrial = await subscription.isEligibleForIntroOffer
    }

    /// Apple's price for a new texting number, once the App Store products have loaded.
    var smsExtraDisplayPrice: String? {
        productsByID[BookkingProductID.smsExtra]?.displayPrice
    }

    func displayPrice(for plan: SubscriptionPlan) -> String {
        if let price = productsByID[BookkingProductID.subscriptionID(for: plan)]?.displayPrice {
            return price
        }
        switch plan {
        case .solo: return "$39.99"
        case .studio: return "$79.99"
        case .shop: return "$149.99"
        case .charter: return "$24.99"
        }
    }

    func trialLine(for plan: SubscriptionPlan) -> String {
        let price = displayPrice(for: plan)
        return "14 days free, then \(price) a month"
    }

    @discardableResult
    /// Start paid plan. Buys the no-trial product so an active free period ends and Apple charges today.
    func purchaseAndSync(plan: SubscriptionPlan) async throws -> BookkingPurchaseRecord {
        let record = try await purchaseSubscription(plan: plan, payNow: true)
        try await sync(record)
        return record
    }

    /// Account id Apple copies into the receipt. Created once per login.
    func prepareAccountToken() async throws -> UUID {
        guard Auth.auth().currentUser != nil else {
            throw BookkingPurchaseError.notSignedIn
        }
        let result = try await functions.httpsCallable("prepareAppleAccountToken").call([:])
        let data = result.data as? [String: Any]
        guard let raw = data?["appleAppAccountToken"] as? String,
              let uuid = UUID(uuidString: raw) else {
            throw BookkingPurchaseError.unverified
        }
        return uuid
    }

    /// Pays for a texting number. The payment stays open with Apple until `settleSmsExtra`
    /// says the server recorded it, so a dropped connection can't lose a payment.
    func purchaseSmsExtra() async throws -> BookkingSmsExtraPurchase {
        let accountToken = try await prepareAccountToken()
        // A payment Apple already took for this account but the server never recorded is
        // used first instead of charging again.
        for await pending in Transaction.unfinished {
            guard case .verified(let transaction) = pending,
                  transaction.productID == BookkingProductID.smsExtra,
                  transaction.revocationDate == nil,
                  transaction.appAccountToken == accountToken else { continue }
            return BookkingSmsExtraPurchase(
                signedTransaction: pending.jwsRepresentation,
                transaction: transaction
            )
        }
        if productsByID[BookkingProductID.smsExtra] == nil {
            await loadProducts()
        }
        guard let product = productsByID[BookkingProductID.smsExtra] else {
            throw BookkingPurchaseError.productUnavailable
        }
        isPurchasing = true
        defer { isPurchasing = false }
        let result = try await product.purchase(options: [.appAccountToken(accountToken)])
        switch result {
        case .success(let verification):
            let transaction = try verified(verification)
            return BookkingSmsExtraPurchase(
                signedTransaction: verification.jwsRepresentation,
                transaction: transaction
            )
        case .userCancelled:
            throw BookkingPurchaseError.cancelled
        case .pending:
            throw BookkingPurchaseError.pending
        @unknown default:
            throw BookkingPurchaseError.unverified
        }
    }

    /// Closes a texting-number payment with Apple once the server has recorded it (`error` nil)
    /// or says it was already spent. Any other failure leaves it open so the next attempt
    /// reuses the same payment instead of charging again.
    func settleSmsExtra(_ purchase: BookkingSmsExtraPurchase, error: Error? = nil) async {
        var isSpent = false
        if let error {
            let ns = error as NSError
            isSpent = ns.domain == FunctionsErrorDomain
                && ns.code == FunctionsErrorCode.alreadyExists.rawValue
        }
        // Xcode's local StoreKit receipts are never accepted by the server; don't keep them open.
        if error == nil || isSpent || purchase.transaction.environment == .xcode {
            await purchase.transaction.finish()
        }
    }

    func purchaseSubscription(plan: SubscriptionPlan, payNow: Bool = false) async throws -> BookkingPurchaseRecord {
        let productID = payNow
            ? BookkingProductID.paidSubscriptionID(for: plan)
            : BookkingProductID.subscriptionID(for: plan)
        if productsByID[productID] == nil {
            await loadProducts()
        }
        guard let product = productsByID[productID] else {
            throw BookkingPurchaseError.productUnavailable
        }
        let accountToken = try await prepareAccountToken()
        isPurchasing = true
        defer { isPurchasing = false }
        let result = try await product.purchase(options: [.appAccountToken(accountToken)])
        switch result {
        case .success(let verification):
            let transaction = try verified(verification)
            let record = BookkingPurchaseRecord(
                productID: transaction.productID,
                originalTransactionID: transaction.originalID,
                isIntroductory: transaction.offerType == Transaction.OfferType.introductory,
                expiresAt: transaction.expirationDate,
                isXcodeEnvironment: transaction.environment == .xcode,
                signedTransaction: verification.jwsRepresentation
            )
            await transaction.finish()
            return record
        case .userCancelled:
            throw BookkingPurchaseError.cancelled
        case .pending:
            throw BookkingPurchaseError.pending
        @unknown default:
            throw BookkingPurchaseError.unverified
        }
    }

    private func verified(_ result: VerificationResult<Transaction>) throws -> Transaction {
        switch result {
        case .unverified:
            throw BookkingPurchaseError.unverified
        case .verified(let transaction):
            return transaction
        }
    }

    func syncPurchase(_ record: BookkingPurchaseRecord) async throws {
        try await sync(record)
    }

    private func sync(_ record: BookkingPurchaseRecord) async throws {
        guard Auth.auth().currentUser != nil else {
            throw BookkingPurchaseError.notSignedIn
        }
        guard !record.signedTransaction.isEmpty else {
            throw BookkingPurchaseError.unverified
        }
        _ = try await functions.httpsCallable("syncAppleSubscription").call([
            "signedTransaction": record.signedTransaction,
        ])
        await MainActor.run {
            NotificationCenter.default.post(name: .subscriptionDidChange, object: nil)
        }
    }
}
