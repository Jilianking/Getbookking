//
//  TenantSessionStore.swift
//
//  Shared session cache for tenant profile, team roster, bookings, and customers.
//

import Foundation
import Combine
import FirebaseAuth
import FirebaseFunctions

@MainActor
final class TenantSessionStore: ObservableObject {
    static let dataCacheTTL: TimeInterval = 60

    @Published private(set) var profile: ProviderProfile?
    @Published private(set) var tenantId: String?
    @Published private(set) var tenant: [String: Any]?
    @Published private(set) var teamMembers: [TenantTeamMember] = []
    @Published private(set) var bookingRequests: [BookingRequest] = []
    /// Status `NEW` rows — drives drawer badge via `unreadRequestsCount`.
    @Published private(set) var newBookingRequests: [BookingRequest] = []
    @Published private(set) var customers: [Client] = []
    @Published private(set) var smsQuickPresets: [String] = []
    @Published private(set) var ownerUid: String?

    /// Active marketing sandbox persona (read-only; local mutations only).
    @Published private(set) var demoPersona: DemoPersona?
    @Published private(set) var demoSmsThreads: [SmsThreadSummary] = []
    @Published private(set) var demoSmsMessages: [String: [Message]] = [:]
    @Published private(set) var demoServices: [[String: Any]] = []
    @Published private(set) var demoPayments: DemoPaymentsSnapshot?
    @Published private(set) var isDemoSession = false
    @Published private(set) var demoLoadError: String?
    @Published private(set) var isDemoLoading = false

    private static var demoSnapshotCache: [String: [String: Any]] = [:]

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    private var sessionLoaded = false
    private var bookingsLoadedAt: Date?
    private var customersLoadedAt: Date?
    private var teamMembersLoadedAt: Date?
    private var newBookingsLoadedAt: Date?
    private var customerCountCache: Int?
    private var loadedUid: String?

    var businessDisplayName: String {
        profile?.business.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var tenantIndustry: String {
        let fromTenant = (tenant?["industry"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !fromTenant.isEmpty { return fromTenant }
        return profile?.industry ?? BookingTemplate.custom.rawValue
    }

    var tenantIndustryCustomLabel: String {
        (tenant?["industryCustomLabel"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var tenantIndustryDisplayName: String {
        BookingTemplate.displayLabel(
            forIndustryRaw: tenantIndustry,
            customLabel: tenantIndustryCustomLabel
        )
    }

    /// Drawer badge + dashboard unread subtitle (updated when `newBookingRequests` changes).
    @Published private(set) var unreadRequestsCount = 0

    var pendingRequestsCount: Int {
        newBookingRequests.count
    }

    static func isNewWorkflowStatus(_ status: String) -> Bool {
        BookingRequestStatus.isNew(status)
    }

    static func isInFlightPendingStatus(_ status: String) -> Bool {
        BookingRequestStatus.isInFlightPending(status)
    }

    static func filterNewWorkflowRequests(_ list: [BookingRequest]) -> [BookingRequest] {
        list
            .filter { isNewWorkflowStatus($0.status) }
            .sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }

    private func syncUnreadRequestsCount() {
        unreadRequestsCount = newBookingRequests.filter { $0.readAt == nil }.count
    }

    func reset() {
        profile = nil
        tenantId = nil
        tenant = nil
        teamMembers = []
        bookingRequests = []
        customers = []
        smsQuickPresets = []
        ownerUid = nil
        sessionLoaded = false
        bookingsLoadedAt = nil
        customersLoadedAt = nil
        teamMembersLoadedAt = nil
        newBookingsLoadedAt = nil
        newBookingRequests = []
        unreadRequestsCount = 0
        customerCountCache = nil
        loadedUid = nil
        demoPersona = nil
        demoSmsThreads = []
        demoSmsMessages = [:]
        demoServices = []
        demoPayments = nil
        isDemoSession = false
        demoLoadError = nil
        isDemoLoading = false
    }

    /// Clears cached session only when the signed-in user or demo persona changes.
    @discardableResult
    func prepareForSession(uid: String?, isDemoMode: Bool, demoPersona: DemoPersona?) -> Bool {
        let newKey: String?
        if isDemoMode, let persona = demoPersona {
            newKey = "demo-\(persona.slug)"
        } else {
            newKey = uid
        }
        guard let newKey else {
            if loadedUid != nil {
                reset()
                return true
            }
            return false
        }
        if loadedUid == newKey, sessionLoaded || isDemoSession {
            return false
        }
        reset()
        return true
    }

    func bootstrap(isDemoMode: Bool, demoPersona persona: DemoPersona? = nil) async {
        if isDemoMode, let persona {
            if isDemoSession, demoPersona == persona, sessionLoaded, demoLoadError == nil {
                return
            }
            await loadDemoSession(persona: persona)
            return
        }
        if isDemoMode {
            reset()
            return
        }
        await ensureSessionLoaded(isDemoMode: false)
        async let bookings: () = loadBookingsIfNeeded(force: false, isDemoMode: false)
        async let newBookings: () = loadNewBookingsIfNeeded(force: false, isDemoMode: false)
        async let members: () = loadTeamMembersIfNeeded(force: false, isDemoMode: false)
        _ = await (bookings, newBookings, members)
    }

    func loadDemoSession(persona: DemoPersona, forceRefresh: Bool = false) async {
        demoLoadError = nil

        if !forceRefresh, let cached = Self.demoSnapshotCache[persona.slug] {
            applyDemoPayload(cached, persona: persona)
            return
        }

        isDemoLoading = true
        defer { isDemoLoading = false }

        do {
            let result = try await functions.httpsCallable("getDemoAppSnapshot").call(["slug": persona.slug])
            guard let payload = result.data as? [String: Any] else {
                throw DemoSessionError.loadFailed("Demo data unavailable.")
            }
            Self.demoSnapshotCache[persona.slug] = payload
            applyDemoPayload(payload, persona: persona)
        } catch {
            let msg = FirebaseFunctionsErrorHelper.message(from: error)
            demoLoadError = msg
            print("TenantSessionStore demo load error: \(error)")
        }
    }

    private func applyDemoPayload(_ payload: [String: Any], persona: DemoPersona) {
        guard let tenantId = payload["tenantId"] as? String,
              let tenant = payload["tenant"] as? [String: Any] else {
            demoLoadError = "Demo data incomplete."
            return
        }
        let owner = payload["owner"] as? [String: Any] ?? [:]
        demoPersona = persona
        isDemoSession = true
        self.tenantId = tenantId
        self.tenant = tenant
        ownerUid = (owner["uid"] as? String) ?? "demo-owner"
        profile = DemoSnapshotParser.providerProfile(
            persona: persona,
            tenantId: tenantId,
            tenant: tenant,
            owner: owner
        )

        let bookingRaw = payload["bookingRequests"] as? [[String: Any]] ?? []
        bookingRequests = bookingRaw.compactMap { DemoSnapshotParser.bookingRequest(from: $0, tenantId: tenantId) }
        newBookingRequests = Self.filterNewWorkflowRequests(bookingRequests)
        syncUnreadRequestsCount()
        bookingsLoadedAt = Date()
        newBookingsLoadedAt = Date()

        let customerRaw = payload["customers"] as? [[String: Any]] ?? []
        customers = customerRaw.compactMap { DemoSnapshotParser.client(from: $0) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        customerCountCache = customers.count
        customersLoadedAt = Date()

        let threadRaw = payload["smsThreads"] as? [[String: Any]] ?? []
        demoSmsThreads = threadRaw.compactMap { DemoSnapshotParser.smsThread(from: $0) }

        var messagesByThread: [String: [Message]] = [:]
        let messageRaw = payload["smsMessages"] as? [[String: Any]] ?? []
        for item in messageRaw {
            guard let msg = DemoSnapshotParser.smsMessage(from: item) else { continue }
            let key = PhoneFormatting.smsThreadId(msg.threadId)
            messagesByThread[key, default: []].append(msg)
        }
        for key in messagesByThread.keys {
            messagesByThread[key]?.sort { $0.createdAt < $1.createdAt }
        }
        demoSmsMessages = messagesByThread

        demoServices = payload["services"] as? [[String: Any]] ?? []
        demoPayments = DemoSnapshotParser.payments(from: payload["payments"] as? [String: Any])

        smsQuickPresets = ManagerSettingsViewModel.defaultQuickReplyPresets
        teamMembers = []
        sessionLoaded = true
        loadedUid = "demo-\(persona.slug)"
    }

    func demoMessages(for threadId: String) -> [Message] {
        let key = PhoneFormatting.smsThreadId(threadId)
        return demoSmsMessages[key] ?? []
    }

    func appendDemoOutboundMessage(threadId: String, message: Message) {
        let key = PhoneFormatting.smsThreadId(threadId)
        var list = demoSmsMessages[key] ?? []
        list.append(message)
        demoSmsMessages[key] = list
        if let idx = demoSmsThreads.firstIndex(where: {
            PhoneFormatting.smsThreadId($0.threadId) == key
        }) {
            let thread = demoSmsThreads[idx]
            demoSmsThreads[idx] = SmsThreadSummary(
                threadId: thread.threadId,
                clientName: thread.clientName,
                lastMessageBody: message.content,
                lastMessageAt: message.createdAt,
                assignedMemberUid: thread.assignedMemberUid
            )
        }
    }

    func applyDemoBookingConfirmation(
        requestId: String,
        memberUid: String,
        memberName: String,
        memberEmail: String,
        scheduledStart: Date,
        preferredTimeLabel: String,
        status: String
    ) {
        let matches: (BookingRequest) -> Bool = { req in
            req.documentId == requestId || req.id == requestId
        }
        func apply(to request: inout BookingRequest) {
            request.status = status
            request.assignedMemberUid = memberUid
            request.assignedMemberName = memberName
            request.assignedMemberEmail = memberEmail
            request.requestedStartTime = scheduledStart
            request.preferredTime = preferredTimeLabel
        }
        if let idx = bookingRequests.firstIndex(where: matches) {
            var updated = bookingRequests[idx]
            apply(to: &updated)
            bookingRequests[idx] = updated
        }
        if let idx = newBookingRequests.firstIndex(where: matches) {
            if Self.isNewWorkflowStatus(status) {
                var updated = newBookingRequests[idx]
                apply(to: &updated)
                newBookingRequests[idx] = updated
            } else {
                newBookingRequests.remove(at: idx)
            }
        } else if Self.isNewWorkflowStatus(status),
                  let updated = bookingRequests.first(where: matches) {
            newBookingRequests.append(updated)
        }
        newBookingRequests.sort {
            ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast)
        }
        syncUnreadRequestsCount()
    }

    func applyDemoBookingStatus(requestId: String, status: String) {
        let matches: (BookingRequest) -> Bool = { req in
            req.documentId == requestId || req.id == requestId
        }
        if let idx = bookingRequests.firstIndex(where: matches) {
            var updated = bookingRequests[idx]
            updated.status = status
            bookingRequests[idx] = updated
        }
        if let idx = newBookingRequests.firstIndex(where: matches) {
            if Self.isNewWorkflowStatus(status) {
                var updated = newBookingRequests[idx]
                updated.status = status
                newBookingRequests[idx] = updated
            } else {
                newBookingRequests.remove(at: idx)
            }
        } else if Self.isNewWorkflowStatus(status),
                  let updated = bookingRequests.first(where: matches) {
            newBookingRequests.append(updated)
        }
        newBookingRequests.sort {
            ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast)
        }
        syncUnreadRequestsCount()
    }

    func markAppTourCompleted() {
        guard var current = profile else { return }
        current.appTourPending = false
        profile = current
    }

    func ensureSessionLoaded(isDemoMode: Bool) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode {
            reset()
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            reset()
            return
        }
        if let loadedUid, loadedUid != uid {
            reset()
        }
        if sessionLoaded, profile != nil, loadedUid == uid { return }

        do {
            let fetchedProfile = try await firebaseService.fetchProviderProfile(uid: uid)
            profile = fetchedProfile
            tenantId = fetchedProfile?.tenantId
            if let tid = fetchedProfile?.tenantId {
                tenant = try await firebaseService.fetchTenant(tenantId: tid)
            } else {
                tenant = nil
            }
            loadedUid = uid
            sessionLoaded = true
        } catch {
            print("TenantSessionStore session load error: \(error)")
        }
    }

    func loadBookingsIfNeeded(force: Bool = false, isDemoMode: Bool = false) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode { return }
        await ensureSessionLoaded(isDemoMode: false)
        guard let tid = tenantId else { return }
        if !force, let loadedAt = bookingsLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL {
            return
        }
        do {
            bookingRequests = try await firebaseService.fetchTenantBookingRequests(tenantId: tid)
            bookingsLoadedAt = Date()
        } catch {
            print("TenantSessionStore bookings load error: \(error)")
        }
    }

    /// Lightweight fetch for dashboard stats and drawer badges.
    func loadDashboardBookingsIfNeeded(force: Bool = false, isDemoMode: Bool = false) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode { return }
        await ensureSessionLoaded(isDemoMode: false)
        guard let tid = tenantId else { return }
        if !force, let loadedAt = bookingsLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL,
           !bookingRequests.isEmpty {
            return
        }
        do {
            bookingRequests = try await firebaseService.fetchTenantBookingRequests(
                tenantId: tid,
                limit: 100
            )
            bookingsLoadedAt = Date()
        } catch {
            print("TenantSessionStore dashboard bookings load error: \(error)")
        }
    }

    func loadNewBookingsIfNeeded(force: Bool = false, isDemoMode: Bool = false) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode { return }
        await ensureSessionLoaded(isDemoMode: false)
        guard let tid = tenantId else { return }
        if !force, let loadedAt = newBookingsLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL {
            return
        }
        do {
            if !force,
               !bookingRequests.isEmpty,
               let loadedAt = bookingsLoadedAt,
               Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL {
                newBookingRequests = Self.filterNewWorkflowRequests(bookingRequests)
            } else {
                let fetched = try await firebaseService.fetchTenantBookingRequests(
                    tenantId: tid,
                    limit: 200
                )
                newBookingRequests = Self.filterNewWorkflowRequests(fetched)
            }
            newBookingsLoadedAt = Date()
            syncUnreadRequestsCount()
        } catch {
            print("TenantSessionStore new bookings load error: \(error)")
        }
    }

    func loadCustomersIfNeeded(force: Bool = false, isDemoMode: Bool = false) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode { return }
        await ensureSessionLoaded(isDemoMode: false)
        guard let tid = tenantId else { return }
        if !force, let loadedAt = customersLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL,
           !customers.isEmpty {
            return
        }
        do {
            customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
            customersLoadedAt = Date()
            customerCountCache = customers.count
        } catch {
            print("TenantSessionStore customers load error: \(error)")
        }
    }

    func customerCount(isDemoMode: Bool = false) async -> Int {
        if isDemoMode, isDemoSession { return customers.count }
        if isDemoMode { return 0 }
        await ensureSessionLoaded(isDemoMode: false)
        guard let tid = tenantId else { return 0 }
        if let customerCountCache { return customerCountCache }
        do {
            let count = try await firebaseService.countTenantCustomers(tenantId: tid)
            customerCountCache = count
            return count
        } catch {
            print("TenantSessionStore customer count error: \(error)")
            return customers.count
        }
    }

    func loadTeamMembersIfNeeded(force: Bool = false, isDemoMode: Bool = false) async {
        if isDemoMode, isDemoSession { return }
        if isDemoMode { return }
        await ensureSessionLoaded(isDemoMode: false)
        guard tenantId != nil else { return }
        if !force, let loadedAt = teamMembersLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.dataCacheTTL,
           !teamMembers.isEmpty {
            return
        }
        do {
            let result = try await functions.httpsCallable("listTenantMembers").call([:])
            guard let data = result.data as? [String: Any] else { return }
            ownerUid = data["ownerUid"] as? String
            teamMembers = Self.parseTeamMembers(
                data["members"] as? [[String: Any]],
                ownerUid: ownerUid
            )
            let quick = (data["smsQuickPresets"] as? [String])?
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty } ?? []
            smsQuickPresets = quick.isEmpty
                ? ManagerSettingsViewModel.defaultQuickReplyPresets
                : quick
            teamMembersLoadedAt = Date()
        } catch {
            print("TenantSessionStore team members load error: \(error)")
        }
    }

    /// Optimistic update when a request is opened (`readAt` only; status stays NEW).
    func markBookingRequestReadLocally(requestId: String, readAt: Date = Date()) {
        let matches: (BookingRequest) -> Bool = { req in
            req.documentId == requestId || req.id == requestId
        }
        guard let bookingIndex = bookingRequests.firstIndex(where: matches) else {
            if let index = newBookingRequests.firstIndex(where: matches) {
                var updated = newBookingRequests[index]
                if updated.readAt == nil {
                    updated.readAt = readAt
                    newBookingRequests[index] = updated
                }
            }
            syncUnreadRequestsCount()
            return
        }

        var updatedBooking = bookingRequests[bookingIndex]
        guard updatedBooking.readAt == nil else {
            syncUnreadRequestsCount()
            return
        }
        updatedBooking.readAt = readAt
        bookingRequests[bookingIndex] = updatedBooking

        if Self.isNewWorkflowStatus(updatedBooking.status) {
            if let index = newBookingRequests.firstIndex(where: matches) {
                newBookingRequests[index] = updatedBooking
            } else {
                newBookingRequests.append(updatedBooking)
                newBookingRequests.sort {
                    ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast)
                }
            }
        }
        syncUnreadRequestsCount()
    }

    /// Updates badge immediately, then persists `readAt` when a tenant id is available.
    func markBookingRequestAsRead(requestId: String, tenantId overrideTenantId: String? = nil) async {
        let trimmed = requestId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let readAt = Date()
        markBookingRequestReadLocally(requestId: trimmed, readAt: readAt)
        if isDemoSession { return }
        guard let tid = overrideTenantId ?? tenantId else { return }
        do {
            try await firebaseService.updateTenantBookingRequest(
                tenantId: tid,
                requestId: trimmed,
                updates: ["readAt": readAt]
            )
        } catch {
            print("TenantSessionStore mark booking request read error: \(error)")
        }
    }

    func markBookingRequestAsReadIfNeeded(
        _ booking: BookingRequest,
        tenantId overrideTenantId: String? = nil
    ) async {
        guard booking.readAt == nil else { return }
        guard let requestId = booking.documentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requestId.isEmpty else { return }
        await markBookingRequestAsRead(requestId: requestId, tenantId: overrideTenantId)
    }

    func invalidateBookings() {
        bookingsLoadedAt = nil
        newBookingsLoadedAt = nil
    }

    func invalidateCustomers() {
        customersLoadedAt = nil
        customerCountCache = nil
    }

    func invalidateTeamMembers() {
        teamMembersLoadedAt = nil
    }

    func refreshProfileAndTenant() async {
        sessionLoaded = false
        await ensureSessionLoaded(isDemoMode: false)
    }

    static func parseTeamMembers(_ raw: [[String: Any]]?, ownerUid: String?) -> [TenantTeamMember] {
        guard let raw else { return [] }
        return raw.compactMap { row in
            guard let uid = row["uid"] as? String else { return nil }
            let role = TeamAccessRole.fromFirestore(row["accessRole"] as? String ?? row["role"] as? String)
            let fn = (row["firstName"] as? String) ?? ""
            let ln = (row["lastName"] as? String) ?? ""
            var name = "\(fn) \(ln)".trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { name = (row["displayName"] as? String) ?? (row["name"] as? String) ?? "Member" }
            if uid == ownerUid {
                return TenantTeamMember(
                    uid: uid,
                    displayName: name,
                    email: (row["email"] as? String) ?? "",
                    phone: (row["phone"] as? String) ?? "",
                    profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                    accessRole: .owner,
                    jobTitle: "",
                    memberSlug: (row["memberSlug"] as? String) ?? "",
                    isBookable: row["isBookable"] as? Bool ?? true,
                    showOnTeamPage: row["showOnTeamPage"] as? Bool ?? (row["isBookable"] as? Bool ?? true),
                    showOnTeamHome: row["showOnTeamHome"] as? Bool ?? (row["isBookable"] as? Bool ?? true),
                    providerAboutText: (row["providerAboutText"] as? String) ?? "",
                    providerGalleryImages: Self.parseProviderGalleryImages(row),
                    smsEnabled: row["smsEnabled"] as? Bool ?? false,
                    smsStatus: (row["smsStatus"] as? String) ?? "off",
                    smsPhoneNumber: (row["smsPhoneNumber"] as? String) ?? "",
                    memberSettings: TeamMemberSettings(),
                    personalConfirmationType: parsePersonalConfirmationType(row),
                    effectiveConfirmationType: parseEffectiveConfirmationType(row)
                )
            }
            return TenantTeamMember(
                uid: uid,
                displayName: name,
                email: (row["email"] as? String) ?? "",
                phone: (row["phone"] as? String) ?? "",
                profilePhotoUrl: (row["profilePhotoUrl"] as? String) ?? "",
                accessRole: role,
                jobTitle: (row["jobTitle"] as? String) ?? "",
                memberSlug: (row["memberSlug"] as? String) ?? "",
                isBookable: row["isBookable"] as? Bool ?? (role == .member),
                showOnTeamPage: row["showOnTeamPage"] as? Bool ?? (row["isBookable"] as? Bool ?? (role == .member)),
                showOnTeamHome: row["showOnTeamHome"] as? Bool ?? (row["isBookable"] as? Bool ?? (role == .member)),
                providerAboutText: (row["providerAboutText"] as? String) ?? "",
                providerGalleryImages: Self.parseProviderGalleryImages(row),
                smsEnabled: row["smsEnabled"] as? Bool ?? false,
                smsStatus: (row["smsStatus"] as? String) ?? "off",
                smsPhoneNumber: (row["smsPhoneNumber"] as? String) ?? "",
                memberSettings: TeamMemberSettings(dictionary: row["memberSettings"] as? [String: Any]),
                personalConfirmationType: parsePersonalConfirmationType(row),
                effectiveConfirmationType: parseEffectiveConfirmationType(row)
            )
        }
    }

    private static func parsePersonalConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["personalConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func parseEffectiveConfirmationType(_ row: [String: Any]) -> String? {
        let raw = (row["effectiveConfirmationType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    private static func parseProviderGalleryImages(_ row: [String: Any]) -> [String] {
        guard let raw = row["providerGalleryImages"] as? [Any] else { return [] }
        return raw.compactMap { item -> String? in
            let s = (item as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return s.isEmpty ? nil : s
        }
    }
}
