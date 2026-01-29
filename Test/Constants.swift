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
}

