//
//  TenantService.swift
//
//  Model for services in tenants/{tenantId}/services.
//

import Foundation

struct TenantService: Identifiable {
    var id: String
    var slug: String
    var name: String
    /// When `nil`, no duration is stored (Classic “+” panel and optional booking hints stay empty).
    var durationMinutes: Int?
    /// Shown on Blade service cards and anywhere the web reads `description`.
    var description: String?
    /// Blade / web display order (`sortOrder` in Firestore). Lower values appear first (01, 02, …).
    var sortOrder: Int
    /// If non-nil and > 0, Blade shows “From $X”; otherwise “Book for pricing”.
    var price: Double?
    var isActive: Bool
    var bookingModeOverride: String?
    var formSchema: [[String: Any]]?
    /// Charter trip timeline. `offsetMinutes` is relative to departure (0 = leave the dock).
    var itinerary: [CharterItineraryStep] = []
    /// Distinguishes an intentionally empty itinerary from an older trip that has never configured one.
    var hasConfiguredItinerary: Bool = false
    /// Fleet boats this trip can run on (`tenants.charterBoats[].id`).
    var boatIds: [String] = []
    /// Optional service-specific photo. Empty preserves the public site's legacy featured-work fallback.
    var imageUrl: String = ""

    static func parseBoatIds(_ d: [String: Any]) -> [String] {
        var ids: [String] = []
        if let arr = d["boatIds"] as? [String] {
            ids = arr
        } else if let arr = d["boatIds"] as? [Any] {
            ids = arr.compactMap { $0 as? String }
        }
        ids = ids.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if ids.isEmpty {
            let one = (d["boatId"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !one.isEmpty { ids = [one] }
        }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

struct CharterItineraryStep: Identifiable, Equatable, Hashable {
    var id: UUID
    var offsetMinutes: Int
    var text: String

    init(id: UUID = UUID(), offsetMinutes: Int, text: String) {
        self.id = id
        self.offsetMinutes = offsetMinutes
        self.text = text
    }

    static func defaults(durationMinutes: Int) -> [CharterItineraryStep] {
        let dur = max(60, durationMinutes)
        let mid = max(30, (dur / 2 / 15) * 15)
        return [
            CharterItineraryStep(offsetMinutes: -30, text: "Meet at the marina, gear briefing"),
            CharterItineraryStep(offsetMinutes: 0, text: "Depart"),
            CharterItineraryStep(offsetMinutes: mid, text: "On the water"),
            CharterItineraryStep(offsetMinutes: dur, text: "Return to dock")
        ]
    }

    static func fromFirestore(_ raw: Any?) -> [CharterItineraryStep] {
        let rows: [[String: Any]]
        if let arr = raw as? [[String: Any]] {
            rows = arr
        } else if let arr = raw as? [Any] {
            rows = arr.compactMap { $0 as? [String: Any] }
        } else {
            return []
        }
        return rows.compactMap { m in
            let text = (m["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { return nil }
            let off: Int
            if let n = m["offsetMinutes"] as? Int {
                off = n
            } else if let n = m["offsetMinutes"] as? Double {
                off = Int(n)
            } else {
                off = 0
            }
            return CharterItineraryStep(offsetMinutes: off, text: text)
        }
    }

    var firestoreDict: [String: Any] {
        ["offsetMinutes": offsetMinutes, "text": text]
    }

    var offsetCaption: String {
        if offsetMinutes == 0 { return "Departure" }
        if offsetMinutes < 0 { return "\(abs(offsetMinutes)) min before departure" }
        let h = offsetMinutes / 60
        let m = offsetMinutes % 60
        if h > 0 && m == 0 { return "\(h) hr after departure" }
        if h > 0 { return "\(h) hr \(m) min after departure" }
        return "\(offsetMinutes) min after departure"
    }
}

extension TenantService {
    var bladePriceCaption: String {
        if let p = price, p > 0 {
            if p.rounded() == p {
                return "From $\(Int(p))"
            }
            return String(format: "From $%.2f", p)
        }
        return "Book for pricing"
    }

    /// Website trip cards use `imageUrl`, then `photoUrl`, then featured/gallery by index.
    func resolvedImageURL(fallbackImages: [String], index: Int) -> String {
        let own = imageUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !own.isEmpty { return own }
        guard fallbackImages.indices.contains(index) else { return "" }
        return fallbackImages[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Parses Firestore image arrays as strings or `{ url }` maps, keeping empty slots for index alignment.
    static func parseImageURLList(_ raw: Any?) -> [String] {
        let items: [Any]
        if let arr = raw as? [String] {
            return arr.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        } else if let arr = raw as? [Any] {
            items = arr
        } else {
            return []
        }
        return items.map { item in
            if let s = item as? String {
                return s.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let dict = item as? [String: Any] {
                let u = (dict["url"] as? String)
                    ?? (dict["imageUrl"] as? String)
                    ?? ""
                return u.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return ""
        }
    }
}
