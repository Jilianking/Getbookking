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

@MainActor
final class BookkingSubscriptionStore: ObservableObject {
    static let shared = BookkingSubscriptionStore()

    @Published private(set) var isPurchasing = false
    private var productsByID: [String: StoreKit.Product] = [:]
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    private init() {}

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

    @discardableResult
    func purchaseSmsExtra() async throws -> UInt64 {
        if productsByID[BookkingProductID.smsExtra] == nil {
            await loadProducts()
        }
        guard let product = productsByID[BookkingProductID.smsExtra] else {
            throw BookkingPurchaseError.productUnavailable
        }
        isPurchasing = true
        defer { isPurchasing = false }
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
            let transaction = try verified(verification)
            await transaction.finish()
            return transaction.id
        case .userCancelled:
            throw BookkingPurchaseError.cancelled
        case .pending:
            throw BookkingPurchaseError.pending
        @unknown default:
            throw BookkingPurchaseError.unverified
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
    }
}
