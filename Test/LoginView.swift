//
//  LoginView.swift
//  Test
//
//  Provider sign-in and entry to sign-up.
//

import SwiftUI

struct LoginView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage = ""
    @State private var isPasswordVisible = false
    @State private var showingSignUp = false

    var body: some View {
        VStack(spacing: 32) {
            // Branding
            Text("Booking App")
                .font(.system(size: 36, weight: .bold))
                .padding(.top, 80)

            if showingSignUp {
                SignUpFormView(
                    onSignUp: performSignUp,
                    onSwitchToSignIn: { showingSignUp = false },
                    isLoading: $isLoading,
                    errorMessage: $errorMessage
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                signInCard
            }

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

            Button(action: { showingSignUp = true }) {
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

    private func performSignUp(name: String, business: String, email: String, password: String, plan: SubscriptionPlan) {
        errorMessage = ""
        isLoading = true
        Task {
            do {
                try await authViewModel.signUp(email: email, password: password, name: name, business: business, subscriptionPlan: plan)
                await MainActor.run {
                    showingSignUp = false
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }
}

// MARK: - Sign up form (name, business, email, password, subscription plan)

struct SignUpFormView: View {
    @State private var name = ""
    @State private var business = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var selectedPlan: SubscriptionPlan = .free
    @State private var isPasswordVisible = false
    @State private var isConfirmVisible = false

    var onSignUp: (String, String, String, String, SubscriptionPlan) -> Void
    var onSwitchToSignIn: () -> Void
    @Binding var isLoading: Bool
    @Binding var errorMessage: String

    private var passwordsMatch: Bool {
        password == confirmPassword
    }

    private var canSubmit: Bool {
        !name.isEmpty && !business.isEmpty && !email.isEmpty &&
        !password.isEmpty && !confirmPassword.isEmpty && passwordsMatch && password.count >= 6
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Button(action: onSwitchToSignIn) {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                            .font(.subheadline.weight(.semibold))
                        Text("Sign in")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundColor(.secondary)
                }
                .padding(.bottom, 4)

                Text("Create account")
                    .font(.system(size: 28, weight: .bold))
                Text("Sign up to start managing your bookings")
                    .font(.subheadline)
                    .foregroundColor(.secondary)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Name")
                        .font(.subheadline.weight(.medium))
                    TextField("Your full name", text: $name)
                        .textContentType(.name)
                        .padding(12)
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(10)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                        )
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Business")
                        .font(.subheadline.weight(.medium))
                    TextField("Business or studio name", text: $business)
                        .textContentType(.organizationName)
                        .padding(12)
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(10)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                        )
                }

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
                    Text("Subscription plan")
                        .font(.subheadline.weight(.medium))
                    VStack(spacing: 8) {
                        ForEach(SubscriptionPlan.allCases, id: \.self) { plan in
                            Button(action: { selectedPlan = plan }) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(plan.displayName)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundColor(.primary)
                                        Text(plan.shortDescription)
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    if selectedPlan == plan {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(.black)
                                    }
                                }
                                .padding(12)
                                .background(selectedPlan == plan ? Color.gray.opacity(0.15) : Color.gray.opacity(0.06))
                                .cornerRadius(10)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10)
                                        .stroke(selectedPlan == plan ? Color.black : Color.gray.opacity(0.2), lineWidth: selectedPlan == plan ? 2 : 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Password (min 6 characters)")
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

                VStack(alignment: .leading, spacing: 8) {
                    Text("Confirm password")
                        .font(.subheadline.weight(.medium))
                    HStack {
                        if isConfirmVisible {
                            TextField("Confirm password", text: $confirmPassword)
                        } else {
                            SecureField("Confirm password", text: $confirmPassword)
                        }
                        Button(action: { isConfirmVisible.toggle() }) {
                            Image(systemName: isConfirmVisible ? "eye.slash.fill" : "eye.fill")
                                .foregroundColor(.secondary)
                        }
                    }
                    .padding(12)
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(passwordsMatch ? Color.gray.opacity(0.3) : Color.red.opacity(0.5), lineWidth: 1)
                    )
                    .cornerRadius(10)
                    if !confirmPassword.isEmpty && !passwordsMatch {
                        Text("Passwords don't match")
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }

                if !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                }

                Button(action: submit) {
                    if isLoading {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        Text("Create account")
                            .frame(maxWidth: .infinity)
                            .padding()
                    }
                }
                .background(Color.black)
                .foregroundColor(.white)
                .cornerRadius(12)
                .disabled(!canSubmit || isLoading)

                Button(action: onSwitchToSignIn) {
                    Text("Already have an account? Sign in")
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
            }
            .padding(24)
        }
        .frame(maxHeight: .infinity)
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.06), radius: 12, x: 0, y: 4)
        .padding(.horizontal, 24)
    }

    private func submit() {
        errorMessage = ""
        onSignUp(name, business, email, password, selectedPlan)
    }
}
