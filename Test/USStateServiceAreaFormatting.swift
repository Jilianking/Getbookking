//
//  USStateServiceAreaFormatting.swift
//
//  US state list (name → abbreviation), city word capitalization, and `serviceArea` string helpers.
//

import Foundation

struct USStateRow: Identifiable, Hashable {
    let abbr: String
    let name: String
    var id: String { abbr }
}

enum USStateServiceAreaFormatting {
    /// All US states + DC, sorted by display name for menus.
    static let statesSortedByName: [USStateRow] = [
        ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"),
        ("CA", "California"), ("CO", "Colorado"), ("CT", "Connecticut"), ("DE", "Delaware"),
        ("DC", "District of Columbia"), ("FL", "Florida"), ("GA", "Georgia"), ("HI", "Hawaii"),
        ("ID", "Idaho"), ("IL", "Illinois"), ("IN", "Indiana"), ("IA", "Iowa"),
        ("KS", "Kansas"), ("KY", "Kentucky"), ("LA", "Louisiana"), ("ME", "Maine"),
        ("MD", "Maryland"), ("MA", "Massachusetts"), ("MI", "Michigan"), ("MN", "Minnesota"),
        ("MS", "Mississippi"), ("MO", "Missouri"), ("MT", "Montana"), ("NE", "Nebraska"),
        ("NV", "Nevada"), ("NH", "New Hampshire"), ("NJ", "New Jersey"), ("NM", "New Mexico"),
        ("NY", "New York"), ("NC", "North Carolina"), ("ND", "North Dakota"), ("OH", "Ohio"),
        ("OK", "Oklahoma"), ("OR", "Oregon"), ("PA", "Pennsylvania"), ("RI", "Rhode Island"),
        ("SC", "South Carolina"), ("SD", "South Dakota"), ("TN", "Tennessee"), ("TX", "Texas"),
        ("UT", "Utah"), ("VT", "Vermont"), ("VA", "Virginia"), ("WA", "Washington"),
        ("WV", "West Virginia"), ("WI", "Wisconsin"), ("WY", "Wyoming")
    ]
    .map { USStateRow(abbr: $0.0, name: $0.1) }
    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

    private static let abbrSet: Set<String> = Set(statesSortedByName.map(\.abbr))

    private static let nameToAbbr: [String: String] = {
        var map: [String: String] = [:]
        for row in statesSortedByName {
            map[row.name.lowercased()] = row.abbr
        }
        return map
    }()

    static func displayName(forAbbr abbr: String) -> String? {
        let up = abbr.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return statesSortedByName.first { $0.abbr == up }?.name
    }

    /// Whitespace-separated words: `capitalized` per segment (en-US POSIX).
    static func titleCaseWords(_ raw: String) -> String {
        let parts = raw.split { $0.isWhitespace || $0.isNewline }
        guard !parts.isEmpty else { return "" }
        let locale = Locale(identifier: "en_US_POSIX")
        return parts.map { String($0).capitalized(with: locale) }.joined(separator: " ")
    }

    /// Firestore `serviceArea`: `"City, ST"` or legacy free text.
    static func parseStoredServiceArea(_ raw: String) -> (city: String, stateAbbr: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return ("", "") }
        guard let commaIdx = t.lastIndex(of: ",") else {
            return (t, "")
        }
        let left = String(t[..<commaIdx]).trimmingCharacters(in: .whitespacesAndNewlines)
        let right = String(t[t.index(after: commaIdx)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty else { return (t, "") }

        if right.count == 2 {
            let up = right.uppercased()
            if abbrSet.contains(up) {
                return (left, up)
            }
        }
        if let abbr = nameToAbbr[right.lowercased()] {
            return (left, abbr)
        }
        return (t, "")
    }

    static func composedServiceArea(city rawCity: String, stateAbbr rawAbbr: String) -> String {
        let city = titleCaseWords(rawCity.trimmingCharacters(in: .whitespacesAndNewlines))
        let abbr = rawAbbr.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if city.isEmpty, abbr.isEmpty { return "" }
        if abbr.isEmpty { return city }
        if city.isEmpty { return abbr }
        return "\(city), \(abbr)"
    }
}
