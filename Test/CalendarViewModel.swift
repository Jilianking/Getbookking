import Foundation
import Combine
import FirebaseAuth

class CalendarViewModel: ObservableObject {
    @Published var events: [Event] = []
    @Published private(set) var bookingRequestsById: [String: BookingRequest] = [:]
    @Published var isLoading = false

    private let firebaseService = FirebaseService()
    private var loadedMonthKey: String?

    func bookingRequest(for event: Event) -> BookingRequest? {
        guard let id = event.id?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else { return nil }
        return bookingRequestsById[id]
    }

    func loadEvents(forMonthAround anchor: Date = Date(), isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        let calendar = Calendar.current
        let monthKey = Self.monthKey(for: anchor, calendar: calendar)
        let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: anchor))!
        let endOfMonth = calendar.date(byAdding: .month, value: 1, to: startOfMonth)!

        await MainActor.run { isLoading = true }

        if isDemoMode {
            if let sessionStore, sessionStore.isDemoSession {
                let bookings = sessionStore.bookingRequests
                await MainActor.run {
                    applyMonthEvents(from: bookings, startOfMonth: startOfMonth, endOfMonth: endOfMonth, monthKey: monthKey)
                }
                return
            }
            await MainActor.run {
                events = Self.demoEvents(calendar: calendar, anchor: anchor)
                bookingRequestsById = [:]
                loadedMonthKey = monthKey
                isLoading = false
            }
            return
        }

        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run {
                    events = []
                    bookingRequestsById = [:]
                    loadedMonthKey = monthKey
                    isLoading = false
                }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tenantId = profile?.tenantId, !tenantId.isEmpty else {
                await MainActor.run {
                    events = []
                    bookingRequestsById = [:]
                    loadedMonthKey = monthKey
                    isLoading = false
                }
                return
            }

            let bookings = try await firebaseService.fetchTenantBookingRequests(tenantId: tenantId)
            await MainActor.run {
                applyMonthEvents(from: bookings, startOfMonth: startOfMonth, endOfMonth: endOfMonth, monthKey: monthKey)
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading calendar appointments: \(error)")
        }
    }

    private func applyMonthEvents(
        from bookings: [BookingRequest],
        startOfMonth: Date,
        endOfMonth: Date,
        monthKey: String
    ) {
        var byId: [String: BookingRequest] = [:]
        for booking in bookings {
            if let docId = booking.documentId?.trimmingCharacters(in: .whitespacesAndNewlines), !docId.isEmpty {
                byId[docId] = booking
            }
        }
        let inMonth = bookings.compactMap { Self.event(from: $0) }
            .filter { $0.start >= startOfMonth && $0.start < endOfMonth }
            .sorted { $0.start < $1.start }
        events = inMonth
        bookingRequestsById = byId
        loadedMonthKey = monthKey
        isLoading = false
    }

    /// Skips reload when the visible month is unchanged (day taps within the same month).
    func loadEventsIfMonthChanged(forMonthAround anchor: Date, isDemoMode: Bool, sessionStore: TenantSessionStore? = nil) async {
        let key = Self.monthKey(for: anchor)
        if key == loadedMonthKey, !events.isEmpty || isDemoMode { return }
        await loadEvents(forMonthAround: anchor, isDemoMode: isDemoMode, sessionStore: sessionStore)
    }

    // MARK: - BookingRequest → Event

    static func event(from booking: BookingRequest) -> Event? {
        let statusRaw = booking.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard statusRaw == "confirmed" else { return nil }
        guard let start = appointmentStart(for: booking) else { return nil }

        let service = (booking.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let client = (booking.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        return Event(
            id: booking.documentId ?? booking.id,
            title: service.isEmpty ? "Appointment" : service,
            start: start,
            end: nil,
            type: .appointment,
            status: .confirmed,
            clientId: booking.customerId ?? booking.id,
            clientName: client.isEmpty ? "Client" : client,
            notes: booking.notes,
            color: nil,
            documents: nil
        )
    }

    static func appointmentStart(for booking: BookingRequest) -> Date? {
        if let start = booking.requestedStartTime { return start }
        guard let slot = booking.preferredTime?.trimmingCharacters(in: .whitespacesAndNewlines), !slot.isEmpty else {
            return nil
        }
        let referenceDay = booking.createdAt ?? Date()
        let calendar = Calendar.current
        let dayStart = calendar.startOfDay(for: referenceDay)
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.defaultDate = dayStart
        guard let time = formatter.date(from: slot) else { return nil }
        return time
    }

    private static func monthKey(for date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)"
    }

    private static func demoEvents(calendar: Calendar, anchor: Date) -> [Event] {
        let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: anchor))!
        let day = calendar.startOfDay(for: anchor)
        func at(dayOffset: Int, hour: Int, minute: Int) -> Date {
            let d = calendar.date(byAdding: .day, value: dayOffset, to: day) ?? day
            return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: d) ?? d
        }
        return [
            Event(
                id: "demo-1",
                title: "Consultation",
                start: at(dayOffset: 1, hour: 10, minute: 0),
                end: nil,
                type: .appointment,
                status: .confirmed,
                clientId: "demo-client-1",
                clientName: "Alex M.",
                notes: nil,
                color: nil,
                documents: nil
            ),
            Event(
                id: "demo-2",
                title: "Full session",
                start: at(dayOffset: 3, hour: 14, minute: 30),
                end: nil,
                type: .appointment,
                status: .confirmed,
                clientId: "demo-client-2",
                clientName: "Jordan K.",
                notes: nil,
                color: nil,
                documents: nil
            ),
        ].filter { $0.start >= startOfMonth && $0.start < calendar.date(byAdding: .month, value: 1, to: startOfMonth)! }
    }
}
