//
//  BookingRequest.swift
//
//  Model for web booking requests (tenants/{tenantId}/bookingRequests).
//

import Foundation

struct BookingRequest: Identifiable {
    var documentId: String?
    var id: String { documentId ?? UUID().uuidString }
    var status: String
    var source: String?
    var serviceId: String?
    var serviceSlug: String?
    var serviceName: String?
    var tenantId: String?
    var customerId: String?
    var customerName: String?
    var customerPhone: String?
    var customerEmail: String?
    var bookingModeUsed: String?
    var preferredDays: [String]?
    var preferredTime: String?
    var requestedStartTime: Date?
    var notes: String?
    var formResponses: [String: Any]?
    var createdAt: Date?
}
