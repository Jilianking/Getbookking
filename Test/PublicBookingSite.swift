//
//  PublicBookingSite.swift
//
//  Canonical production URLs: https://getbookking.com/{slug}/…
//

import Foundation

enum PublicBookingSite {
    /// Production hostname (path-based tenant sites).
    static let host = "getbookking.com"
    static let httpsBase = "https://\(host)"

    /// Public home URL: `https://getbookking.com/{slug}`
    static func urlString(forSlug slug: String) -> String {
        let s = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty else { return httpsBase }
        return "\(httpsBase)/\(s)"
    }

    static func url(forSlug slug: String) -> URL? {
        URL(string: urlString(forSlug: slug))
    }
}
