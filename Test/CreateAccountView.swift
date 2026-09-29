//
//  CreateAccountView.swift
//
//  In-app account creation. Same questions as getbookking.com/signup.
//  Create my account opens Apple’s payment sheet.
//

import SwiftUI
import UIKit
import FirebaseAuth
import FirebaseFunctions

struct CreateAccountView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = BookkingSubscriptionStore.shared

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
    @State private var plan: SubscriptionPlan?
    @State private var agreeTerms = false
    @State private var isWorking = false
    @State private var errorMessage = ""

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
                    Text("Step \(step + 1) of 4")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                    Text(stepTitle)
                        .font(AppDesign.screenHeaderFont(size: 26))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(stepSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    stepContent
                    if !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(Color(hex: "C0392B"))
                    }
                }
                .padding(24)
            }
            .appScreenBackground()
            .navigationTitle("Create an account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .disabled(isWorking)
                }
            }
            .task { await store.loadProducts() }
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case 0:
            pathStep
        case 1:
            businessStep
        case 2:
            youStep
        default:
            planStep
        }
    }

    private var stepTitle: String {
        switch step {
        case 0: return "What kind of business?"
        case 1: return "Tell us about your business"
        case 2: return "Tell us about you"
        default: return "Choose your plan"
        }
    }

    private var stepSubtitle: String {
        switch step {
        case 0:
            return "Choose a path first. We’ll tailor signup, your site, and billing from this."
        case 1:
            return "We’ll tailor your booking form, services, and site from this. All editable after signup."
        case 2:
            return "Your name and phone appear on your profile and booking site."
        default:
            return "14 days free. Nothing is charged today. Apple’s sheet confirms the plan, and texting stays off until Apple charges."
        }
    }

    private var pathStep: some View {
        VStack(spacing: 12) {
            pathButton(
                title: "Studios and Shops",
                subtitle: "Barbers, salons, tattoo, nails, and more · Solo, Studio, or Shop",
                charter: false
            )
            pathButton(
                title: "Fishing Charters",
                subtitle: "Fishing charters, guides, and boat rentals · Trip booking, guest texting, and your site",
                charter: true
            )
        }
    }

    private func pathButton(title: String, subtitle: String, charter: Bool) -> some View {
        Button {
            isCharterPath = charter
            if charter {
                industry = BookingTemplate.charters.rawValue
                customIndustry = ""
                plan = .charter
            } else {
                if plan == .charter { plan = nil }
                if industry == BookingTemplate.charters.rawValue { industry = "" }
            }
            errorMessage = ""
            step = 1
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(AppDesign.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .signupChoiceChrome(selected: false)
        }
        .buttonStyle(.plain)
    }

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
            navRow(back: { step = 0 }, canContinue: businessStepValid) {
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

    private var youStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            field("First name", text: $firstName, placeholder: "Brandon", contentType: .givenName)
            field("Last name", text: $lastName, placeholder: "Smith", contentType: .familyName)
            VStack(alignment: .leading, spacing: 6) {
                field("Email", text: $email, placeholder: "you@example.com", keyboard: .emailAddress, contentType: .emailAddress)
                Text("Used to sign in to the app and web, and for receipts.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.brandMuted)
            }
            field(
                "Phone number",
                text: Binding(
                    get: { phone },
                    set: { phone = PhoneFormatting.formatAsYouType($0) }
                ),
                placeholder: "(555) 123-4567",
                keyboard: .phonePad,
                contentType: .telephoneNumber
            )
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
                Text("Symbols (!@#…) are optional — add one if you like.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.brandMuted)
            }
            navRow(back: { step = 1 }, canContinue: youStepValid) {
                firstName = USStateServiceAreaFormatting.titleCaseWords(firstName)
                lastName = USStateServiceAreaFormatting.titleCaseWords(lastName)
                errorMessage = ""
                step = 3
            }
        }
    }

    private var planStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isCharterPath {
                planCard(plan: .charter, selected: true) {}
            } else {
                ForEach([SubscriptionPlan.solo, .studio, .shop], id: \.self) { choice in
                    planCard(plan: choice, selected: plan == choice) {
                        plan = choice
                        errorMessage = ""
                    }
                }
            }
            if let plan {
                Text("\(plan.displayName) plan — \(store.displayPrice(for: plan))/month when the 14 days end.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                bullet("Your 14-day trial starts today. Nothing is charged today.")
                bullet("Apple charges this plan when the 14 days end.")
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
            Text(.init("Questions? [support@getbookking.com](mailto:support@getbookking.com)"))
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .tint(AppDesign.brandWarm)
            navRow(back: { step = 2 }, continueTitle: "Create my account", canContinue: planStepValid && !isWorking) {
                Task { await finish() }
            }
            if isWorking {
                ProgressView("Starting your plan…")
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func planCard(plan choice: SubscriptionPlan, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.displayName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(choice.shortDescription)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                Spacer(minLength: 8)
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(store.displayPrice(for: choice))
                        .font(AppDesign.screenHeaderFont(size: 22))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text("/mo")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }
            .padding(16)
            .signupChoiceChrome(selected: selected)
        }
        .buttonStyle(.plain)
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

    private func navRow(back: @escaping () -> Void, continueTitle: String = "Continue", canContinue: Bool, next: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
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

    private var youStepValid: Bool {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let at = trimmedEmail.firstIndex(of: "@")
        let emailOk: Bool = {
            guard let at else { return false }
            return at != trimmedEmail.startIndex
                && trimmedEmail.lastIndex(of: "@") == at
                && trimmedEmail.index(after: at) != trimmedEmail.endIndex
        }()
        let digits = phone.filter(\.isNumber).count
        return !firstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !lastName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && emailOk
            && digits >= 10
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

    private var planStepValid: Bool {
        agreeTerms && plan != nil
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

    private func finish() async {
        guard let plan else { return }
        isWorking = true
        errorMessage = ""
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        do {
            if Auth.auth().currentUser == nil {
                _ = try await Auth.auth().createUser(withEmail: trimmedEmail, password: password)
            }
            let record = try await store.purchaseSubscription(plan: plan)
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
            try await store.syncPurchase(record)
            dismiss()
        } catch let error as BookkingPurchaseError {
            if case .cancelled = error {
                errorMessage = ""
            } else if case .productUnavailable = error {
                errorMessage = "The App Store plan didn’t load. Stop the app, then in Xcode choose Product → Scheme → Edit Scheme → Run → Options, set StoreKit Configuration to GetBookking.storekit, and run again."
            } else {
                errorMessage = error.localizedDescription
            }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
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
