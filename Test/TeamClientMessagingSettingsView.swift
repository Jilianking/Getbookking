//
//  TeamClientMessagingSettingsView.swift
//

import SwiftUI
import UIKit

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
    @State private var selectedSmsLine: SmsLineAssignmentRow?
    @State private var showRemoveNumberConfirm = false
    @State private var showSoloEnableChargeConfirm = false
    @State private var pendingAssignMember: TenantTeamMember?
    @State private var showAssignNumberConfirm = false
    @State private var removeLinePhase: RemoveLinePhase = .idle
    @State private var didCopySmsPhone = false

    private enum RemoveLinePhase: Equatable {
        case idle
        case removing
        case success
    }

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
        .sheet(isPresented: $showAddNumberSheet, onDismiss: {
            showAssignNumberConfirm = false
            pendingAssignMember = nil
        }) {
            NavigationStack {
                addNumberSheetContent
            }
            .presentationDetents([.medium, .large])
            .interactiveDismissDisabled(viewModel.isProvisioningMemberSms)
            // Dialog must sit on the sheet root — nested List dialogs often never appear.
            .confirmationDialog(
                assignConfirmTitle,
                isPresented: $showAssignNumberConfirm,
                titleVisibility: .visible
            ) {
                Button(assignConfirmActionTitle) {
                    guard let member = pendingAssignMember else { return }
                    Task {
                        if viewModel.smsMustChargeForNextLine {
                            _ = await viewModel.purchaseAndEnablePersonalSmsLine(
                                for: member.uid,
                                consentAccepted: true
                            )
                        } else {
                            await viewModel.ownerEnablePersonalSmsLine(
                                for: member.uid,
                                consentAccepted: true
                            )
                        }
                        if viewModel.errorMessage == nil {
                            showAddNumberSheet = false
                        }
                        pendingAssignMember = nil
                    }
                }
                Button("Cancel", role: .cancel) {
                    pendingAssignMember = nil
                }
            } message: {
                Text(assignConfirmMessage)
            }
        }
        .sheet(item: $selectedSmsLine, onDismiss: {
            removeLinePhase = .idle
            showRemoveNumberConfirm = false
            didCopySmsPhone = false
        }) { row in
            NavigationStack {
                smsLineDetailSheet(row)
            }
            .presentationDetents([.medium, .large])
            .interactiveDismissDisabled(removeLinePhase == .removing)
            .confirmationDialog(
                "Remove number for \(row.name)?",
                isPresented: $showRemoveNumberConfirm,
                titleVisibility: .visible
            ) {
                Button("Remove number", role: .destructive) {
                    Task { await runRemoveSmsLine(row) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(removeNumberConfirmMessage)
            }
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
            Button("Charge card & start") {
                Task { _ = await viewModel.startSubscriptionToday() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(startSubscriptionConfirmMessage)
        }
        .confirmationDialog(
            "Purchase a new texting number?",
            isPresented: $showSoloEnableChargeConfirm,
            titleVisibility: .visible
        ) {
            Button("Charge \(viewModel.smsExtraOneTimeReplacementLabel)") {
                Task { await viewModel.requestSmsProvisioning(consentAccepted: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "A \(viewModel.smsExtraOneTimeReplacementLabel) fee will be charged to your card on file. This is not added to your monthly subscription."
            )
        }
    }

    private var removeNumberConfirmMessage: String {
        if viewModel.tenantSubscriptionPlan == .solo {
            return "Releases this Twilio number permanently. Texts will stop. Your included number is used. Getting another later costs $12. This cannot be undone."
        }
        return "Releases this Twilio number permanently. Texts will stop. This cannot be undone."
    }

    private var startSubscriptionConfirmMessage: String {
        "Ends your free trial now and charges your card on file for \(viewModel.tenantSubscriptionPlan.monthlyPriceLabel). Client texting and payments unlock when the plan is active."
    }

    private var smsMonthlyLimitFooter: String {
        let limit = viewModel.smsMonthlyLimit > 0
            ? viewModel.smsMonthlyLimit
            : (viewModel.tenantSubscriptionPlan.isCharterPlan ? 750 : 1000)
        return "Each texting number has its own \(limit.formatted()) messages/month (inbound + outbound). Tap a person under Texting lines for their usage. Resets each calendar month (UTC)."
    }

    private func smsLineLimitFooter(for limit: Int) -> String {
        let cap = limit > 0 ? limit : (viewModel.tenantSubscriptionPlan.isCharterPlan ? 750 : 1000)
        return "Each number has \(cap.formatted()) texts per month (sent + received). Resets monthly (UTC)."
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
                Text("Studio line this month")
                Spacer()
                Text("\(viewModel.smsMonthlyUsageCount) of \(viewModel.smsMonthlyLimit)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        } header: {
            Text("Monthly limit")
        } footer: {
            Text(smsMonthlyLimitFooter)
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
            } else if viewModel.smsPhonePurchasingBlockedDuringTestFlight,
                      !(viewModel.smsStatus == "active" && !viewModel.smsPhoneNumber.isEmpty) {
                testFlightSmsBlockContent
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
            if viewModel.isTenantOwner,
               !authViewModel.isDemoMode,
               viewModel.smsPhonePurchasingBlockedDuringTestFlight,
               !(viewModel.smsStatus == "active" && !viewModel.smsPhoneNumber.isEmpty) {
                Text(viewModel.smsPhonePurchaseBlockedDisplayMessage)
                    .font(.caption2)
            } else if viewModel.isTenantOwner, !authViewModel.isDemoMode, viewModel.smsStatus == "active" {
                Text("Dedicated local number for appointment texts to clients.")
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

    private var testFlightSmsBlockContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Unavailable during TestFlight", systemImage: "phone.badge.waveform.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppDesign.brandWarm)
            Text(viewModel.smsPhonePurchaseBlockedDisplayMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("You can still explore billing in test mode and build your website in Design.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var trialingPaywallContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Constants.App.paidFeatureUpgradeMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            startSubscriptionPrimaryButton
            if let msg = viewModel.errorMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            billingSecondaryLinks
        }
    }

    private var billingLinkContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Constants.App.paidFeatureUpgradeMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            startSubscriptionPrimaryButton
            if let msg = viewModel.errorMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            billingSecondaryLinks
        }
    }

    private var startSubscriptionPrimaryButton: some View {
        Button {
            showStartSubscriptionConfirm = true
        } label: {
            HStack {
                if viewModel.isOpeningBillingWebsite || viewModel.isStartingSubscription {
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
            viewModel.isStartingSubscription ||
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
                    viewModel.isOpeningBillingWebsite ||
                    viewModel.isStartingSubscription
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
            if let studioRow = viewModel.smsLineAssignments.first(where: { $0.kind == .studio }) {
                Button {
                    selectedSmsLine = studioRow
                } label: {
                    HStack {
                        Text(viewModel.smsPhoneDisplay)
                            .font(.body.monospacedDigit())
                            .foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens number details")
            } else {
                Text(viewModel.smsPhoneDisplay)
                    .font(.body.monospacedDigit())
            }
            if viewModel.isProvisioningSms {
                HStack {
                    ProgressView()
                    Text("Setting up your texting number…")
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
                Text("\(viewModel.smsLinesUsed) of \(viewModel.smsMaxLines)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if viewModel.tenantSubscriptionPlan == .solo {
                HStack {
                    Text("Included")
                    Spacer()
                    Text("\(viewModel.smsFreeIncluded)")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            } else {
                HStack {
                    Text("Additional numbers")
                    Spacer()
                    Text(viewModel.smsExtraSubscriptionStatusLabel)
                        .foregroundStyle(.secondary)
                }
            }

            if !viewModel.smsLineAssignments.isEmpty {
                ForEach(viewModel.smsLineAssignments) { row in
                    if row.canRelease {
                        Button {
                            selectedSmsLine = row
                        } label: {
                            smsLineAssignmentRow(row)
                        }
                        .buttonStyle(.plain)
                    } else {
                        smsLineAssignmentRow(row)
                    }
                }
            }

            if viewModel.tenantSubscriptionPlan != .solo,
               viewModel.smsStatus == "active" {
                if viewModel.smsPhonePurchasingBlockedDuringTestFlight {
                    Text(viewModel.smsPhonePurchaseBlockedDisplayMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Button {
                        if viewModel.smsAtMaxLines {
                            return
                        }
                        addNumberConsent = false
                        showAddNumberSheet = true
                    } label: {
                        HStack {
                            Image(systemName: "phone.badge.plus")
                            Text(
                                viewModel.smsMustChargeForNextLine
                                    ? "Add a new number — \(viewModel.smsNextLinePurchaseLabel)"
                                    : "Add a new number"
                            )
                        }
                    }
                    .disabled(
                        viewModel.smsAtMaxLines ||
                        viewModel.isProvisioningMemberSms
                    )
                }
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
                    ? "Solo includes 1 texting number. After you remove it, getting another costs $12 (not monthly)."
                    : "Includes 2 numbers with no $12/mo extra while 2 or fewer are active. A 3rd line is $12 now + $12/mo. After your 2 free lifetime numbers, replacing a line costs $12 one-time until you exceed 2 concurrent lines."
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
                            if viewModel.smsPhonePurchasingBlockedDuringTestFlight {
                                Text(viewModel.smsPhonePurchaseBlockedDisplayMessage)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if viewModel.smsMustChargeForNextLine {
                                Button("Charge \(viewModel.smsNextLinePurchaseLabel) & enable") {
                                    Task {
                                        _ = await viewModel.purchaseAndEnablePersonalSmsLine(
                                            for: member.uid,
                                            consentAccepted: true
                                        )
                                    }
                                }
                                .disabled(viewModel.isProvisioningMemberSms)
                            } else {
                                Button("Enable line") {
                                    Task {
                                        await viewModel.ownerEnablePersonalSmsLine(
                                            for: member.uid,
                                            consentAccepted: true
                                        )
                                    }
                                }
                                .disabled(viewModel.isProvisioningMemberSms)
                            }
                            if viewModel.isProvisioningMember(uid: member.uid) {
                                ProgressView().scaleEffect(0.85)
                            }
                            Button("Dismiss", role: .destructive) {
                                Task { await viewModel.clearSmsLineRequest(memberUid: member.uid) }
                            }
                            .disabled(viewModel.isProvisioningMemberSms)
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
    private func smsLineAssignmentRow(_ row: SmsLineAssignmentRow) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: row.kind == .studio ? "building.2" : (row.kind == .open ? "phone.badge.plus" : "person.crop.circle"))
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 22, alignment: .center)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.primary)
                Text(row.roleLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if row.kind != .open {
                    Text(row.phoneDisplay)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(row.phone.isEmpty ? .secondary : .primary)
                    Text("\(row.usageLabel) texts")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(row.statusLabel)
                    .font(.caption)
                    .foregroundStyle(row.status == "active" ? Color.green : Color.secondary)
                    .multilineTextAlignment(.trailing)
                if row.canRelease {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func smsLineDetailSheet(_ row: SmsLineAssignmentRow) -> some View {
        ZStack {
            List {
                Section {
                    LabeledContent("Name", value: row.name)
                    LabeledContent("Type", value: row.roleLabel)
                    if row.phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        LabeledContent("Number", value: "—")
                    } else {
                        LabeledContent("Number") {
                            Text(row.phoneDisplay)
                                .monospacedDigit()
                                .foregroundStyle(.primary)
                                .overlay(alignment: .top) {
                                    if didCopySmsPhone {
                                        Text("Copied")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(.primary.opacity(0.9))
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 5)
                                            .background(
                                                Capsule()
                                                    .fill(.ultraThinMaterial)
                                                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                                            )
                                            .offset(y: -22)
                                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                                            .allowsHitTesting(false)
                                    }
                                }
                        }
                        .contentShape(Rectangle())
                        .onLongPressGesture(minimumDuration: 0.4) {
                            copySmsPhoneNumber(row.phone)
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                        .accessibilityHint("Long press to copy phone number")
                        .animation(.easeOut(duration: 0.18), value: didCopySmsPhone)
                        .zIndex(didCopySmsPhone ? 1 : 0)
                    }
                    LabeledContent("Status", value: row.statusLabel)
                }
                Section {
                    HStack {
                        Text("Used this month")
                        Spacer()
                        Text(row.usageLabel)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                } header: {
                    Text("Message usage")
                } footer: {
                    Text(smsLineLimitFooter(for: row.usageLimit))
                        .font(.caption2)
                }

                if row.canRelease {
                    Section {
                        Button(role: .destructive) {
                            showRemoveNumberConfirm = true
                        } label: {
                            Text(row.kind == .studio ? "Remove studio number" : "Remove number")
                        }
                        .disabled(
                            removeLinePhase != .idle ||
                            viewModel.isReleasingSmsLine
                        )
                    } footer: {
                        Text(
                            viewModel.tenantSubscriptionPlan == .solo
                                ? "Releases the number from Twilio. Your included number is used. Getting another later costs $12 (not monthly)."
                                : "Releases the number from Twilio. The person keeps their Bookking login; they can get a new number later if capacity allows."
                        )
                        .font(.caption2)
                    }
                }

                if let msg = viewModel.errorMessage, !msg.isEmpty,
                   removeLinePhase == .idle {
                    Section {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }

            if removeLinePhase == .removing {
                removeLineStatusOverlay(
                    title: "Removing \(row.name)…",
                    subtitle: "Releasing this texting number. Please wait.",
                    showSpinner: true,
                    showDoneButton: false
                )
            } else if removeLinePhase == .success {
                removeLineStatusOverlay(
                    title: "Removed \(row.name)",
                    subtitle: "Their texting number has been released. Texts will no longer send from this line.",
                    showSpinner: false,
                    showDoneButton: true
                )
            }
        }
        .navigationTitle(row.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { selectedSmsLine = nil }
                    .disabled(removeLinePhase == .removing)
            }
        }
    }

    private func copySmsPhoneNumber(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let value = PhoneFormatting.e164US(trimmed) ?? trimmed
        let pb = UIPasteboard.general
        pb.items = []
        pb.string = value
        withAnimation(.easeOut(duration: 0.18)) {
            didCopySmsPhone = true
        }
        Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await MainActor.run {
                withAnimation(.easeOut(duration: 0.15)) {
                    didCopySmsPhone = false
                }
            }
        }
    }

    @ViewBuilder
    private func removeLineStatusOverlay(
        title: String,
        subtitle: String,
        showSpinner: Bool,
        showDoneButton: Bool
    ) -> some View {
        Color.black.opacity(0.28)
            .ignoresSafeArea()
        VStack(spacing: 16) {
            if showSpinner {
                ProgressView()
                    .scaleEffect(1.15)
                    .padding(.bottom, 4)
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.green)
            }
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if showDoneButton {
                Button("Done") {
                    removeLinePhase = .idle
                    selectedSmsLine = nil
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            }
        }
        .padding(24)
        .frame(maxWidth: 320)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(24)
    }

    private func runRemoveSmsLine(_ row: SmsLineAssignmentRow) async {
        removeLinePhase = .removing
        viewModel.errorMessage = nil
        let ok: Bool
        if row.kind == .studio {
            ok = await viewModel.releaseSmsPhoneNumber(scope: "studio", memberUid: nil)
        } else {
            ok = await viewModel.releaseSmsPhoneNumber(
                scope: "personal",
                memberUid: row.memberUid
            )
        }
        if ok {
            removeLinePhase = .success
        } else {
            removeLinePhase = .idle
        }
    }

    @ViewBuilder
    private var addNumberSheetContent: some View {
        List {
            Section {
                Text(
                    viewModel.smsNextLineIsFree
                        ? "An included number is available. Choose an independent teammate to enable their personal line (no extra charge)."
                        : "This number requires \(viewModel.smsNextLinePurchaseLabel). Confirm in the next step, then we’ll set up their line."
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
                            guard addNumberConsent else {
                                viewModel.errorMessage =
                                    "Turn on the consent toggle above before enabling a line."
                                return
                            }
                            guard !viewModel.isProvisioningMemberSms else { return }
                            pendingAssignMember = member
                            showAssignNumberConfirm = true
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName)
                                        .font(.body)
                                        .foregroundStyle(Color.primary)
                                    Text(member.badgeLabel)
                                        .font(.caption)
                                        .foregroundStyle(Color.secondary)
                                }
                                Spacer()
                                if viewModel.isProvisioningMember(uid: member.uid) {
                                    ProgressView()
                                } else {
                                    Image(systemName: "plus.circle.fill")
                                        .foregroundStyle(
                                            addNumberConsent ? Color.accentColor : Color.secondary
                                        )
                                        .opacity(viewModel.isProvisioningMemberSms ? 0.35 : 1)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isProvisioningMemberSms && !viewModel.isProvisioningMember(uid: member.uid))
                    }
                }
            } header: {
                Text("Team members")
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
                    .disabled(viewModel.isProvisioningMemberSms)
            }
        }
    }

    private var assignConfirmTitle: String {
        let name = pendingAssignMember?.displayName ?? "this teammate"
        if viewModel.smsMustChargeForNextLine {
            return "Purchase number for \(name)?"
        }
        return "Assign number to \(name)?"
    }

    private var assignConfirmActionTitle: String {
        if viewModel.smsMustChargeForNextLine {
            return "Charge \(viewModel.smsNextLinePurchaseLabel) & assign"
        }
        return "Assign number"
    }

    private var assignConfirmMessage: String {
        let name = pendingAssignMember?.displayName ?? "this teammate"
        if viewModel.smsMustChargeForNextLine {
            if viewModel.smsMustChargeMonthlyForNextLine {
                return "Charge \(viewModel.smsExtraOneTimeReplacementLabel) now and add \(viewModel.smsExtraMonthlyPriceLabel) to your subscription, then set up \(name)’s texting number."
            }
            return "Charge your saved Stripe payment method \(viewModel.smsExtraOneTimeReplacementLabel), then set up \(name)’s texting number. No monthly extra while you have 2 or fewer lines."
        }
        return "Enable a personal texting number for \(name)? No extra charge — you have available capacity."
    }

    private var failedSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(viewModel.smsProvisionError.isEmpty
                ? "Could not set up your number. Try again."
                : viewModel.smsProvisionError)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button(viewModel.smsMustPaySoloReplacementFee
                   ? "Charge \(viewModel.smsExtraOneTimeReplacementLabel) & try again"
                   : "Try again") {
                smsConsentAccepted = false
                if viewModel.smsMustPaySoloReplacementFee {
                    showSoloEnableChargeConfirm = true
                } else {
                    Task { await viewModel.requestSmsProvisioning(consentAccepted: true) }
                }
            }
            .disabled(viewModel.isProvisioningSms)
        }
    }

    private var enableSmsContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(
                viewModel.smsMustPaySoloReplacementFee
                    ? "Your included number is used. Getting another costs \(viewModel.smsExtraOneTimeReplacementLabel). This fee is not added to your monthly subscription."
                    : "Get a dedicated local number for appointment texts."
            )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Toggle("I agree clients may receive appointment-related texts.", isOn: $smsConsentAccepted)
                .font(.caption)
            Button {
                if viewModel.smsMustPaySoloReplacementFee {
                    showSoloEnableChargeConfirm = true
                } else {
                    Task { await viewModel.requestSmsProvisioning(consentAccepted: smsConsentAccepted) }
                }
            } label: {
                HStack {
                    if viewModel.isProvisioningSms { ProgressView().scaleEffect(0.9) }
                    Text(
                        viewModel.smsMustPaySoloReplacementFee
                            ? "Purchase texting number — \(viewModel.smsExtraOneTimeReplacementLabel)"
                            : "Enable client texting"
                    )
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
