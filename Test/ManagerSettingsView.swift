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

            if viewModel.isTenantOwner {
                Section {
                    Text("Studio team rules are in Settings → Team settings.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section(
                header: Text("Team members"),
                footer: viewModel.isTenantOwner
                    ? Text("Tap a member for job title, booking override, and payment split. Manager capabilities are set in Settings.")
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
        ZStack {
            Circle()
                .fill(Color(.secondarySystemGroupedBackground))
                .frame(width: 44, height: 44)
            Text(member.initials)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            if let url = URL(string: member.profilePhotoUrl), !member.profilePhotoUrl.isEmpty {
                AsyncImage(url: url) { phase in
                    if case .success(let img) = phase {
                        img.resizable().scaledToFill()
                    }
                }
                .frame(width: 44, height: 44)
                .clipShape(Circle())
            }
        }
    }
}

// MARK: - Invite sheet

private struct TeamInviteSheet: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @Environment(\.dismiss) private var dismiss

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
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Invite link ready")
                                .font(.subheadline.weight(.semibold))
                            Text(url.absoluteString)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                            Button {
                                UIPasteboard.general.string = url.absoluteString
                            } label: {
                                Label("Copy link", systemImage: "doc.on.doc")
                            }
                            ShareLink(item: url, subject: Text("Join our team"), message: Text("Open this link to join on Get Bookking.")) {
                                Label("Share link", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                }
            }
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
        var seen = Set<String>()
        var out: [TeamJobTitleOption] = []
        for opt in TeamJobTitleCatalog.primaryOptions(for: industry) + TeamJobTitleCatalog.allPresetOptions {
            let key = opt.label.lowercased()
            if seen.insert(key).inserted { out.append(opt) }
        }
        return out
    }
}
