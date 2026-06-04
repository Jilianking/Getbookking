//
//  TeamNotificationsSettingsView.swift
//

import SwiftUI

struct TeamNotificationsSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var smsConsentAccepted = false

    var body: some View {
        List {
            clientMessagingSection

            Section(
                header: Text("Manager notifications"),
                footer: Text("Booking alerts are under Booking settings.")
                    .font(.caption2)
            ) {
                if viewModel.smsCanUse {
                    TeamPermissionToggle(
                        viewModel: viewModel,
                        title: "Send client text notifications",
                        keyPath: \.sendClientNotifications
                    )
                } else {
                    HStack {
                        Text("Send client text notifications")
                        Spacer()
                        Text("Requires client texting")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                TeamNotificationToggle(
                    viewModel: viewModel,
                    title: "Daily summary email",
                    keyPath: \.dailySummaryEmail
                )
            }

            TeamManagerPolicySaveSection(viewModel: viewModel, label: "Save")
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await viewModel.syncBillingAfterPortalIfNeeded() }
        }
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
            } else if viewModel.isProvisioningSms {
                HStack {
                    ProgressView()
                    Text("Setting up your texting number…")
                        .font(.subheadline)
                }
            } else if viewModel.smsStatus == "pending" {
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
            Text("Client texting")
        } footer: {
            if viewModel.isTenantOwner, !authViewModel.isDemoMode, viewModel.smsStatus == "active" {
                Text("If texts fail to send, use Refresh texting number to move your line onto the platform messaging service. You may get a new local number.")
                    .font(.caption2)
            } else if viewModel.isTenantOwner, !authViewModel.isDemoMode {
                Text("Subscription changes in Stripe (portal or Dashboard) sync via webhooks or Sync billing. Manage card, plan, and invoices in Stripe.")
                    .font(.caption2)
            } else {
                Text("Text confirmations and declines from your own business number. Not included during the free trial.")
                    .font(.caption2)
            }
        }
    }

    private var billingLinkContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Link your Stripe subscription to unlock client texting. If you already subscribed on the website, sync billing first.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            billingActionButtons
        }
    }

    private var trialingPaywallContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Client texting is available on a paid subscription. Your free trial does not include messaging.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            billingActionButtons
        }
    }

    private var billingActionButtons: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await viewModel.openStripeBillingPortal() }
            } label: {
                HStack {
                    if viewModel.isOpeningBillingPortal {
                        ProgressView()
                            .scaleEffect(0.9)
                    }
                    Text("Manage billing in Stripe")
                }
            }
            .disabled(
                viewModel.isOpeningBillingPortal ||
                viewModel.isSyncingBilling ||
                viewModel.isStartingSubscription
            )

            Button {
                Task { await viewModel.syncBillingFromStripe() }
            } label: {
                HStack {
                    if viewModel.isSyncingBilling {
                        ProgressView()
                            .scaleEffect(0.9)
                    }
                    Text("Sync billing from Stripe")
                }
            }
            .disabled(
                viewModel.isSyncingBilling ||
                viewModel.isStartingSubscription ||
                viewModel.isOpeningBillingPortal
            )

            Button {
                Task { await viewModel.startSubscriptionToday() }
            } label: {
                HStack {
                    if viewModel.isStartingSubscription {
                        ProgressView()
                            .scaleEffect(0.9)
                    }
                    Text("Start subscription today")
                }
            }
            .disabled(
                viewModel.isStartingSubscription ||
                viewModel.isSyncingBilling ||
                viewModel.isOpeningBillingPortal
            )
        }
    }

    private var activeSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Active", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.green)
            Text("Your client number")
                .font(.caption)
                .foregroundStyle(.secondary)
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
            Button {
                Task { await viewModel.openStripeBillingPortal() }
            } label: {
                Text("Manage billing in Stripe")
                    .font(.subheadline)
            }
            .disabled(viewModel.isOpeningBillingPortal || viewModel.isProvisioningSms)
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
            Text("Get a dedicated local number for appointment texts to clients.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Toggle("I agree clients may receive appointment-related texts. Message & data rates may apply.", isOn: $smsConsentAccepted)
                .font(.caption)
            Button {
                Task { await viewModel.requestSmsProvisioning(consentAccepted: smsConsentAccepted) }
            } label: {
                HStack {
                    if viewModel.isProvisioningSms {
                        ProgressView()
                            .scaleEffect(0.9)
                    }
                    Text("Enable client texting")
                }
            }
            .disabled(!smsConsentAccepted || viewModel.isProvisioningSms)
        }
    }
}
