//
//  Studio12IndustryCopy.swift
//
//  Industry-specific defaults for Studio 12 (`studio-12-v1`). Kept in sync with `studio12IndustryBundle` in web/index.html.
//

import Foundation

enum Studio12IndustryCopy {
    static func template(from industry: String?) -> BookingTemplate {
        let r = industry?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return BookingTemplate(rawValue: r) ?? .custom
    }

    // MARK: Hero (eyebrow + two lines before italic)

    static func heroEyebrow(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "Colour · Cut · Care"
        case .barber: return "Cuts · Fades · Detail"
        case .tattoos: return "Design · Ink · Detail"
        case .nails: return "Color · Care · Finish"
        case .custom: return "Book · Visit · Connect"
        }
    }

    static func heroLine1(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "Hair that"
        case .barber: return "Cuts that"
        case .tattoos: return "Ink that"
        case .nails: return "Nails that"
        case .custom: return "Work that"
        }
    }

    static func heroLine2(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "reflects"
        case .barber: return "define"
        case .tattoos: return "tells"
        case .nails: return "elevate"
        case .custom: return "reflects"
        }
    }

    /// Suggested italic ending when the field is empty (web uses same as default before `heroTagline`).
    static func heroItalicPlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "story."
        case .barber: return "you."
        case .tattoos: return "your story."
        case .nails: return "every day."
        case .custom: return "you."
        }
    }

    /// Hint for hero intro / tagline when empty on site.
    static func heroIntroPlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair:
            return "A boutique studio dedicated to the art of hair — bespoke colour, precision cuts, and restorative care."
        case .barber:
            return "Sharp fades, clean lines, and consistent results — every chair, every visit."
        case .tattoos:
            return "Custom work, clean execution, and a calm studio experience from idea to healed piece."
        case .nails:
            return "Clean finishes, thoughtful details, and sets built to last — book your next appointment."
        case .custom:
            return "Professional service, thoughtful communication, and a smooth booking experience."
        }
    }

    // MARK: Philosophy headline (three parts)

    static func philosophyLine1Placeholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "Hair is more than"
        case .barber: return "Precision is more than"
        case .tattoos: return "Art is more than"
        case .nails: return "Polish is more than"
        case .custom: return "Quality is more than"
        }
    }

    static func philosophyLine2Placeholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "style."
        case .barber: return "a fade."
        case .tattoos: return "ink on skin."
        case .nails: return "color."
        case .custom: return "a checklist."
        }
    }

    static func philosophyItalicPlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "It's you."
        case .barber: return "It's confidence."
        case .tattoos: return "It's permanence with intention."
        case .nails: return "It's the details."
        case .custom: return "It's consistency."
        }
    }

    // MARK: Book CTA

    static func bookCtaLine1Placeholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair, .barber, .nails: return "Ready for your"
        case .tattoos: return "Ready for your"
        case .custom: return "Ready to"
        }
    }

    static func bookCtaItalicPlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "next look?"
        case .barber: return "next cut?"
        case .tattoos: return "next piece?"
        case .nails: return "next set?"
        case .custom: return "book?"
        }
    }

    static func bookCtaBodyPlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .tattoos:
            return "Book online to start your request. We'll confirm timing and follow up with next steps."
        default:
            return "Book online in minutes. We'll confirm your slot and follow up with everything you need."
        }
    }

    /// Default process steps when Firestore has none (per industry).
    static func processSteps(for t: BookingTemplate) -> [Studio12ProcessStep] {
        switch t {
        case .hair:
            return [
                Studio12ProcessStep(id: 0, title: "Book online", body: "Choose your service and send a request. We'll confirm your appointment."),
                Studio12ProcessStep(id: 1, title: "Consultation", body: "We listen to your goals and recommend the right approach."),
                Studio12ProcessStep(id: 2, title: "The service", body: "Expert care in a calm, welcoming environment."),
                Studio12ProcessStep(id: 3, title: "Aftercare", body: "Tips and product guidance so your look lasts.")
            ]
        case .barber:
            return [
                Studio12ProcessStep(id: 0, title: "Book online", body: "Choose your service and send a request. We'll confirm your appointment."),
                Studio12ProcessStep(id: 1, title: "Consultation", body: "We align on style, length, and the details that matter to you."),
                Studio12ProcessStep(id: 2, title: "The cut", body: "Clean execution with attention to line, blend, and finish."),
                Studio12ProcessStep(id: 3, title: "Aftercare", body: "Product tips and timing so your cut stays sharp.")
            ]
        case .tattoos:
            return [
                Studio12ProcessStep(id: 0, title: "Book online", body: "Send a request with timing and ideas. We'll follow up to plan next steps."),
                Studio12ProcessStep(id: 1, title: "Design", body: "We refine placement, size, and style before your appointment."),
                Studio12ProcessStep(id: 2, title: "The session", body: "Professional application in a clean, focused environment."),
                Studio12ProcessStep(id: 3, title: "Healing", body: "Aftercare guidance so your tattoo heals clean and stays bold.")
            ]
        case .nails:
            return [
                Studio12ProcessStep(id: 0, title: "Book online", body: "Choose your service and send a request. We'll confirm your appointment."),
                Studio12ProcessStep(id: 1, title: "Consultation", body: "We confirm shape, length, color, and any nail-art details."),
                Studio12ProcessStep(id: 2, title: "The service", body: "Careful prep and application for a clean, lasting finish."),
                Studio12ProcessStep(id: 3, title: "Aftercare", body: "Home care tips so your set stays fresh longer.")
            ]
        case .custom:
            return [
                Studio12ProcessStep(id: 0, title: "Book online", body: "Choose your service and send a request. We'll confirm your appointment."),
                Studio12ProcessStep(id: 1, title: "Consultation", body: "We clarify scope, timing, and what to expect."),
                Studio12ProcessStep(id: 2, title: "The service", body: "Focused work with clear communication throughout."),
                Studio12ProcessStep(id: 3, title: "Follow-up", body: "Clear next steps and guidance after your appointment.")
            ]
        }
    }
}
