//
//  APIService.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation

class APIService {
    static let shared = APIService()
    
    // Load from Constants (which gets values from SecretsManager)
    // No hardcoded URLs - all configuration is in Secrets.plist
    private var baseURL: String {
        return Constants.API.baseURL
    }
    
    private init() {}
    
    func login(password: String) async throws -> Bool {
        let url = URL(string: "\(baseURL)/admin/login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["password": password]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "APIService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
        }
        
        guard httpResponse.statusCode == 200 else {
            return false
        }
        
        // Extract session token from response headers/cookies
        if let cookies = HTTPCookieStorage.shared.cookies(for: url) {
            for cookie in cookies where cookie.name == "admin-session" {
                UserDefaults.standard.set(cookie.value, forKey: "adminSessionToken")
                return true
            }
        }
        
        // Also check response body for token
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["token"] as? String {
            UserDefaults.standard.set(token, forKey: "adminSessionToken")
            return true
        }
        
        return false
    }
    
    func logout() async {
        let url = URL(string: "\(baseURL)/admin/logout")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        
        if let token = UserDefaults.standard.string(forKey: "adminSessionToken") {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        _ = try? await URLSession.shared.data(for: request)
    }
    
    func submitBooking(_ bookingData: [String: Any]) async throws -> Bool {
        let url = URL(string: "\(baseURL)/book")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: bookingData)
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            return false
        }
        
        return httpResponse.statusCode == 200
    }
    
    func fetchRequests() async throws -> [String: Any] {
        let url = URL(string: "\(baseURL)/admin/requests")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        
        if let token = UserDefaults.standard.string(forKey: "adminSessionToken") {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw NSError(domain: "APIService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to fetch requests"])
        }
        
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "APIService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response format"])
        }
        
        return json
    }
}

