//
//  SettingsView.swift
//
//  Generic settings: account, business info, app info.
//

import SwiftUI
import PhotosUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = SettingsViewModel()
    @StateObject private var teamPolicyViewModel = ManagerSettingsViewModel()
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @State private var showingLogoutAlert = false
    @State private var showingDeleteAccountSheet = false
    @State private var settingsAlertMessage: String?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppScreenTitle(title: sectionTitle)
                    profileCard

                    if !authViewModel.isDemoMode && viewModel.hasProfile {
                        businessSection
                        paymentsSection
                    }

                    accountSection

                    if let msg = viewModel.errorMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 4)
                    }

                    HStack(alignment: .center) {
                        HStack(spacing: 6) {
                            Text("Version")
                            Text(Constants.App.version)
                        }
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                        Spacer(minLength: 0)
                        AppSunMoonAppearanceToggle(isDark: appearanceIsDark)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 24)
                }
                .padding(16)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .alert("Logout", isPresented: $showingLogoutAlert) {
                Button("Cancel", role: .cancel) { }
                Button("Logout", role: .destructive) {
                    authViewModel.logout()
                }
            } message: {
                Text("Are you sure you want to logout?")
            }
            .alert("Settings", isPresented: Binding(
                get: { settingsAlertMessage != nil },
                set: { if !$0 { settingsAlertMessage = nil } }
            )) {
                Button("OK", role: .cancel) { settingsAlertMessage = nil }
            } message: {
                Text(settingsAlertMessage ?? "")
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
                if viewModel.isTenantOwner {
                    await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
                }
                await paymentsViewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
                if viewModel.isTenantOwner {
                    await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
                }
                await paymentsViewModel.loadData(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await authViewModel.refreshTeamAccess()
            }
            .sheet(isPresented: $showingDeleteAccountSheet) {
                DeleteAccountSettingsSheet(viewModel: viewModel)
                    .environmentObject(authViewModel)
            }
            .onReceive(NotificationCenter.default.publisher(for: .stripeConnectShouldRefresh)) { _ in
                Task { await paymentsViewModel.refreshStripeConnectStatus(isDemoMode: authViewModel.isDemoMode) }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var profileCard: some View {
        Group {
            if authViewModel.isDemoMode {
                HStack(spacing: 14) {
                    AppAvatarView(
                        tenantLogoURL: nil,
                        accountPhotoURL: nil,
                        displayNameFallback: authViewModel.currentUserDisplayName,
                        size: 56
                    )
                    VStack(alignment: .leading, spacing: 4) {
                        Text(sessionStore.businessDisplayName.isEmpty
                            ? (authViewModel.demoPersona?.businessName ?? "Demo")
                            : sessionStore.businessDisplayName)
                            .font(.headline)
                            .foregroundStyle(AppDesign.textPrimary)
                        Text(authViewModel.currentUserDisplayName ?? "Owner")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                        Text("Demo · nothing is saved")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    Spacer()
                }
                .padding(16)
                .appCard()
            } else if let email = authViewModel.currentUserEmail {
                NavigationLink {
                    AccountSettingsDetailView(viewModel: viewModel)
                        .environmentObject(authViewModel)
                } label: {
                    HStack(spacing: 14) {
                        AppAvatarView(
                            tenantLogoURL: authViewModel.tenantLogoUrl,
                            accountPhotoURL: authViewModel.accountPhotoUrl,
                            displayNameFallback: profileDisplayName,
                            size: 56
                        )
                        VStack(alignment: .leading, spacing: 6) {
                            Text(profileDisplayName)
                                .font(.headline)
                                .foregroundStyle(AppDesign.textPrimary)
                            Text(email)
                                .font(.subheadline)
                                .foregroundStyle(AppDesign.textSecondary)
                            if viewModel.isTenantOwner {
                                Text(planIndustryPill)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AppDesign.accentGreen)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(AppDesign.accentGreen.opacity(0.12))
                                    .clipShape(Capsule())
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .appCard()
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var profileDisplayName: String {
        if !viewModel.accountDisplayName.isEmpty { return viewModel.accountDisplayName }
        if !viewModel.businessDisplayName.isEmpty { return viewModel.businessDisplayName }
        return authViewModel.currentUserDisplayName ?? "Account"
    }

    private var planIndustryPill: String {
        let industry = BookingTemplate.displayLabel(
            forIndustryRaw: viewModel.selectedIndustry,
            customLabel: viewModel.industryCustomLabel
        )
        return "\(viewModel.tenantSubscriptionPlan.displayName) · \(industry)"
    }

    /// Non-owners only, when the studio owner does not set a shared booking type.
    private var showsMyBookingTypeOnMainSettings: Bool {
        !viewModel.isTenantOwner && !viewModel.managersApproveAppointments
    }

    @ViewBuilder
    private var businessSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Business")

            VStack(spacing: 0) {
                if viewModel.isTenantOwner {
                    if viewModel.tenantSubscriptionPlan.usesBusinessSettingsHub {
                        NavigationLink {
                            BusinessSettingsDetailView(
                                teamPolicyViewModel: teamPolicyViewModel,
                                settingsViewModel: viewModel,
                                isDemoMode: authViewModel.isDemoMode
                            )
                            .environmentObject(authViewModel)
                        } label: {
                            AppSettingsRow(
                                icon: "storefront.fill",
                                iconColor: .purple,
                                title: "Business settings"
                            )
                        }
                        .buttonStyle(.plain)
                    } else {
                        NavigationLink {
                            TeamSettingsDetailView(
                                teamPolicyViewModel: teamPolicyViewModel,
                                settingsViewModel: viewModel,
                                isDemoMode: authViewModel.isDemoMode
                            )
                            .environmentObject(authViewModel)
                        } label: {
                            AppSettingsRow(
                                icon: "person.3.fill",
                                iconColor: .purple,
                                title: "Team settings"
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    if teamPolicyViewModel.smsStatus == "active", !teamPolicyViewModel.smsPhoneNumber.isEmpty {
                        NavigationLink {
                            TeamClientMessagingSettingsView(viewModel: teamPolicyViewModel)
                                .environmentObject(authViewModel)
                        } label: {
                            AppSettingsRow(
                                icon: "message.fill",
                                iconColor: .orange,
                                title: "Messaging",
                                value: PhoneFormatting.displayUS(teamPolicyViewModel.smsPhoneNumber)
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    Divider().padding(.leading, 52)
                }

                if viewModel.isTenantOwner && viewModel.tenantSubscriptionPlan.allowsTeamInvites,
                   let ownerMember = teamPolicyViewModel.members.first(where: { $0.accessRole == .owner }) {
                    NavigationLink {
                        OwnerPublicBookingProfileView(
                            viewModel: teamPolicyViewModel,
                            member: ownerMember
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        AppSettingsRow(
                            icon: "person.crop.circle.badge.checkmark",
                            iconColor: AppDesign.accentBlue,
                            title: "Your booking profile",
                            value: ownerMember.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? nil
                                : ownerMember.jobTitle
                        )
                    }
                    .buttonStyle(.plain)

                    Divider().padding(.leading, 52)
                }

                if showsMyBookingTypeOnMainSettings {
                    NavigationLink {
                        PersonalBookingSettingsView(viewModel: viewModel)
                            .environmentObject(authViewModel)
                    } label: {
                        AppSettingsRow(
                            icon: "calendar.badge.clock",
                            iconColor: AppDesign.accentBlue,
                            title: "My booking type",
                            value: viewModel.effectiveBookingConfirmationType.displayName
                        )
                    }
                    .buttonStyle(.plain)

                    Divider().padding(.leading, 52)
                }

                NavigationLink {
                    PersonalSchedulingSettingsView(viewModel: viewModel)
                        .environmentObject(authViewModel)
                } label: {
                    AppSettingsRow(
                        icon: "calendar",
                        iconColor: AppDesign.accentGreen,
                        title: "Scheduling & hours",
                        value: SettingsViewModel.shortTimeZoneLabel(viewModel.timeZoneId)
                    )
                }
                .buttonStyle(.plain)
            }
            .appCard()
        }
    }

    @ViewBuilder
    private var paymentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Payments")

            VStack(spacing: 0) {
                Button {
                    drawerState.selectedSection = .payments
                    drawerState.isOpen = false
                } label: {
                    let status = paymentsSetupStatus
                    AppSettingsRow(
                        icon: "s.circle.fill",
                        iconColor: AppDesign.accentGreen,
                        title: "Stripe & Tap to Pay",
                        status: status.label,
                        statusColor: status.color
                    )
                }
                .buttonStyle(.plain)
            }
            .appCard()
        }
    }

    private var paymentsSetupStatus: (label: String, color: Color) {
        if !paymentsViewModel.stripeConnected {
            return ("Setup", AppDesign.brandWarm)
        }
        #if TAP_TO_PAY_ENABLED
        if TapToPayLocationStore.shared.resolvedLocationId.isEmpty {
            return ("Connected", AppDesign.accentGreen)
        }
        return ("Ready", AppDesign.accentGreen)
        #else
        return ("Connected", AppDesign.accentGreen)
        #endif
    }

    @AppStorage(AppAppearanceStorage.key) private var appearanceRaw = AppAppearance.light.rawValue

    private var appearanceIsDark: Binding<Bool> {
        Binding(
            get: { AppAppearance.resolved(from: appearanceRaw).isDark },
            set: { appearanceRaw = ($0 ? AppAppearance.dark : AppAppearance.light).rawValue }
        )
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Account")

            VStack(spacing: 0) {
                if !authViewModel.isDemoMode, authViewModel.currentUserEmail != nil {
                    Button { sendPasswordReset() } label: {
                        AppSettingsRow(icon: "lock.fill", iconColor: .gray, title: "Change password")
                    }
                    .buttonStyle(.plain)

                    if viewModel.isTenantOwner {
                        Divider().padding(.leading, 52)
                        NavigationLink {
                            TeamNotificationsSettingsView(
                                viewModel: teamPolicyViewModel,
                                isSoloBusinessSettings: viewModel.tenantSubscriptionPlan.usesBusinessSettingsHub
                            )
                            .environmentObject(authViewModel)
                        } label: {
                            AppSettingsRow(icon: "bell.fill", iconColor: AppDesign.accentBlue, title: "Notifications")
                        }
                        .buttonStyle(.plain)
                    }

                    Divider().padding(.leading, 52)
                    Link(destination: URL(string: Constants.Hosting.marketingWebOrigin)!) {
                        AppSettingsRow(icon: "info.circle.fill", iconColor: .gray, title: "Support")
                    }
                    .buttonStyle(.plain)

                    Divider().padding(.leading, 52)
                }

                Link(destination: URL(string: Constants.Hosting.marketingPrivacyURL)!) {
                    AppSettingsRow(icon: "hand.raised.fill", iconColor: .gray, title: "Privacy Policy")
                }
                .buttonStyle(.plain)

                Divider().padding(.leading, 52)

                Link(destination: URL(string: Constants.Hosting.marketingTermsURL)!) {
                    AppSettingsRow(icon: "doc.text.fill", iconColor: .gray, title: "Terms of Service")
                }
                .buttonStyle(.plain)

                Divider().padding(.leading, 52)

                if authViewModel.isDemoMode {
                    Button {
                        sessionStore.reset()
                        authViewModel.exitDemo()
                    } label: {
                        HStack {
                            AppSettingsRow(icon: "rectangle.portrait.and.arrow.right", iconColor: .red, title: "Exit demo")
                        }
                    }
                    .buttonStyle(.plain)
                } else {
                    Button { showingLogoutAlert = true } label: {
                        HStack {
                            AppSettingsRow(icon: "rectangle.portrait.and.arrow.right", iconColor: .red, title: "Log out")
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .appCard()

            if !authViewModel.isDemoMode, authViewModel.currentUserEmail != nil {
                Button { showingDeleteAccountSheet = true } label: {
                    Text("Delete account")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary.opacity(0.7))
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .padding(.top, 12)
            }
        }
    }

    private func sendPasswordReset() {
        guard let email = authViewModel.currentUserEmail else { return }
        Task {
            do {
                try await authViewModel.sendPasswordReset(email: email)
                await MainActor.run {
                    settingsAlertMessage = "Password reset email sent to \(email)."
                }
            } catch {
                await MainActor.run {
                    settingsAlertMessage = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Personal scheduling (hours + time zone)

struct PersonalSchedulingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @State private var showBusinessHoursSheet = false

    var body: some View {
        List {
            Section(
                footer: Text(
                    "Weekly hours are shared with Design → About and shown on your public site. Use the calendar below for days off or fixed appointment dates."
                )
                .font(.caption2)
            ) {
                Button {
                    showBusinessHoursSheet = true
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Weekly business hours")
                                .foregroundStyle(.primary)
                            Text(viewModel.businessHoursSummary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer()
                        Text("Edit")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.tenantId == nil || viewModel.isLoading)

                Toggle("Show hours on site", isOn: $viewModel.showBusinessHoursOnPage)
                    .disabled(viewModel.tenantId == nil || viewModel.isLoading)
                    .onChange(of: viewModel.showBusinessHoursOnPage) { _, _ in
                        Task { await viewModel.saveBusinessHours() }
                    }
            }

            Section(
                footer: Text(schedulingSettingsFooter)
                .font(.caption2)
            ) {
                Picker("Time zone", selection: $viewModel.timeZoneId) {
                    ForEach(SettingsViewModel.sortedTimeZoneIdentifiers, id: \.self) { zoneId in
                        Text(zoneId).tag(zoneId)
                    }
                }
                NavigationLink("Edit availability calendar") {
                    DaysOpenCalendarSheet(viewModel: viewModel)
                }
                Button("Save calendar & time zone") {
                    Task {
                        await viewModel.saveAvailability()
                        await authViewModel.refreshTeamAccess()
                    }
                }
                .disabled(viewModel.isLoading)
                if viewModel.saveSuccess {
                    Label("Saved", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .appListSurface()
        .navigationTitle("Scheduling & hours")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showBusinessHoursSheet) {
            SettingsBusinessHoursSheet(viewModel: viewModel)
        }
    }

    private var schedulingSettingsFooter: String {
        if viewModel.isTenantOwner && viewModel.tenantSubscriptionPlan.usesBusinessSettingsHub {
            return "Your time zone and calendar. Booking type is in Business settings → Booking settings."
        }
        if viewModel.isTenantOwner {
            return "Your time zone and calendar. Studio booking policy is in Team settings → Booking settings."
        }
        if !viewModel.managersApproveAppointments {
            return "Your time zone and calendar. Booking type is in Settings → My booking type."
        }
        return "Your time zone and calendar. Your owner sets booking type in Team settings → Booking settings."
    }
}

private struct SettingsBusinessHoursSheet: View {
    @ObservedObject var viewModel: SettingsViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                BusinessHoursWeeklyEditor(viewModel: viewModel) {
                    await viewModel.saveBusinessHours()
                }
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle("Business hours")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Account detail (name, plan, profile photo)
private struct AccountSettingsDetailView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @StateObject private var billingViewModel = ManagerSettingsViewModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var profilePhotoPickerItem: PhotosPickerItem?
    @State private var profilePhotoCropItem: SingleImageCropSheetItem?
    @State private var showIndustryChangeAlert = false
    @State private var previousIndustryForCancel: String = ""
    @State private var isRestoringIndustry = false
    @State private var hasLoadedIndustryOnce = false

    var body: some View {
        List {
            if authViewModel.isDemoMode {
                Section {
                    Text("Account details aren’t available in demo mode.")
                        .foregroundStyle(.secondary)
                }
            } else {
                if let email = authViewModel.currentUserEmail {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Signed in as")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(email)
                                .font(.body)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if viewModel.hasProfile, viewModel.tenantId != nil {
                    Section(
                        footer: Text("Used for your account profile. Website logo is managed in Web Page Design. \(UploadImageAdvice.profile)")
                            .font(.caption2)
                    ) {
                        HStack(alignment: .center, spacing: 12) {
                            PhotosPicker(
                                selection: $profilePhotoPickerItem,
                                matching: .images,
                                photoLibrary: .shared()
                            ) {
                                ZStack(alignment: .bottomTrailing) {
                                    Group {
                                        if viewModel.profilePhotoUrl.isEmpty {
                                            Circle()
                                                .fill(Color(.secondarySystemGroupedBackground))
                                                .overlay(
                                                    Image(systemName: "person.fill")
                                                        .font(.system(size: 22))
                                                        .foregroundColor(.secondary)
                                                )
                                        } else if let url = URL(string: viewModel.profilePhotoUrl) {
                                            AsyncImage(url: url) { phase in
                                                switch phase {
                                                case .success(let image):
                                                    image
                                                        .resizable()
                                                        .scaledToFill()
                                                case .failure:
                                                    Image(systemName: "exclamationmark.triangle")
                                                        .font(.caption)
                                                        .foregroundColor(.secondary)
                                                default:
                                                    Color(.secondarySystemGroupedBackground)
                                                        .overlay(ProgressView().scaleEffect(0.7))
                                                }
                                            }
                                        } else {
                                            Circle()
                                                .fill(Color(.secondarySystemGroupedBackground))
                                        }
                                    }
                                    .frame(width: 52, height: 52)
                                    .clipShape(Circle())
                                    .overlay(
                                        Circle()
                                            .strokeBorder(Color(.separator), lineWidth: 0.5)
                                    )

                                    Image(systemName: "camera.circle.fill")
                                        .symbolRenderingMode(.multicolor)
                                        .font(.system(size: 20))
                                        .background(
                                            Circle()
                                                .fill(Color(.systemBackground))
                                                .frame(width: 16, height: 16)
                                        )
                                        .offset(x: 1, y: 1)
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(viewModel.isUploadingLogo)

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Tap photo to change")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                if viewModel.isUploadingLogo {
                                    ProgressView()
                                        .scaleEffect(0.85)
                                }
                                if !viewModel.profilePhotoUrl.isEmpty {
                                    Button(role: .destructive) {
                                        Task {
                                            await viewModel.removeProfilePhoto()
                                            await MainActor.run {
                                                authViewModel.accountPhotoUrl = nil
                                            }
                                        }
                                    } label: {
                                        Text("Remove")
                                            .font(.caption.weight(.medium))
                                    }
                                    .disabled(viewModel.isUploadingLogo)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 2)
                    }
                }
                if viewModel.hasProfile {
                    Section(
                        header: Text("Your name"),
                        footer: Text("Your personal name as shown to clients and team members.")
                            .font(.caption2)
                    ) {
                        HStack {
                            Text("Full name")
                            Spacer(minLength: 12)
                            Text(accountNameReadOnlyLabel)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
                if viewModel.hasProfile, viewModel.isTenantOwner, viewModel.tenantId != nil {
                    Section(
                        header: Text("Business name"),
                        footer: Text("Shown in the app sidebar. Your website and Tap to Pay customer name can use different names.")
                            .font(.caption2)
                    ) {
                        TextField("Business name", text: $viewModel.businessNameDraft)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()
                        Button {
                            Task { await viewModel.saveBusinessName() }
                        } label: {
                            HStack {
                                Text("Save business name")
                                if viewModel.isSavingBusinessName {
                                    Spacer()
                                    ProgressView()
                                        .scaleEffect(0.9)
                                }
                            }
                        }
                        .disabled(
                            viewModel.isSavingBusinessName
                                || viewModel.businessNameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                        if viewModel.businessNameSaveSuccess {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Business name saved")
                                    .foregroundColor(.green)
                            }
                        }
                    }
                }
                if viewModel.hasProfile, viewModel.isTenantOwner {
                    Section(
                        header: Text("Industry"),
                        footer: Text("Industry controls your booking form, default services, and how template copy is auto-filled. Changing it asks for confirmation because your current services are replaced. Template choice lives in Website Design.")
                            .font(.caption2)
                    ) {
                        Picker("Industry", selection: $viewModel.selectedIndustry) {
                            ForEach(BookingTemplate.allCases) { template in
                                Text(template.displayName).tag(template.rawValue)
                            }
                        }
                        .onChange(of: viewModel.selectedIndustry) { oldValue, newValue in
                            guard hasLoadedIndustryOnce else { return }
                            if isRestoringIndustry {
                                isRestoringIndustry = false
                                return
                            }
                            previousIndustryForCancel = oldValue
                            showIndustryChangeAlert = true
                        }
                        if viewModel.selectedIndustry == BookingTemplate.custom.rawValue,
                           !viewModel.industryCustomLabel.isEmpty {
                            LabeledContent("Custom industry name", value: viewModel.industryCustomLabel)
                        }
                        Button(action: {
                            Task { await viewModel.applyTemplateAndSave() }
                        }) {
                            HStack {
                                Text("Save and apply to website")
                                if viewModel.isSavingService {
                                    Spacer()
                                    ProgressView()
                                        .scaleEffect(0.9)
                                }
                            }
                        }
                        .disabled(viewModel.isSavingService)
                        if viewModel.saveSuccess {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Saved — booking form and services applied")
                                    .foregroundColor(.green)
                            }
                        }
                    }
                }
                if viewModel.hasProfile, viewModel.tenantId != nil {
                    Section(
                        header: Text("Plan & billing"),
                        footer: Text("Manage subscription, payment method, and invoices in Stripe. Changes sync automatically or use Sync billing.")
                            .font(.caption2)
                    ) {
                        HStack {
                            Text("Current plan")
                            Spacer()
                            Text(billingViewModel.tenantSubscriptionPlan.displayName)
                                .foregroundStyle(.secondary)
                        }
                        if viewModel.isTenantOwner {
                            HStack {
                                Text("Billing status")
                                Spacer()
                                Text(billingStatusLabel)
                                    .foregroundStyle(billingStatusColor)
                            }
                            Button {
                                Task { await billingViewModel.openStripeBillingPortal() }
                            } label: {
                                HStack {
                                    if billingViewModel.isOpeningBillingPortal {
                                        ProgressView()
                                            .scaleEffect(0.9)
                                    }
                                    Text("Manage billing in Stripe")
                                }
                            }
                            .disabled(
                                billingViewModel.isOpeningBillingPortal ||
                                billingViewModel.isSyncingBilling
                            )
                            Button {
                                Task { await billingViewModel.syncBillingFromStripe() }
                            } label: {
                                HStack {
                                    if billingViewModel.isSyncingBilling {
                                        ProgressView()
                                            .scaleEffect(0.9)
                                    }
                                    Text("Sync billing from Stripe")
                                }
                            }
                            .disabled(
                                billingViewModel.isSyncingBilling ||
                                billingViewModel.isOpeningBillingPortal
                            )
                            if billingViewModel.subscriptionTrialing {
                                Button {
                                    Task { await billingViewModel.openBillingToStartSubscription() }
                                } label: {
                                    HStack {
                                        if billingViewModel.isOpeningBillingWebsite {
                                            ProgressView()
                                                .scaleEffect(0.9)
                                        }
                                        Text("Start subscription today")
                                    }
                                }
                                .disabled(
                                    billingViewModel.isOpeningBillingWebsite ||
                                    billingViewModel.isSyncingBilling ||
                                    billingViewModel.isOpeningBillingPortal
                                )
                            }
                        }
                    }
                } else if authViewModel.currentUserEmail != nil && !viewModel.hasProfile {
                    Section {
                        Text("Your business profile is still loading. Pull to refresh on Settings, or try again in a moment.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .appListSurface()
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .alert(industryChangeAlertTitle, isPresented: $showIndustryChangeAlert) {
            Button("Cancel", role: .cancel) {
                isRestoringIndustry = true
                viewModel.selectedIndustry = previousIndustryForCancel
            }
            Button("Continue") {
                Task { await viewModel.applyTemplateAndSave() }
            }
        } message: {
            Text(industryChangeAlertMessage)
        }
        .task {
            if !authViewModel.isDemoMode {
                await billingViewModel.load(isDemoMode: false)
            }
            hasLoadedIndustryOnce = true
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await billingViewModel.syncBillingAfterWebIfNeeded() }
        }
        .onChange(of: profilePhotoPickerItem) { _, newItem in
            Task {
                guard let newItem else { return }
                guard let data = try? await newItem.loadTransferable(type: Data.self), !data.isEmpty,
                      let uiImage = UIImage(data: data) else {
                    await MainActor.run { profilePhotoPickerItem = nil }
                    return
                }
                await MainActor.run {
                    profilePhotoCropItem = SingleImageCropSheetItem(image: uiImage)
                    profilePhotoPickerItem = nil
                }
            }
        }
        .sheet(item: $profilePhotoCropItem, onDismiss: { profilePhotoCropItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: UploadImageAdvice.profile,
                navigationTitle: "Profile photo",
                allowedChoices: UploadCropPresetMenu.profile,
                defaultChoice: .square,
                onUseJPEGData: { dataList in
                    profilePhotoCropItem = nil
                    guard let data = dataList.first else { return }
                    Task {
                        await viewModel.uploadProfilePhoto(imageData: data)
                        await MainActor.run {
                            let trimmed = viewModel.profilePhotoUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                            authViewModel.accountPhotoUrl = trimmed.isEmpty ? nil : trimmed
                        }
                    }
                }
            )
        }
    }

    private var accountNameReadOnlyLabel: String {
        let trimmed = viewModel.accountDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let authName = authViewModel.currentUserDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !authName.isEmpty {
            return authName
        }
        return "—"
    }

    private var billingStatusLabel: String {
        if billingViewModel.subscriptionPaid { return "Active" }
        if billingViewModel.subscriptionTrialing { return "Free trial" }
        let raw = billingViewModel.subscriptionStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.isEmpty ? "Not linked" : raw.capitalized
    }

    private var billingStatusColor: Color {
        if billingViewModel.subscriptionPaid { return .green }
        if billingViewModel.subscriptionTrialing { return .secondary }
        return .orange
    }

    private var industryChangeAlertTitle: String {
        let name = BookingTemplate.displayLabel(
            forIndustryRaw: viewModel.selectedIndustry,
            customLabel: viewModel.industryCustomLabel
        )
        return "Switch to \(name)?"
    }

    private var industryChangeAlertMessage: String {
        guard let template = BookingTemplate(rawValue: viewModel.selectedIndustry) else {
            return "Your booking form and services will update to match this industry. Website templates in Website Design follow the industry you set here."
        }
        switch template {
        case .custom:
            let customName = viewModel.industryCustomLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            let modeLabel = customName.isEmpty ? "Custom" : customName
            return """
            You're entering \(modeLabel) mode.

            • Booking form switches to a generic field set (editable in Website Design).
            • Your current services are removed and replaced with four generic starter services.
            • In Website Design, only templates for Custom are available under Website templates.

            You can customize everything after saving.
            """
        default:
            let label = template.displayName
            return """
            You're entering \(label) mode.

            • Booking form switches to fields for this industry (editable afterward).
            • Your current services are removed and replaced with starter services for \(label).
            • Website Design → Website templates only shows options that match this industry.

            Tap Continue to apply, or Cancel to keep your previous type.
            """
        }
    }
}

// MARK: - Days open calendar sheet
struct DaysOpenCalendarSheet: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var displayDate = Date()
    @Environment(\.dismiss) var dismiss

    private var calendarModeHint: String {
        if viewModel.effectiveBookingConfirmationType.usesFixedSlots {
            return "Tap dates when you accept appointments. Weekly hours still apply on those days."
        }
        return "Tap dates to block time off. Clients can book on open days during your weekly hours."
    }

    private var monthYearText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: displayDate)
    }

    private var calendarDays: [Date?] {
        let cal = Calendar.current
        guard let range = cal.range(of: .day, in: .month, for: displayDate),
              let first = cal.date(from: cal.dateComponents([.year, .month], from: displayDate)) else { return [] }
        let weekday = cal.component(.weekday, from: first) - 1 // 0=Sun
        let count = range.count
        var out: [Date?] = Array(repeating: nil, count: weekday)
        for day in 1...count {
            if let d = cal.date(byAdding: .day, value: day - 1, to: first) {
                out.append(d)
            }
        }
        while out.count % 7 != 0 { out.append(nil) }
        return out
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    Text(calendarModeHint)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                    HStack {
                        Button(action: previousMonth) {
                            Image(systemName: "chevron.left")
                                .font(.body.weight(.semibold))
                        }
                        Text(monthYearText)
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                        Button(action: nextMonth) {
                            Image(systemName: "chevron.right")
                                .font(.body.weight(.semibold))
                        }
                    }
                    .padding(.horizontal, 24)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
                        ForEach(Array(calendarDays.enumerated()), id: \.offset) { _, dateOpt in
                            if let date = dateOpt {
                                CalendarDateCell(
                                    date: date,
                                    isBlocked: !viewModel.effectiveBookingConfirmationType.usesFixedSlots && viewModel.isDateBlocked(date),
                                    isAvailable: viewModel.effectiveBookingConfirmationType.usesFixedSlots && viewModel.isDateAvailable(date),
                                    isToday: Calendar.current.isDateInToday(date)
                                ) {
                                    if viewModel.effectiveBookingConfirmationType.usesFixedSlots {
                                        viewModel.toggleAvailableDate(date)
                                    } else {
                                        viewModel.toggleBlockedDate(date)
                                    }
                                }
                            } else {
                                Color.clear
                                    .frame(height: 40)
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                }
            }
            .appScreenBackground()
            .navigationTitle("Availability calendar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .onAppear {
            displayDate = Date()
        }
    }

    private func previousMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: -1, to: displayDate) {
            displayDate = d
        }
    }

    private func nextMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: 1, to: displayDate) {
            displayDate = d
        }
    }

}

struct CalendarDateCell: View {
    let date: Date
    let isBlocked: Bool   // Approval mode: blocked (vacation)
    let isAvailable: Bool // Fixed slots: selected for appointments
    let isToday: Bool
    let onTap: () -> Void

    private var dayNumber: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d"
        return formatter.string(from: date)
    }

    var body: some View {
        Button(action: onTap) {
            Text(dayNumber)
                .font(.caption.weight(isToday ? .bold : .medium))
                .frame(width: 36, height: 36)
                .background(backgroundColor)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isToday ? AppDesign.brandDark : Color.clear, lineWidth: 2)
                )
                .foregroundColor(foregroundColor)
                .cornerRadius(8)
                .strikethrough(isBlocked, color: .primary)
        }
        .buttonStyle(.plain)
    }

    private var backgroundColor: Color {
        if isBlocked { return Color.red.opacity(0.3) }
        if isAvailable { return Color.green.opacity(0.4) }
        if isToday { return AppDesign.searchBackground }
        return Color.clear
    }

    private var foregroundColor: Color {
        if isBlocked { return .secondary }
        return .primary
    }
}
