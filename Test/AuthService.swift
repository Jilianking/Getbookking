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
    case solo = "solo"
    case studio = "studio"
    case shop = "shop"

    var displayName: String {
        switch self {
        case .solo: return "Solo"
        case .studio: return "Studio"
        case .shop: return "Shop"
        }
    }

    var shortDescription: String {
        switch self {
        case .solo: return "1 employee"
        case .studio: return "2–5 employees"
        case .shop: return "6+ employees"
        }
    }

    /// Solo is owner-only; team invites require Studio or Shop.
    var allowsTeamInvites: Bool {
        self != .solo
    }

    /// Solo owners use Business settings (not Team settings) in the app.
    var usesBusinessSettingsHub: Bool {
        self == .solo
    }

    /// Total members (owner + staff) allowed for this plan tier.
    var maxSeats: Int {
        switch self {
        case .solo: return 1
        case .studio: return 5
        case .shop: return 500
        }
    }

    /// Aligns with `normalizeSubscriptionPlan` in Cloud Functions / web sign-up.
    static func normalized(fromFirestore raw: String?) -> SubscriptionPlan {
        let p = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch p {
        case "basic", "solo", "free", "starter": return .solo
        case "growth", "pro": return .studio
        case "enterprise": return .shop
        case SubscriptionPlan.solo.rawValue: return .solo
        case SubscriptionPlan.studio.rawValue: return .studio
        case SubscriptionPlan.shop.rawValue: return .shop
        default: return .solo
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
    /// Firebase Auth profile photo (fallback when tenant logo is unset).
    @Published var accountPhotoUrl: String?
    /// Team role + manager toggles + tenant booking policy (from `getMyTeamAccess`).
    @Published var teamAccess: EffectiveTeamAccess = .ownerFullAccess
    @Published var tenantSubscriptionPlan: SubscriptionPlan = .solo

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
                    self.accountPhotoUrl = user?.photoURL?.absoluteString
                    PushNotificationManager.shared.syncTokenAfterSignIn()
                    await self.refreshTenantLogoFromServer()
                    await self.refreshTeamAccess()
                } else if !self.isDemoMode {
                    self.isAuthenticated = false
                    self.currentUserEmail = nil
                    self.currentUserDisplayName = nil
                    self.tenantLogoUrl = nil
                    self.accountPhotoUrl = nil
                    self.teamAccess = EffectiveTeamAccess()
                    self.tenantSubscriptionPlan = .solo
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
        PushNotificationManager.shared.syncTokenAfterSignIn()
    }

    /// Sends Firebase password reset email (login screen and Settings → Change password).
    func sendPasswordReset(email: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(
                domain: "AuthViewModel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Enter your email address first."]
            )
        }
        try await Auth.auth().sendPasswordReset(withEmail: trimmed)
    }

    /// Required before sensitive actions such as account deletion.
    func reauthenticate(password: String) async throws {
        guard let user = Auth.auth().currentUser else {
            throw NSError(
                domain: "AuthViewModel",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "You are not signed in."]
            )
        }
        guard let email = currentUserEmail?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty else {
            throw NSError(
                domain: "AuthViewModel",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "No email on this account."]
            )
        }
        let credential = EmailAuthProvider.credential(withEmail: email, password: password)
        try await user.reauthenticate(with: credential)
    }
    
    func signUp(
        email: String,
        password: String,
        firstName: String,
        lastName: String,
        business: String,
        industry: String,
        subscriptionPlan: SubscriptionPlan
    ) async throws {
        let result = try await Auth.auth().createUser(withEmail: email, password: password)
        let fullName = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespacesAndNewlines)
        let changeRequest = result.user.createProfileChangeRequest()
        changeRequest.displayName = fullName
        do {
            try await changeRequest.commitChanges()
            try await firebaseService.createProviderProfile(
                uid: result.user.uid,
                email: email,
                name: fullName,
                firstName: firstName,
                lastName: lastName,
                business: business,
                industry: industry,
                subscriptionPlan: subscriptionPlan.rawValue
            )
        } catch {
            try? await result.user.delete()
            throw error
        }
    }
    
    func signOut() throws {
        let uid = Auth.auth().currentUser?.uid
        Task {
            await PushNotificationManager.shared.clearTokenForSignOut(providerUid: uid)
        }
        try Auth.auth().signOut()
    }
    
    /// Call from UI (e.g. Settings); ignores errors.
    func logout() {
        isDemoMode = false
        let uid = Auth.auth().currentUser?.uid
        Task {
            await PushNotificationManager.shared.clearTokenForSignOut(providerUid: uid)
        }
        try? Auth.auth().signOut()
    }

    /// Demo mode: full app experience without Firebase sign-in.
    func demoLogin() {
        isDemoMode = true
        isAuthenticated = true
        currentUserEmail = "demo@example.com"
        currentUserDisplayName = "Demo Provider"
        tenantLogoUrl = nil
        accountPhotoUrl = nil
        teamAccess = .ownerFullAccess
        tenantSubscriptionPlan = .studio
    }

    func refreshTeamAccess() async {
        if isDemoMode {
            teamAccess = .ownerFullAccess
            tenantSubscriptionPlan = .studio
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            teamAccess = EffectiveTeamAccess()
            tenantSubscriptionPlan = .solo
            return
        }
        var access = await TenantTeamAccessService.fetchCurrentAccess(isDemoMode: false)
        if !access.isOwner {
            access = await TenantTeamAccessService.reconcileOwnerAccess(
                uid: uid,
                current: access,
                firebaseService: firebaseService
            )
        }
        teamAccess = access
        tenantSubscriptionPlan = access.subscriptionPlan
    }

    /// Loads `logoUrl` from Firestore (profile → tenant). Prefer `applyTenantLogoCache` when URL is already known.
    /// On network/Firestore failure, keeps the previous `tenantLogoUrl` so the drawer avatar doesn’t flicker empty.
    func refreshTenantLogoFromServer() async {
        if isDemoMode || !isAuthenticated {
            tenantLogoUrl = nil
            return
        }
        guard let uid = Auth.auth().currentUser?.uid else {
            tenantLogoUrl = nil
            return
        }
        accountPhotoUrl = Auth.auth().currentUser?.photoURL?.absoluteString
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            let storedProfilePhoto = profile?.profilePhotoUrl.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !storedProfilePhoto.isEmpty {
                accountPhotoUrl = storedProfilePhoto
            }
            guard let tid = profile?.tenantId else {
                tenantLogoUrl = nil
                return
            }
            let tenant = try await firebaseService.fetchTenant(tenantId: tid)
            let raw = tenant?["logoUrl"] as? String
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            tenantLogoUrl = trimmed.isEmpty ? nil : trimmed
        } catch {
            // Keep existing tenantLogoUrl; user still sees last good logo until refresh succeeds.
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
    /// Posted with `userInfo["businessName"]` when the studio business name changes in Firestore from this app.
    static let tenantBusinessNameDidChange = Notification.Name("tenantBusinessNameDidChange")
}
