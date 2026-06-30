//
//  ShopOrder.swift
//
//  Model for shop orders (tenants/{tenantId}/shopOrders).
//

import Foundation

struct ShopOrderLineItem: Identifiable, Equatable {
    var productId: String
    var name: String
    var qty: Int
    var unitPriceCents: Int
    var lineTotalCents: Int

    var id: String { productId }

    var formattedUnitPrice: String {
        String(format: "$%.2f", Double(unitPriceCents) / 100.0)
    }

    var formattedLineTotal: String {
        String(format: "$%.2f", Double(lineTotalCents) / 100.0)
    }
}

struct ShopOrder: Identifiable, Equatable {
    var id: String
    var status: String
    var source: String?
    var lineItems: [ShopOrderLineItem]
    var subtotalCents: Int
    var surchargeCents: Int?
    var totalCents: Int?
    var customerName: String?
    var customerEmail: String?
    var customerPhone: String?
    var notes: String?
    var bookingRequestId: String?
    var stripePaymentIntentId: String?
    var createdAt: Date?
    var paidAt: Date?
    var readAt: Date?

    var isUnread: Bool { readAt == nil }

    var hasCustomerContact: Bool {
        let email = (customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let phone = (customerPhone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && (!email.isEmpty || !phone.isEmpty)
    }

    var statusLower: String {
        status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var displayCustomerName: String {
        let name = (customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Guest" : name
    }

    var formattedSubtotal: String {
        String(format: "$%.2f", Double(subtotalCents) / 100.0)
    }

    var formattedTotal: String {
        let cents = totalCents ?? subtotalCents
        return String(format: "$%.2f", Double(cents) / 100.0)
    }

    var isPaid: Bool {
        statusLower == ShopOrderStatus.paid
    }

    var itemSummary: String {
        let count = lineItems.reduce(0) { $0 + max(1, $1.qty) }
        if count == 1, let first = lineItems.first {
            return first.name
        }
        return "\(count) items"
    }

    static func parseLineItems(_ raw: [[String: Any]]?) -> [ShopOrderLineItem] {
        guard let raw else { return [] }
        return raw.compactMap { item -> ShopOrderLineItem? in
            let productId = (item["productId"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !productId.isEmpty else { return nil }
            let name = item["name"] as? String ?? "Item"
            let qty: Int
            if let v = item["qty"] as? Int {
                qty = v
            } else if let v = item["qty"] as? Double {
                qty = Int(v)
            } else {
                qty = 1
            }
            let unitPriceCents: Int
            if let v = item["unitPriceCents"] as? Int {
                unitPriceCents = v
            } else if let v = item["unitPriceCents"] as? Double {
                unitPriceCents = Int(v)
            } else {
                unitPriceCents = 0
            }
            let lineTotalCents: Int
            if let v = item["lineTotalCents"] as? Int {
                lineTotalCents = v
            } else if let v = item["lineTotalCents"] as? Double {
                lineTotalCents = Int(v)
            } else {
                lineTotalCents = unitPriceCents * max(1, qty)
            }
            return ShopOrderLineItem(
                productId: productId,
                name: name,
                qty: max(1, qty),
                unitPriceCents: unitPriceCents,
                lineTotalCents: lineTotalCents
            )
        }
    }
}

enum ShopOrderStatus {
    static let pending = "pending"
    static let pendingPayment = "pending_payment"
    static let paid = "paid"
    static let fulfilled = "fulfilled"
    static let cancelled = "cancelled"

    static func displayLabel(for status: String) -> String {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case pending: return "Pending"
        case pendingPayment: return "Awaiting payment"
        case paid: return "Paid"
        case fulfilled: return "Fulfilled"
        case cancelled: return "Cancelled"
        default: return status.capitalized
        }
    }
}
