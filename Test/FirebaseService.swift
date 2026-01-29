//
//  FirebaseService.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation
import FirebaseFirestore
import Combine

class FirebaseService: ObservableObject {
    @Published var bookings: [Booking] = []
    @Published var services: [Service] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let db = Firestore.firestore()
    private var bookingsListener: ListenerRegistration?
    
    // MARK: - Fetch Services
    func fetchServices() async {
        await MainActor.run {
            isLoading = true
        }
        
        do {
            let snapshot = try await db.collection("services").getDocuments()
            let fetchedServices = snapshot.documents.compactMap { doc -> Service? in
                let data = doc.data()
                return Service(
                    id: doc.documentID,
                    name: data["name"] as? String ?? "",
                    description: data["description"] as? String,
                    price: data["price"] as? Double,
                    duration: data["duration"] as? Int
                )
            }
            
            await MainActor.run {
                self.services = fetchedServices
                self.isLoading = false
            }
        } catch {
            await MainActor.run {
                self.errorMessage = "Failed to fetch services: \(error.localizedDescription)"
                self.isLoading = false
            }
        }
    }
    
    // MARK: - Create Booking
    func createBooking(_ booking: Booking) async throws -> String {
        let bookingData: [String: Any] = [
            "name": booking.name,
            "email": booking.email,
            "phone": booking.phone,
            "service": booking.service,
            "date": booking.date,
            "timeSlot": booking.timeSlot ?? "",
            "promoCode": booking.promoCode ?? "",
            "status": booking.status.rawValue,
            "createdAt": Timestamp(date: Date()),
            "notes": booking.notes ?? ""
        ]
        
        let docRef = try await db.collection("bookings").addDocument(data: bookingData)
        return docRef.documentID
    }
    
    // MARK: - Fetch Bookings (with listener for real-time updates)
    func startListeningToBookings() {
        bookingsListener = db.collection("bookings")
            .order(by: "date", descending: false)
            .addSnapshotListener { [weak self] snapshot, error in
                guard let self = self else { return }
                
                if let error = error {
                    DispatchQueue.main.async {
                        self.errorMessage = "Error fetching bookings: \(error.localizedDescription)"
                    }
                    return
                }
                
                guard let documents = snapshot?.documents else {
                    DispatchQueue.main.async {
                        self.bookings = []
                    }
                    return
                }
                
                let fetchedBookings = documents.compactMap { doc -> Booking? in
                    var data = doc.data()
                    data["id"] = doc.documentID
                    
                    // Convert Firestore Timestamps to Booking format
                    guard let name = data["name"] as? String,
                          let email = data["email"] as? String,
                          let phone = data["phone"] as? String,
                          let service = data["service"] as? String,
                          let dateTimestamp = data["date"] as? Timestamp,
                          let createdAtTimestamp = data["createdAt"] as? Timestamp,
                          let statusString = data["status"] as? String,
                          let status = Booking.BookingStatus(rawValue: statusString) else {
                        return nil
                    }
                    
                    return Booking(
                        id: doc.documentID,
                        name: name,
                        email: email,
                        phone: phone,
                        service: service,
                        date: dateTimestamp,
                        timeSlot: data["timeSlot"] as? String,
                        promoCode: data["promoCode"] as? String,
                        status: status,
                        createdAt: createdAtTimestamp,
                        notes: data["notes"] as? String
                    )
                }
                
                DispatchQueue.main.async {
                    self.bookings = fetchedBookings
                }
            }
    }
    
    func stopListeningToBookings() {
        bookingsListener?.remove()
        bookingsListener = nil
    }
    
    // MARK: - Validate Promo Code
    func validatePromoCode(_ code: String) async throws -> PromoCode? {
        let snapshot = try await db.collection("promoCodes")
            .whereField("code", isEqualTo: code.uppercased())
            .whereField("isActive", isEqualTo: true)
            .limit(to: 1)
            .getDocuments()
        
        guard let doc = snapshot.documents.first else {
            return nil
        }
        
        var data = doc.data()
        data["id"] = doc.documentID
        
        guard let codeString = data["code"] as? String,
              let discount = data["discount"] as? Double,
              let isActive = data["isActive"] as? Bool else {
            return nil
        }
        
        return PromoCode(
            id: doc.documentID,
            code: codeString,
            discount: discount,
            isActive: isActive,
            validUntil: data["validUntil"] as? Timestamp
        )
    }
    
    // MARK: - Fetch Available Time Slots
    func fetchAvailableTimeSlots(for date: Date) async throws -> [String] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: date)
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!
        
        let startTimestamp = Timestamp(date: startOfDay)
        let endTimestamp = Timestamp(date: endOfDay)
        
        let snapshot = try await db.collection("bookings")
            .whereField("date", isGreaterThanOrEqualTo: startTimestamp)
            .whereField("date", isLessThan: endTimestamp)
            .whereField("status", in: ["pending", "approved"])
            .getDocuments()
        
        let bookedSlots = snapshot.documents.compactMap { doc -> String? in
            return doc.data()["timeSlot"] as? String
        }
        
        // Generate time slots (9 AM to 6 PM, every hour)
        let allSlots = generateTimeSlots()
        return allSlots.filter { !bookedSlots.contains($0) }
    }
    
    private func generateTimeSlots() -> [String] {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        
        var slots: [String] = []
        let calendar = Calendar.current
        var date = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date())!
        
        while calendar.component(.hour, from: date) < 18 {
            slots.append(formatter.string(from: date))
            if let nextDate = calendar.date(byAdding: .hour, value: 1, to: date) {
                date = nextDate
            } else {
                break
            }
        }
        
        return slots
    }
    
    // MARK: - Fetch Requests
    func fetchRequests() async throws -> [Request] {
        let snapshot = try await db.collection("requests").getDocuments()
        return snapshot.documents.compactMap { doc -> Request? in
            let data = doc.data()
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            if let request = try? decoder.decode(Request.self, from: jsonData) {
                var mutableRequest = request
                mutableRequest.id = doc.documentID
                return mutableRequest
            }
            return nil
        }
    }
    
    // MARK: - Update Request
    func updateRequest(_ requestId: String, updates: [String: Any]) async throws {
        var firestoreUpdates = updates
        // Convert Date objects to Timestamps
        if let reviewedAt = firestoreUpdates["reviewedAt"] as? Date {
            firestoreUpdates["reviewedAt"] = Timestamp(date: reviewedAt)
        }
        try await db.collection("requests").document(requestId).updateData(firestoreUpdates)
    }
    
    // MARK: - Delete Request
    func deleteRequest(_ requestId: String) async throws {
        try await db.collection("requests").document(requestId).delete()
    }
    
    // MARK: - Fetch Clients
    func fetchClients() async throws -> [Client] {
        let snapshot = try await db.collection("clients").getDocuments()
        return snapshot.documents.compactMap { doc -> Client? in
            let data = doc.data()
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            if let client = try? decoder.decode(Client.self, from: jsonData) {
                var mutableClient = client
                mutableClient.id = doc.documentID
                return mutableClient
            }
            return nil
        }
    }
    
    // MARK: - Create Client
    func createClient(_ client: Client) async throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(client)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode client"])
        }
        let docRef = try await db.collection("clients").addDocument(data: dict)
        return docRef.documentID
    }
    
    // MARK: - Update Client
    func updateClient(_ clientId: String, updates: [String: Any]) async throws {
        try await db.collection("clients").document(clientId).updateData(updates)
    }
    
    // MARK: - Fetch Events
    func fetchEvents(startDate: Date, endDate: Date) async throws -> [Event] {
        let startTimestamp = Timestamp(date: startDate)
        let endTimestamp = Timestamp(date: endDate)
        
        let snapshot = try await db.collection("events")
            .whereField("start", isGreaterThanOrEqualTo: startTimestamp)
            .whereField("start", isLessThan: endTimestamp)
            .getDocuments()
        
        return snapshot.documents.compactMap { doc -> Event? in
            let data = doc.data()
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            if let event = try? decoder.decode(Event.self, from: jsonData) {
                var mutableEvent = event
                mutableEvent.id = doc.documentID
                return mutableEvent
            }
            return nil
        }
    }
    
    // MARK: - Create Event
    func createEvent(_ event: Event) async throws -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(event)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode event"])
        }
        let docRef = try await db.collection("events").addDocument(data: dict)
        return docRef.documentID
    }
    
    // MARK: - Fetch Messages
    func fetchMessages(threadId: String) async throws -> [Message] {
        let snapshot = try await db.collection("messages")
            .whereField("threadId", isEqualTo: threadId)
            .order(by: "createdAt", descending: false)
            .getDocuments()
        
        return snapshot.documents.compactMap { doc -> Message? in
            let data = doc.data()
            guard let jsonData = try? JSONSerialization.data(withJSONObject: data) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .secondsSince1970
            if let message = try? decoder.decode(Message.self, from: jsonData) {
                var mutableMessage = message
                mutableMessage.id = doc.documentID
                return mutableMessage
            }
            return nil
        }
    }
    
    // MARK: - Fetch All Threads
    func fetchAllThreads() async throws -> [String] {
        let snapshot = try await db.collection("messages").getDocuments()
        let threadIds = Set(snapshot.documents.compactMap { doc -> String? in
            return doc.data()["threadId"] as? String
        })
        return Array(threadIds)
    }
    
    // MARK: - Send Message
    func sendMessage(_ message: Message) async throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(message)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "FirebaseService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode message"])
        }
        _ = try await db.collection("messages").addDocument(data: dict)
    }
}

