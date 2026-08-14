//
//  CharterBoat.swift
//
//  Fleet boats for the fishing charter plan (Settings → Business settings → Boats).
//

import Foundation

struct CharterBoat: Identifiable, Equatable, Hashable {
    var id: String
    var boatType: String
    var maxPeople: Int
    var imageUrl: String

    var displayName: String {
        let t = boatType.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Boat" : t
    }

    var capacityLabel: String {
        maxPeople == 1 ? "1 person" : "\(maxPeople) people"
    }

    func toFirestore() -> [String: Any] {
        [
            "id": id,
            "boatType": boatType,
            "maxPeople": max(1, maxPeople),
            "imageUrl": imageUrl,
        ]
    }

    static func parseList(_ raw: Any?) -> [CharterBoat] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { parse($0) }
    }

    static func parse(_ d: [String: Any]) -> CharterBoat? {
        let id = (d["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }
        let type = (d["boatType"] as? String ?? d["type"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let people: Int = {
            if let n = d["maxPeople"] as? Int { return n }
            if let n = d["maxPeople"] as? Double { return Int(n) }
            return 6
        }()
        return CharterBoat(
            id: id,
            boatType: type,
            maxPeople: max(1, min(people, 50)),
            imageUrl: (d["imageUrl"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}
