//
//  PublicBookingSite.swift
//
//  Canonical production URLs: https://{slug}.getbookking.com/…
//

import Foundation

enum PublicBookingSite {
    static let host = "getbookking.com"
    static let httpsBase = "https://\(host)"

    /// Public home URL: `https://{slug}.getbookking.com`
    static func urlString(forSlug slug: String) -> String {
        let s = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty else { return httpsBase }
        return "https://\(s).\(host)"
    }

    static func url(forSlug slug: String) -> URL? {
        URL(string: urlString(forSlug: slug))
    }
}
