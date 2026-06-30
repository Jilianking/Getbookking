import Foundation
import Combine
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions

class RequestsViewModel: ObservableObject {
    @Published var requests: [Request] = []
    @Published var bookingRequests: [BookingRequest] = []
    @Published var tenantId: String?
    /// Firestore `tenants/{id}.industry` (BookingTemplate raw value); drives booking detail section titles.
    @Published var tenantIndustry: String?
    @Published var teamMembers: [TenantTeamMember] = []
    @Published var studioAvailability: ProviderAvailability = .default
    @Published var workflowDepositAmount: Double?
    @Published var isLoading = false
    @Published var actionError: String?
    @Published var isUpdatingStatus = false
    @Published var isUpdatingAssignment = false
    @Published var isSeeding = false
    @Published var seedMessage: String?
    
    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    var sessionStore: TenantSessionStore?
    
    var useTenantData: Bool { tenantId != nil }

    /// Full team for booking list filter: owner first, then everyone else by name.
    var teamFilterRoster: [TenantTeamMember] {
        teamMembers.sorted { lhs, rhs in
            if lhs.accessRole == .owner, rhs.accessRole != .owner { return true }
            if rhs.accessRole == .owner, lhs.accessRole != .owner { return false }
            return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }
    }

    var teamFilterOwner: TenantTeamMember? {
        teamMembers.first { $0.accessRole == .owner }
    }

    /// For industry-specific copy (e.g. booking request form section titles).
    var tenantBookingTemplate: BookingTemplate? {
        guard let raw = tenantIndustry?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return BookingTemplate(rawValue: raw)
    }

    private func resolvedStudioAvailability(
        profileAvailability: ProviderAvailability,
        tenant: [String: Any]?
    ) -> ProviderAvailability {
        ProviderAvailability.mergingTenantBusinessHours(tenant, into: profileAvailability)
    }
    
    func loadRequests(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            if let sessionStore, sessionStore.isDemoSession {
                let availability = resolvedStudioAvailability(
                    profileAvailability: sessionStore.profile?.availability ?? .default,
                    tenant: sessionStore.tenant
                )
                let industryRaw = sessionStore.tenantIndustry
                await MainActor.run {
                    tenantId = sessionStore.tenantId
                    tenantIndustry = industryRaw.isEmpty ? nil : industryRaw
                    bookingRequests = sessionStore.bookingRequests
                    teamMembers = sessionStore.teamMembers
                    studioAvailability = availability
                    workflowDepositAmount = sessionStore.profile?.workflow.depositAmount
                    requests = []
                    isLoading = false
                }
                return
            }
            await MainActor.run {
                requests = []
                bookingRequests = []
                tenantId = nil
                tenantIndustry = nil
                teamMembers = []
                studioAvailability = .default
                workflowDepositAmount = nil
                isLoading = false
            }
            return
        }
        
        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }

            if let sessionStore {
                await sessionStore.ensureSessionLoaded(isDemoMode: false)
                async let bookings: () = sessionStore.loadBookingsIfNeeded(force: false, isDemoMode: false)
                async let newBookings: () = sessionStore.loadNewBookingsIfNeeded(force: false, isDemoMode: false)
                async let members: () = sessionStore.loadTeamMembersIfNeeded(force: false, isDemoMode: false)
                _ = await (bookings, newBookings, members)
                let availability = resolvedStudioAvailability(
                    profileAvailability: sessionStore.profile?.availability ?? .default,
                    tenant: sessionStore.tenant
                )
                let industryRaw = sessionStore.tenantIndustry
                await MainActor.run {
                    tenantId = sessionStore.tenantId
                    tenantIndustry = industryRaw.isEmpty ? nil : industryRaw
                    bookingRequests = sessionStore.bookingRequests
                    teamMembers = sessionStore.teamMembers
                    studioAvailability = availability
                    workflowDepositAmount = sessionStore.profile?.workflow.depositAmount
                    requests = []
                    isLoading = false
                }
                return
            }

            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            let tid = profile?.tenantId
            let baseAvailability = profile?.availability ?? .default
            
            if let tid = tid {
                async let fetched = firebaseService.fetchTenantBookingRequests(tenantId: tid)
                async let tenantDoc = firebaseService.fetchTenant(tenantId: tid)
                async let membersPayload = functions.httpsCallable("listTenantMembers").call([:])
                let (bookingList, tenant, membersResult) = try await (fetched, tenantDoc, membersPayload)
                let availability = resolvedStudioAvailability(
                    profileAvailability: baseAvailability,
                    tenant: tenant
                )
                let industryRaw = (tenant?["industry"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let membersData = membersResult.data as? [String: Any]
                let roster = Self.parseTeamMembers(
                    membersData?["members"] as? [[String: Any]],
                    ownerUid: membersData?["ownerUid"] as? String
                )
                await MainActor.run {
                    tenantId = tid
                    tenantIndustry = industryRaw?.isEmpty == false ? industryRaw : nil
                    bookingRequests = bookingList
                    teamMembers = roster
                    studioAvailability = availability
                    workflowDepositAmount = profile?.workflow.depositAmount
                    requests = []
                    isLoading = false
                }
            } else {
                let fetched = try await firebaseService.fetchRequests()
                await MainActor.run {
                    tenantId = nil
                    tenantIndustry = nil
                    teamMembers = []
                    studioAvailability = baseAvailability
                    requests = fetched
                    bookingRequests = []
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading requests: \(error)")
        }
    }

    func refreshRequests(isDemoMode: Bool = false, sessionStore: TenantSessionStore? = nil) async {
        let store = sessionStore ?? self.sessionStore
        if let store {
            store.invalidateBookings()
            store.invalidateTeamMembers()
            await store.loadNewBookingsIfNeeded(force: true, isDemoMode: isDemoMode)
        }
        await loadRequests(isDemoMode: isDemoMode, sessionStore: store)
    }

    private func reloadAfterMutation(isDemoMode: Bool = false) async {
        await refreshRequests(isDemoMode: isDemoMode, sessionStore: sessionStore)
    }
    
    func updateRequest(_ requestId: String, status: Request.RequestStatus, notes: String?) async {
        if let store = sessionStore, store.isDemoSession {
            store.applyDemoBookingStatus(requestId: requestId, status: status.rawValue)
            await reloadAfterMutation(isDemoMode: true)
            return
        }
        var updates: [String: Any] = ["status": status.rawValue]
        if let notes = notes { updates["notes"] = notes }
        updates["reviewedAt"] = Date()
        
        do {
            if let tid = tenantId {
                try await firebaseService.updateTenantBookingRequest(tenantId: tid, requestId: requestId, updates: updates)
            } else {
                try await firebaseService.updateRequest(requestId, updates: updates)
            }
            await reloadAfterMutation()
        } catch {
            print("Error updating request: \(error)")
        }
    }
    
    func updateBookingRequest(_ requestId: String, status: String, notes: String?) async {
        await setBookingRequestStatus(requestId: requestId, status: status, notes: notes)
    }

    /// Uses Cloud Function so manager `approveRejectRequests` is enforced server-side.
    func setBookingRequestStatus(
        requestId: String,
        status: String,
        notes: String?,
        managesLoadingState: Bool = true
    ) async {
        if let store = sessionStore, store.isDemoSession {
            await markBookingRequestAsRead(requestId: requestId)
            if managesLoadingState {
                await MainActor.run {
                    isUpdatingStatus = true
                    actionError = nil
                }
            }
            store.applyDemoBookingStatus(requestId: requestId, status: status)
            await reloadAfterMutation(isDemoMode: true)
            if managesLoadingState {
                await MainActor.run { isUpdatingStatus = false }
            }
            return
        }
        guard resolvedTenantId != nil else { return }
        await markBookingRequestAsRead(requestId: requestId)
        if managesLoadingState {
            await MainActor.run {
                isUpdatingStatus = true
                actionError = nil
            }
        }
        var payload: [String: Any] = [
            "requestId": requestId,
            "status": status,
        ]
        if let notes { payload["notes"] = notes }
        do {
            _ = try await functions.httpsCallable("updateBookingRequestStatus").call(payload)
            await reloadAfterMutation()
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
        }
        if managesLoadingState {
            await MainActor.run { isUpdatingStatus = false }
        }
    }

    /// Assigns time + artist and marks the request confirmed (single confirm flow).
    func confirmBookingAppointment(
        requestId: String,
        member: TenantTeamMember,
        scheduledStart: Date,
        preferredTimeLabel: String,
        notes: String?
    ) async {
        if let store = sessionStore, store.isDemoSession {
            await markBookingRequestAsRead(requestId: requestId)
            await MainActor.run {
                isUpdatingStatus = true
                actionError = nil
            }
            store.applyDemoBookingConfirmation(
                requestId: requestId,
                memberUid: member.uid,
                memberName: member.displayName,
                memberEmail: member.email,
                scheduledStart: scheduledStart,
                preferredTimeLabel: preferredTimeLabel,
                status: "confirmed"
            )
            await reloadAfterMutation(isDemoMode: true)
            await MainActor.run { isUpdatingStatus = false }
            return
        }
        guard resolvedTenantId != nil else { return }
        await markBookingRequestAsRead(requestId: requestId)
        await MainActor.run {
            isUpdatingStatus = true
            actionError = nil
        }
        await assignBookingRequest(
            requestId: requestId,
            member: member,
            scheduledStart: scheduledStart,
            preferredTimeLabel: preferredTimeLabel,
            managesLoadingState: false
        )
        if actionError != nil {
            await MainActor.run { isUpdatingStatus = false }
            return
        }
        await setBookingRequestStatus(
            requestId: requestId,
            status: "confirmed",
            notes: notes,
            managesLoadingState: false
        )
        await MainActor.run { isUpdatingStatus = false }
    }

    /// Updates time + artist on an already-confirmed booking (no status change).
    func rescheduleBookingAppointment(
        requestId: String,
        member: TenantTeamMember,
        scheduledStart: Date,
        preferredTimeLabel: String
    ) async {
        if let store = sessionStore, store.isDemoSession {
            await MainActor.run {
                isUpdatingAssignment = true
                actionError = nil
            }
            store.applyDemoBookingConfirmation(
                requestId: requestId,
                memberUid: member.uid,
                memberName: member.displayName,
                memberEmail: member.email,
                scheduledStart: scheduledStart,
                preferredTimeLabel: preferredTimeLabel,
                status: "confirmed"
            )
            await reloadAfterMutation(isDemoMode: true)
            await MainActor.run { isUpdatingAssignment = false }
            return
        }
        await assignBookingRequest(
            requestId: requestId,
            member: member,
            scheduledStart: scheduledStart,
            preferredTimeLabel: preferredTimeLabel
        )
    }

    /// Staff walk-in: create a booking request for an existing client and confirm in one step.
    /// Returns the new request id when confirm succeeds.
    @discardableResult
    func createAndConfirmBookingForClient(
        client: Client,
        serviceId: String,
        serviceSlug: String,
        serviceName: String,
        member: TenantTeamMember,
        scheduledStart: Date,
        notes: String?
    ) async -> String? {
        if let store = sessionStore, store.isDemoSession {
            await MainActor.run {
                actionError = "Scheduling is not available in demo mode."
            }
            return nil
        }
        guard let tid = resolvedTenantId else {
            await MainActor.run { actionError = "Studio not loaded." }
            return nil
        }
        await MainActor.run {
            isUpdatingStatus = true
            actionError = nil
        }
        do {
            let preferred = BookingAssignSchedulePlanner.formatSlotLabel(scheduledStart)
            let requestId = try await firebaseService.createTenantBookingRequest(
                tenantId: tid,
                customerName: client.name,
                customerEmail: client.email,
                customerPhone: client.phone,
                serviceId: serviceId,
                serviceSlug: serviceSlug,
                serviceName: serviceName,
                preferredTime: preferred,
                requestedStartTime: scheduledStart,
                notes: notes,
                formResponses: nil
            )
            await confirmBookingAppointment(
                requestId: requestId,
                member: member,
                scheduledStart: scheduledStart,
                preferredTimeLabel: preferred,
                notes: notes
            )
            let failed = await MainActor.run { actionError != nil }
            return failed ? nil : requestId
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
                isUpdatingStatus = false
            }
            return nil
        }
    }

    /// Creates a Stripe deposit link and texts it to the client (after confirm).
    func sendDepositLinkViaSms(for booking: BookingRequest, depositAmount: Double) async {
        if let store = sessionStore, store.isDemoSession { return }
        let cents = Int(round(depositAmount * 100))
        guard cents >= 50 else {
            await MainActor.run {
                actionError = "Deposit must be at least $0.50 to send a payment link."
            }
            return
        }
        let phoneRaw = (booking.customerPhone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !PhoneFormatting.digits(from: phoneRaw).isEmpty else {
            await MainActor.run {
                actionError = "Client has no phone number — deposit link was not sent."
            }
            return
        }
        do {
            var payload: [String: Any] = ["serviceAmountCents": cents]
            if let rid = booking.documentId?.trimmingCharacters(in: .whitespacesAndNewlines), !rid.isEmpty {
                payload["bookingRequestId"] = rid
            }
            let result = try await functions.httpsCallable("createDepositLink").call(payload)
            guard let data = result.data as? [String: Any],
                  let urlString = data["url"] as? String,
                  !urlString.isEmpty else {
                await MainActor.run { actionError = "Could not create deposit link." }
                return
            }
            let e164 = PhoneFormatting.e164US(phoneRaw) ?? phoneRaw
            let message = Message(
                id: nil,
                clientId: e164,
                clientName: booking.customerName ?? "Client",
                content: "Pay your deposit here: \(urlString)",
                sender: .admin,
                createdAt: Date(),
                read: true,
                threadId: PhoneFormatting.smsThreadId(e164)
            )
            try await firebaseService.sendMessage(message)
        } catch {
            await MainActor.run {
                actionError = FirebaseFunctionsErrorHelper.message(from: error)
            }
        }
    }

    /// Owner / managers with view-all: set or clear staff on a booking request.
    func assignBookingRequest(
        requestId: String,
        member: TenantTeamMember?,
        scheduledStart: Date? = nil,
        preferredTimeLabel: String? = nil,
        managesLoadingState: Bool = true
    ) async {
        guard let tid = tenantId, !requestId.isEmpty else { return }
        if managesLoadingState {
            await MainActor.run {
                isUpdatingAssignment = true
                actionError = nil
            }
        }
        var updates: [String: Any]
        if let member {
            updates = [
                "assignedMemberUid": member.uid,
                "assignedMemberName": member.displayName,
                "assignedMemberEmail": member.email,
            ]
            if let scheduledStart {
                updates["requestedStartTime"] = scheduledStart
            }
            if let preferredTimeLabel, !preferredTimeLabel.isEmpty {
                updates["preferredTime"] = preferredTimeLabel
            }
        } else {
            updates = [
                "assignedMemberUid": FieldValue.delete(),
                "assignedMemberName": FieldValue.delete(),
                "assignedMemberEmail": FieldValue.delete(),
            ]
        }
        do {
            try await firebaseService.updateTenantBookingRequest(
                tenantId: tid,
                requestId: requestId,
                updates: updates
            )
            await reloadAfterMutation()
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
        }
        if managesLoadingState {
            await MainActor.run { isUpdatingAssignment = false }
        }
    }

    /// Marks opened if still unread (`readAt` nil). Safe to call on list tap and detail open.
    func markBookingRequestAsReadIfNeeded(_ booking: BookingRequest) async {
        guard booking.readAt == nil else { return }
        guard let requestId = booking.documentId, !requestId.isEmpty else { return }
        _ = await markBookingRequestAsRead(requestId: requestId)
    }

    private var resolvedTenantId: String? {
        tenantId ?? sessionStore?.tenantId
    }

    private func syncViewModelReadAt(requestId: String, readAt: Date) {
        if let index = bookingRequests.firstIndex(where: { $0.documentId == requestId || $0.id == requestId }) {
            bookingRequests[index].readAt = readAt
        }
    }

    /// Marks the request as opened in-app (`readAt`). Does not change `status` (e.g. stays NEW).
    @discardableResult
    func markBookingRequestAsRead(requestId: String) async -> Bool {
        let trimmed = requestId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let readAt = Date()
        await MainActor.run {
            sessionStore?.markBookingRequestReadLocally(requestId: trimmed, readAt: readAt)
            syncViewModelReadAt(requestId: trimmed, readAt: readAt)
        }

        if let store = sessionStore {
            await store.markBookingRequestAsRead(
                requestId: trimmed,
                tenantId: resolvedTenantId
            )
            return true
        }

        guard let tid = resolvedTenantId else { return true }
        do {
            try await firebaseService.updateTenantBookingRequest(
                tenantId: tid,
                requestId: trimmed,
                updates: ["readAt": readAt]
            )
            return true
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
            }
            print("Error marking booking request read: \(error)")
            return false
        }
    }
    
    /// Owner-only (Cloud Function). Inserts test rows with `source: seed` (no push spam).
    func seedTestBookingRequests(count: Int = 100) async {
        guard tenantId != nil else {
            await MainActor.run { seedMessage = "Sign in to a business account first." }
            return
        }
        await MainActor.run {
            isSeeding = true
            seedMessage = nil
            actionError = nil
        }
        let payload: [String: Any] = [
            "confirm": "SEED_BOOKING_REQUESTS",
            "count": min(500, max(1, count)),
        ]
        do {
            let result = try await functions.httpsCallable("seedTenantBookingRequests").call(payload)
            let data = result.data as? [String: Any]
            let written = data?["written"] as? Int ?? count
            await reloadAfterMutation()
            await MainActor.run {
                seedMessage = "Added \(written) test request(s). Pull to refresh if needed."
            }
        } catch {
            await MainActor.run {
                actionError = error.localizedDescription
                seedMessage = nil
            }
        }
        await MainActor.run { isSeeding = false }
    }

    private static func parseTeamMembers(_ raw: [[String: Any]]?, ownerUid: String?) -> [TenantTeamMember] {
        TenantSessionStore.parseTeamMembers(raw, ownerUid: ownerUid)
    }

    func deleteRequest(_ requestId: String) async {
        do {
            if tenantId != nil {
                // Tenant requests: update status to cancelled instead of delete
                await updateBookingRequest(requestId, status: "cancelled", notes: nil)
            } else {
                try await firebaseService.deleteRequest(requestId)
                await reloadAfterMutation()
            }
        } catch {
            print("Error deleting request: \(error)")
        }
    }

    /// Stable `tenants/{id}/customers/{docId}` key (phone digits, then email slug).
    /// Stable `tenants/{id}/customers/{docId}` key (phone digits, then email slug).
    static func matchingClient(for booking: BookingRequest, in customers: [Client]) -> Client? {
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone) ?? ""
        let digits = PhoneFormatting.digits(from: phone)
        let targetPhoneId = digits.count >= 10 ? String(digits.suffix(10)) : ""
        let targetEmailId = email.isEmpty
            ? ""
            : String(email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression).prefix(120))
        let customerDocId = customerDocumentId(for: booking)

        return customers.first { customer in
            if let customerDocId,
               let id = customer.id?.trimmingCharacters(in: .whitespacesAndNewlines),
               !id.isEmpty,
               id == customerDocId {
                return true
            }
            let existingPhoneDigits = PhoneFormatting.digits(from: customer.phone ?? "")
            let existingPhoneId = existingPhoneDigits.count >= 10 ? String(existingPhoneDigits.suffix(10)) : ""
            let existingEmailId = customer.email
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            if !targetPhoneId.isEmpty && existingPhoneId == targetPhoneId { return true }
            if !targetEmailId.isEmpty && String(existingEmailId.prefix(120)) == targetEmailId { return true }
            return false
        }
    }

    static func enrichBookingRequestWithClientContact(_ booking: BookingRequest, client: Client?) -> BookingRequest {
        guard let client else { return booking }
        var enriched = booking
        let bookingName = (enriched.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let clientName = client.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if bookingName.isEmpty, !clientName.isEmpty {
            enriched.customerName = clientName
        }
        let bookingEmail = (enriched.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let clientEmail = client.email.trimmingCharacters(in: .whitespacesAndNewlines)
        if bookingEmail.isEmpty, !clientEmail.isEmpty {
            enriched.customerEmail = clientEmail
        }
        let bookingPhone = (enriched.customerPhone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let clientPhone = (client.phone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if bookingPhone.isEmpty, !clientPhone.isEmpty {
            enriched.customerPhone = clientPhone
        }
        if (enriched.customerId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let clientId = client.id?.trimmingCharacters(in: .whitespacesAndNewlines),
           !clientId.isEmpty {
            enriched.customerId = clientId
        }
        return enriched
    }

    func enrichedBookingRequestWithClientContact(_ booking: BookingRequest) async -> BookingRequest {
        guard let tid = tenantId else { return booking }
        do {
            let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
            let match = Self.matchingClient(for: booking, in: customers)
            return Self.enrichBookingRequestWithClientContact(booking, client: match)
        } catch {
            return booking
        }
    }

    static func customerDocumentId(for booking: BookingRequest) -> String? {
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone)
        let digits = PhoneFormatting.digits(from: phone ?? "")
        if digits.count >= 10 { return String(digits.suffix(10)) }
        if !email.isEmpty {
            let safe = email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            return String(safe.prefix(120))
        }
        return nil
    }

    func addBookingRequestCustomerToContacts(_ booking: BookingRequest) async -> Bool {
        guard let tid = tenantId else { return false }
        let name = (booking.customerName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone)
        guard !name.isEmpty else {
            await MainActor.run { actionError = "Customer name is required to save contact." }
            return false
        }
        guard !email.isEmpty || (phone != nil && !(phone ?? "").isEmpty) else {
            await MainActor.run { actionError = "Add an email or phone number to save contact." }
            return false
        }
        do {
            let customerId = Self.customerDocumentId(for: booking) ?? UUID().uuidString
            try await firebaseService.upsertTenantCustomer(
                tenantId: tid,
                customerId: customerId,
                name: name,
                email: email,
                phone: phone
            )
            await MainActor.run { actionError = nil }
            return true
        } catch {
            await MainActor.run { actionError = error.localizedDescription }
            return false
        }
    }

    func isBookingRequestCustomerInContacts(_ booking: BookingRequest) async -> Bool {
        guard let tid = tenantId else { return false }
        let email = (booking.customerEmail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let phone = PhoneFormatting.normalizedForStorage(booking.customerPhone) ?? ""
        let digits = PhoneFormatting.digits(from: phone)
        let targetPhoneId = digits.count >= 10 ? String(digits.suffix(10)) : ""
        let targetEmailId = email.isEmpty
            ? ""
            : String(email.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression).prefix(120))
        do {
            let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
            return customers.contains { customer in
                let existingPhoneDigits = PhoneFormatting.digits(from: customer.phone ?? "")
                let existingPhoneId = existingPhoneDigits.count >= 10 ? String(existingPhoneDigits.suffix(10)) : ""
                let existingEmailId = customer.email
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                    .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
                if !targetPhoneId.isEmpty && existingPhoneId == targetPhoneId { return true }
                if !targetEmailId.isEmpty && String(existingEmailId.prefix(120)) == targetEmailId { return true }
                return false
            }
        } catch {
            return false
        }
    }
}

