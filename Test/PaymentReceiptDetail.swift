//
//  PaymentReceiptDetail.swift
//

import Foundation

struct PaymentReceiptLineItem: Identifiable, Equatable {
    let id: String
    let name: String
    let quantity: Int
    let amountCents: Int

    var amountUSD: Double { Double(amountCents) / 100.0 }
}

struct PaymentReceiptDetail: Equatable {
    let businessName: String
    let receiptNumber: String?
    let paidAt: Date
    let customerName: String?
    let customerEmail: String?
    let serviceLabel: String
    let lineItems: [PaymentReceiptLineItem]
    let totalPaidCents: Int
    let serviceCents: Int
    let stripeReceiptUrl: String?

    var totalPaidUSD: Double { Double(totalPaidCents) / 100.0 }
    var serviceUSD: Double { Double(serviceCents) / 100.0 }

    var pdfFileName: String {
        if let receiptNumber, !receiptNumber.isEmpty {
            let safe = receiptNumber.replacingOccurrences(of: "/", with: "-")
            return "Receipt-\(safe).pdf"
        }
        let stamp = paidAt.formatted(.dateTime.year().month().day())
        return "Receipt-\(stamp).pdf"
    }

    /// Text body prefilled when sharing a receipt via Messages compose.
    func smsBody() -> String {
        var lines = [
            "Receipt from \(businessName)",
            "Amount paid: \(PaymentsViewModel.formatUSD(totalPaidUSD))",
            "Date paid: \(paidAt.formatted(.dateTime.month(.wide).day().year().hour().minute()))",
        ]
        if let receiptNumber, !receiptNumber.isEmpty {
            lines.append("Receipt #\(receiptNumber)")
        }
        if let stripeReceiptUrl, !stripeReceiptUrl.isEmpty {
            lines.append("View receipt: \(stripeReceiptUrl)")
        }
        return lines.joined(separator: "\n")
    }

    static func fromFirestoreDict(_ data: [String: Any]) -> PaymentReceiptDetail? {
        guard let businessName = data["businessName"] as? String else { return nil }
        let paidAt: Date = {
            if let ts = data["paidAt"] as? NSNumber {
                return Date(timeIntervalSince1970: ts.doubleValue)
            }
            return Date()
        }()
        let rawItems = data["lineItems"] as? [[String: Any]] ?? []
        let lineItems: [PaymentReceiptLineItem] = rawItems.compactMap { item in
            guard let name = item["name"] as? String else { return nil }
            let qty = (item["quantity"] as? NSNumber)?.intValue ?? 1
            let cents = (item["amountCents"] as? NSNumber)?.intValue ?? 0
            return PaymentReceiptLineItem(
                id: "\(name)-\(cents)",
                name: name,
                quantity: max(1, qty),
                amountCents: cents
            )
        }
        let totalPaidCents = (data["totalPaidCents"] as? NSNumber)?.intValue ?? 0
        let serviceCents = (data["serviceCents"] as? NSNumber)?.intValue ?? totalPaidCents
        return PaymentReceiptDetail(
            businessName: businessName,
            receiptNumber: data["receiptNumber"] as? String,
            paidAt: paidAt,
            customerName: data["customerName"] as? String,
            customerEmail: data["customerEmail"] as? String,
            serviceLabel: (data["serviceLabel"] as? String) ?? "Payment",
            lineItems: lineItems,
            totalPaidCents: totalPaidCents,
            serviceCents: serviceCents,
            stripeReceiptUrl: data["stripeReceiptUrl"] as? String
        )
    }

    static func fallback(
        from transaction: PaymentTransaction,
        businessName: String
    ) -> PaymentReceiptDetail {
        let serviceCents = Int(round(transaction.amount * 100))
        let grossCents: Int = {
            if transaction.grossAmount > 0 {
                return Int(round(transaction.grossAmount * 100))
            }
            let checkout = CardCheckoutPricing.breakdown(serviceCents: max(serviceCents, 50))
            return checkout.totalCents
        }()
        let surchargeCents = max(0, grossCents - serviceCents)
        let platformFee = CardCheckoutPricing.platformFeeCents(totalCents: grossCents)
        let cardProcessing = max(0, surchargeCents - platformFee)
        let kind = transaction.channelLabel.lowercased().contains("deposit") ? "deposit" : "service"
        let serviceLabel = kind == "deposit" ? "Deposit" : transaction.channelLabel

        var items: [PaymentReceiptLineItem] = [
            PaymentReceiptLineItem(
                id: "service",
                name: serviceLabel,
                quantity: 1,
                amountCents: serviceCents
            ),
        ]
        let passThroughFee = cardProcessing + platformFee
        if passThroughFee > 0 {
            items.append(
                PaymentReceiptLineItem(
                    id: "fees",
                    name: "Processing & service fees",
                    quantity: 1,
                    amountCents: passThroughFee
                )
            )
        }

        let customerName: String? = {
            let trimmed = (transaction.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.lowercased() != "payment" else { return nil }
            return trimmed
        }()

        return PaymentReceiptDetail(
            businessName: businessName,
            receiptNumber: nil,
            paidAt: transaction.createdAt ?? Date(),
            customerName: customerName,
            customerEmail: nil,
            serviceLabel: serviceLabel,
            lineItems: items,
            totalPaidCents: grossCents,
            serviceCents: serviceCents,
            stripeReceiptUrl: nil
        )
    }

    /// Receipt shown immediately after an in-person Tap to Pay charge (Apple 4.5 outcome + receipt).
    static func fromTapToPay(
        checkout: CardCheckoutBreakdown,
        businessName: String,
        customerName: String?,
        note: String?,
        paymentIntentId: String?,
        includesSignature: Bool,
        paidAt: Date = Date()
    ) -> PaymentReceiptDetail {
        var items: [PaymentReceiptLineItem] = [
            PaymentReceiptLineItem(
                id: "service",
                name: "Tap to Pay on iPhone",
                quantity: 1,
                amountCents: checkout.serviceCents
            ),
        ]
        if checkout.hasPassThroughFees {
            items.append(
                PaymentReceiptLineItem(
                    id: "fees",
                    name: "Processing & service fees",
                    quantity: 1,
                    amountCents: checkout.passThroughFeeCents
                )
            )
        }
        let trimmedNote = (note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedNote.isEmpty {
            items.append(
                PaymentReceiptLineItem(
                    id: "note",
                    name: trimmedNote,
                    quantity: 1,
                    amountCents: 0
                )
            )
        }
        if includesSignature {
            items.append(
                PaymentReceiptLineItem(
                    id: "signature",
                    name: "Customer signature on file",
                    quantity: 1,
                    amountCents: 0
                )
            )
        }

        let receiptNumber: String? = {
            let id = (paymentIntentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { return nil }
            return String(id.suffix(8)).uppercased()
        }()

        let trimmedCustomer = (customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        return PaymentReceiptDetail(
            businessName: businessName.isEmpty ? "Receipt" : businessName,
            receiptNumber: receiptNumber,
            paidAt: paidAt,
            customerName: trimmedCustomer.isEmpty ? nil : trimmedCustomer,
            customerEmail: nil,
            serviceLabel: "Tap to Pay on iPhone",
            lineItems: items,
            totalPaidCents: checkout.totalCents,
            serviceCents: checkout.serviceCents,
            stripeReceiptUrl: nil
        )
    }
}
