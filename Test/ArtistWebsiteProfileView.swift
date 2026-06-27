//
//  ArtistWebsiteProfileView.swift
//
//  Limited website editing for team members (portfolio and/or bio when owner enables).
//

import SwiftUI
import FirebaseFunctions

struct ArtistWebsiteProfileView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var teamViewModel = ManagerSettingsViewModel()
    @State private var hasLoaded = false
    @State private var bioText: String = ""
    @State private var isSavingBio = false
    @State private var bioSaveMessage: String?
    var drawerState: DrawerState
    let sectionTitle: String

    private let functions = Functions.functions()

    private var currentMember: TenantTeamMember? {
        guard let uid = authViewModel.currentUserUid else { return nil }
        return teamViewModel.members.first { $0.uid == uid }
    }

    var body: some View {
        NavigationStack {
            Group {
                if !hasLoaded && !authViewModel.isDemoMode {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    profileContent
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
            }
        }
        .task(id: authViewModel.currentUserUid) {
            await reload()
        }
        .refreshable {
            await reload()
        }
    }

    @ViewBuilder
    private var profileContent: some View {
        List {
            if authViewModel.isDemoMode {
                Section {
                    Text("Website profile editing is preview-only in demo mode.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let me = currentMember, me.isBookable, !me.memberSlug.isEmpty {
                Section(
                    header: Text("Your pages"),
                    footer: Text("Layout and visibility are managed by your studio owner.")
                        .font(.caption2)
                ) {
                    LabeledContent("Team page", value: PublicBookingSite.memberPagePath(memberSlug: me.memberSlug))
                    if let bookPath = bookingPath(for: me) {
                        LabeledContent("Booking link", value: bookPath)
                    }
                }
            }

            if authViewModel.teamAccess.canEditPublicBio {
                Section(
                    header: Text("Bio"),
                    footer: Text("Shown on your team profile and booking page.")
                        .font(.caption2)
                ) {
                    TeamMemberBioTextEditor(
                        placeholder: "Short bio (optional)…",
                        text: $bioText
                    )
                    .frame(minHeight: 100)
                    .disabled(authViewModel.isDemoMode || isSavingBio)

                    if let bioSaveMessage {
                        Text(bioSaveMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Button {
                        Task { await saveBio() }
                    } label: {
                        if isSavingBio {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Saving…")
                            }
                        } else {
                            Text("Save bio")
                        }
                    }
                    .disabled(authViewModel.isDemoMode || isSavingBio)
                }
            }

            if authViewModel.teamAccess.canEditPortfolio, let me = currentMember {
                Section(
                    header: Text("Portfolio"),
                    footer: Text("Photos appear on your profile and the studio gallery.")
                        .font(.caption2)
                ) {
                    NavigationLink {
                        ProviderPortfolioView(
                            teamViewModel: teamViewModel,
                            member: me,
                            tenantId: teamViewModel.tenantId,
                            isDemoMode: authViewModel.isDemoMode,
                            ownerEditingMember: false
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        Label("Portfolio photos", systemImage: "photo.stack")
                    }
                    if !me.providerGalleryImages.isEmpty {
                        Text("\(me.providerGalleryImages.count) photo\(me.providerGalleryImages.count == 1 ? "" : "s") on site")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func bookingPath(for member: TenantTeamMember) -> String? {
        let path = PublicBookingSite.memberBookPath(memberSlug: member.memberSlug)
        return path.isEmpty ? nil : path
    }

    private func reload() async {
        if authViewModel.isDemoMode {
            await teamViewModel.load(isDemoMode: true)
            bioText = currentMember?.providerAboutText ?? ""
            hasLoaded = true
            return
        }
        async let access: () = authViewModel.refreshTeamAccess()
        async let roster: () = teamViewModel.load(isDemoMode: false)
        _ = await (access, roster)
        bioText = currentMember?.providerAboutText ?? ""
        hasLoaded = true
    }

    private func saveBio() async {
        if authViewModel.isDemoMode { return }
        isSavingBio = true
        bioSaveMessage = nil
        defer { isSavingBio = false }
        do {
            let trimmed = bioText.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await functions.httpsCallable("updateMyPublicProfile").call([
                "providerAboutText": trimmed,
            ])
            bioSaveMessage = "Saved"
            await teamViewModel.load(isDemoMode: false)
            bioText = currentMember?.providerAboutText ?? trimmed
        } catch {
            bioSaveMessage = error.localizedDescription
        }
    }
}
