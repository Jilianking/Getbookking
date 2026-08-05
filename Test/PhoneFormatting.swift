//
//  PhoneFormatting.swift
//
//  US display (xxx) xxx-xxxx and normalization for booking contact fields.
//

import Foundation

enum PhoneFormatting {
    /// Digits only from a phone string.
    static func digits(from raw: String) -> String {
        raw.filter(\.isNumber)
    }

    /// Format for display or storage when possible; matches public web `normalizePhone`.
    static func displayUS(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }

        let hasPlus = trimmed.hasPrefix("+")
        let d = digits(from: trimmed)
        guard !d.isEmpty else { return trimmed }

        if d.count == 10 {
            return formatUS10(d)
        }
        if d.count == 11, d.first == "1" {
            return formatUS10(String(d.dropFirst()))
        }
        if hasPlus, d.count >= 7 {
            return "+\(d)"
        }
        if d.count >= 7 {
            return "+\(d)"
        }
        return d
    }

    /// Normalized value for Firestore; nil when empty after trim.
    static func normalizedForStorage(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return displayUS(trimmed)
    }

    /// US E.164 for Twilio SMS thread ids (`+1…`); matches Cloud Functions `toE164US`.
    static func e164US(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hasPlus = trimmed.hasPrefix("+")
        let d = digits(from: trimmed)
        guard !d.isEmpty else { return nil }
        if d.count == 10 { return "+1\(d)" }
        if d.count == 11, d.first == "1" { return "+\(d)" }
        if hasPlus, d.count >= 7 { return "+\(d)" }
        if d.count >= 7 { return "+\(d)" }
        return nil
    }

    /// Thread id for SMS collections; prefers E.164, falls back to trimmed input.
    /// Line-scoped ids (`l{lineDigits}_c{clientDigits}`) must pass through unchanged.
    static func smsThreadId(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLineScopedThreadId(trimmed) { return trimmed }
        return e164US(trimmed) ?? trimmed
    }

    static func isLineScopedThreadId(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("l"), trimmed.contains("_c") else { return false }
        let parts = trimmed.split(separator: "_", maxSplits: 1)
        guard parts.count == 2,
              parts[0].dropFirst().allSatisfy(\.isNumber),
              parts[1].hasPrefix("c"),
              parts[1].dropFirst().allSatisfy(\.isNumber) else { return false }
        return true
    }

    /// Build personal-line conversation id matching Cloud Functions `lineScopedThreadId`.
    static func lineScopedThreadId(linePhone: String, clientPhone: String) -> String? {
        guard let line = e164US(linePhone), let client = e164US(clientPhone) else { return nil }
        let lineDigits = digits(from: line)
        let clientDigits = digits(from: client)
        guard !lineDigits.isEmpty, !clientDigits.isEmpty else { return nil }
        return "l\(lineDigits)_c\(clientDigits)"
    }

    static func clientPhoneFromThreadId(_ threadId: String) -> String? {
        let trimmed = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        if isLineScopedThreadId(trimmed),
           let clientPart = trimmed.split(separator: "_").last,
           clientPart.hasPrefix("c") {
            return e164US(String(clientPart.dropFirst()))
        }
        return e164US(trimmed)
    }

    /// Incremental US mask while typing (max 10 digits): (555) 123-4567
    static func formatAsYouType(_ input: String) -> String {
        let limited = String(digits(from: input).prefix(10))
        var result = ""
        for (i, ch) in limited.enumerated() {
            if i == 0 { result += "(" }
            if i == 3 { result += ") " }
            if i == 6 { result += "-" }
            result.append(ch)
        }
        return result
    }

    private static func formatUS10(_ d10: String) -> String {
        guard d10.count == 10 else { return d10 }
        let idx = d10.startIndex
        let a = d10[idx ..< d10.index(idx, offsetBy: 3)]
        let b = d10[d10.index(idx, offsetBy: 3) ..< d10.index(idx, offsetBy: 6)]
        let c = d10[d10.index(idx, offsetBy: 6)...]
        return "(\(a)) \(b)-\(c)"
    }
}
