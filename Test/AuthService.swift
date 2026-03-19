//
//  AuthService.swift
//  Test
//
//  Provider auth via Firebase Auth: sign in, sign up, sign out.
//

import Foundation
import Combine
import FirebaseAuth

/// Subscription plan chosen at sign-up (stored in Firestore; payment later).
enum SubscriptionPlan: String, CaseIterable {
    case free = "free"
    case pro = "pro"
    case enterprise = "enterprise"
    
    var displayName: String { rawValue.capitalized }
    var shortDescription: String {
        switch self {
        case .free: return "Get started"
        case .pro: return "More features"
        case .enterprise: return "For teams"
        }
    }
}

@MainActor
class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var currentUserEmail: String?
    @Published var currentUserDisplayName: String?
    @Published var isDemoMode = false
    /// Cached tenant logo (Web Page Design). Prefetched on sign-in; updated via notification after uploads.
    @Published var tenantLogoUrl: String?

    private var authStateHandle: AuthStateDidChangeListenerHandle?
    private let firebaseService = FirebaseService()

    init() {
        authStateHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                guard let self = self else { return }
                if user != nil {
                    self.isAuthenticated = true
                    self.isDemoMode = false
                    self.currentUserEmail = user?.email
                    self.currentUserDisplayName = user?.displayName
                    Task { await self.refreshTenantLogoFromServer() }
                } else if !self.isDemoMode {
                    self.isAuthenticated = false
                    self.currentUserEmail = nil
                    self.currentUserDisplayName = nil
                    self.tenantLogoUrl = nil
                }
            }
        }
    }
    
    deinit {
        if let handle = authStateHandle {
            Auth.auth().removeStateDidChangeListener(handle)
        }
    }
    
    func signIn(email: String, password: String) async throws {
        _ = try await Auth.auth().signIn(withEmail: email, password: password)
    }
    
    func signUp(email: String, password: String, name: String, business: String, subscriptionPlan: SubscriptionPlan) async throws {
        let result = try await Auth.auth().createUser(withEmail: email, password: password)
        let changeRequest = result.user.createProfileChangeRequest()
        changeRequest.displayName = name
        try await changeRequest.commitChanges()
        try await firebaseService.createProviderProfile(
            uid: result.user.uid,
            email: email,
            name: name,
            business: business,
            subscriptionPlan: subscriptionPlan.rawValue
        )
    }
    
    func signOut() throws {
        try Auth.auth().signOut()
    }
    
    /// Call from UI (e.g. Settings); ignores errors.
    func logout() {
        isDemoMode = false
        try? Auth.auth().signOut()
        isAuthenticated = false
        currentUserEmail = nil
        currentUserDisplayName = nil
        tenantLogoUrl = nil
    }

    /// Demo mode: full app experience without Firebase sign-in.
    func demoLogin() {
        isDemoMode = true
        isAuthenticated = true
        currentUserEmail = "demo@example.com"
        currentUserDisplayName = "Demo Provider"
        tenantLogoUrl = nil
    }

    /// Loads `logoUrl` from Firestore (profile → tenant). Prefer `applyTenantLogoCache` when URL is already known.
    func refreshTenantLogoFromServer() async {
        if isDemoMode || !isAuthenticated {
            tenantLogoUrl = nil
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            tenantLogoUrl = nil
            return
        }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            guard let tid = profile?.tenantId else {
                tenantLogoUrl = nil
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let raw = tenant?["logoUrl"] as? String
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            tenantLogoUrl = trimmed.isEmpty ? nil : trimmed
        } catch {
            tenantLogoUrl = nil
        }
    }

    /// Update cache without a network round-trip (e.g. after logo upload in Design).
    func applyTenantLogoCache(_ url: String) {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        tenantLogoUrl = trimmed.isEmpty ? nil : trimmed
    }
}

extension Notification.Name {
    /// Posted with `userInfo["logoUrl"]` when the tenant logo changes in Firestore from this app.
    static let tenantLogoDidChange = Notification.Name("tenantLogoDidChange")
}
