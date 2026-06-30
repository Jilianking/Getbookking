//
//  TapToPayReceiptPreferences.swift
//  Tap to Pay receipt delivery + content settings (text only — no email).
//

import Foundation

enum TapToPayReceiptDelivery: String, CaseIterable, Identifiable {
    case prompt
    case text
    case none

    var id: String { rawValue }

    var title: String {
        switch self {
        case .prompt: return "Ask customer"
        case .text: return "Text only"
        case .none: return "No receipt"
        }
    }

    var subtitle: String {
        switch self {
        case .prompt: return "Prompt for phone number after each payment"
        case .text: return "Always open Messages with receipt text"
        case .none: return "Skip the receipt prompt entirely"
        }
    }

    static func fromStored(_ raw: String?, legacyAutoOffer: Bool?) -> TapToPayReceiptDelivery {
        if let raw, let parsed = TapToPayReceiptDelivery(rawValue: raw) {
            return parsed
        }
        if legacyAutoOffer == false { return .none }
        return .prompt
    }
}

struct TapToPayReceiptPreferences: Equatable {
    var delivery: TapToPayReceiptDelivery = .prompt
    var showBusinessName: Bool = true
    var itemized: Bool = false
    var customFooter: Bool = false
    var footerMessage: String = ""

    var settingsRowSubtitle: String {
        switch delivery {
        case .prompt: return "Ask customer · text"
        case .text: return "Text only"
        case .none: return "No receipt"
        }
    }

    static func fromFirestore(_ data: [String: Any]?) -> TapToPayReceiptPreferences {
        guard let data else {
            return TapToPayReceiptPreferences()
        }
        let legacyAuto = data["tapToPayAutoOfferReceipt"] as? Bool
        return TapToPayReceiptPreferences(
            delivery: TapToPayReceiptDelivery.fromStored(
                data["tapToPayReceiptDelivery"] as? String,
                legacyAutoOffer: legacyAuto
            ),
            showBusinessName: data["tapToPayReceiptShowBusinessName"] as? Bool ?? true,
            itemized: data["tapToPayReceiptItemized"] as? Bool ?? false,
            customFooter: data["tapToPayReceiptCustomFooter"] as? Bool ?? false,
            footerMessage: (data["tapToPayReceiptFooterMessage"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    func firestorePayload() -> [String: Any] {
        [
            "tapToPayReceiptDelivery": delivery.rawValue,
            "tapToPayReceiptShowBusinessName": showBusinessName,
            "tapToPayReceiptItemized": itemized,
            "tapToPayReceiptCustomFooter": customFooter,
            "tapToPayReceiptFooterMessage": String(footerMessage.prefix(200)),
            "tapToPayAutoOfferReceipt": delivery != .none,
        ]
    }

    static func fromCallableResponse(_ data: [String: Any]?) -> TapToPayReceiptPreferences? {
        guard let data else { return nil }
        if data["receiptDelivery"] != nil || data["tapToPayReceiptDelivery"] != nil {
            let deliveryRaw = (data["receiptDelivery"] ?? data["tapToPayReceiptDelivery"]) as? String
            return TapToPayReceiptPreferences(
                delivery: TapToPayReceiptDelivery.fromStored(deliveryRaw, legacyAutoOffer: nil),
                showBusinessName: data["receiptShowBusinessName"] as? Bool
                    ?? data["tapToPayReceiptShowBusinessName"] as? Bool ?? true,
                itemized: data["receiptItemized"] as? Bool
                    ?? data["tapToPayReceiptItemized"] as? Bool ?? false,
                customFooter: data["receiptCustomFooter"] as? Bool
                    ?? data["tapToPayReceiptCustomFooter"] as? Bool ?? false,
                footerMessage: (data["receiptFooterMessage"] as? String
                    ?? data["tapToPayReceiptFooterMessage"] as? String ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
        if let auto = data["autoOfferReceipt"] as? Bool {
            return TapToPayReceiptPreferences(delivery: auto ? .prompt : .none)
        }
        return nil
    }
}
