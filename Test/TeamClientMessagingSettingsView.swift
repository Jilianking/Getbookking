//
//  TeamClientMessagingSettingsView.swift
//

import SwiftUI

struct TeamClientMessagingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var smsConsentAccepted = false
    @State private var draftConfirmed = ""
    @State private var draftDeclined = ""
    @State private var draftQuickReplies: [String] = []
    @State private var presetsLoaded = false
    @State private var showStartSubscriptionConfirm = false
    @State private var showAddNumberSheet = false
    @State private var addNumberConsent = false

    var body: some View {
        List {
            clientMessagingSection
            if viewModel.isTenantOwner, !authViewModel.isDemoMode {
                smsLinesSection
            }
            usageSection
            presetsSection
            if viewModel.isTenantOwner {
                TeamManagerPolicySaveSection(
                    viewModel: viewModel,
                    label: "Save presets",
                    saveAction: { await viewModel.saveMessagingPresets() }
                )
            }
        }
        .appListSurface()
        .navigationTitle("Messaging")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAddNumberSheet) {
            NavigationStack {
                addNumberSheetContent
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            syncPresetDraftsFromViewModel()
        }
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            syncPresetDraftsFromViewModel()
        }
        .onChange(of: viewModel.smsPresetConfirmed) { _, _ in
            if !presetsLoaded { syncPresetDraftsFromViewModel() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await viewModel.syncBillingAfterWebIfNeeded() }
        }
        .confirmationDialog(
            "Start subscription today?",
            isPresented: $showStartSubscriptionConfirm,
            titleVisibility: .visible
        ) {
            Button("Continue on website") {
                Task { await viewModel.openBillingToStartSubscription() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(startSubscriptionConfirmMessage)
        }
    }

    private var startSubscriptionConfirmMessage: String {
        Constants.App.paidFeatureUpgradeMessage
    }

    private func syncPresetDraftsFromViewModel() {
        draftConfirmed = viewModel.smsPresetConfirmed
        draftDeclined = viewModel.smsPresetDeclined
        draftQuickReplies = viewModel.smsQuickPresets.isEmpty
            ? ManagerSettingsViewModel.defaultQuickReplyPresets
            : viewModel.smsQuickPresets
        presetsLoaded = true
    }

    @ViewBuilder
    private var usageSection: some View {
        Section {
            HStack {
                Text("Used this month")
                Spacer()
                Text("\(viewModel.smsMonthlyUsageCount) of \(viewModel.smsMonthlyLimit)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        } header: {
            Text("Monthly limit")
        } footer: {
            Text("Inbound and outbound texts count toward the limit. Resets each calendar month (UTC).")
                .font(.caption2)
        }
    }

    @ViewBuilder
    private var presetsSection: some View {
        Section {
            if viewModel.isTenantOwner {
                presetRow(
                    caption: "Appointment confirmed",
                    placeholder: "Confirmed message",
                    text: $draftConfirmed,
                    onRemove: {
                        draftConfirmed = ManagerSettingsViewModel.defaultPresetConfirmed
                    }
                )
                presetRow(
                    caption: "Appointment declined",
                    placeholder: "Declined message",
                    text: $draftDeclined,
                    onRemove: {
                        draftDeclined = ManagerSettingsViewModel.defaultPresetDeclined
                    }
                )
                ForEach(draftQuickReplies.indices, id: \.self) { index in
                    presetRow(
                        caption: nil,
                        placeholder: "Quick reply",
                        text: $draftQuickReplies[index],
                        onRemove: {
                            if draftQuickReplies.count > 1 {
                                draftQuickReplies.remove(at: index)
                            } else {
                                draftQuickReplies = ManagerSettingsViewModel.defaultQuickReplyPresets
                            }
                        }
                    )
                }
                if draftQuickReplies.count < ManagerSettingsViewModel.maxQuickReplies {
                    Button {
                        draftQuickReplies.append("")
                    } label: {
                        Label("Add quick reply", systemImage: "plus.circle")
                    }
                }
            } else {
                Text("Only the business owner can edit message presets.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Message presets")
        } footer: {
            Text("Placeholders: {business} or {businessName}, {service} or {serviceName}. Quick replies appear when composing texts in Messages.")
                .font(.caption2)
        }
        .onChange(of: draftConfirmed) { _, v in viewModel.smsPresetConfirmed = v }
        .onChange(of: draftDeclined) { _, v in viewModel.smsPresetDeclined = v }
        .onChange(of: draftQuickReplies) { _, v in viewModel.smsQuickPresets = v }
    }

    @ViewBuilder
    private var clientMessagingSection: some View {
        Section {
            if authViewModel.isDemoMode {
                Text("Client texting is not available in demo mode.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if !viewModel.isTenantOwner {
                Text("Only the business owner can manage client texting.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if viewModel.subscriptionTrialing {
                trialingPaywallContent
            } else if !viewModel.subscriptionPaid {
                billingLinkContent
            } else if viewModel.smsStatus == "active", !viewModel.smsPhoneNumber.isEmpty {
                activeSmsContent
            } else if viewModel.isProvisioningSms || viewModel.smsStatus == "pending" {
                HStack {
                    ProgressView()
                    Text("Setting up your texting number…")
                        .font(.subheadline)
                }
            } else if viewModel.smsStatus == "failed" {
                failedSmsContent
            } else {
                enableSmsContent
            }
        } header: {
            Text("Your number")
        } footer: {
            if viewModel.isTenantOwner, !authViewModel.isDemoMode, viewModel.smsStatus == "active" {
                Text("If texts fail to send, use Refresh texting number.")
                    .font(.caption2)
            } else if viewModel.isTenantOwner, !authViewModel.isDemoMode, viewModel.subscriptionTrialing {
                Text(Constants.App.paidFeatureUpgradeMessage)
                    .font(.caption2)
            } else if viewModel.isTenantOwner, !authViewModel.isDemoMode {
                Text("Manage your plan under Account → Plan & billing.")
                    .font(.caption2)
            } else {
                Text("Dedicated local number for appointment texts to clients.")
                    .font(.caption2)
            }
        }
    }

    private var billingLinkContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Constants.App.paidFeatureUpgradeMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            startSubscriptionPrimaryButton
            billingSecondaryLinks
        }
    }

    private var trialingPaywallContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Constants.App.paidFeatureUpgradeMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            startSubscriptionPrimaryButton
            billingSecondaryLinks
        }
    }

    private var startSubscriptionPrimaryButton: some View {
        Button {
            showStartSubscriptionConfirm = true
        } label: {
            HStack {
                if viewModel.isOpeningBillingWebsite {
                    ProgressView()
                        .scaleEffect(0.9)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Start subscription today")
                        .font(.headline)
                    Text("Skip free trial · \(viewModel.tenantSubscriptionPlan.monthlyPriceLabel) · Unlock texting and payments")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.borderedProminent)
        .disabled(
            viewModel.isOpeningBillingWebsite ||
            viewModel.isSyncingBilling ||
            viewModel.isOpeningBillingPortal
        )
    }

    private var billingSecondaryLinks: some View {
        VStack(alignment: .leading, spacing: 8) {
            if viewModel.hasStripeBillingCustomer {
                Button {
                    Task { await viewModel.openStripeBillingPortal() }
                } label: {
                    HStack {
                        if viewModel.isOpeningBillingPortal { ProgressView().scaleEffect(0.9) }
                        Text("View Stripe account")
                            .font(.subheadline)
                    }
                }
                .disabled(
                    viewModel.isOpeningBillingPortal ||
                    viewModel.isOpeningBillingWebsite
                )
            } else {
                Button {
                    Task { await viewModel.openBillingToStartSubscription() }
                } label: {
                    HStack {
                        if viewModel.isOpeningBillingWebsite { ProgressView().scaleEffect(0.9) }
                        Text("Sign up for Stripe")
                            .font(.subheadline)
                    }
                }
                .disabled(
                    viewModel.isOpeningBillingWebsite ||
                    viewModel.isOpeningBillingPortal
                )
            }
        }
        .foregroundStyle(.secondary)
        .padding(.top, 4)
    }

    private var activeSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Active", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.green)
            Text(viewModel.smsPhoneDisplay)
                .font(.body.monospacedDigit())
            if viewModel.isProvisioningSms {
                HStack {
                    ProgressView()
                    Text("Refreshing your texting number…")
                        .font(.subheadline)
                }
            } else {
                Button {
                    Task { await viewModel.requestSmsProvisioning(consentAccepted: true, forceReprovision: true) }
                } label: {
                    Text("Refresh texting number")
                        .font(.subheadline)
                }
            }
        }
    }

    @ViewBuilder
    private var smsLinesSection: some View {
        Section {
            HStack {
                Text("Numbers in use")
                Spacer()
                Text("\(viewModel.smsLinesUsed) of \(viewModel.smsLineCapacity)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            HStack {
                Text("Included free")
                Spacer()
                Text("\(viewModel.smsFreeIncluded)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if viewModel.smsExtraPaid > 0 {
                HStack {
                    Text("Paid extras")
                    Spacer()
                    Text("\(viewModel.smsExtraPaid) × \(viewModel.smsExtraMonthlyPriceLabel)")
                        .foregroundStyle(.secondary)
                }
            }

            if viewModel.tenantSubscriptionPlan != .solo,
               viewModel.smsStatus == "active" {
                Button {
                    if viewModel.smsAtMaxLines {
                        return
                    }
                    if viewModel.smsNeedsPurchaseForNextLine {
                        Task { await viewModel.openBillingForExtraSmsLine() }
                    } else {
                        addNumberConsent = false
                        showAddNumberSheet = true
                    }
                } label: {
                    HStack {
                        if viewModel.isOpeningBillingWebsite || viewModel.isProvisioningMemberSms {
                            ProgressView().scaleEffect(0.9)
                        }
                        Image(systemName: "phone.badge.plus")
                        Text(
                            viewModel.smsNeedsPurchaseForNextLine
                                ? "Add a new number — \(viewModel.smsExtraMonthlyPriceLabel)"
                                : "Add a new number"
                        )
                    }
                }
                .disabled(
                    viewModel.smsAtMaxLines ||
                    viewModel.isOpeningBillingWebsite ||
                    viewModel.isProvisioningMemberSms
                )
            }

            if viewModel.smsAtMaxLines {
                Text("You’ve reached the max of \(viewModel.smsMaxLines) numbers on \(viewModel.tenantSubscriptionPlan.displayName).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Texting lines")
        } footer: {
            Text(
                viewModel.tenantSubscriptionPlan == .solo
                    ? "Solo includes 1 texting number."
                    : "\(viewModel.tenantSubscriptionPlan.displayName): \(viewModel.smsFreeIncluded) free numbers, then \(viewModel.smsExtraMonthlyPriceLabel) each, up to \(viewModel.smsMaxLines) (matches plan seats)."
            )
            .font(.caption2)
        }

        if !viewModel.membersWithPendingSmsLineRequest.isEmpty {
            Section {
                ForEach(viewModel.membersWithPendingSmsLineRequest) { member in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(member.displayName)
                            .font(.subheadline.weight(.medium))
                        Text("Requested a personal texting number.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 12) {
                            if viewModel.smsCanAddWithoutPurchase {
                                Button("Enable line") {
                                    Task {
                                        await viewModel.ownerEnablePersonalSmsLine(
                                            for: member.uid,
                                            consentAccepted: true
                                        )
                                    }
                                }
                                .disabled(viewModel.isProvisioningMemberSms)
                            } else {
                                Button("Add \(viewModel.smsExtraMonthlyPriceLabel)") {
                                    Task { await viewModel.openBillingForExtraSmsLine() }
                                }
                                .disabled(viewModel.isOpeningBillingWebsite)
                            }
                            Button("Dismiss", role: .destructive) {
                                Task { await viewModel.clearSmsLineRequest(memberUid: member.uid) }
                            }
                        }
                        .font(.subheadline)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("Number requests")
            } footer: {
                Text("Teammates use Messaging → Request phone number. Included lines are free; extras bill to your plan.")
                    .font(.caption2)
            }
        }
    }

    @ViewBuilder
    private var addNumberSheetContent: some View {
        List {
            Section {
                Text(
                    viewModel.smsNextLineIsFree
                        ? "An included number is available. Choose an independent teammate to enable their personal line (no extra charge)."
                        : "A paid slot is ready. Choose an independent teammate to enable their personal line."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
                Toggle("I agree clients may receive appointment-related texts on their line.", isOn: $addNumberConsent)
                    .font(.caption)
            }

            Section {
                let eligible = viewModel.membersEligibleForPersonalSms
                if eligible.isEmpty {
                    Text("No independent teammates without a number. Invite a member or set their payout mode to Independent under Team.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(eligible) { member in
                        Button {
                            Task {
                                await viewModel.ownerEnablePersonalSmsLine(
                                    for: member.uid,
                                    consentAccepted: addNumberConsent
                                )
                                if viewModel.errorMessage == nil {
                                    showAddNumberSheet = false
                                }
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName)
                                        .foregroundStyle(.primary)
                                    Text(member.badgeLabel)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if viewModel.isProvisioningMemberSms {
                                    ProgressView()
                                } else {
                                    Image(systemName: "plus.circle.fill")
                                }
                            }
                        }
                        .disabled(!addNumberConsent || viewModel.isProvisioningMemberSms)
                    }
                }
            } header: {
                Text("Team members")
            }

            if viewModel.smsNeedsPurchaseForNextLine || viewModel.membersEligibleForPersonalSms.isEmpty {
                Section {
                    Button {
                        showAddNumberSheet = false
                        Task { await viewModel.openBillingForExtraSmsLine() }
                    } label: {
                        Label(
                            "Pay \(viewModel.smsExtraMonthlyPriceLabel) for an extra number",
                            systemImage: "creditcard"
                        )
                    }
                }
            }

            if let msg = viewModel.errorMessage, !msg.isEmpty {
                Section {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Add a number")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { showAddNumberSheet = false }
            }
        }
    }

    private var failedSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(viewModel.smsProvisionError.isEmpty
                ? "Could not set up your number. Try again."
                : viewModel.smsProvisionError)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Try again") {
                smsConsentAccepted = false
                Task { await viewModel.requestSmsProvisioning(consentAccepted: true) }
            }
            .disabled(viewModel.isProvisioningSms)
        }
    }

    private var enableSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Get a dedicated local number for appointment texts.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Toggle("I agree clients may receive appointment-related texts.", isOn: $smsConsentAccepted)
                .font(.caption)
            Button {
                Task { await viewModel.requestSmsProvisioning(consentAccepted: smsConsentAccepted) }
            } label: {
                HStack {
                    if viewModel.isProvisioningSms { ProgressView().scaleEffect(0.9) }
                    Text("Enable client texting")
                }
            }
            .disabled(!smsConsentAccepted || viewModel.isProvisioningSms)
        }
    }

    @ViewBuilder
    private func presetRow(
        caption: String?,
        placeholder: String,
        text: Binding<String>,
        onRemove: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 8) {
                TextField(placeholder, text: text, axis: .vertical)
                    .lineLimit(caption == nil ? 1...3 : 3...6)
                Button(role: .destructive, action: onRemove) {
                    Image(systemName: "minus.circle.fill")
                }
                .buttonStyle(.borderless)
            }
        }
    }
}
