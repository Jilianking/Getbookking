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

    var body: some View {
        List {
            clientMessagingSection
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
        let price = viewModel.tenantSubscriptionPlan.monthlyPriceLabel
        return """
        You’ll finish on getbookking.com. Your card on file will be charged \(price) today, \
        skipping your free trial. Return to the app afterward to enable client texting.
        """
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
                Text("Client texting is not included during the free trial. Payment completes on getbookking.com.")
                    .font(.caption2)
            } else if viewModel.isTenantOwner, !authViewModel.isDemoMode {
                Text("Already paid on the website? Pull to refresh or use Sync billing below.")
                    .font(.caption2)
            } else {
                Text("Dedicated local number for appointment texts to clients.")
                    .font(.caption2)
            }
        }
    }

    private var billingLinkContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Link your Stripe subscription to unlock client texting.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            startSubscriptionPrimaryButton
            billingSecondaryLinks
        }
    }

    private var trialingPaywallContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Client texting starts after your paid subscription begins.")
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
                    Text("Skip free trial · \(viewModel.tenantSubscriptionPlan.monthlyPriceLabel) · Unlock texting")
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
            Button {
                Task { await viewModel.syncBillingFromStripe() }
            } label: {
                HStack {
                    if viewModel.isSyncingBilling { ProgressView().scaleEffect(0.9) }
                    Text("Sync billing from Stripe")
                        .font(.subheadline)
                }
            }
            .disabled(
                viewModel.isSyncingBilling ||
                viewModel.isOpeningBillingWebsite ||
                viewModel.isOpeningBillingPortal
            )

            Button {
                Task { await viewModel.openStripeBillingPortal() }
            } label: {
                HStack {
                    if viewModel.isOpeningBillingPortal { ProgressView().scaleEffect(0.9) }
                    Text("Manage billing in Stripe")
                        .font(.subheadline)
                }
            }
            .disabled(
                viewModel.isOpeningBillingPortal ||
                viewModel.isSyncingBilling ||
                viewModel.isOpeningBillingWebsite
            )
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
