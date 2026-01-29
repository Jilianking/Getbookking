import SwiftUI

struct LoginView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage = ""
    
    var body: some View {
        VStack(spacing: 30) {
            Text("Admin")
                .font(.system(size: 48, weight: .bold))
                .padding(.top, 100)
            
            VStack(alignment: .leading, spacing: 10) {
                Text("Admin Login")
                    .font(.system(size: 32, weight: .bold))
                
                SecureField("Password", text: $password)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .padding(.vertical, 10)
                    .onSubmit {
                        login()
                    }
                
                if !errorMessage.isEmpty {
                    Text(errorMessage)
                        .foregroundColor(.red)
                        .font(.caption)
                }
                
                Button(action: login) {
                    if isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Login")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isLoading || password.isEmpty)
            }
            .padding()
            
            Spacer()
        }
    }
    
    private func login() {
        isLoading = true
        errorMessage = ""
        
        authViewModel.login(password: password) { success, error in
            isLoading = false
            if !success {
                errorMessage = error ?? "Invalid password"
            }
        }
    }
}

