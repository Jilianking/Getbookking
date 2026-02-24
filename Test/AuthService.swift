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
                } else if !self.isDemoMode {
                    self.isAuthenticated = false
                    self.currentUserEmail = nil
                    self.currentUserDisplayName = nil
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
    }

    /// Demo mode: full app experience without Firebase sign-in.
    func demoLogin() {
        isDemoMode = true
        isAuthenticated = true
        currentUserEmail = "demo@example.com"
        currentUserDisplayName = "Demo Provider"
    }
}
