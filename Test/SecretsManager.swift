//
//  SecretsManager.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation

class SecretsManager {
    static let shared = SecretsManager()
    
    private var secrets: [String: Any] = [:]
    
    private init() {
        loadSecrets()
    }
    
    private func loadSecrets() {
        // Try to load from Secrets.plist (not committed to git)
        if let path = Bundle.main.path(forResource: "Secrets", ofType: "plist"),
           let plist = NSDictionary(contentsOfFile: path) as? [String: Any] {
            secrets = plist
            return
        }
        
        // Fallback: Try Info.plist
        if let path = Bundle.main.path(forResource: "Info", ofType: "plist"),
           let plist = NSDictionary(contentsOfFile: path) as? [String: Any] {
            secrets = plist
            return
        }
        
        print("⚠️ Warning: No Secrets.plist found. Using default/placeholder values.")
    }
    
    // MARK: - API URLs
    var apiBaseURL: String {
        #if DEBUG
        return secrets["API_BASE_URL_DEBUG"] as? String ?? "http://localhost:3000/api"
        #else
        return secrets["API_BASE_URL"] as? String ?? ""
        #endif
    }
    
    var localURL: String {
        return secrets["API_LOCAL_URL"] as? String ?? "http://localhost:3000/api"
    }
    
    // MARK: - Stripe Configuration (if needed)
    var stripePublishableKey: String {
        return secrets["STRIPE_PUBLISHABLE_KEY"] as? String ?? ""
    }

    // MARK: - Stripe Terminal (Tap to Pay on iPhone)
    // Required by Stripe Terminal `TapToPayConnectionConfigurationBuilder(locationId:)`.
    // Add to `Secrets.plist`:
    //   TAP_TO_PAY_LOCATION_ID = tml_<id>  (optional; tenant stripeTerminalLocationId is preferred)
    var tapToPayLocationId: String {
        return secrets["TAP_TO_PAY_LOCATION_ID"] as? String ?? ""
    }
    
    // MARK: - Validation
    func validate() -> Bool {
        // Only validate critical values in production
        #if DEBUG
        return true
        #else
        return !apiBaseURL.isEmpty
        #endif
    }
}

