//
//  LoginView.swift
//
//  Business sign-in; new accounts open the marketing sign-up wizard in Safari.
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
            Text("Get Bookking")
                .font(.system(size: 36, weight: .bold, design: .serif))
                .foregroundStyle(AppDesign.textPrimary)
                .padding(.top, 80)

            signInCard

            Spacer()
        }
        .appScreenBackground()
    }

    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(AppDesign.textPrimary)
            Text("Use your account to manage bookings")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("Email")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.textPrimary)
                TextField("you@example.com", text: $email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .padding(12)
                    .background(AppDesign.searchBackground)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(AppDesign.chipBorder, lineWidth: 1)
                    )
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Password")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.textPrimary)
                HStack {
                    if isPasswordVisible {
                        TextField("Password", text: $password)
                    } else {
                        SecureField("Password", text: $password)
                    }
                    Button(action: { isPasswordVisible.toggle() }) {
                        Image(systemName: isPasswordVisible ? "eye.slash.fill" : "eye.fill")
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(12)
                .background(AppDesign.searchBackground)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(AppDesign.chipBorder, lineWidth: 1)
                )

                HStack {
                    Spacer()
                    Button(action: openMarketingForgotPassword) {
                        Text("Forgot password?")
                            .font(.subheadline)
                    }
                    .foregroundStyle(AppDesign.linkAccent)
                    .disabled(isLoading)
                }
                .padding(.top, 4)
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
                } else {
                    Text("Sign in")
                }
            }
            .buttonStyle(AppPrimaryButtonStyle(enabled: !isLoading && !email.isEmpty && !password.isEmpty))
            .disabled(isLoading || email.isEmpty || password.isEmpty)

            Button(action: openMarketingSignUp) {
                Text("Create an account")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
            }
            .foregroundStyle(AppDesign.textPrimary)
            .padding(.vertical, 14)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppDesign.chipBorder, lineWidth: 1)
            )

            Button(action: openMarketingTemplates) {
                Text("Browse templates")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(.top, 4)

            demoSection
        }
        .padding(24)
        .appCard()
        .padding(.horizontal, 24)
    }

    private var demoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Try a live demo")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
                .padding(.top, 8)

            Text("Explore the full app with sample data. Nothing you do is saved.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)

            HStack(spacing: 10) {
                ForEach(DemoPersona.allCases) { persona in
                    Button {
                        startDemo(persona)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Image(systemName: persona.iconSystemName)
                                .font(.title3)
                                .foregroundStyle(AppDesign.linkAccent)
                            Text(persona == .salon ? "Salon" : "Gym")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                            Text(persona.businessName)
                                .font(.caption2)
                                .foregroundStyle(AppDesign.textSecondary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(AppDesign.searchBackground)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(AppDesign.chipBorder, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(isLoading)
                }
            }
        }
    }

    private func startDemo(_ persona: DemoPersona) {
        isLoading = true
        errorMessage = ""
        authViewModel.demoLogin(persona: persona)
        isLoading = false
    }

    private func openMarketingSignUp() {
        guard let url = URL(string: Constants.Hosting.marketingSignUpURL) else { return }
        UIApplication.shared.open(url)
    }

    private func openMarketingTemplates() {
        guard let url = URL(string: Constants.Hosting.marketingTemplatesURL) else { return }
        UIApplication.shared.open(url)
    }

    private func openMarketingForgotPassword() {
        guard let url = Constants.Hosting.marketingForgotPasswordURL(email: email) else { return }
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
        }
    }
}
