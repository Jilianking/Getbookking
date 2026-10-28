//
//  PlanChooserView.swift
//
//  The plans-and-prices block shared by sign-up and by "Choose a plan" for existing accounts:
//  plan cards with Apple's prices, what the free trial includes, a free trial or subscribe-now
//  choice, Apple's renewal terms, Terms / Privacy links and Restore purchases.
//

import SwiftUI

struct PlanChooserView: View {
    @ObservedObject var store: BookkingSubscriptionStore
    @Binding var isCharterPath: Bool
    @Binding var plan: SubscriptionPlan?
    /// Shows the Studios & Shops / Fishing Charters tabs, so every plan can be found.
    var showsPathPicker: Bool
    var isWorking: Bool
    var onPathChange: (Bool) -> Void = { _ in }
    var onPurchase: (SubscriptionPlan, _ payNow: Bool) -> Void
    var onRestore: () -> Void
    /// Shown as "Already have an account? Log in" when set.
    var onLogin: (() -> Void)?

    /// What the free trial includes and what waits for the paid plan.
    private let trialFeatures: [(label: String, inTrial: Bool)] = [
        ("Website & booking page", true),
        ("Bookings, calendar & clients", true),
        ("Design editor & team", true),
        ("Client texting", false),
        ("Payments & Tap to Pay", false),
    ]

    var selectedPlan: SubscriptionPlan {
        if isCharterPath { return .charter }
        if let plan, plan != .charter { return plan }
        return .solo
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if showsPathPicker {
                pathPicker
            }
            VStack(spacing: 10) {
                ForEach(isCharterPath ? [SubscriptionPlan.charter] : [.solo, .studio, .shop], id: \.self) { choice in
                    planCard(plan: choice, selected: selectedPlan == choice) {
                        plan = choice
                    }
                }
            }
            featureTable
            purchaseButtons
            VStack(alignment: .leading, spacing: 10) {
                Text(renewalTerms)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 14) {
                    Link("Terms of Use", destination: URL(string: Constants.Hosting.marketingTermsURL)!)
                    Link("Privacy Policy", destination: URL(string: Constants.Hosting.marketingPrivacyURL)!)
                    Button("Restore purchases", action: onRestore)
                        .disabled(isWorking)
                }
                .font(.footnote)
                .tint(AppDesign.brandWarm)
            }
            if let onLogin {
                HStack(spacing: 6) {
                    Text("Already have an account?")
                        .foregroundStyle(AppDesign.textSecondary)
                    Button("Log in", action: onLogin)
                        .fontWeight(.semibold)
                        .tint(AppDesign.brandWarm)
                        .disabled(isWorking)
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
            }
        }
    }

    private var pathPicker: some View {
        HStack(spacing: 4) {
            pathTab("Studios & Shops", charter: false)
            pathTab("Fishing Charters", charter: true)
        }
        .padding(4)
        .background(AppDesign.brandCream)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func pathTab(_ title: String, charter: Bool) -> some View {
        let on = isCharterPath == charter
        return Button {
            isCharterPath = charter
            if charter {
                plan = .charter
            } else if plan == .charter {
                plan = .solo
            }
            onPathChange(charter)
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(on ? AppDesign.textPrimary : AppDesign.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(on ? AppDesign.cardBackground : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var featureTable: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHAT’S IN EACH OPTION")
                .font(.caption2.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(AppDesign.textSecondary)
            Grid(alignment: .leading, horizontalSpacing: 6, verticalSpacing: 8) {
                GridRow {
                    Color.clear.frame(height: 1)
                    Text("Free trial").font(.caption2.weight(.semibold)).foregroundStyle(AppDesign.textSecondary)
                        .frame(width: 64)
                    Text("Paid now").font(.caption2.weight(.semibold)).foregroundStyle(AppDesign.textSecondary)
                        .frame(width: 64)
                }
                ForEach(trialFeatures, id: \.label) { feature in
                    GridRow {
                        Text(feature.label)
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Image(systemName: feature.inTrial ? "checkmark" : "lock")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(feature.inTrial ? AppDesign.accentGreen : AppDesign.brandWarm)
                            .frame(width: 64)
                            .accessibilityLabel(feature.inTrial ? "Included in free trial" : "Not in free trial")
                        Image(systemName: "checkmark")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppDesign.accentGreen)
                            .frame(width: 64)
                            .accessibilityLabel("Included when paid")
                    }
                }
            }
            Text("Client texting and payments unlock when your paid plan starts — automatically after the trial, or today if you subscribe now.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppDesign.chipBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var purchaseButtons: some View {
        let chosen = selectedPlan
        let price = store.displayPrice(for: chosen)
        VStack(spacing: 10) {
            if store.isEligibleForFreeTrial {
                purchaseButton(
                    title: "Start 14-day free trial",
                    detail: "Free for 14 days, then \(price)/month",
                    filled: true
                ) { onPurchase(chosen, false) }
                purchaseButton(
                    title: "Skip trial — subscribe now",
                    detail: "\(price)/month starting today · every feature",
                    filled: false
                ) { onPurchase(chosen, true) }
            } else {
                purchaseButton(
                    title: "Subscribe — \(price)/month",
                    detail: "Starts today · every feature",
                    filled: true
                ) { onPurchase(chosen, true) }
                Text("This Apple ID has already used its free trial.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            if isWorking {
                ProgressView("Opening Apple’s sheet…")
                    .font(.caption)
            }
        }
    }

    private func purchaseButton(title: String, detail: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .opacity(filled ? 0.85 : 1)
                    .foregroundStyle(filled ? AppDesign.brandCream : AppDesign.textSecondary)
            }
            .foregroundStyle(filled ? AppDesign.brandCream : AppDesign.brandDark)
            .frame(maxWidth: .infinity, minHeight: 56)
            .padding(.horizontal, 16)
            .background(filled ? AppDesign.brandDark : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(AppDesign.brandDark, lineWidth: filled ? 0 : 1.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .opacity(isWorking ? 0.5 : 1)
    }

    private var renewalTerms: String {
        let price = store.displayPrice(for: selectedPlan)
        let charged = store.isEligibleForFreeTrial
            ? "Payment is charged to your Apple ID when the trial ends, or today if you skip the trial."
            : "Payment is charged to your Apple ID today."
        return "\(selectedPlan.displayName) plan, \(price) per month. \(charged) Your subscription renews automatically each month unless you cancel at least 24 hours before the end of the current period. Manage or cancel anytime in your Apple ID settings."
    }

    private func planCard(plan choice: SubscriptionPlan, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle()
                        .stroke(selected ? AppDesign.brandDark : AppDesign.brandMuted, lineWidth: selected ? 2 : 1.5)
                        .frame(width: 22, height: 22)
                    if selected {
                        Circle().fill(AppDesign.brandDark).frame(width: 10, height: 10)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.displayName)
                        .font(.body.weight(.semibold))
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
            .frame(minHeight: 64)
            .background(AppDesign.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(selected ? AppDesign.brandDark : AppDesign.chipBorder, lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// "Choose a plan" for an account that already exists: an ended plan, a free trial, or a plan change.
struct PlanPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var authViewModel: AuthViewModel
    @StateObject private var store = BookkingSubscriptionStore.shared

    let currentPlan: SubscriptionPlan
    var planEnded = false
    var onPurchased: () -> Void = {}

    @State private var plan: SubscriptionPlan?
    @State private var isCharterPath = false
    @State private var isWorking = false
    @State private var errorMessage = ""
    @State private var infoMessage = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Choose a plan")
                        .font(AppDesign.screenHeaderFont(size: 30))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(planEnded
                         ? "Your plan has ended. Choose a plan to turn client texting and payments back on."
                         : "Pick the plan that fits your business.")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    PlanChooserView(
                        store: store,
                        isCharterPath: $isCharterPath,
                        plan: $plan,
                        showsPathPicker: true,
                        isWorking: isWorking,
                        onPurchase: { chosen, payNow in Task { await purchase(chosen, payNow: payNow) } },
                        onRestore: { Task { await restore() } }
                    )
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .disabled(isWorking)
                }
            }
            .interactiveDismissDisabled(isWorking)
            .task {
                isCharterPath = currentPlan == .charter
                plan = currentPlan
                await store.loadProducts()
                await store.refreshTrialEligibility()
            }
        }
    }

    private func purchase(_ chosen: SubscriptionPlan, payNow: Bool) async {
        isWorking = true
        errorMessage = ""
        infoMessage = ""
        defer { isWorking = false }
        do {
            let record = try await store.purchaseSubscription(plan: chosen, payNow: payNow)
            // Xcode's local receipts aren't Apple-signed; the server verifies every real one.
            if !record.isXcodeEnvironment {
                try await store.syncPurchase(record)
            }
            await authViewModel.refreshTeamAccess()
            NotificationCenter.default.post(name: .subscriptionDidChange, object: nil)
            onPurchased()
            dismiss()
        } catch let error as BookkingPurchaseError {
            if case .cancelled = error { return }
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    private func restore() async {
        isWorking = true
        errorMessage = ""
        infoMessage = ""
        defer { isWorking = false }
        do {
            if try await store.restorePurchases() {
                await authViewModel.refreshTeamAccess()
                NotificationCenter.default.post(name: .subscriptionDidChange, object: nil)
                onPurchased()
                dismiss()
            } else {
                infoMessage = "No active Get Bookking plan was found for this Apple ID."
            }
        } catch let error as BookkingPurchaseError {
            if case .cancelled = error { return }
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }
}

extension Notification.Name {
    /// A plan was bought or restored in the app; billing screens and banners refresh.
    static let subscriptionDidChange = Notification.Name("subscriptionDidChange")
}

/// Plan statuses that mean the paid plan is over (cancelled and run out, or unpaid).
enum PlanStatus {
    static func hasEnded(_ raw: String) -> Bool {
        ["canceled", "cancelled", "expired", "unpaid", "incomplete_expired"]
            .contains(raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}
