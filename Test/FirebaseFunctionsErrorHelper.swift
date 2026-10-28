//
//  FirebaseFunctionsErrorHelper.swift
//
//  Readable messages from Firebase httpsCallable / HttpsError (avoids showing only "INTERNAL").
//

import Foundation
import FirebaseFunctions

enum FirebaseFunctionsErrorHelper {
    static func message(from error: Error, fallback: String = "Something went wrong. Please try again.") -> String {
        let ns = error as NSError
        if ns.domain == FunctionsErrorDomain {
            let code = FunctionsErrorCode(rawValue: ns.code)
            let details = ns.userInfo[FunctionsErrorDetailsKey]
            if let detailString = details as? String, !detailString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return detailString.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let detailDict = details as? [String: Any],
               let nested = detailDict["message"] as? String,
               !nested.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return nested.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let fnMessage = ns.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if !fnMessage.isEmpty, fnMessage.uppercased() != "INTERNAL", fnMessage != ns.userInfo["code"] as? String {
                return fnMessage
            }
            switch code {
            case .unauthenticated:
                return "You must be signed in to continue."
            case .permissionDenied:
                return "You don't have permission to do that."
            case .notFound:
                return "This isn't available right now. Please try again later."
            case .failedPrecondition:
                return fnMessage.isEmpty || fnMessage.uppercased() == "INTERNAL"
                    ? "This isn't ready yet. Please try again in a moment."
                    : fnMessage
            case .internal:
                return "Something went wrong on our end. Please try again in a moment."
            case .unavailable:
                return "Service temporarily unavailable. Try again in a moment."
            case .deadlineExceeded:
                return "Request timed out. Try again."
            default:
                break
            }
        }
        let localized = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if localized.isEmpty || localized.uppercased() == "INTERNAL" {
            return fallback
        }
        return localized
    }
}
