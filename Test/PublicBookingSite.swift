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

    /// Artist page path: `/team/{memberSlug}`
    static func memberPagePath(memberSlug: String) -> String {
        let ms = memberSlug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !ms.isEmpty else { return "" }
        return "/team/\(ms)"
    }

    /// Studio book with artist pre-selected: `/book?member={memberSlug}`
    static func memberBookPath(memberSlug: String) -> String {
        let ms = memberSlug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !ms.isEmpty else { return "/book" }
        return "/book?member=\(ms)"
    }

    /// `https://{tenant}.getbookking.com/book?member={memberSlug}`
    static func memberBookURLString(tenantSlug: String, memberSlug: String) -> String {
        let tenant = tenantSlug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let bookPath = memberBookPath(memberSlug: memberSlug)
        guard !tenant.isEmpty else { return "" }
        return "https://\(tenant).\(host)\(bookPath)"
    }
}
