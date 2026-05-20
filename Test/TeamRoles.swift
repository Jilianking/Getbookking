//
//  TeamRoles.swift
//
//  Access roles (permissions) and job titles (display labels) for team members.
//

import Foundation

// MARK: - Access role

enum TeamAccessRole: String, CaseIterable, Identifiable, Codable {
    case owner
    case manager
    case member

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .owner: return "Owner"
        case .manager: return "Manager"
        case .member: return "Team member"
        }
    }

    /// Parses Firestore `role` / `accessRole` (legacy `staff` → member).
    static func fromFirestore(_ raw: String?) -> TeamAccessRole {
        let r = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch r {
        case "owner": return .owner
        case "manager": return .manager
        case "staff", "member", "artist": return .member
        default: return .member
        }
    }

    var firestoreValue: String { rawValue }
}

// MARK: - Job title

struct TeamJobTitleOption: Identifiable, Hashable {
    let id: String
    let label: String
}

enum TeamJobTitleCatalog {
    /// Primary title for the tenant’s industry.
    static func defaultTitle(for industry: String?) -> String {
        primaryOptions(for: industry).first?.label ?? "Team member"
    }

    /// Job title presets for the tenant’s industry (invite + member detail pickers).
    static func options(for industry: String?) -> [TeamJobTitleOption] {
        primaryOptions(for: industry)
    }

    /// Suggestions for the business type.
    static func primaryOptions(for industry: String?) -> [TeamJobTitleOption] {
        let t = BookingTemplate(rawValue: (industry ?? "").lowercased()) ?? .custom
        switch t {
        case .tattoos:
            return [
                TeamJobTitleOption(id: "artist", label: "Artist"),
                TeamJobTitleOption(id: "apprentice", label: "Apprentice"),
                TeamJobTitleOption(id: "guest_artist", label: "Guest artist"),
            ]
        case .hair:
            return [
                TeamJobTitleOption(id: "stylist", label: "Stylist"),
                TeamJobTitleOption(id: "colorist", label: "Colorist"),
                TeamJobTitleOption(id: "assistant", label: "Assistant"),
            ]
        case .barber:
            return [
                TeamJobTitleOption(id: "barber", label: "Barber"),
                TeamJobTitleOption(id: "apprentice", label: "Apprentice"),
            ]
        case .nails:
            return [
                TeamJobTitleOption(id: "nail_tech", label: "Nail technician"),
                TeamJobTitleOption(id: "nail_artist", label: "Nail artist"),
            ]
        case .custom:
            return [
                TeamJobTitleOption(id: "team_member", label: "Team member"),
            ]
        }
    }

    static let customOptionId = "__custom__"
}

// MARK: - Per-member settings (owner edits on Team → member detail)

enum PaymentSplitAppliesTo: String, CaseIterable, Identifiable {
    case service
    case deposit
    case both

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .service: return "Service payments"
        case .deposit: return "Deposits only"
        case .both: return "Services & deposits"
        }
    }
}

struct TeamMemberSettings: Equatable {
    /// When true, uses tenant booking policy from Settings.
    var useStudioBookingPolicy: Bool = true
    var bookingConfirmationOverride: String?
    var paymentSplitPercent: Int = 0
    var paymentSplitAppliesTo: PaymentSplitAppliesTo = .service

    init() {}

    init(dictionary: [String: Any]?) {
        guard let d = dictionary else { return }
        if let u = d["useStudioBookingPolicy"] as? Bool {
            useStudioBookingPolicy = u
        }
        let override = (d["bookingConfirmationOverride"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        bookingConfirmationOverride = override.isEmpty ? nil : override
        if let p = d["paymentSplitPercent"] as? Int {
            paymentSplitPercent = min(100, max(0, p))
        } else if let p = d["paymentSplitPercent"] as? Double {
            paymentSplitPercent = min(100, max(0, Int(p)))
        }
        if let raw = d["paymentSplitAppliesTo"] as? String,
           let parsed = PaymentSplitAppliesTo(rawValue: raw) {
            paymentSplitAppliesTo = parsed
        }
    }

    var firestoreDictionary: [String: Any] {
        var d: [String: Any] = [
            "useStudioBookingPolicy": useStudioBookingPolicy,
            "paymentSplitPercent": paymentSplitPercent,
            "paymentSplitAppliesTo": paymentSplitAppliesTo.rawValue,
        ]
        if let override = bookingConfirmationOverride, !useStudioBookingPolicy {
            d["bookingConfirmationOverride"] = override
        }
        return d
    }
}

// MARK: - Manager policy

struct ManagerPermissions: Equatable {
    var viewAllBookings: Bool = true
    var approveRejectRequests: Bool = true
    var editServicesPricing: Bool = false
    var manageBookingFormStyle: Bool = false
    var manageArtistSchedules: Bool = true
    var accessClientList: Bool = true
    var viewEarningsReports: Bool = false
    var sendClientNotifications: Bool = true

    static let defaults = ManagerPermissions()

    init() {}

    init(
        viewAllBookings: Bool = true,
        approveRejectRequests: Bool = true,
        editServicesPricing: Bool = false,
        manageBookingFormStyle: Bool = false,
        manageArtistSchedules: Bool = true,
        accessClientList: Bool = true,
        viewEarningsReports: Bool = false,
        sendClientNotifications: Bool = true
    ) {
        self.viewAllBookings = viewAllBookings
        self.approveRejectRequests = approveRejectRequests
        self.editServicesPricing = editServicesPricing
        self.manageBookingFormStyle = manageBookingFormStyle
        self.manageArtistSchedules = manageArtistSchedules
        self.accessClientList = accessClientList
        self.viewEarningsReports = viewEarningsReports
        self.sendClientNotifications = sendClientNotifications
    }

    init(dictionary: [String: Any]?) {
        guard let d = dictionary else { return }
        viewAllBookings = d["viewAllBookings"] as? Bool ?? true
        approveRejectRequests = d["approveRejectRequests"] as? Bool ?? true
        editServicesPricing = d["editServicesPricing"] as? Bool ?? false
        manageBookingFormStyle = d["manageBookingFormStyle"] as? Bool ?? false
        manageArtistSchedules = d["manageArtistSchedules"] as? Bool ?? true
        accessClientList = d["accessClientList"] as? Bool ?? true
        viewEarningsReports = d["viewEarningsReports"] as? Bool ?? false
        sendClientNotifications = d["sendClientNotifications"] as? Bool ?? true
    }

    var firestoreDictionary: [String: Bool] {
        [
            "viewAllBookings": viewAllBookings,
            "approveRejectRequests": approveRejectRequests,
            "editServicesPricing": editServicesPricing,
            "manageBookingFormStyle": manageBookingFormStyle,
            "manageArtistSchedules": manageArtistSchedules,
            "accessClientList": accessClientList,
            "viewEarningsReports": viewEarningsReports,
            "sendClientNotifications": sendClientNotifications,
        ]
    }
}

struct ManagerNotifications: Equatable {
    var onNewBooking: Bool = true
    var onCancellation: Bool = true
    var dailySummaryEmail: Bool = false

    static let defaults = ManagerNotifications()

    init() {}

    init(dictionary: [String: Any]?) {
        guard let d = dictionary else { return }
        onNewBooking = d["onNewBooking"] as? Bool ?? true
        onCancellation = d["onCancellation"] as? Bool ?? true
        dailySummaryEmail = d["dailySummaryEmail"] as? Bool ?? false
    }

    var firestoreDictionary: [String: Bool] {
        [
            "onNewBooking": onNewBooking,
            "onCancellation": onCancellation,
            "dailySummaryEmail": dailySummaryEmail,
        ]
    }
}

// MARK: - Team roster row

struct TenantTeamMember: Identifiable, Equatable {
    let uid: String
    let displayName: String
    let email: String
    let profilePhotoUrl: String
    let accessRole: TeamAccessRole
    let jobTitle: String
    let memberSettings: TeamMemberSettings

    var id: String { uid }

    var isEditable: Bool { accessRole != .owner }

    var badgeLabel: String {
        switch accessRole {
        case .owner: return "Owner"
        case .manager: return "Manager"
        case .member:
            let t = jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? TeamJobTitleCatalog.defaultTitle(for: nil) : t
        }
    }

    var initials: String {
        let parts = displayName.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if parts.count >= 2 {
            return "\(parts[0].prefix(1))\(parts[1].prefix(1))".uppercased()
        }
        return String(displayName.prefix(2)).uppercased()
    }
}
