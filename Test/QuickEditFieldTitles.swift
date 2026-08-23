//
//  QuickEditFieldTitles.swift
//
//  Human-readable labels for `data-edit-key` fields in preview quick edit.
//

import Foundation

enum QuickEditFieldTitles {
    static func title(for key: String) -> String {
        if key == "displayName" || key.hasPrefix("displayName.") {
            return "Name on website"
        }
        if key.hasPrefix("wc.tm.") {
            let parts = key.split(separator: ".").map(String.init)
            if let field = parts.last {
                switch field {
                case "name": return "Name on website"
                case "role": return "Title on website"
                case "bio": return "Bio on website"
                case "bookLabel": return "Book with CTA"
                case "workTitle": return "Portfolio heading"
                default: break
                }
            }
        }
        if key.hasPrefix("tm:") {
            let parts = key.split(separator: ":").map(String.init)
            if parts.count == 3 {
                switch parts[2] {
                case "name": return "Name on website"
                case "role": return "Title on website"
                case "bio": return "Bio on website"
                case "bookLabel": return "Book with CTA"
                case "workTitle": return "Portfolio heading"
                case "photo": return "Profile photo"
                default: break
                }
            }
        }
        switch key {
        case "luxeHeroTagline": return "Hero line"
        case "bladeHeroTagline": return "Hero headline"
        case "bladeHeroDescription": return "Hero description"
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
        case "heroSubtitle": return "Hero description"
        case "serviceArea": return "Service area"
        case "aboutText": return "About text"
        case "studio12HeroEyebrow": return "Hero eyebrow"
        case "studio12HeroLine1": return "Hero headline (line 1)"
        case "studio12HeroLine2": return "Hero headline (line 2)"
        case "studio12BookCtaLine1": return "Booking headline"
        case "studio12BookCtaItalic": return "Booking headline accent"
        case "studio12BookCtaBody": return "Booking section text"
        case "studio12PhilosophyHeadLine1": return "Philosophy headline (line 1)"
        case "studio12PhilosophyHeadLine2": return "Philosophy headline (line 2)"
        case "studio12PhilosophyHeadItalic": return "Philosophy headline (accent)"
        case "heroImage": return "Hero image"
        case "classicAboutImage": return "About photo"
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
            if key.hasPrefix("charterFaq:") {
                let parts = key.split(separator: ":").map(String.init)
                if parts.count == 3, parts[2] == "edit" { return "Edit FAQ" }
                if parts.count == 3, parts[2] == "question" { return "FAQ question" }
                if parts.count == 3, parts[2] == "answer" { return "FAQ answer" }
                return "FAQ"
            }
            if key == "charterQuote:edit" { return "Client quote" }
            if key.hasPrefix("svc:") {
                let parts = key.split(separator: ":").map(String.init)
                if parts.count == 3, parts[2] == "edit" { return "Edit service" }
                if parts.count == 3, parts[2] == "name" { return "Service name" }
                if parts.count == 3, parts[2] == "description" { return "Service description" }
                return "Service"
            }
            if key.hasPrefix("wc.contact.") {
                let tail = String(key.dropFirst("wc.contact.".count))
                switch tail {
                case "phone": return "Phone (website only)"
                case "email": return "Email (website only)"
                case "hours": return "Hours (website only)"
                case "address": return "Address (website only)"
                case "location": return "Location (website only)"
                case "serviceArea": return "City / area (website only)"
                case "whereHead": return "Location headline (website only)"
                case "instagram": return "Instagram (website only)"
                default: return "Contact: \(tail)"
                }
            }
            if key.hasPrefix("wc.svc.") {
                let tail = String(key.dropFirst("wc.svc.".count))
                if tail.hasSuffix(".name") { return "Service name (website only)" }
                if tail.hasSuffix(".description") { return "Service description (website only)" }
                if tail.hasSuffix(".price") { return "Service price (website only)" }
                if tail.hasSuffix(".duration") { return "Service duration (website only)" }
                if tail.hasSuffix(".details") { return "Service details link (website only)" }
                return "Service text (website only)"
            }
            if key == "wc.classic.heroTag" || key == "wc.classic.heroTagline" { return "Hero tagline (website only)" }
            if key == "wc.classic.aboutBio" { return "About bio (website only)" }
            if key == "wc.luxe.promoTag" { return "Promo line (website only)" }
            if key == "wc.luxe.teamBio" { return "Team bio (website only)" }
            if key == "wc.s12.heroLead" || key == "wc.s12.navSub" { return "Hero intro (website only)" }
            if key == "wc.charter.heroEyebrow" { return "Hero location line" }
            if key == "wc.charter.featuredLabel" { return "Featured section label" }
            if key == "wc.charter.featuredHeading" { return "Featured section heading" }
            if key == "wc.charter.viewAll" { return "Featured view all link" }
            if key == "wc.charter.browseMonth" { return "Month picker button" }
            if key == "wc.charter.browseChipDate" { return "Browse date chip" }
            if key == "wc.charter.browseChipType" { return "Browse trip type chip" }
            if key == "wc.charter.browseChipDuration" { return "Browse duration chip" }
            if key == "wc.charter.browseChipPeople" { return "Browse party size chip" }
            if key == "wc.charter.browseChipBoat" { return "Browse boat chip" }
            if key == "wc.charter.browsePartyTooLarge" { return "Browse party too large message" }
            if key == "wc.charter.browseShowCharters" { return "Month sheet apply button" }
            if key == "wc.charter.browseBookTrip" { return "Browse book CTA" }
            if key == "wc.charter.captainName" { return "Captain name (website only)" }
            if key == "wc.charter.quote" { return "Quote" }
            if key == "wc.charter.quoteBy" { return "Quote attribution" }
            if key.hasPrefix("wc.") {
                let tail = String(key.dropFirst(3)).replacingOccurrences(of: ".", with: " → ")
                return "Site text: \(tail)"
            }
            return "Page text"
        }
    }
}
