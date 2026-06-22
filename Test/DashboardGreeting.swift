import Foundation

enum DashboardGreeting {
    static func salutation(for date: Date = Date(), calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: date)
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

    static func firstName(from displayName: String?) -> String {
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return "" }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? trimmed
    }

    static func firstNameFromEmail(_ email: String?) -> String {
        guard let local = email?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "@")
            .first,
            !local.isEmpty else { return "" }
        let s = String(local)
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    static func headline(displayName: String?, email: String?, date: Date = Date()) -> String {
        var name = firstName(from: displayName)
        if name.isEmpty {
            name = firstNameFromEmail(email)
        }
        let greeting = salutation(for: date)
        return name.isEmpty ? greeting : "\(greeting), \(name)"
    }
}
