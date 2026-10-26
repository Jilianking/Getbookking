//
//  PlanBillingView.swift
//
//  Settings → Account → Plan & billing: the current plan and its status, Choose a plan,
//  Apple's Manage subscription sheet and Restore purchases.
//

import SwiftUI
import StoreKit

struct PlanBillingView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @StateObject private var billing = ManagerSettingsViewModel()
    @State private var showPlanPicker = false
    @State private var showManageSubscriptions = false

    var body: some View {
        List {
            Section {
                HStack {
                    Text("Current plan")
                    Spacer()
                    Text(billing.tenantSubscriptionPlan.displayName)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("Status")
                    Spacer()
                    Text(PlanBillingStatus.label(for: billing))
                        .foregroundStyle(PlanBillingStatus.color(for: billing))
                }
                if PlanStatus.hasEnded(billing.subscriptionStatus) {
                    Text("Your plan has ended. Client texting and payments are off until you choose a plan.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if billing.subscriptionTrialing {
                    Text("Your free trial includes the website builder, bookings and team. Client texting and payments unlock when your paid plan starts.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section(
                footer: Text("Plans are billed monthly through your Apple ID. Manage subscription opens Apple’s page to change or cancel. Restore purchases brings back a plan you already paid for with this Apple ID.")
                    .font(.caption2)
            ) {
                Button("Choose a plan") { showPlanPicker = true }
                Button("Manage subscription") { showManageSubscriptions = true }
                Button {
                    Task { await billing.restorePurchases() }
                } label: {
                    HStack {
                        if billing.isRestoringPurchases {
                            ProgressView().scaleEffect(0.9)
                        }
                        Text("Restore purchases")
                    }
                }
                .disabled(billing.isRestoringPurchases)
                if let message = billing.restorePurchasesMessage, !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let error = billing.errorMessage, !error.isEmpty {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle("Plan & billing")
        .navigationBarTitleDisplayMode(.inline)
        .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
        .sheet(isPresented: $showPlanPicker) {
            PlanPickerSheet(
                currentPlan: billing.tenantSubscriptionPlan,
                planEnded: PlanStatus.hasEnded(billing.subscriptionStatus)
            )
            .environmentObject(authViewModel)
        }
        .task {
            await billing.load(isDemoMode: authViewModel.isDemoMode)
        }
        .onChange(of: showManageSubscriptions) { _, showing in
            // Apple's sheet may have changed or cancelled the plan.
            if !showing { Task { await billing.load(isDemoMode: authViewModel.isDemoMode) } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .subscriptionDidChange)) { _ in
            Task { await billing.load(isDemoMode: authViewModel.isDemoMode) }
        }
    }
}

/// How a plan's status reads in Settings.
enum PlanBillingStatus {
    static func label(for billing: ManagerSettingsViewModel) -> String {
        if billing.subscriptionPaid { return "Active" }
        if billing.subscriptionTrialing { return "Free trial" }
        let raw = billing.subscriptionStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if PlanStatus.hasEnded(raw) { return "Plan ended" }
        if raw == "past_due" || raw == "incomplete" { return "Payment issue" }
        if raw.isEmpty { return "No plan" }
        return raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func color(for billing: ManagerSettingsViewModel) -> Color {
        if billing.subscriptionPaid { return AppDesign.accentGreen }
        if billing.subscriptionTrialing { return .secondary }
        return AppDesign.statusPending
    }
}
