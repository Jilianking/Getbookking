//
//  PublicBookingSite.swift
//
//  Canonical production URLs: https://{slug}.getbookking.com/…
//  When a Bookking-managed custom domain is active on the tenant, prefer that apex.
//

import Foundation

enum PublicBookingSite {
    static let host = "getbookking.com"
    static let httpsBase = "https://\(host)"

    /// Public home URL. Pass `customDomain` when tenant.customDomainStatus == "active".
    static func urlString(forSlug slug: String, customDomain: String? = nil) -> String {
        let s = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty else { return httpsBase }
        let custom = (customDomain ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
            .replacingOccurrences(of: "/.*$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
        if !custom.isEmpty {
            return "https://\(custom)"
        }
        return "https://\(s).\(host)"
    }

    static func url(forSlug slug: String, customDomain: String? = nil) -> URL? {
        URL(string: urlString(forSlug: slug, customDomain: customDomain))
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

    /// Public book URL with artist pre-selected.
    static func memberBookURLString(
        tenantSlug: String,
        memberSlug: String,
        customDomain: String? = nil
    ) -> String {
        let tenant = tenantSlug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let bookPath = memberBookPath(memberSlug: memberSlug)
        guard !tenant.isEmpty else { return "" }
        return urlString(forSlug: tenant, customDomain: customDomain) + bookPath
    }

    /// Active custom domain from a tenant Firestore dictionary, if connected.
    static func activeCustomDomain(fromTenant tenant: [String: Any]?) -> String? {
        guard let tenant else { return nil }
        let status = (tenant["customDomainStatus"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard status == "active" else { return nil }
        let domain = (tenant["customDomain"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return domain.isEmpty ? nil : domain
    }
}
