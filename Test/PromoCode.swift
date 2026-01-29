//
//  PromoCode.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation
import FirebaseFirestore

struct PromoCode: Codable, Identifiable {
    @DocumentID var id: String?
    var code: String
    var discount: Double // percentage or amount
    var isActive: Bool
    var validUntil: Timestamp?
    
    var validUntilValue: Date? {
        return validUntil?.dateValue()
    }
    
    var isValid: Bool {
        guard isActive else { return false }
        if let validUntil = validUntilValue {
            return validUntil > Date()
        }
        return true
    }
}


