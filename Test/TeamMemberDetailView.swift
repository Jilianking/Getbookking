//
//  TeamMemberDetailView.swift
//
//  Owner: per-member job title, booking override, payment split.
//

import SwiftUI

struct TeamMemberDetailView: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    let member: TenantTeamMember

    @Environment(\.dismiss) private var dismiss
    @State private var jobTitlePresetId: String = ""
    @State private var customJobTitle: String = ""
    @State private var memberSettings: TeamMemberSettings
    @State private var showRemoveConfirm = false
    @State private var showDemoteConfirm = false
    @State private var showPromoteConfirm = false

    init(viewModel: ManagerSettingsViewModel, member: TenantTeamMember) {
        self.viewModel = viewModel
        self.member = member
        _memberSettings = State(initialValue: member.memberSettings)
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let industry = viewModel.tenantIndustry
        let options = TeamJobTitleCatalog.primaryOptions(for: industry)
            + TeamJobTitleCatalog.allPresetOptions
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

    private var studioConfirmationLabel: String {
        let type = BookingConfirmationType(rawValue: viewModel.tenantDefaultConfirmationType)
            ?? .requestApprove
        return type.displayName
    }

    private var resolvedJobTitle: String {
        if jobTitlePresetId == TeamJobTitleCatalog.customOptionId {
            let c = customJobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return c.isEmpty ? TeamJobTitleCatalog.defaultTitle(for: viewModel.tenantIndustry) : String(c.prefix(60))
        }
        let all = TeamJobTitleCatalog.primaryOptions(for: viewModel.tenantIndustry)
            + TeamJobTitleCatalog.allPresetOptions
        return all.first(where: { $0.id == jobTitlePresetId })?.label
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

    @ViewBuilder
    private var bookingSection: some View {
        Section(
            header: Text("Booking"),
            footer: Text("Studio default: \(studioConfirmationLabel). Set in Settings → Booking policy.")
                .font(.caption2)
        ) {
            Toggle("Use studio booking policy", isOn: $memberSettings.useStudioBookingPolicy)
            if !memberSettings.useStudioBookingPolicy {
                Picker("Booking type", selection: bookingOverrideBinding) {
                    ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                        Text(type.displayName).tag(type.rawValue)
                    }
                }
            }
        }
    }

    private var bookingOverrideBinding: Binding<String> {
        Binding(
            get: {
                memberSettings.bookingConfirmationOverride
                    ?? viewModel.tenantDefaultConfirmationType
            },
            set: { memberSettings.bookingConfirmationOverride = $0 }
        )
    }

    @ViewBuilder
    private var paymentSection: some View {
        Section(
            header: Text("Payment split"),
            footer: Text("Percentage of service/deposit revenue attributed to this person for reporting. Payout routing is not configured yet.")
                .font(.caption2)
        ) {
            Stepper(
                value: $memberSettings.paymentSplitPercent,
                in: 0...100,
                step: 5
            ) {
                HStack {
                    Text("Split")
                    Spacer()
                    Text("\(memberSettings.paymentSplitPercent)%")
                        .foregroundStyle(.secondary)
                }
            }
            if memberSettings.paymentSplitPercent > 0 {
                Picker("Applies to", selection: $memberSettings.paymentSplitAppliesTo) {
                    ForEach(PaymentSplitAppliesTo.allCases) { opt in
                        Text(opt.displayName).tag(opt)
                    }
                }
            }
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
        var seen = Set<String>()
        var out: [TeamJobTitleOption] = []
        for opt in TeamJobTitleCatalog.primaryOptions(for: viewModel.tenantIndustry)
            + TeamJobTitleCatalog.allPresetOptions {
            if seen.insert(opt.label.lowercased()).inserted { out.append(opt) }
        }
        return out
    }

    private func save() async {
        let title = member.accessRole == .manager ? "Manager" : resolvedJobTitle
        let ok = await viewModel.saveMemberSettings(
            memberUid: member.uid,
            accessRole: member.accessRole,
            jobTitle: title,
            memberSettings: memberSettings
        )
        if ok { dismiss() }
    }
}
