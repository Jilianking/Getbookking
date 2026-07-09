//
//  TapToPayEligibility.swift
//  Device / OS checks for Tap to Pay on iPhone (Apple 4.1).
//

#if TAP_TO_PAY_ENABLED

import Foundation
import StripeTerminal
import UIKit

enum TapToPayEligibility {
    /// User-visible blocker, if any.
    static func blockingMessage() -> String? {
        if UIDevice.current.userInterfaceIdiom != .phone {
            return "Tap to Pay on iPhone is only available on iPhone."
        }
        if ProcessInfo.processInfo.isiOSAppOnMac {
            return "Tap to Pay is not available on Mac."
        }
        if let osMessage = iosVersionMessage() {
            return osMessage
        }
        return nil
    }

    /// Call after `Terminal` is initialized.
    static func deviceSupportsTapToPay() -> String? {
        do {
            let config = try TapToPayDiscoveryConfigurationBuilder().build()
            switch Terminal.shared.supportsReaders(
                of: .tapToPay,
                discoveryMethod: config.discoveryMethod,
                simulated: false
            ) {
            case .success:
                return nil
            case .failure(let error):
                return TapToPayErrorMapper.userMessage(for: error)
            }
        } catch {
            return error.localizedDescription
        }
    }

    private static func iosVersionMessage() -> String? {
        // Apple: full Tap to Pay on 17.6+; advise update for earlier 17.x when deployment target allows it.
        if #available(iOS 17.6, *) {
            return nil
        }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        if version.majorVersion == 17 {
            return "Update to iOS 17.6 or later to use Tap to Pay on this iPhone."
        }
        return nil
    }
}

enum TapToPayErrorMapper {
    /// Stripe Terminal `SCPErrorAlreadyConnectedToReader` (1110).
    static func isAlreadyConnectedToReader(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.code == 1110 { return true }
        let combined = "\(ns.domain) \(ns.code) \(ns.localizedDescription)".lowercased()
        return combined.contains("alreadyconnectedtoreader")
            || combined.contains("already connected to a reader")
            || combined.contains("already using a reader")
    }

    static func userMessage(for error: Error) -> String {
        let ns = error as NSError
        if isAlreadyConnectedToReader(error) {
            return "Tap to Pay is still connecting. Wait a moment and try again."
        }
        let combined = "\(ns.domain) \(ns.code) \(ns.localizedDescription)".lowercased()
        if combined.contains("osversionnotsupported") || combined.contains("os_version_not_supported") {
            return "Update iOS to the latest version to use Tap to Pay."
        }
        if combined.contains("simulator") {
            return "Tap to Pay requires a physical iPhone XS or later."
        }
        // Apple req 5.9: "timed out" must be a named outcome distinct from declined/failed.
        if combined.contains("collectiontimeout")
            || combined.contains("collection timeout")
            || combined.contains("scperrorcollectiontimeout")
            || (combined.contains("timeout") && !combined.contains("request timed out"))
            || ns.code == 2107  // SCPErrorCollectionTimeout
        {
            return "Payment timed out. Ask the customer to tap their card or wallet again."
        }
        return ns.localizedDescription
    }
}

#endif
