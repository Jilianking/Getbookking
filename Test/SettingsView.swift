//
//  SettingsView.swift
//
//  Generic settings: account, business info, app info.
//

import SwiftUI
import PhotosUI
import UIKit
import FirebaseAuth

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = SettingsViewModel()
    @StateObject private var teamPolicyViewModel = ManagerSettingsViewModel()
    @StateObject private var paymentsViewModel = PaymentsViewModel()
    @State private var showingLogoutAlert = false
    @State private var settingsAlertMessage: String?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    profileCard

                    if !authViewModel.isDemoMode && viewModel.hasProfile {
                        businessSection
                        paymentsSection
                    }

                    appearanceSection
                    accountSection

                    if let msg = viewModel.errorMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 4)
                    }

                    HStack {
                        Text("Version")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                        Spacer()
                        Text(Constants.App.version)
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    .padding(.horizontal, 4)
                }
                .padding(16)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
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
                if viewModel.isTenantOwner {
                    await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
                }
                await paymentsViewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                if viewModel.isTenantOwner {
                    await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
                }
                await paymentsViewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await authViewModel.refreshTeamAccess()
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
                        displayNameFallback: "Demo",
                        size: 56
                    )
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Demo mode")
                            .font(.headline)
                            .foregroundStyle(AppDesign.textPrimary)
                        Text("Sign in to manage your business")
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
        let industry = BookingTemplate(rawValue: viewModel.selectedIndustry)?.displayName ?? "Business"
        return "\(viewModel.tenantSubscriptionPlan.displayName) · \(industry)"
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
                } else {
                    HStack {
                        Text("Booking confirmation")
                            .font(.subheadline)
                        Spacer()
                        Text(viewModel.tenantConfirmationType.displayName)
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    .padding(16)
                }

                Divider().padding(.leading, 52)

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
                    AppSettingsRow(
                        icon: "s.circle.fill",
                        iconColor: AppDesign.accentGreen,
                        title: "Stripe Connect",
                        status: paymentsViewModel.stripeConnected ? "Connected" : "Setup",
                        statusColor: paymentsViewModel.stripeConnected ? AppDesign.accentGreen : AppDesign.brandWarm
                    )
                }
                .buttonStyle(.plain)

                Divider().padding(.leading, 52)

                Button {
                    drawerState.selectedSection = .payments
                    drawerState.isOpen = false
                } label: {
                    AppSettingsRow(
                        icon: "iphone.gen3",
                        iconColor: AppDesign.accentBlue,
                        title: "Tap to Pay",
                        status: tapToPayStatus,
                        statusColor: tapToPayStatus == "Configured" ? AppDesign.textSecondary : AppDesign.brandWarm
                    )
                }
                .buttonStyle(.plain)
            }
            .appCard()
        }
    }

    private var tapToPayStatus: String {
        TapToPayLocationStore.shared.resolvedLocationId.isEmpty ? "Setup" : "Configured"
    }

    @AppStorage(AppAppearanceStorage.key) private var appearanceRaw = AppAppearance.system.rawValue

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppSectionHeader(title: "Appearance")

            VStack(alignment: .leading, spacing: 12) {
                Picker("Theme", selection: $appearanceRaw) {
                    ForEach(AppAppearance.allCases) { mode in
                        Text(mode.label).tag(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                Text("System follows your iPhone light or dark setting.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            .padding(16)
            .appCard()
        }
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
                            TeamNotificationsSettingsView(viewModel: teamPolicyViewModel)
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

                Button { showingLogoutAlert = true } label: {
                    HStack {
                        AppSettingsRow(icon: "rectangle.portrait.and.arrow.right", iconColor: .red, title: "Log out")
                    }
                }
                .buttonStyle(.plain)
            }
            .appCard()
        }
    }

    private func sendPasswordReset() {
        guard let email = authViewModel.currentUserEmail else { return }
        Task {
            do {
                try await Auth.auth().sendPasswordReset(withEmail: email)
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

    var body: some View {
        List {
            Section(
                footer: Text(
                    viewModel.isTenantOwner && viewModel.tenantSubscriptionPlan.usesBusinessSettingsHub
                        ? "Your personal hours and time zone. Booking flow is in Business settings → Booking settings."
                        : "Your personal hours and time zone. Studio booking flow is in Team settings → Booking settings."
                )
                .font(.caption2)
            ) {
                Picker("Time zone", selection: $viewModel.timeZoneId) {
                    ForEach(SettingsViewModel.sortedTimeZoneIdentifiers, id: \.self) { zoneId in
                        Text(zoneId).tag(zoneId)
                    }
                }
                NavigationLink("Edit availability & calendar") {
                    DaysOpenCalendarSheet(viewModel: viewModel)
                }
                Button("Save") {
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
                        footer: Text("Your personal name is set when you sign up and can’t be changed here. To update your business name on your website, use Website Design → Business name.")
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
                                    Task { await billingViewModel.startSubscriptionToday() }
                                } label: {
                                    HStack {
                                        if billingViewModel.isStartingSubscription {
                                            ProgressView()
                                                .scaleEffect(0.9)
                                        }
                                        Text("Start subscription today")
                                    }
                                }
                                .disabled(
                                    billingViewModel.isStartingSubscription ||
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
            Task { await billingViewModel.syncBillingAfterPortalIfNeeded() }
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
        let name = BookingTemplate(rawValue: viewModel.selectedIndustry)?.displayName ?? "this type"
        return "Switch to \(name)?"
    }

    private var industryChangeAlertMessage: String {
        guard let template = BookingTemplate(rawValue: viewModel.selectedIndustry) else {
            return "Your booking form and services will update to match this industry. Website templates in Website Design follow the industry you set here."
        }
        switch template {
        case .custom:
            return """
            You're entering Custom mode.

            • Booking form switches to a generic field set (editable in Website Design).
            • Your current services are removed. Custom starts with no default services—add them under Book in Website Design.
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
    @State private var editingSlot: TimeSlot?
    @Environment(\.dismiss) var dismiss

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
                    Text(viewModel.confirmationType.usesFixedSlots ? "Fixed time slots" : "Open booking")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(.primary)
                        .frame(maxWidth: .infinity)
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
                                    isBlocked: !viewModel.confirmationType.usesFixedSlots && viewModel.isDateBlocked(date),
                                    isAvailable: viewModel.confirmationType.usesFixedSlots && viewModel.isDateAvailable(date),
                                    isToday: Calendar.current.isDateInToday(date)
                                ) {
                                    if viewModel.confirmationType.usesFixedSlots {
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
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Slots available")
                            .font(.subheadline.weight(.medium))
                        ForEach(Array(viewModel.timeSlots.enumerated()), id: \.element.id) { index, slot in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 12) {
                                    Button(action: { editingSlot = slot }) {
                                        HStack {
                                            Text("\(viewModel.formatHour(slot.open)) – \(viewModel.formatHour(slot.close))")
                                                .font(.subheadline.weight(.medium))
                                                .foregroundColor(.primary)
                                            Image(systemName: "chevron.right")
                                                .font(.caption2.weight(.semibold))
                                                .foregroundColor(.secondary)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(12)
                                        .background(viewModel.hasInvalidSlot(slot) ? AppDesign.declineBackground : AppDesign.searchBackground)
                                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                    Picker("", selection: Binding(
                                        get: { slot.type },
                                        set: { viewModel.updateTimeSlot(id: slot.id, type: $0) }
                                    )) {
                                        ForEach(SlotType.allCases, id: \.self) { type in
                                            Text(type.displayName).tag(type)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                    .frame(minWidth: 130)
                                    if viewModel.timeSlots.count > 1 {
                                        Button(action: { viewModel.removeTimeSlot(at: index) }) {
                                            Image(systemName: "trash")
                                                .font(.body)
                                                .foregroundColor(.red)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                if slot.type == .custom {
                                    TextField("Custom label", text: Binding(
                                        get: { slot.customLabel ?? "" },
                                        set: { viewModel.setSlotCustomLabel(id: slot.id, $0) }
                                    ))
                                    .textFieldStyle(.roundedBorder)
                                    .font(.subheadline)
                                }
                                if slot.type == .recurring {
                                    recurringDaysRow(slot: slot)
                                }
                                if viewModel.hasInvalidSlot(slot) {
                                    Text("End must be after start")
                                        .font(.caption)
                                        .foregroundColor(.red)
                                }
                            }
                        }
                        Button(action: { viewModel.addTimeSlot() }) {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                Text("Add time slot")
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .appCard()
                    .padding(.horizontal, 24)
                }
            }
            .appScreenBackground()
            .navigationTitle("Scheduling")
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
        .sheet(item: $editingSlot) { slot in
            TimeSlotEditSheet(slot: slot, viewModel: viewModel) {
                editingSlot = nil
            }
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

    private func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    @ViewBuilder
    private func recurringDaysRow(slot: TimeSlot) -> some View {
        let days = viewModel.dayLabels
        Text("Repeat on")
            .font(.caption)
            .foregroundColor(.secondary)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
            ForEach(days, id: \.0) { day, label in
                Button(action: { viewModel.toggleRecurringDay(slotId: slot.id, day: day) }) {
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background((slot.recurringDays ?? []).contains(day) ? AppDesign.brandDark : AppDesign.searchBackground)
                        .foregroundStyle((slot.recurringDays ?? []).contains(day) ? Color.white : AppDesign.textPrimary)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Time slot edit sheet
struct TimeSlotEditSheet: View {
    let slot: TimeSlot
    @ObservedObject var viewModel: SettingsViewModel
    let onDismiss: () -> Void

    @State private var openHour: Int
    @State private var closeHour: Int

    init(slot: TimeSlot, viewModel: SettingsViewModel, onDismiss: @escaping () -> Void) {
        self.slot = slot
        self.viewModel = viewModel
        self.onDismiss = onDismiss
        _openHour = State(initialValue: slot.open)
        _closeHour = State(initialValue: slot.close)
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("From")) {
                    Picker("From", selection: $openHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                Section(header: Text("To")) {
                    Picker("To", selection: $closeHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                if closeHour <= openHour {
                    Section {
                        Text("End must be after start")
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                }
            }
            .appListSurface()
            .navigationTitle("Edit time slot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        viewModel.updateTimeSlot(id: slot.id, open: openHour, close: closeHour)
                        onDismiss()
                    }
                    .disabled(closeHour <= openHour)
                }
            }
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
