//
//  TeamView.swift
//
//  Drawer destination: roster, invites, per-member config; policy is in Settings → Team settings.
//

import SwiftUI
import FirebaseAuth

struct TeamView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var teamViewModel = ManagerSettingsViewModel()
    @State private var hasLoadedTeamContext = false
    var drawerState: DrawerState
    let sectionTitle: String

    private var showsOwnerTeamUI: Bool {
        authViewModel.isDemoMode
            || authViewModel.teamAccess.isOwner
            || teamViewModel.isTenantOwner
    }

    var body: some View {
        NavigationStack {
            Group {
                if !hasLoadedTeamContext && !authViewModel.isDemoMode {
                    ProgressView("Loading team…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if showsOwnerTeamUI,
                          teamViewModel.tenantSubscriptionPlan.usesBusinessSettingsHub {
                    SoloOwnerTeamPlaceholderView()
                        .environmentObject(authViewModel)
                } else if showsOwnerTeamUI {
                    ManagerSettingsView(
                        viewModel: teamViewModel,
                        showInlineNavigationTitle: false
                    )
                    .environmentObject(authViewModel)
                } else {
                    TeamMemberOverviewContent(viewModel: teamViewModel, drawerState: drawerState)
                        .environmentObject(authViewModel)
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(showsOwnerTeamUI ? .large : .inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
                if showsOwnerTeamUI && hasLoadedTeamContext && teamViewModel.tenantSubscriptionPlan.allowsTeamInvites {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            teamViewModel.teamInviteShareURL = nil
                            teamViewModel.teamInviteError = nil
                            teamViewModel.presentInviteSheet = true
                        } label: {
                            Image(systemName: "person.badge.plus")
                        }
                        .accessibilityLabel("Invite team member")
                    }
                }
            }
        }
        .task(id: authViewModel.currentUserUid) {
            await reloadTeamContext()
        }
        .refreshable {
            await reloadTeamContext()
        }
    }

    private func reloadTeamContext() async {
        if authViewModel.isDemoMode {
            await teamViewModel.load(isDemoMode: true)
            hasLoadedTeamContext = true
            return
        }
        async let access: () = authViewModel.refreshTeamAccess()
        async let roster: () = teamViewModel.load(isDemoMode: false)
        _ = await (access, roster)
        if teamViewModel.isTenantOwner && !authViewModel.teamAccess.isOwner {
            await authViewModel.refreshTeamAccess()
        }
        hasLoadedTeamContext = true
    }
}

// MARK: - Solo owner (Team drawer hidden; fallback if navigated here)

private struct SoloOwnerTeamPlaceholderView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Solo plan", systemImage: "person.fill")
        } description: {
            Text("Your plan is owner-only. Manage booking, design, and client texting under Settings → Business settings, or open Messages and tap the gear icon.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Non-owner: my agreement + team directory

private struct TeamMemberOverviewContent: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel
    var drawerState: DrawerState
    @State private var selectedDirectoryMember: TenantTeamMember?

    private var currentMember: TenantTeamMember? {
        guard let uid = Auth.auth().currentUser?.uid else { return nil }
        return viewModel.members.first { $0.uid == uid }
    }

    var body: some View {
        List {
            if authViewModel.teamAccess.canAccessWebsiteProfile {
                Section {
                    Label {
                        Text("Website profile")
                            .foregroundStyle(AppDesign.textPrimary)
                    } icon: {
                        Image(systemName: "globe")
                            .foregroundStyle(AppDesign.brandWarm)
                    }
                    Text("Your owner enabled editing for your public page. Preview your team page, then tap Manage to update Gallery or Bio.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }

            if authViewModel.teamAccess.usesOwnPayments {
                Section {
                    NavigationLink {
                        PaymentsView(drawerState: drawerState, sectionTitle: "Payments")
                            .environmentObject(authViewModel)
                    } label: {
                        Label {
                            Text(
                                authViewModel.teamAccess.canTakePayments
                                    ? "My payments"
                                    : "Set up payments"
                            )
                            .foregroundStyle(AppDesign.textPrimary)
                        } icon: {
                            Image(systemName: "creditcard")
                                .foregroundStyle(AppDesign.brandWarm)
                        }
                    }
                } footer: {
                    Text("You take your own payments. Connect Stripe to accept deposits and Tap to Pay for your bookings.")
                        .font(.caption2)
                }
            }

            if authViewModel.teamAccess.usesOwnPayments, authViewModel.teamAccess.studioSmsActive {
                Section {
                    NavigationLink {
                        if let me = currentMember {
                            MemberPersonalSmsView(
                                viewModel: viewModel,
                                member: me,
                                ownerEditingMember: false
                            )
                            .environmentObject(authViewModel)
                        }
                    } label: {
                        Label {
                            Text(
                                authViewModel.teamAccess.usesOwnSms
                                    ? "Messaging"
                                    : "Request phone number"
                            )
                            .foregroundStyle(AppDesign.textPrimary)
                        } icon: {
                            Image(systemName: "message.fill")
                                .foregroundStyle(AppDesign.brandWarm)
                        }
                    }
                    if authViewModel.teamAccess.usesOwnSms {
                        LabeledContent(
                            "Your number",
                            value: PhoneFormatting.displayUS(authViewModel.teamAccess.memberSmsPhoneNumber)
                        )
                    }
                } footer: {
                    Text("Text clients from your own number. Each personal line has its own monthly SMS limit.")
                        .font(.caption2)
                }
            }

            if let me = currentMember, me.isBookable, !me.memberSlug.isEmpty {
                Section(header: Text("Your booking page")) {
                    LabeledContent("Share link", value: PublicBookingSite.memberBookPath(memberSlug: me.memberSlug))
                    Text("Clients can book you directly from your studio website.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            }

            Section {
                DisclosureGroup {
                    agreementDetails
                } label: {
                    HStack {
                        Text("Access")
                            .foregroundStyle(AppDesign.textPrimary)
                        Spacer()
                        Text(authViewModel.teamAccess.accessRole.displayName)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            } header: {
                Text("My role")
            } footer: {
                Text("Terms are set by your studio owner. Contact them to request changes.")
                    .font(.caption2)
            }

            if !viewModel.members.isEmpty {
                Section(header: Text("Team members")) {
                    ForEach(viewModel.members) { member in
                        Button {
                            selectedDirectoryMember = member
                        } label: {
                            TeamMemberDirectoryRow(member: member)
                        }
                        .buttonStyle(.plain)
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
        .tint(AppDesign.brandWarm)
        .listStyle(.insetGrouped)
        .appListSurface()
        .contentMargins(.top, 8, for: .scrollContent)
        .sheet(item: $selectedDirectoryMember) { member in
            TeamMemberContactSheet(member: member)
        }
    }

    @ViewBuilder
    private var agreementDetails: some View {
        if let me = currentMember {
            LabeledContent("Job title", value: me.badgeLabel)
            LabeledContent("Booking type", value: me.personalBookingTypeDisplayName)
            if let split = me.paymentSplitSummary(forIndustry: viewModel.tenantIndustry) {
                LabeledContent("Payment split", value: split)
                Text("Split applies to the service amount before any card processing fee at checkout.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("No payment split configured for you.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let payout = me.payoutModeSummary {
                LabeledContent("Payments", value: payout)
            }
        } else {
            LabeledContent("Role", value: authViewModel.teamAccess.accessRole.displayName)
            Text("Your studio profile is still loading. Pull to refresh if details are missing.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Staff roster: name + role; tap for contact

struct TeamMemberDirectoryRow: View {
    let member: TenantTeamMember

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: member.profilePhotoUrl.isEmpty ? nil : member.profilePhotoUrl,
                displayNameFallback: member.displayName,
                size: 44
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(member.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Text(member.badgeLabel)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(roleColor.opacity(0.15))
                    .foregroundStyle(roleColor)
                    .clipShape(Capsule())
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary.opacity(0.55))
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var roleColor: Color {
        switch member.accessRole {
        case .owner: return AppDesign.brandDark
        case .manager: return AppDesign.brandWarm
        case .member: return AppDesign.textSecondary
        }
    }
}

private struct TeamMemberContactSheet: View {
    let member: TenantTeamMember
    @Environment(\.dismiss) private var dismiss

    private var emailTrimmed: String {
        member.email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var phoneTrimmed: String {
        member.phone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var phoneDisplay: String {
        let formatted = PhoneFormatting.displayUS(phoneTrimmed)
        return formatted.isEmpty ? phoneTrimmed : formatted
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        AppAvatarView(
                            tenantLogoURL: nil,
                            accountPhotoURL: member.profilePhotoUrl.isEmpty ? nil : member.profilePhotoUrl,
                            displayNameFallback: member.displayName,
                            size: 56
                        )
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                            Text(member.badgeLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppDesign.brandWarm)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(Color.clear)
                }

                Section {
                    LabeledContent("Name", value: member.displayName)
                    if !phoneTrimmed.isEmpty {
                        LabeledContent("Phone", value: phoneDisplay)
                    } else {
                        LabeledContent("Phone", value: "Not shared")
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                    if !emailTrimmed.isEmpty {
                        if let url = URL(string: "mailto:\(emailTrimmed)") {
                            Link(destination: url) {
                                LabeledContent("Email", value: emailTrimmed)
                            }
                            .foregroundStyle(AppDesign.linkAccent)
                        } else {
                            LabeledContent("Email", value: emailTrimmed)
                        }
                    } else {
                        LabeledContent("Email", value: "Not shared")
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .tint(AppDesign.brandWarm)
            .navigationTitle("Contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AppDesign.brandDark)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
