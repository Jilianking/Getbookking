//
//  TeamNotificationsSettingsView.swift
//

import SwiftUI

struct TeamNotificationsSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
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
                Text("Complete subscription billing to unlock client texting.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if viewModel.smsStatus == "active", !viewModel.smsPhoneNumber.isEmpty {
                activeSmsContent
            } else if viewModel.smsStatus == "pending" || viewModel.isProvisioningSms {
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
            Text("Text confirmations and declines from your own business number. Not included during the free trial.")
                .font(.caption2)
        }
    }

    private var trialingPaywallContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Client texting is available on a paid subscription. Your free trial does not include messaging.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
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
            .disabled(viewModel.isStartingSubscription)
        }
    }

    private var activeSmsContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Active", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.green)
            Text("Your client number")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(viewModel.smsPhoneDisplay)
                .font(.body.monospacedDigit())
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
