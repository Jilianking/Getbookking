//
//  LoginView.swift
//
//  Provider sign-in; new accounts open the marketing sign-up wizard in Safari.
//

import SwiftUI
import UIKit

struct LoginView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage = ""
    @State private var isPasswordVisible = false

    var body: some View {
        VStack(spacing: 32) {
            // Branding
            Text("Booking App")
                .font(.system(size: 36, weight: .bold))
                .padding(.top, 80)

            signInCard

            Spacer()
        }
        .background(Color.gray.opacity(0.06))
    }

    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in")
                .font(.system(size: 28, weight: .bold))
            Text("Use your account to manage bookings")
                .font(.subheadline)
                .foregroundColor(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("Email")
                    .font(.subheadline.weight(.medium))
                TextField("you@example.com", text: $email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .padding(12)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Password")
                    .font(.subheadline.weight(.medium))
                HStack {
                    if isPasswordVisible {
                        TextField("Password", text: $password)
                    } else {
                        SecureField("Password", text: $password)
                    }
                    Button(action: { isPasswordVisible.toggle() }) {
                        Image(systemName: isPasswordVisible ? "eye.slash.fill" : "eye.fill")
                            .foregroundColor(.secondary)
                    }
                }
                .padding(12)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(10)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                )
            }

            if !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
            }

            Button(action: performSignIn) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        .frame(maxWidth: .infinity)
                        .padding()
                } else {
                    Text("Sign in")
                        .frame(maxWidth: .infinity)
                        .padding()
                }
            }
            .background(Color.black)
            .foregroundColor(.white)
            .cornerRadius(12)
            .disabled(isLoading || email.isEmpty || password.isEmpty)

            Button(action: openMarketingSignUp) {
                Text("Create an account")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding()
            }
            .foregroundColor(.primary)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.gray.opacity(0.3), lineWidth: 1)
            )
            .cornerRadius(12)

            Button("Demo login (no backend)") {
                authViewModel.demoLogin()
            }
            .font(.subheadline)
            .foregroundColor(.secondary)
            .padding(.top, 4)
        }
        .padding(24)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 12, x: 0, y: 4)
        .padding(.horizontal, 24)
    }

    private func openMarketingSignUp() {
        guard let url = URL(string: Constants.Hosting.marketingSignUpURL) else { return }
        UIApplication.shared.open(url)
    }

    private func performSignIn() {
        isLoading = true
        errorMessage = ""
        Task {
            do {
                try await authViewModel.signIn(email: email, password: password)
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
            await MainActor.run { isLoading = false }
        }
    }
}
