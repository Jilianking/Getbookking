import Foundation
import Combine
import FirebaseAuth
import FirebaseFirestore

enum ClientProfileTab: String, CaseIterable, Identifiable {
    case overview
    case history
    case notes

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .history: return "History"
        case .notes: return "Notes"
        }
    }
}

struct ClientVisitSummary: Identifiable {
    let id: String
    let serviceName: String
    let date: Date
    let status: String
    let price: Double?
}

enum ClientScheduleAction {
    case confirm(BookingRequest)
    case reschedule(BookingRequest)
    case scheduleNew

    var toolbarLabel: String {
        switch self {
        case .confirm: return "Confirm"
        case .reschedule: return "Reschedule"
        case .scheduleNew: return "Schedule"
        }
    }
}

enum NotesSaveState: Equatable {
    case idle
    case saving
    case saved
    case failed(String)
}

@MainActor
final class ClientProfileViewModel: ObservableObject {
    @Published var client: Client
    @Published var selectedTab: ClientProfileTab = .overview
    @Published var isLoading = false
    @Published var bookings: [BookingRequest] = []
    @Published var servicePrices: [String: Double] = [:]
    @Published var saveError: String?
    @Published var noteEntries: [Client.ClientNoteEntry] = []
    @Published var notesSaveState: NotesSaveState = .idle

    private let firebaseService = FirebaseService()
    private var tenantId: String?
    private var authorDisplayName: String?
    private var notesSaveTask: Task<Void, Never>?
    private var notesPersistGeneration = 0

    init(client: Client) {
        self.client = client
    }

    var matchingBookings: [BookingRequest] {
        bookings.filter { Self.matches(booking: $0, client: client) }
    }

    var visitCount: Int {
        matchingBookings.filter { Self.isVisitStatus($0.status) }.count
    }

    var totalSpent: Double {
        matchingBookings
            .filter { Self.isVisitStatus($0.status) }
            .reduce(0) { partial, booking in
                partial + (price(for: booking) ?? 0)
            }
    }

    var averagePerMonth: Double {
        let visits = matchingBookings.filter { Self.isVisitStatus($0.status) }
        guard !visits.isEmpty else { return 0 }
        let dates = visits.compactMap { $0.requestedStartTime ?? $0.createdAt }
        guard let earliest = dates.min() else { return 0 }
        let months = max(1, Calendar.current.dateComponents([.month], from: earliest, to: Date()).month ?? 1)
        return totalSpent / Double(months)
    }

    var pendingBooking: BookingRequest? {
        matchingBookings
            .filter { Self.isPendingStatus($0.status) }
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
            .first
    }

    var upcomingBooking: BookingRequest? {
        let now = Date()
        return matchingBookings
            .filter {
                $0.status.lowercased() == "confirmed" &&
                ($0.requestedStartTime ?? .distantPast) >= now
            }
            .sorted { ($0.requestedStartTime ?? .distantFuture) < ($1.requestedStartTime ?? .distantFuture) }
            .first
    }

    func scheduleToolbarLabel(canManageAssignment: Bool) -> String {
        scheduleAction(using: bookings, canManageAssignment: canManageAssignment).toolbarLabel
    }

    func scheduleAction(using tenantBookings: [BookingRequest], canManageAssignment: Bool) -> ClientScheduleAction {
        let matched = tenantBookings.filter { Self.matches(booking: $0, client: client) }
        if canManageAssignment,
           let pending = matched
            .filter({ Self.isPendingStatus($0.status) })
            .sorted(by: { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) })
            .first {
            return .confirm(pending)
        }
        if canManageAssignment {
            let now = Date()
            if let upcoming = matched
                .filter({
                    $0.status.lowercased() == "confirmed" &&
                    ($0.requestedStartTime ?? .distantPast) >= now
                })
                .sorted(by: { ($0.requestedStartTime ?? .distantFuture) < ($1.requestedStartTime ?? .distantFuture) })
                .first {
                return .reschedule(upcoming)
            }
        }
        return .scheduleNew
    }

    var recentVisits: [ClientVisitSummary] {
        let now = Date()
        return matchingBookings
            .filter {
                Self.isVisitStatus($0.status) &&
                ($0.requestedStartTime ?? $0.createdAt ?? .distantPast) <= now
            }
            .sorted {
                ($0.requestedStartTime ?? $0.createdAt ?? .distantPast) >
                ($1.requestedStartTime ?? $1.createdAt ?? .distantPast)
            }
            .prefix(5)
            .map { booking in
                ClientVisitSummary(
                    id: booking.id,
                    serviceName: booking.serviceName ?? "Appointment",
                    date: booking.requestedStartTime ?? booking.createdAt ?? Date(),
                    status: booking.status,
                    price: price(for: booking)
                )
            }
    }

    var smsOptedIn: Bool {
        if let optedIn = client.smsOptedIn { return optedIn }
        return matchingBookings.contains { $0.smsConsentAccepted == true }
    }

    var smsConsentDate: Date? {
        client.smsConsentAt ?? matchingBookings.compactMap(\.smsConsentAt).max()
    }

    var smsConsentMethod: String? {
        if let source = client.smsConsentSource, !source.isEmpty {
            return Self.displayConsentSource(source)
        }
        if matchingBookings.contains(where: { $0.smsConsentAccepted == true }) {
            return "Booking form checkbox"
        }
        return nil
    }

    var preferredStaff: String? {
        matchingBookings
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
            .compactMap(\.assignedMemberDisplayLabel)
            .first
    }

    var preferredDays: String? {
        var seen = Set<String>()
        var ordered: [String] = []
        for booking in matchingBookings.sorted(by: { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }) {
            guard let days = booking.preferredDays else { continue }
            for day in days {
                let trimmed = day.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
                seen.insert(trimmed)
                ordered.append(trimmed)
            }
        }
        return ordered.isEmpty ? nil : ordered.joined(separator: ", ")
    }

    var preferredTimeDisplay: String? {
        if let time = client.preferences?.preferredTime?.trimmingCharacters(in: .whitespacesAndNewlines), !time.isEmpty {
            return time
        }
        return matchingBookings
            .compactMap(\.preferredTime)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
    }

    var messageThreadId: String? {
        guard let phone = PhoneFormatting.normalizedForStorage(client.phone) else { return nil }
        let digits = PhoneFormatting.digits(from: phone)
        return digits.count >= 10 ? phone : nil
    }

    func load(isDemoMode: Bool) async {
        isLoading = true
        defer { isLoading = false }

        if isDemoMode {
            bookings = []
            return
        }

        guard let uid = Auth.auth().currentUser?.uid else { return }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else { return }
            tenantId = tid
            if let profile {
                let name = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
                authorDisplayName = name.isEmpty ? profile.business : name
            }

            async let bookingTask = firebaseService.fetchTenantBookingRequests(tenantId: tid)
            async let servicesTask = firebaseService.fetchTenantServices(tenantId: tid)
            if let customerId = client.id {
                async let customerTask = firebaseService.fetchTenantCustomer(tenantId: tid, customerId: customerId)
                let (fetchedBookings, services, refreshedClient) = try await (bookingTask, servicesTask, customerTask)
                bookings = fetchedBookings
                servicePrices = Self.priceLookup(from: services)
                if let refreshedClient {
                    client = refreshedClient
                }
            } else {
                let (fetchedBookings, services) = try await (bookingTask, servicesTask)
                bookings = fetchedBookings
                servicePrices = Self.priceLookup(from: services)
            }
            syncNoteEntriesFromClient()
        } catch {
            print("Client profile load error: \(error)")
        }
    }

    func syncNoteEntriesFromClient() {
        noteEntries = Self.sortedNoteEntries(client.resolvedNoteEntries)
    }

    func addNoteEntry() {
        let entry = Client.ClientNoteEntry(
            body: "",
            createdAt: Date(),
            authorName: authorDisplayName
        )
        noteEntries.insert(entry, at: 0)
    }

    func deleteNoteEntry(id: String) {
        noteEntries.removeAll { $0.id == id }
        scheduleNoteEntriesSave(delayNanoseconds: 0)
    }

    func noteEntryBodyChanged(id: String) {
        guard let index = noteEntries.firstIndex(where: { $0.id == id }) else { return }
        noteEntries[index].updatedAt = Date()
        scheduleNoteEntriesSave()
    }

    func scheduleNoteEntriesSave(delayNanoseconds: UInt64 = 700_000_000) {
        notesSaveTask?.cancel()
        notesSaveTask = Task {
            if delayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: delayNanoseconds)
            }
            guard !Task.isCancelled else { return }
            await persistNoteEntries()
        }
    }

    func flushNoteEntriesSave() async {
        notesSaveTask?.cancel()
        await persistNoteEntries()
    }

    private func persistNoteEntries() async {
        guard let tid = tenantId, let customerId = client.id else { return }
        notesPersistGeneration += 1
        let generation = notesPersistGeneration
        notesSaveState = .saving

        let drafts = noteEntries.filter {
            $0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let cleaned = noteEntries
            .map { entry in
                Client.ClientNoteEntry(
                    id: entry.id,
                    body: entry.body.trimmingCharacters(in: .whitespacesAndNewlines),
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    authorName: entry.authorName
                )
            }
            .filter { !$0.body.isEmpty }

        let sorted = Self.sortedNoteEntries(cleaned)
        var updates: [String: Any] = [
            "noteEntries": Self.firestorePayload(for: sorted),
        ]
        if sorted.isEmpty {
            updates["notes"] = FieldValue.delete()
        } else if let latest = sorted.first {
            updates["notes"] = latest.body
        }

        do {
            try await firebaseService.updateTenantCustomer(
                tenantId: tid,
                customerId: customerId,
                updates: updates
            )
            guard generation == notesPersistGeneration else { return }
            noteEntries = Self.sortedNoteEntries(cleaned + drafts)
            client.noteEntries = sorted.isEmpty ? nil : sorted
            client.notes = sorted.first?.body
            notesSaveState = .saved
            saveError = nil
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard generation == notesPersistGeneration else { return }
                if notesSaveState == .saved {
                    notesSaveState = .idle
                }
            }
        } catch {
            guard generation == notesPersistGeneration else { return }
            notesSaveState = .failed(error.localizedDescription)
            saveError = error.localizedDescription
        }
    }

    private static func sortedNoteEntries(_ entries: [Client.ClientNoteEntry]) -> [Client.ClientNoteEntry] {
        entries.sorted {
            ($0.updatedAt ?? $0.createdAt) > ($1.updatedAt ?? $1.createdAt)
        }
    }

    private static func firestorePayload(for entries: [Client.ClientNoteEntry]) -> [[String: Any]] {
        entries.map { entry in
            var row: [String: Any] = [
                "id": entry.id,
                "body": entry.body,
                "createdAt": Timestamp(date: entry.createdAt),
            ]
            if let updatedAt = entry.updatedAt {
                row["updatedAt"] = Timestamp(date: updatedAt)
            }
            if let authorName = entry.authorName, !authorName.isEmpty {
                row["authorName"] = authorName
            }
            return row
        }
    }

    func saveEdits(
        name: String,
        email: String,
        phone: String?,
        vip: Bool,
        birthday: String?,
        referralSource: String?,
        preferredTime: String?,
        tattooStyles: [String],
        allergies: [String],
        profileExtras: [Client.ClientProfileExtra]
    ) async {
        guard let tid = tenantId, let customerId = client.id else { return }
        var updates: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            "vip": vip,
        ]
        if let phone = PhoneFormatting.normalizedForStorage(phone) {
            updates["phone"] = phone
        }
        if let birthday, !birthday.isEmpty {
            updates["birthday"] = birthday
        } else {
            updates["birthday"] = FieldValue.delete()
        }
        if let referralSource, !referralSource.isEmpty {
            updates["referralSource"] = referralSource
        } else {
            updates["referralSource"] = FieldValue.delete()
        }

        let cleanedStyles = tattooStyles
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let cleanedAllergies = allergies
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var prefs: [String: Any] = [:]
        if let preferredTime, !preferredTime.isEmpty {
            prefs["preferredTime"] = preferredTime
        } else {
            prefs["preferredTime"] = FieldValue.delete()
        }
        if !cleanedStyles.isEmpty {
            prefs["tattooStyles"] = cleanedStyles
            prefs["tattooStyle"] = cleanedStyles[0]
        } else {
            prefs["tattooStyles"] = FieldValue.delete()
            prefs["tattooStyle"] = FieldValue.delete()
        }
        if !cleanedAllergies.isEmpty {
            prefs["allergies"] = cleanedAllergies
        } else {
            prefs["allergies"] = FieldValue.delete()
        }
        updates["preferences"] = prefs

        let cleanedExtras = profileExtras
            .map {
                Client.ClientProfileExtra(
                    id: $0.id,
                    label: $0.label.trimmingCharacters(in: .whitespacesAndNewlines),
                    value: $0.value.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            }
            .filter { !$0.label.isEmpty || !$0.value.isEmpty }
        if cleanedExtras.isEmpty {
            updates["profileExtras"] = FieldValue.delete()
        } else {
            updates["profileExtras"] = cleanedExtras.map { ["id": $0.id, "label": $0.label, "value": $0.value] }
        }

        do {
            try await firebaseService.updateTenantCustomer(tenantId: tid, customerId: customerId, updates: updates)
            client.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            client.email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            client.phone = PhoneFormatting.normalizedForStorage(phone)
            client.vip = vip
            client.birthday = trimmedOrNil(birthday)
            client.referralSource = trimmedOrNil(referralSource)
            client.profileExtras = cleanedExtras.isEmpty ? nil : cleanedExtras
            client.preferences = Client.ClientPreferences(
                preferredTime: trimmedOrNil(preferredTime),
                tattooStyle: cleanedStyles.first,
                tattooStyles: cleanedStyles.isEmpty ? nil : cleanedStyles,
                allergies: cleanedAllergies.isEmpty ? nil : cleanedAllergies
            )
            saveError = nil
        } catch {
            saveError = error.localizedDescription
        }
    }

    func price(for booking: BookingRequest) -> Double? {
        if let serviceId = booking.serviceId, let price = servicePrices[serviceId] {
            return price
        }
        if let serviceName = booking.serviceName, let price = servicePrices[serviceName] {
            return price
        }
        return nil
    }

    static func matches(booking: BookingRequest, client: Client) -> Bool {
        if let customerId = client.id, let bookingCustomerId = booking.customerId, customerId == bookingCustomerId {
            return true
        }
        let clientPhone = PhoneFormatting.digits(from: client.phone ?? "")
        let bookingPhone = PhoneFormatting.digits(from: booking.customerPhone ?? "")
        if clientPhone.count >= 10, bookingPhone.count >= 10 {
            return String(clientPhone.suffix(10)) == String(bookingPhone.suffix(10))
        }
        let clientEmail = client.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let bookingEmail = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !clientEmail.isEmpty && clientEmail == bookingEmail
    }

    static func isVisitStatus(_ status: String) -> Bool {
        let normalized = status.lowercased()
        return normalized == "confirmed" || normalized == "completed"
    }

    static func isPendingStatus(_ status: String) -> Bool {
        BookingRequestStatus.isNew(status) || BookingRequestStatus.isInFlightPending(status)
    }

    private func trimmedOrNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func displayConsentSource(_ source: String) -> String {
        switch source {
        case "web_booking": return "Booking form checkbox"
        default:
            return source.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private static func priceLookup(from services: [TenantService]) -> [String: Double] {
        var lookup: [String: Double] = [:]
        for service in services {
            guard let price = service.price else { continue }
            lookup[service.id] = price
            lookup[service.name] = price
            if !service.slug.isEmpty {
                lookup[service.slug] = price
            }
        }
        return lookup
    }
}
