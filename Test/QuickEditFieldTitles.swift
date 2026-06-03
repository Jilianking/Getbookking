//
//  QuickEditFieldTitles.swift
//
//  Human-readable labels for `data-edit-key` fields in preview quick edit.
//

import Foundation

enum QuickEditFieldTitles {
    static func title(for key: String) -> String {
        switch key {
        case "displayName": return "Business name"
        case "tagline": return "Tagline"
        case "luxeHeroTagline": return "Hero line"
        case "bladeHeroTagline": return "Hero headline"
        case "bladeHeroDescription": return "Hero description"
        case "serviceArea": return "City / area"
        case "contactAddress": return "Street address"
        case "contactPhone": return "Phone"
        case "contactEmail": return "Email"
        case "aboutText": return "About text"
        case "classicAboutEyebrow": return "About section label"
        case "classicAboutHeading": return "About headline"
        case "classicStatYearsValue": return "Stat — years value"
        case "classicStatYearsLabel": return "Stat — years label"
        case "classicStatClientsValue": return "Stat — clients value"
        case "classicStatClientsLabel": return "Stat — clients label"
        case "classicStatRatedValue": return "Stat — rating value"
        case "classicStatRatedLabel": return "Stat — rating label"
        case "classicFeaturedWorkEyebrow": return "Featured section label"
        case "classicFeaturedWorkHeading": return "Featured section title"
        case "classicFeaturedWorkSub": return "Featured section subtext"
        case "classicFeaturedWorkEmpty": return "Featured empty-state text"
        case "wc.classic.galleryLink": return "Gallery link text"
        case "classicServicesEyebrow": return "Services section label"
        case "classicServicesHeading": return "Services section title"
        case "luxePromoHeadline": return "Promo headline"
        case "luxeFeaturedWorkEyebrow": return "Gallery section label"
        case "luxeFeaturedWorkHeading": return "Gallery section title"
        case "luxeHomeServicesEyebrow": return "Services section label"
        case "luxeHomeServicesHeading": return "Services section title"
        case "heroTagline": return "Hero accent line"
        case "studio12HeroEyebrow": return "Hero eyebrow"
        case "studio12HeroLine1": return "Hero headline (line 1)"
        case "studio12HeroLine2": return "Hero headline (line 2)"
        case "studio12BookCtaLine1": return "Booking headline"
        case "studio12BookCtaItalic": return "Booking headline accent"
        case "studio12BookCtaBody": return "Booking section text"
        case "businessHours": return "Business hours"
        case "instagramHandle": return "Instagram handle"
        case "studio12PhilosophyHeadLine1": return "Philosophy headline (line 1)"
        case "studio12PhilosophyHeadLine2": return "Philosophy headline (line 2)"
        case "studio12PhilosophyHeadItalic": return "Philosophy headline (accent)"
        case "heroImage": return "Hero image"
        case "studio12PhilosophyImage": return "Philosophy image"
        case "studio12BookCtaImage": return "Booking section image"
        default:
            if key.hasPrefix("galleryImage:") {
                return "Gallery photo"
            }
            if key.hasPrefix("featuredWork:") {
                return "Featured work"
            }
            if key.hasPrefix("s12Process:") {
                let parts = key.split(separator: ":").map(String.init)
                if parts.count == 3, parts[2] == "edit" { return "Edit step" }
                if parts.count == 3, parts[2] == "title" { return "Step title" }
                if parts.count == 3, parts[2] == "body" { return "Step description" }
                return "Process step"
            }
            if key.hasPrefix("svc:") {
                let parts = key.split(separator: ":").map(String.init)
                if parts.count == 3, parts[2] == "edit" { return "Edit service" }
                if parts.count == 3, parts[2] == "name" { return "Service name" }
                if parts.count == 3, parts[2] == "description" { return "Service description" }
                return "Service"
            }
            if key.hasPrefix("wc.") {
                let tail = String(key.dropFirst(3)).replacingOccurrences(of: ".", with: " → ")
                return "Site text: \(tail)"
            }
            return "Page text"
        }
    }
}
