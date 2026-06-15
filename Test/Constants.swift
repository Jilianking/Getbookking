//
//  Constants.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation

struct Constants {
    struct API {
        // API URLs are loaded from SecretsManager (no hardcoded secrets)
        static var baseURL: String {
            return SecretsManager.shared.apiBaseURL
        }
        
        static var localURL: String {
            return SecretsManager.shared.localURL
        }
    }
    
    struct Database {
        // Firestore collection names (not secrets, just structure)
        static let collectionRequests = "requests"
        static let collectionClients = "clients"
        static let collectionMessages = "messages"
        static let collectionEvents = "events"
        static let collectionPromos = "promos"
    }
    
    struct App {
        static let name = "Admin App"
        static let version = "1.0.0"
    }

    /// Public origin for team invite links: `{bookingWebOrigin}/join?t=…`
    /// Uses `join.getbookking.com` so Cloudflare `*.getbookking.com` worker can proxy to Firebase without apex DNS.
    /// Add DNS: CNAME `join` → zone apex, **proxied** (orange cloud). Firebase Auth → authorized domains: `join.getbookking.com`.
    struct Hosting {
        static let bookingWebOrigin = "https://join.getbookking.com"
        /// Marketing Hosting (`web/marketing`; Firebase target `marketing`). Use `https://test-app-96812-marketing.web.app` if testing without a custom domain on apex.
        static let marketingWebOrigin = "https://getbookking.com"
        /// Public sign-up wizard (`signup.html`).
        static var marketingSignUpURL: String { "\(marketingWebOrigin)/signup.html" }
        /// Account login (`login.html`).
        static var marketingLoginURL: String { "\(marketingWebOrigin)/login.html" }
        /// Password reset page (`forgot-password.html`).
        static var marketingForgotPasswordPageURL: String { "\(marketingWebOrigin)/forgot-password.html" }
        /// Live showcase tenant sites (`demos.html`).
        static var marketingDemosURL: String { "\(marketingWebOrigin)/demos.html" }
        static var marketingPrivacyURL: String { "\(marketingWebOrigin)/privacy.html" }
        static var marketingTermsURL: String { "\(marketingWebOrigin)/terms.html" }

        /// Opens web forgot-password with optional email prefill from the iOS app.
        static func marketingForgotPasswordURL(email: String) -> URL? {
            var components = URLComponents(string: marketingForgotPasswordPageURL)
            let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                components?.queryItems = [URLQueryItem(name: "email", value: trimmed)]
            }
            return components?.url
        }
    }

    /// Region for callable Cloud Functions (must match `firebase functions:log` / console and `web/join.html`).
    struct Firebase {
        static let cloudFunctionsRegion = "us-central1"
    }
}

