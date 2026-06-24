//
//  TeamMemberDetailView.swift
//
//  Owner: per-member job title, payment split; read-only personal booking type.
//

import SwiftUI
import FirebaseAuth

struct TeamMemberDetailView: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @EnvironmentObject var authViewModel: AuthViewModel
    let member: TenantTeamMember

    @Environment(\.dismiss) private var dismiss
    @State private var jobTitlePresetId: String = ""
    @State private var customJobTitle: String = ""
    @State private var memberSettings: TeamMemberSettings
    @State private var isBookable: Bool
    @State private var providerAboutText: String
    @State private var showRemoveConfirm = false
    @State private var showDemoteConfirm = false
    @State private var showPromoteConfirm = false

    init(viewModel: ManagerSettingsViewModel, member: TenantTeamMember) {
        self.viewModel = viewModel
        self.member = member
        _memberSettings = State(initialValue: member.memberSettings)
        _isBookable = State(initialValue: member.isBookable)
        _providerAboutText = State(initialValue: member.providerAboutText)
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let industry = viewModel.tenantIndustry
        let options = TeamJobTitleCatalog.options(for: industry)
        if let match = options.first(where: { $0.label.caseInsensitiveCompare(title) == .orderedSame }) {
            _jobTitlePresetId = State(initialValue: match.id)
            _customJobTitle = State(initialValue: "")
        } else if title.isEmpty {
            _jobTitlePresetId = State(initialValue: options.first?.id ?? "team_member")
            _customJobTitle = State(initialValue: "")
        } else {
            _jobTitlePresetId = State(initialValue: TeamJobTitleCatalog.customOptionId)
            _customJobTitle = State(initialValue: title)
        }
    }

    private var resolvedJobTitle: String {
        if jobTitlePresetId == TeamJobTitleCatalog.customOptionId {
            let c = customJobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return c.isEmpty ? TeamJobTitleCatalog.defaultTitle(for: viewModel.tenantIndustry) : String(c.prefix(60))
        }
        return TeamJobTitleCatalog.options(for: viewModel.tenantIndustry).first(where: { $0.id == jobTitlePresetId })?.label
            ?? TeamJobTitleCatalog.defaultTitle(for: viewModel.tenantIndustry)
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Text(member.initials)
                        .font(.caption.weight(.bold))
                        .frame(width: 44, height: 44)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 4) {
                        Text(member.displayName)
                            .font(.headline)
                        if !member.email.isEmpty {
                            Text(member.email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(member.badgeLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if member.isEditable && viewModel.isTenantOwner {
                if member.accessRole == .manager {
                    Section {
                        Text("Manager capabilities are set in Settings → Team settings.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                jobTitleSection
                bookingSection
                paymentSection
                actionsSection
            } else {
                Section(header: Text("Role")) {
                    LabeledContent("Access", value: member.accessRole.displayName)
                    if !member.jobTitle.isEmpty {
                        LabeledContent("Job title", value: member.jobTitle)
                    }
                }
                Section {
                    Text("Owner account settings are in Settings.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let err = viewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle(member.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if member.isEditable && viewModel.isTenantOwner {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(viewModel.isUpdatingMember)
                }
            }
        }
        .alert("Remove from team?", isPresented: $showRemoveConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) {
                Task {
                    await viewModel.removeFromTeam(uid: member.uid)
                    dismiss()
                }
            }
        } message: {
            Text("\(member.displayName) will lose access to this business.")
        }
        .alert("Make manager?", isPresented: $showPromoteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Make manager") {
                Task {
                    if await viewModel.promoteToManager(uid: member.uid) {
                        dismiss()
                    }
                }
            }
        } message: {
            Text("\(member.displayName) will get manager access based on your Team settings.")
        }
        .alert("Remove manager role?", isPresented: $showDemoteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Demote", role: .destructive) {
                Task {
                    if await viewModel.demoteManager(uid: member.uid) {
                        dismiss()
                    }
                }
            }
        } message: {
            Text("They will keep team access as a team member.")
        }
    }

    @ViewBuilder
    private var jobTitleSection: some View {
        if member.accessRole == .member {
            Section(header: Text("Job title")) {
                Picker("Title", selection: $jobTitlePresetId) {
                    ForEach(jobTitleOptions) { opt in
                        Text(opt.label).tag(opt.id)
                    }
                    Text("Custom…").tag(TeamJobTitleCatalog.customOptionId)
                }
                if jobTitlePresetId == TeamJobTitleCatalog.customOptionId {
                    TextField("Custom title", text: $customJobTitle)
                        .textInputAutocapitalization(.words)
                }
            }
        }
    }

    private var liveMember: TenantTeamMember {
        viewModel.member(byUid: member.uid) ?? member
    }

    private var ownerEditingMemberPortfolio: Bool {
        guard let currentUid = Auth.auth().currentUser?.uid else { return false }
        return viewModel.isTenantOwner && member.uid != currentUid
    }

    @ViewBuilder
    private var bookingSection: some View {
        if viewModel.tenantSubscriptionPlan.allowsTeamInvites {
            Section(
                header: Text("Online booking page"),
                footer: Text("When enabled, this person gets a bookable page on your studio site.")
                    .font(.caption2)
            ) {
                Toggle("Bookable on website", isOn: $isBookable)
                if isBookable, !member.memberSlug.isEmpty {
                    LabeledContent("Page path", value: "/\(member.memberSlug)")
                }
                TextField("Short bio (optional)", text: $providerAboutText, axis: .vertical)
                    .lineLimit(3...6)
                if isBookable {
                    NavigationLink {
                        ProviderPortfolioView(
                            teamViewModel: viewModel,
                            member: liveMember,
                            tenantId: viewModel.tenantId,
                            isDemoMode: authViewModel.isDemoMode,
                            ownerEditingMember: ownerEditingMemberPortfolio
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        Label("Portfolio photos", systemImage: "photo.stack")
                    }
                    if !liveMember.providerGalleryImages.isEmpty {
                        Text("\(liveMember.providerGalleryImages.count) photo\(liveMember.providerGalleryImages.count == 1 ? "" : "s") on their booking page")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        Section(
            header: Text("Booking"),
            footer: Text(bookingSectionFooter)
                .font(.caption2)
        ) {
            LabeledContent("Booking type", value: member.personalBookingTypeDisplayName)
        }
    }

    private var bookingSectionFooter: String {
        if viewModel.managersApproveAppointments {
            return "Set by owner in Settings → Booking settings."
        }
        return "Self-managed — they set this in Settings → My booking type."
    }

    @ViewBuilder
    private var paymentSection: some View {
        Section(
            header: Text("Payments"),
            footer: Text(paymentSectionFooter)
                .font(.caption2)
        ) {
            Picker("Payout mode", selection: $memberSettings.payoutMode) {
                ForEach(MemberPayoutMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
        }
        Section(
            header: Text("Payment split"),
            footer: Text("Split is calculated on the service/deposit amount (before the card processing fee added at checkout). Unassigned bookings stay with the studio.")
                .font(.caption2)
        ) {
            Toggle("Enable payment split", isOn: $memberSettings.paymentSplitEnabled)
                .onChange(of: memberSettings.paymentSplitEnabled) { _, enabled in
                    if enabled, memberSettings.paymentSplitPercent < 5 {
                        memberSettings.paymentSplitPercent = 70
                    }
                }
            if memberSettings.paymentSplitEnabled {
                Stepper(
                    value: $memberSettings.paymentSplitPercent,
                    in: 5...100,
                    step: 5
                ) {
                    HStack {
                        Text("Artist share")
                        Spacer()
                        Text("\(memberSettings.paymentSplitPercent)%")
                            .foregroundStyle(.secondary)
                    }
                }
                Picker("Applies to", selection: $memberSettings.paymentSplitAppliesTo) {
                    ForEach(PaymentSplitAppliesTo.allCases) { opt in
                        Text(opt.displayName).tag(opt)
                    }
                }
            }
        }
    }

    private var paymentSectionFooter: String {
        switch memberSettings.payoutMode {
        case .independent:
            return "They connect their own Stripe and can use Tap to Pay. Deposits for their assigned bookings go to their account."
        case .studioPayroll:
            return "Charges go to the studio Connect account. Use payment split for revenue reporting."
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        Section {
            if member.accessRole == .member {
                Button("Make manager") {
                    showPromoteConfirm = true
                }
            }
            if member.accessRole == .manager {
                Button("Remove manager role", role: .destructive) {
                    showDemoteConfirm = true
                }
            }
            Button("Remove from team", role: .destructive) {
                showRemoveConfirm = true
            }
        }
    }

    private var jobTitleOptions: [TeamJobTitleOption] {
        TeamJobTitleCatalog.options(for: viewModel.tenantIndustry)
    }

    private func save() async {
        memberSettings.useStudioBookingPolicy = false
        memberSettings.bookingConfirmationOverride = nil
        let title = member.accessRole == .manager ? "Manager" : resolvedJobTitle
        let ok = await viewModel.saveMemberSettings(
            memberUid: member.uid,
            accessRole: member.accessRole,
            jobTitle: title,
            memberSettings: memberSettings,
            isBookable: isBookable,
            providerAboutText: providerAboutText.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        if ok { dismiss() }
    }
}
