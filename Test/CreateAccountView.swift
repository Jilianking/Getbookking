//
//  CreateAccountView.swift
//
//  In-app sign-up. Plans and prices come first (App Review needs them up front): the owner
//  picks a plan and either a free trial or paying now, Apple's sheet confirms it, then we
//  collect the business and the login. The purchase is tied to a guest login made just before
//  Apple's sheet; the last step turns that guest login into an email-and-password one.
//

import SwiftUI
import UIKit
import StoreKit
import FirebaseAuth
import FirebaseFunctions

struct CreateAccountView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var authViewModel: AuthViewModel
    @StateObject private var store = BookkingSubscriptionStore.shared

    /// Finishing a sign-up after the app was closed partway (the plan may already be paid).
    var isResuming = false

    /// 0 = choose a plan, 1 = the business, 2 = the login.
    @State private var step = 0
    @State private var isCharterPath = false
    @State private var industry = ""
    @State private var customIndustry = ""
    @State private var businessName = ""
    @State private var city = ""
    @State private var stateAbbr = ""
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var password = ""
    @State private var passwordConfirm = ""
    @State private var showPassword = false
    @State private var showPasswordConfirm = false
    @State private var plan: SubscriptionPlan? = .solo
    @State private var purchaseRecord: BookkingPurchaseRecord?
    @State private var agreeTerms = false
    @State private var isWorking = false
    @State private var isPreparing = false
    @State private var errorMessage = ""
    @State private var infoMessage = ""

    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    private let industryChoices: [(template: BookingTemplate, title: String, subtitle: String?)] = [
        (.barber, "Barbershop", nil),
        (.hair, "Hair salon", nil),
        (.tattoos, "Tattoo studio", nil),
        (.nails, "Nail salon", nil),
        (.custom, "Custom", "Describe your type"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if step > 0 {
                        if let purchaseRecord {
                            purchaseBanner(purchaseRecord)
                        }
                        Text("Step \(step) of 2")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    Text(stepTitle)
                        .font(AppDesign.screenHeaderFont(size: step == 0 ? 30 : 26))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(stepSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if isPreparing {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                    } else {
                        stepContent
                    }
                    if !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(Color(hex: "C0392B"))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !infoMessage.isEmpty {
                        Text(infoMessage)
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(24)
            }
            .appScreenBackground()
            .navigationTitle(isResuming ? "Finish setting up" : "Create an account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isResuming ? "Sign out" : "Close") { closeSignup() }
                        .disabled(isWorking)
                }
            }
            .interactiveDismissDisabled(isWorking || authViewModel.isCreatingAccount)
            .task { await prepare() }
        }
    }

    /// Loads Apple's prices; when resuming, skips the plan screen if this login already paid.
    private func prepare() async {
        isPreparing = isResuming
        await store.loadProducts()
        await store.refreshTrialEligibility()
        if isResuming, Auth.auth().currentUser != nil, let existing = await store.existingSubscriptionRecord() {
            usePurchase(existing)
        }
        isPreparing = false
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case 0:
            planStep
        case 1:
            businessStep
        default:
            accountStep
        }
    }

    private var stepTitle: String {
        switch step {
        case 0: return "Choose your plan"
        case 1: return "Tell us about your business"
        default: return needsLoginFields ? "Create your login" : "Tell us about you"
        }
    }

    private var stepSubtitle: String {
        switch step {
        case 0:
            return store.isEligibleForFreeTrial
                ? "Try it free for 14 days, or skip the trial and get every feature today."
                : "Pick the plan that fits your business. Every feature starts today."
        case 1:
            return "We’ll set up your booking page, services and site from this. You can change everything later."
        default:
            return needsLoginFields
                ? "You’ll use this to sign in to the app and the web, and we send receipts here. Your name and phone show on your booking page."
                : "Your name and phone show on your profile and booking page."
        }
    }

    /// A guest login (made just before Apple's sheet) still needs an email and password.
    private var needsLoginFields: Bool {
        guard let user = Auth.auth().currentUser else { return true }
        return user.isAnonymous
    }

    private var selectedPlan: SubscriptionPlan {
        if isCharterPath { return .charter }
        if let plan, plan != .charter { return plan }
        return .solo
    }

    // MARK: - Step 0: plans and prices

    private var planStep: some View {
        PlanChooserView(
            store: store,
            isCharterPath: $isCharterPath,
            plan: $plan,
            showsPathPicker: true,
            isWorking: isWorking,
            onPathChange: { charter in
                if charter {
                    industry = BookingTemplate.charters.rawValue
                    customIndustry = ""
                } else if industry == BookingTemplate.charters.rawValue {
                    industry = ""
                }
                errorMessage = ""
                infoMessage = ""
            },
            onPurchase: { chosen, payNow in
                plan = chosen
                Task { await startPlan(payNow: payNow) }
            },
            onRestore: { Task { await restore() } },
            onLogin: isResuming ? nil : { closeSignup() }
        )
    }

    private func purchaseBanner(_ record: BookkingPurchaseRecord) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.circle")
                .font(.title3)
                .foregroundStyle(AppDesign.accentGreen)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.isIntroductory ? "Your 14-day free trial has started" : "You’re subscribed — every feature is on")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text(record.isIntroductory
                     ? "Nothing is charged today. Client texting and payments unlock when your paid plan starts."
                     : "Client texting and payments are ready as soon as you finish setting up.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppDesign.accentGreen.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - Step 1: business

    private var businessStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isCharterPath {
                VStack(alignment: .leading, spacing: 4) {
                    Text("BUSINESS TYPE")
                        .font(.caption2.weight(.medium))
                        .tracking(0.8)
                        .foregroundStyle(AppDesign.textSecondary)
                    Text("Boating / Fishing Charter")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppDesign.textPrimary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .signupChoiceChrome(selected: true)
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                    ForEach(industryChoices, id: \.template.rawValue) { choice in
                        Button {
                            industry = choice.template.rawValue
                            if choice.template != .custom { customIndustry = "" }
                            errorMessage = ""
                        } label: {
                            VStack(spacing: 4) {
                                Text(choice.title)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(AppDesign.textPrimary)
                                if let subtitle = choice.subtitle {
                                    Text(subtitle)
                                        .font(.caption)
                                        .foregroundStyle(AppDesign.textSecondary)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 18)
                            .padding(.horizontal, 10)
                            .signupChoiceChrome(selected: industry == choice.template.rawValue)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if industry == BookingTemplate.custom.rawValue {
                    field(
                        "Business type",
                        text: $customIndustry,
                        placeholder: "e.g. Spa, Brows, Photography"
                    )
                }
            }

            Rectangle()
                .fill(AppDesign.chipBorder)
                .frame(height: 1)

            field(
                "Business name",
                text: $businessName,
                placeholder: isCharterPath ? "e.g. Harbor Charters" : "e.g. Brandon Smith Barbershop"
            )
            HStack(alignment: .top, spacing: 12) {
                field(
                    "City",
                    text: $city,
                    placeholder: isCharterPath ? "e.g. Key West" : "e.g. St. Petersburg"
                )
                stateField
            }
            navRow(back: { step = 0 }, showBack: purchaseRecord == nil, canContinue: businessStepValid) {
                businessName = USStateServiceAreaFormatting.titleCaseWords(businessName)
                city = USStateServiceAreaFormatting.titleCaseWords(city)
                customIndustry = USStateServiceAreaFormatting.titleCaseWords(customIndustry)
                errorMessage = ""
                step = 2
            }
        }
    }

    private var stateField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("State")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.textSecondary)
            Menu {
                ForEach(USStateServiceAreaFormatting.statesSortedByName) { row in
                    Button {
                        stateAbbr = row.abbr
                    } label: {
                        if stateAbbr == row.abbr {
                            Label(row.name, systemImage: "checkmark")
                        } else {
                            Text(row.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(stateAbbr.isEmpty ? "Select state" : (USStateServiceAreaFormatting.displayName(forAbbr: stateAbbr) ?? stateAbbr))
                        .font(.body)
                        .foregroundStyle(stateAbbr.isEmpty ? AppDesign.brandMuted : AppDesign.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppDesign.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .signupFieldChrome()
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Step 2: you and the login

    private var accountStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                field("First name", text: $firstName, placeholder: "Brandon", contentType: .givenName)
                field("Last name", text: $lastName, placeholder: "Smith", contentType: .familyName)
            }
            field(
                "Mobile phone",
                text: Binding(
                    get: { phone },
                    set: { phone = PhoneFormatting.formatAsYouType($0) }
                ),
                placeholder: "(555) 123-4567",
                keyboard: .phonePad,
                contentType: .telephoneNumber
            )
            if needsLoginFields {
                field("Email", text: $email, placeholder: "you@yourshop.com", keyboard: .emailAddress, contentType: .emailAddress)
                passwordField("Password", placeholder: "8+ characters", text: $password, revealed: $showPassword)
                VStack(alignment: .leading, spacing: 6) {
                    passwordField("Confirm password", placeholder: "Re-enter password", text: $passwordConfirm, revealed: $showPasswordConfirm)
                    if !passwordConfirm.isEmpty && passwordConfirm != password {
                        Text("Passwords do not match.")
                            .font(.caption)
                            .foregroundStyle(Color(hex: "C0392B"))
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        passwordRule("At least 8 characters", met: password.count >= 8)
                        passwordRule("One uppercase letter", met: password.range(of: "[A-Z]", options: .regularExpression) != nil)
                        passwordRule("One lowercase letter", met: password.range(of: "[a-z]", options: .regularExpression) != nil)
                        passwordRule("One number", met: password.range(of: "[0-9]", options: .regularExpression) != nil)
                    }
                }
            }
            HStack(alignment: .top, spacing: 10) {
                Button {
                    agreeTerms.toggle()
                } label: {
                    Image(systemName: agreeTerms ? "checkmark.square.fill" : "square")
                        .font(.title3)
                        .foregroundStyle(agreeTerms ? AppDesign.brandWarm : AppDesign.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("I agree to the Terms of Service and Privacy Policy")
                Text(.init("I agree to the [Terms of Service](\(Constants.Hosting.marketingTermsURL)) and [Privacy Policy](\(Constants.Hosting.marketingPrivacyURL))."))
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .tint(AppDesign.brandWarm)
            }
            navRow(back: { step = 1 }, continueTitle: "Finish setting up", canContinue: accountStepValid && !isWorking) {
                firstName = USStateServiceAreaFormatting.titleCaseWords(firstName)
                lastName = USStateServiceAreaFormatting.titleCaseWords(lastName)
                Task { await finish() }
            }
            if isWorking {
                ProgressView("Setting up your business…")
                    .frame(maxWidth: .infinity)
            }
            Text("Your plan is already active with Apple. If you close the app now, you’ll come back to this step next time.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            Text(.init("Questions? [support@getbookking.com](mailto:support@getbookking.com)"))
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .tint(AppDesign.brandWarm)
                .frame(maxWidth: .infinity)
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(AppDesign.textSecondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func passwordRule(_ title: String, met: Bool) -> some View {
        HStack(spacing: 6) {
            Text(met ? "✓" : "○")
                .foregroundStyle(met ? AppDesign.accentGreen : AppDesign.brandMuted)
            Text(title)
                .foregroundStyle(met ? AppDesign.textSecondary : AppDesign.brandMuted)
        }
        .font(.caption)
    }

    private func navRow(back: @escaping () -> Void, showBack: Bool = true, continueTitle: String = "Continue", canContinue: Bool, next: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            if showBack {
            Button("Back", action: back)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal, 22)
                .padding(.vertical, 13)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(AppDesign.chipBorder, lineWidth: 1)
                )
                .disabled(isWorking)
            }
            Button(continueTitle, action: next)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.brandCream)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(AppDesign.brandDark)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .opacity(canContinue ? 1 : 0.4)
                .disabled(!canContinue)
        }
        .padding(.top, 4)
    }

    private var businessStepValid: Bool {
        let industryOk: Bool
        if isCharterPath {
            industryOk = true
        } else if industry == BookingTemplate.custom.rawValue {
            industryOk = !customIndustry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } else {
            industryOk = !industry.isEmpty
        }
        return industryOk
            && !businessName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && stateAbbr.count == 2
    }

    private var accountStepValid: Bool {
        let digits = phone.filter(\.isNumber).count
        let namesOk = !firstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !lastName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && digits >= 10
            && agreeTerms
        guard needsLoginFields else { return namesOk }
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let at = trimmedEmail.firstIndex(of: "@")
        let emailOk: Bool = {
            guard let at else { return false }
            return at != trimmedEmail.startIndex
                && trimmedEmail.lastIndex(of: "@") == at
                && trimmedEmail.index(after: at) != trimmedEmail.endIndex
        }()
        return namesOk
            && emailOk
            && passwordMeetsPolicy
            && !passwordConfirm.isEmpty
            && password == passwordConfirm
    }

    private var passwordMeetsPolicy: Bool {
        password.count >= 8
            && password.range(of: "[A-Z]", options: .regularExpression) != nil
            && password.range(of: "[a-z]", options: .regularExpression) != nil
            && password.range(of: "[0-9]", options: .regularExpression) != nil
    }

    private func field(
        _ title: String,
        text: Binding<String>,
        placeholder: String,
        keyboard: UIKeyboardType = .default,
        contentType: UITextContentType? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.textSecondary)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(keyboard == .emailAddress ? .never : .words)
                .keyboardType(keyboard)
                .textContentType(contentType)
                .autocorrectionDisabled(keyboard == .emailAddress || keyboard == .phonePad)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .signupFieldChrome()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func passwordField(_ title: String, placeholder: String, text: Binding<String>, revealed: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.textSecondary)
            HStack(spacing: 8) {
                Group {
                    if revealed.wrappedValue {
                        TextField(placeholder, text: text)
                    } else {
                        SecureField(placeholder, text: text)
                    }
                }
                .textContentType(.newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                Button(revealed.wrappedValue ? "Hide" : "Show") {
                    revealed.wrappedValue.toggle()
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(AppDesign.brandWarm)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .signupFieldChrome()
        }
    }

    private func closeSignup() {
        if Auth.auth().currentUser != nil {
            do {
                try authViewModel.signOut()
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        } else {
            authViewModel.isCreatingAccount = false
        }
        dismiss()
    }

    private func usePurchase(_ record: BookkingPurchaseRecord) {
        purchaseRecord = record
        if let bought = BookkingProductID.plan(for: record.productID) {
            plan = bought
            isCharterPath = bought == .charter
            if isCharterPath {
                industry = BookingTemplate.charters.rawValue
                customIndustry = ""
            }
        }
        step = 1
    }

    /// Apple's sheet for the chosen plan, with or without the free trial. A guest login is made
    /// first so the purchase belongs to this sign-up; the last step adds the email and password.
    private func startPlan(payNow: Bool) async {
        let chosen = selectedPlan
        isWorking = true
        errorMessage = ""
        infoMessage = ""
        authViewModel.isCreatingAccount = true
        do {
            if Auth.auth().currentUser == nil {
                _ = try await Auth.auth().signInAnonymously()
            }
            // A plan this login already bought (the sheet closed after paying) is used as is,
            // so nobody is charged twice.
            if let existing = await store.existingSubscriptionRecord() {
                usePurchase(existing)
            } else {
                usePurchase(try await store.purchaseSubscription(plan: chosen, payNow: payNow))
            }
        } catch let error as BookkingPurchaseError {
            if case .cancelled = error {
                errorMessage = ""
            } else if case .productUnavailable = error {
                errorMessage = "The App Store plan didn’t load. Check your connection and try again."
            } else {
                errorMessage = error.localizedDescription
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
        isWorking = false
    }

    /// Restore purchases from the plan screen. A plan bought during this sign-up continues it;
    /// a plan bought for another account means logging in to that account instead.
    private func restore() async {
        isWorking = true
        errorMessage = ""
        infoMessage = ""
        defer { isWorking = false }
        do {
            try await AppStore.sync()
        } catch StoreKitError.userCancelled {
            return
        } catch {
            errorMessage = "Couldn’t reach the App Store. Check your connection and try again."
            return
        }
        if Auth.auth().currentUser != nil, let existing = await store.existingSubscriptionRecord() {
            usePurchase(existing)
            return
        }
        infoMessage = await store.hasActiveSubscriptionOnThisAppleID()
            ? "This Apple ID already has a Get Bookking plan. Log in with the account it belongs to."
            : "No Get Bookking purchases were found for this Apple ID."
    }

    private func finish() async {
        guard let record = purchaseRecord else {
            step = 0
            return
        }
        let plan = BookkingProductID.plan(for: record.productID) ?? selectedPlan
        isWorking = true
        errorMessage = ""
        authViewModel.isCreatingAccount = true
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        do {
            if let user = Auth.auth().currentUser, user.isAnonymous {
                // Same login (and so the same App Store purchase), now with an email and password.
                let credential = EmailAuthProvider.credential(withEmail: trimmedEmail, password: password)
                _ = try await user.link(with: credential)
            } else if Auth.auth().currentUser == nil {
                _ = try await Auth.auth().createUser(withEmail: trimmedEmail, password: password)
            }
            // The sign-up call reads the email from a fresh sign-in token.
            _ = try await Auth.auth().currentUser?.getIDTokenResult(forcingRefresh: true)
            authViewModel.currentUserEmail = Auth.auth().currentUser?.email
            let payload: [String: Any] = [
                "plan": plan.rawValue,
                "teamSize": plan == .shop ? "shop" : (plan == .studio ? "studio" : "solo"),
                "industry": isCharterPath ? BookingTemplate.charters.rawValue : industry,
                "industryCustomLabel": customIndustry,
                "businessName": USStateServiceAreaFormatting.titleCaseWords(businessName),
                "city": USStateServiceAreaFormatting.titleCaseWords(city),
                "stateAbbr": stateAbbr,
                "phone": PhoneFormatting.displayUS(phone),
                "firstName": USStateServiceAreaFormatting.titleCaseWords(firstName),
                "lastName": USStateServiceAreaFormatting.titleCaseWords(lastName),
                "templatePreset": "portfolio",
            ]
            do {
                _ = try await functions.httpsCallable("completeProviderSignupWithoutCheckout").call(payload)
            } catch {
                let message = FirebaseFunctionsErrorHelper.message(from: error)
                if !message.localizedCaseInsensitiveContains("already has a business") {
                    throw error
                }
            }
            // Xcode's local StoreKit receipt is not Apple-signed. The production server
            // still verifies every Sandbox, App Review, TestFlight, and production receipt.
            if !record.isXcodeEnvironment {
                try await store.syncPurchase(record)
            }
            await authViewModel.refreshTeamAccess()
            authViewModel.isCreatingAccount = false
            authViewModel.markSignupFinished()
            dismiss()
        } catch {
            let code = AuthErrorCode(rawValue: (error as NSError).code)
            if code == .emailAlreadyInUse || code == .credentialAlreadyInUse {
                errorMessage = "That email already has a Get Bookking account. Use a different email, or contact support@getbookking.com and we’ll move your plan over."
            } else if code == .invalidEmail {
                errorMessage = "That email address doesn’t look right."
            } else if code == .weakPassword {
                errorMessage = "Choose a stronger password."
            } else {
                errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            }
        }
        isWorking = false
    }
}

private extension View {
    func signupFieldChrome() -> some View {
        background(AppDesign.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(AppDesign.chipBorder, lineWidth: 1)
            )
    }

    func signupChoiceChrome(selected: Bool) -> some View {
        background(selected ? AppDesign.brandCream : AppDesign.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selected ? AppDesign.brandWarm : AppDesign.chipBorder, lineWidth: 1)
            )
    }
}
