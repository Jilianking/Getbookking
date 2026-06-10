//
//  ManagerSettingsView.swift
//
//  Team roster, invites, per-member detail. Policy toggles live in Settings → Team settings.
//

import SwiftUI
import UIKit

struct ManagerSettingsView: View {
    /// When false, parent `TeamView` supplies the navigation title.
    var showInlineNavigationTitle: Bool = true

    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    init(viewModel: ManagerSettingsViewModel, showInlineNavigationTitle: Bool = true) {
        self.viewModel = viewModel
        self.showInlineNavigationTitle = showInlineNavigationTitle
    }

    var body: some View {
        List {
            if viewModel.isLoading && viewModel.members.isEmpty {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }

            if !authViewModel.isDemoMode && !viewModel.tenantSubscriptionPlan.allowsTeamInvites {
                Section {
                    Text("Solo is owner only. Upgrade to Studio or Shop to invite team members.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if viewModel.isTenantOwner && viewModel.tenantSubscriptionPlan.allowsTeamInvites {
                Section {
                    Text("Studio team rules are in Settings → Team settings.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section(
                header: Text("Team members"),
                footer: viewModel.isTenantOwner
                    ? Text("Tap a member for job title and payment split. Manager capabilities are set in Settings.")
                        .font(.caption2)
                    : Text("Your access is based on roles & permissions in Settings.")
                        .font(.caption2)
            ) {
                ForEach(viewModel.members) { member in
                    if viewModel.isTenantOwner && member.isEditable {
                        NavigationLink {
                            TeamMemberDetailView(viewModel: viewModel, member: member)
                        } label: {
                            TeamMemberRow(member: member)
                        }
                    } else {
                        TeamMemberRow(member: member)
                    }
                }
                if viewModel.isTenantOwner && viewModel.tenantSubscriptionPlan.allowsTeamInvites {
                    Button {
                        viewModel.presentInviteSheet = true
                    } label: {
                        Label("Invite team member", systemImage: "plus")
                            .font(.subheadline.weight(.medium))
                    }
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
        .modifier(TeamManagementNavigationTitle(show: showInlineNavigationTitle))
        .sheet(isPresented: $viewModel.presentInviteSheet) {
            TeamInviteSheet(viewModel: viewModel)
        }
    }

}

// MARK: - Member row

private struct TeamManagementNavigationTitle: ViewModifier {
    let show: Bool

    func body(content: Content) -> some View {
        if show {
            content
                .navigationTitle("Team")
                .navigationBarTitleDisplayMode(.inline)
        } else {
            content
        }
    }
}

struct TeamMemberRow: View {
    let member: TenantTeamMember

    var body: some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                Text(member.displayName)
                    .font(.subheadline.weight(.semibold))
                if !member.email.isEmpty {
                    Text(member.email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(member.badgeLabel)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(badgeColor.opacity(0.15))
                    .foregroundStyle(badgeColor)
                    .clipShape(Capsule())
                if member.personalBookingTypeDisplayName != "Not set yet" {
                    Text(member.personalBookingTypeDisplayName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let split = member.paymentSplitSummary {
                    Text(split)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var badgeColor: Color {
        switch member.accessRole {
        case .owner: return .primary
        case .manager: return .blue
        case .member: return .secondary
        }
    }

    @ViewBuilder
    private var avatar: some View {
        AppAvatarView(
            tenantLogoURL: nil,
            accountPhotoURL: member.profilePhotoUrl.isEmpty ? nil : member.profilePhotoUrl,
            displayNameFallback: member.displayName,
            size: 44
        )
    }
}

// MARK: - Invite sheet

private struct TeamInviteSheet: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var inviteLinkCopied = false

  var body: some View {
        NavigationStack {
            Form {
                Section(
                    header: Text("Job title"),
                    footer: Text("Invite links always add team members. Use Team to change someone to manager after they join.")
                        .font(.caption2)
                ) {
                    Picker("Title", selection: $viewModel.inviteJobTitlePresetId) {
                        ForEach(inviteTitleOptions(for: viewModel.tenantIndustry)) { opt in
                            Text(opt.label).tag(opt.id)
                        }
                        Text("Custom…").tag(TeamJobTitleCatalog.customOptionId)
                    }
                    if viewModel.inviteJobTitlePresetId == TeamJobTitleCatalog.customOptionId {
                        TextField("Custom title", text: $viewModel.inviteCustomJobTitle)
                            .textInputAutocapitalization(.words)
                    }
                }

                Section {
                    Button {
                        Task { await viewModel.createTeamInviteLink() }
                    } label: {
                        HStack {
                            Text("Create invite link")
                            if viewModel.isCreatingTeamInvite {
                                Spacer()
                                ProgressView().scaleEffect(0.9)
                            }
                        }
                    }
                    .disabled(viewModel.isCreatingTeamInvite)

                    if let err = viewModel.teamInviteError {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }

                    if let url = viewModel.teamInviteShareURL {
                        let linkString = url.absoluteString
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Invite link ready")
                                .font(.subheadline.weight(.semibold))
                            Text(linkString)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Tap Copy link — don’t select the preview above, or the invite token may be cut off.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Button {
                                copyInviteLink(linkString)
                            } label: {
                                Label(
                                    inviteLinkCopied ? "Copied" : "Copy link",
                                    systemImage: inviteLinkCopied ? "checkmark.circle.fill" : "doc.on.doc"
                                )
                            }
                            ShareLink(item: Self.inviteShareMessage(linkString: linkString)) {
                                Label("Share link", systemImage: "square.and.arrow.up")
                            }
                        }
                        .onChange(of: viewModel.teamInviteShareURL) { _, _ in
                            inviteLinkCopied = false
                        }
                    }
                }
            }
            .appListSurface()
            .navigationTitle("Invite team member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if viewModel.inviteJobTitlePresetId.isEmpty,
                   let first = TeamJobTitleCatalog.primaryOptions(for: viewModel.tenantIndustry).first {
                    viewModel.inviteJobTitlePresetId = first.id
                }
            }
        }
    }

    private func inviteTitleOptions(for industry: String) -> [TeamJobTitleOption] {
        TeamJobTitleCatalog.options(for: industry)
    }

    /// Plain URL only — no message. Avoid `UIPasteboard.url` (breaks iMessage with bplist paste).
    private func copyInviteLink(_ linkString: String) {
        let pb = UIPasteboard.general
        pb.items = []
        pb.string = linkString
        inviteLinkCopied = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await MainActor.run { inviteLinkCopied = false }
        }
    }

    private static func inviteShareMessage(linkString: String) -> String {
        "Join our team on Get Bookking:\n\(linkString)"
    }
}
