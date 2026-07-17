//
//  PaymentReceiptDetail.swift
//

import Foundation

struct PaymentReceiptOutcomeBanner: Equatable {
    enum Style: Equatable {
        case success
        case failure
    }

    let title: String
    let message: String?
    let style: Style
}

struct PaymentReceiptLineItem: Identifiable, Equatable {
    let id: String
    let name: String
    let quantity: Int
    let amountCents: Int

    var amountUSD: Double { Double(amountCents) / 100.0 }
}

enum PaymentReceiptDocumentKind: Equatable {
    case paid
    case unpaidAttempt(reason: UnpaidAttemptReason)

    enum UnpaidAttemptReason: Equatable {
        case declined
        case timedOut
        case notCompleted
    }
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
    var documentKind: PaymentReceiptDocumentKind = .paid
    var statusMessage: String?

    var totalPaidUSD: Double { Double(totalPaidCents) / 100.0 }
    var serviceUSD: Double { Double(serviceCents) / 100.0 }

    var sheetNavigationTitle: String {
        switch documentKind {
        case .paid: return "Receipt"
        case .unpaidAttempt: return "Payment notice"
        }
    }

    var headerTitle: String {
        switch documentKind {
        case .paid: return "Receipt from \(businessName)"
        case .unpaidAttempt: return "Payment notice from \(businessName)"
        }
    }

    var amountMetaLabel: String {
        switch documentKind {
        case .paid: return "Amount paid"
        case .unpaidAttempt: return "Amount"
        }
    }

    var dateMetaLabel: String {
        switch documentKind {
        case .paid: return "Date paid"
        case .unpaidAttempt: return "Date"
        }
    }

    var isUnpaidAttempt: Bool {
        if case .unpaidAttempt = documentKind { return true }
        return false
    }

    var outcomeBanner: PaymentReceiptOutcomeBanner? {
        switch documentKind {
        case .paid:
            return nil
        case .unpaidAttempt(let reason):
            let title: String = {
                switch reason {
                case .declined: return "Payment declined"
                case .timedOut: return "Payment timed out"
                case .notCompleted: return "Payment not completed"
                }
            }()
            return PaymentReceiptOutcomeBanner(
                title: title,
                message: statusMessage,
                style: .failure
            )
        }
    }

    var pdfFileName: String {
        switch documentKind {
        case .paid:
            if let receiptNumber, !receiptNumber.isEmpty {
                let safe = receiptNumber.replacingOccurrences(of: "/", with: "-")
                return "Receipt-\(safe).pdf"
            }
            let stamp = paidAt.formatted(.dateTime.year().month().day())
            return "Receipt-\(stamp).pdf"
        case .unpaidAttempt:
            let stamp = paidAt.formatted(.dateTime.year().month().day())
            return "Payment-Notice-\(stamp).pdf"
        }
    }

    /// Text body prefilled when sharing a receipt via Messages compose.
    func smsBody() -> String {
        switch documentKind {
        case .paid:
            var lines = [
                headerTitle,
                "\(amountMetaLabel): \(PaymentsViewModel.formatUSD(totalPaidUSD))",
                "\(dateMetaLabel): \(paidAt.formatted(.dateTime.month(.wide).day().year().hour().minute()))",
            ]
            if let receiptNumber, !receiptNumber.isEmpty {
                lines.append("Receipt #\(receiptNumber)")
            }
            if let stripeReceiptUrl, !stripeReceiptUrl.isEmpty {
                lines.append("View receipt: \(stripeReceiptUrl)")
            }
            return lines.joined(separator: "\n")
        case .unpaidAttempt:
            var lines = [
                headerTitle,
                "\(amountMetaLabel): \(PaymentsViewModel.formatUSD(totalPaidUSD))",
                "\(dateMetaLabel): \(paidAt.formatted(.dateTime.month(.wide).day().year().hour().minute()))",
            ]
            if let statusMessage, !statusMessage.isEmpty {
                lines.append(statusMessage)
            }
            return lines.joined(separator: "\n")
        }
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
        paidAt: Date = Date(),
        paymentMethodLabel: String = "Tap to Pay on iPhone"
    ) -> PaymentReceiptDetail {
        var items: [PaymentReceiptLineItem] = [
            PaymentReceiptLineItem(
                id: "service",
                name: paymentMethodLabel,
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
            serviceLabel: paymentMethodLabel,
            lineItems: items,
            totalPaidCents: checkout.totalCents,
            serviceCents: checkout.serviceCents,
            stripeReceiptUrl: nil,
            documentKind: .paid
        )
    }

    /// Payment notice for declined, timed-out, or otherwise incomplete Tap to Pay attempts (Apple 5.10).
    static func fromTapToPayUnsuccessful(
        checkout: CardCheckoutBreakdown,
        businessName: String,
        customerName: String?,
        note: String?,
        reason: PaymentReceiptDocumentKind.UnpaidAttemptReason,
        detailMessage: String? = nil,
        attemptedAt: Date = Date()
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

        let trimmedCustomer = (customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let statusMessage: String = {
            switch reason {
            case .declined:
                return "Payment declined — card not charged."
            case .timedOut:
                return "Payment timed out — card not charged."
            case .notCompleted:
                let trimmed = (detailMessage ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? "Payment not completed — card not charged." : trimmed
            }
        }()

        return PaymentReceiptDetail(
            businessName: businessName.isEmpty ? "Payment notice" : businessName,
            receiptNumber: nil,
            paidAt: attemptedAt,
            customerName: trimmedCustomer.isEmpty ? nil : trimmedCustomer,
            customerEmail: nil,
            serviceLabel: "Tap to Pay on iPhone",
            lineItems: items,
            totalPaidCents: checkout.totalCents,
            serviceCents: checkout.serviceCents,
            stripeReceiptUrl: nil,
            documentKind: .unpaidAttempt(reason: reason),
            statusMessage: statusMessage
        )
    }
}
