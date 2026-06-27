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
            .navigationBarTitleDisplayMode(.large)
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

    private var currentMember: TenantTeamMember? {
        guard let uid = Auth.auth().currentUser?.uid else { return nil }
        return viewModel.members.first { $0.uid == uid }
    }

    var body: some View {
        List {
            if authViewModel.teamAccess.canAccessWebsiteProfile {
                Section {
                    Label("Website profile", systemImage: "globe")
                    Text("Your owner enabled editing for your public page. Open Website profile in the menu to update your bio and portfolio.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if authViewModel.teamAccess.usesOwnPayments {
                Section {
                    NavigationLink {
                        PaymentsView(drawerState: drawerState, sectionTitle: "Payments")
                            .environmentObject(authViewModel)
                    } label: {
                        Label(
                            authViewModel.teamAccess.canTakePayments ? "My payments" : "Set up payments",
                            systemImage: "creditcard"
                        )
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
                        Label(
                            authViewModel.teamAccess.usesOwnSms ? "My texting line" : "Set up texting line",
                            systemImage: "message.fill"
                        )
                    }
                    if authViewModel.teamAccess.usesOwnSms {
                        LabeledContent(
                            "Your number",
                            value: PhoneFormatting.displayUS(authViewModel.teamAccess.memberSmsPhoneNumber)
                        )
                    }
                } footer: {
                    Text("Text clients from your own number. Counts toward your studio’s monthly SMS limit.")
                        .font(.caption2)
                }
            }

            if let me = currentMember, me.isBookable, !me.memberSlug.isEmpty {
                Section(header: Text("Your booking page")) {
                    LabeledContent("Share link", value: PublicBookingSite.memberBookPath(memberSlug: me.memberSlug))
                    Text("Clients can book you directly from your studio website.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                DisclosureGroup {
                    agreementDetails
                } label: {
                    HStack {
                        Text("Access")
                        Spacer()
                        Text(authViewModel.teamAccess.accessRole.displayName)
                            .foregroundStyle(.secondary)
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
                        TeamMemberDirectoryRow(member: member)
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
    }

    @ViewBuilder
    private var agreementDetails: some View {
        if let me = currentMember {
            LabeledContent("Job title", value: me.badgeLabel)
            LabeledContent("Booking type", value: me.personalBookingTypeDisplayName)
            if let split = me.paymentSplitSummary {
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

// MARK: - Staff roster: name, role, contact only

struct TeamMemberDirectoryRow: View {
    let member: TenantTeamMember

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
        HStack(alignment: .top, spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: member.profilePhotoUrl.isEmpty ? nil : member.profilePhotoUrl,
                displayNameFallback: member.displayName,
                size: 44
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(member.displayName)
                    .font(.subheadline.weight(.semibold))
                Text(member.badgeLabel)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(roleColor.opacity(0.15))
                    .foregroundStyle(roleColor)
                    .clipShape(Capsule())
                if !emailTrimmed.isEmpty {
                    if let url = URL(string: "mailto:\(emailTrimmed)") {
                        Link(emailTrimmed, destination: url)
                            .font(.caption)
                    } else {
                        Text(emailTrimmed)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if !phoneTrimmed.isEmpty {
                    if let e164 = PhoneFormatting.e164US(phoneTrimmed),
                       let url = URL(string: "tel:\(e164)") {
                        Link(phoneDisplay, destination: url)
                            .font(.caption)
                    } else {
                        Text(phoneDisplay)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var roleColor: Color {
        switch member.accessRole {
        case .owner: return .primary
        case .manager: return .blue
        case .member: return .secondary
        }
    }
}
