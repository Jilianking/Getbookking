import Foundation

struct Client: Codable, Identifiable {
    var id: String?
    var name: String
    var email: String
    var phone: String?
    var createdAt: Date
    var lastContact: Date?
    var totalAppointments: Int
    var notes: String?
    var noteEntries: [ClientNoteEntry]?
    var preferences: ClientPreferences?
    var vip: Bool
    var smsOptedIn: Bool?
    var smsConsentAt: Date?
    var smsConsentSource: String?
    var birthday: String?
    var referralSource: String?
    var profileExtras: [ClientProfileExtra]?

    init(
        id: String? = nil,
        name: String,
        email: String,
        phone: String? = nil,
        createdAt: Date = Date(),
        lastContact: Date? = nil,
        totalAppointments: Int = 0,
        notes: String? = nil,
        noteEntries: [ClientNoteEntry]? = nil,
        preferences: ClientPreferences? = nil,
        vip: Bool = false,
        smsOptedIn: Bool? = nil,
        smsConsentAt: Date? = nil,
        smsConsentSource: String? = nil,
        birthday: String? = nil,
        referralSource: String? = nil,
        profileExtras: [ClientProfileExtra]? = nil
    ) {
        self.id = id
        self.name = name
        self.email = email
        self.phone = phone
        self.createdAt = createdAt
        self.lastContact = lastContact
        self.totalAppointments = totalAppointments
        self.notes = notes
        self.noteEntries = noteEntries
        self.preferences = preferences
        self.vip = vip
        self.smsOptedIn = smsOptedIn
        self.smsConsentAt = smsConsentAt
        self.smsConsentSource = smsConsentSource
        self.birthday = birthday
        self.referralSource = referralSource
        self.profileExtras = profileExtras
    }

    /// Internal note card (Notes tab); persisted as `noteEntries` on the customer doc.
    struct ClientNoteEntry: Codable, Identifiable, Equatable {
        var id: String
        var body: String
        var createdAt: Date
        var updatedAt: Date?
        var authorName: String?

        init(
            id: String = UUID().uuidString,
            body: String = "",
            createdAt: Date = Date(),
            updatedAt: Date? = nil,
            authorName: String? = nil
        ) {
            self.id = id
            self.body = body
            self.createdAt = createdAt
            self.updatedAt = updatedAt
            self.authorName = authorName
        }
    }

    /// Merges `noteEntries` with legacy single `notes` string.
    var resolvedNoteEntries: [ClientNoteEntry] {
        if let noteEntries, !noteEntries.isEmpty { return noteEntries }
        if let legacy = notes?.trimmingCharacters(in: .whitespacesAndNewlines), !legacy.isEmpty {
            return [ClientNoteEntry(body: legacy, createdAt: createdAt)]
        }
        return []
    }

    /// Newest non-empty note for Overview preview.
    var latestNotePreview: String? {
        let sorted = resolvedNoteEntries.sorted {
            ($0.updatedAt ?? $0.createdAt) > ($1.updatedAt ?? $1.createdAt)
        }
        for entry in sorted {
            let trimmed = entry.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    struct ClientProfileExtra: Codable, Identifiable, Equatable {
        var id: String
        var label: String
        var value: String

        init(id: String = UUID().uuidString, label: String = "", value: String = "") {
            self.id = id
            self.label = label
            self.value = value
        }
    }

    struct ClientPreferences: Codable {
        var preferredTime: String?
        var tattooStyle: String?
        var tattooStyles: [String]?
        var allergies: [String]?

        var resolvedTattooStyles: [String] {
            if let tattooStyles, !tattooStyles.isEmpty { return tattooStyles }
            if let tattooStyle = tattooStyle?.trimmingCharacters(in: .whitespacesAndNewlines), !tattooStyle.isEmpty {
                return [tattooStyle]
            }
            return []
        }
    }
}

