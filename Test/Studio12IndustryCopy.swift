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

    // MARK: Hero (eyebrow + headline split on site + italic `<em>`)

    static func heroEyebrow(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "Colour · Cut · Care"
        case .barber: return "Cuts · Fades · Detail"
        case .tattoos: return "Design · Ink · Detail"
        case .nails: return "Color · Care · Finish"
        case .custom: return "Book · Visit · Connect"
        }
    }

    /// One line before the italic hero word; site splits into two lines (`… that …` or balanced at a space).
    static func heroHeadlinePlaceholder(for t: BookingTemplate) -> String {
        switch t {
        case .hair: return "Hair that reflects"
        case .barber: return "Cuts that define"
        case .tattoos: return "Ink that tells"
        case .nails: return "Nails that elevate"
        case .custom: return "Work that reflects"
        }
    }

    /// Middle-dot separator for multi-part single lines in the Studio 12 editor.
    static let studio12PartSeparator = " · "

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

    /// Single editor line: main headline · italic ending (split on the **last** ` · `). Matches `joinBookCtaHeadline` / book CTA pattern.
    static func joinHeroTitleEditorLine(headline: String, italic: String) -> String {
        joinBookCtaHeadline(line1: headline, italic: italic)
    }

    static func splitHeroTitleEditorLine(_ raw: String) -> (headline: String, italic: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return ("", "") }
        guard let r = s.range(of: studio12PartSeparator, options: .backwards) else {
            return (s, "")
        }
        let headline = String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let italic = String(s[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (headline, italic)
    }

    /// Prompt for the combined hero title field in the app.
    static func heroTitleEditorPlaceholder(for t: BookingTemplate) -> String {
        joinHeroTitleEditorLine(headline: heroHeadlinePlaceholder(for: t), italic: heroItalicPlaceholder(for: t))
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

    /// Three-part philosophy `<h2>`: line1 · line2 · italic.
    static func philosophyHeadlinePlaceholder(for t: BookingTemplate) -> String {
        [philosophyLine1Placeholder(for: t), philosophyLine2Placeholder(for: t), philosophyItalicPlaceholder(for: t)]
            .joined(separator: studio12PartSeparator)
    }

    static func joinPhilosophyHeadline(line1: String, line2: String, italic: String) -> String {
        [line1, line2, italic].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: studio12PartSeparator)
    }

    static func splitPhilosophyHeadline(_ raw: String) -> (String, String, String) {
        let p = splitMiddleDotParts(raw, count: 3)
        return (p[0], p[1], p[2])
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

    /// CTA `<h2>`: line before italic · italic part.
    static func bookCtaHeadlinePlaceholder(for t: BookingTemplate) -> String {
        [bookCtaLine1Placeholder(for: t), bookCtaItalicPlaceholder(for: t)]
            .joined(separator: studio12PartSeparator)
    }

    static func joinBookCtaHeadline(line1: String, italic: String) -> String {
        [line1, italic].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: studio12PartSeparator)
    }

    static func splitBookCtaHeadline(_ raw: String) -> (String, String) {
        let p = splitMiddleDotParts(raw, count: 2)
        return (p[0], p[1])
    }

    static func joinProcessStepLine(title: String, body: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty, b.isEmpty { return "" }
        return t + studio12PartSeparator + b
    }

    static func splitProcessStepLine(_ raw: String) -> (title: String, body: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = s.range(of: studio12PartSeparator) else {
            return (s, "")
        }
        let title = String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let body = String(s[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (title, body)
    }

    private static func splitMiddleDotParts(_ raw: String, count: Int) -> [String] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Array(repeating: "", count: count) }
        var parts = trimmed.components(separatedBy: studio12PartSeparator)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        while parts.count < count { parts.append("") }
        if parts.count > count {
            let tail = parts[(count - 1)...].joined(separator: studio12PartSeparator)
            parts = Array(parts.prefix(count - 1)) + [tail]
        }
        return parts
    }

    static func processStepLinePlaceholder(step: Studio12ProcessStep) -> String {
        joinProcessStepLine(title: step.title, body: step.body)
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
