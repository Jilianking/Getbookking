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
                return "This feature isn't available. Check that Cloud Functions are deployed."
            case .failedPrecondition:
                return fnMessage.isEmpty || fnMessage.uppercased() == "INTERNAL"
                    ? "Setup is incomplete. Check Stripe configuration and try again."
                    : fnMessage
            case .internal:
                return "Server error. Check Firebase Functions logs and Stripe secrets (STRIPE_SECRET_KEY), then try again."
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
