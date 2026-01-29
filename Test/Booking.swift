//
//  Booking.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation
import FirebaseFirestore

struct Booking: Codable, Identifiable {
    @DocumentID var id: String?
    var name: String
    var email: String
    var phone: String
    var service: String
    var date: Timestamp
    var timeSlot: String?
    var promoCode: String?
    var status: BookingStatus
    var createdAt: Timestamp
    var notes: String?
    
    enum BookingStatus: String, Codable {
        case pending
        case approved
        case rejected
        case completed
        case cancelled
    }
    
    // Computed property to convert Timestamp to Date
    var dateValue: Date {
        return date.dateValue()
    }
    
    var createdAtValue: Date {
        return createdAt.dateValue()
    }
}

// Helper extension for Date to Timestamp conversion
extension Date {
    func toTimestamp() -> Timestamp {
        return Timestamp(date: self)
    }
}


