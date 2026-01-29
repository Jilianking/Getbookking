import Foundation
import Combine

class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var sessionToken: String?
    
    private let apiService = APIService.shared
    
    init() {
        checkAuthentication()
    }
    
    func checkAuthentication() {
        if let token = UserDefaults.standard.string(forKey: "adminSessionToken"), !token.isEmpty {
            sessionToken = token
            isAuthenticated = true
        }
    }
    
    func login(password: String, completion: @escaping (Bool, String?) -> Void) {
        Task {
            do {
                let success = try await apiService.login(password: password)
                await MainActor.run {
                    if success {
                        self.isAuthenticated = true
                        self.sessionToken = UserDefaults.standard.string(forKey: "adminSessionToken")
                    }
                    completion(success, success ? nil : "Invalid password")
                }
            } catch {
                await MainActor.run {
                    completion(false, error.localizedDescription)
                }
            }
        }
    }
    
    func logout() {
        Task {
            await apiService.logout()
            await MainActor.run {
                UserDefaults.standard.removeObject(forKey: "adminSessionToken")
                sessionToken = nil
                isAuthenticated = false
            }
        }
    }
}

