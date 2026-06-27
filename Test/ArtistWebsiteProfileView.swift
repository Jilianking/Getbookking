//
//  ArtistWebsiteProfileView.swift
//
//  Studio/Shop team members: preview their public team page (Design shell) and edit
//  owner-approved Gallery and/or Bio in Manage mode.
//

import SwiftUI
import PhotosUI
import FirebaseFunctions
import UIKit

private enum WebsiteProfileTab: String, CaseIterable, Hashable {
    case gallery
    case bio

    var segmentTitle: String {
        switch self {
        case .gallery: return "Gallery"
        case .bio: return "Bio"
        }
    }

    static func visible(canEditPortfolio: Bool, canEditPublicBio: Bool) -> [WebsiteProfileTab] {
        var tabs: [WebsiteProfileTab] = []
        if canEditPortfolio { tabs.append(.gallery) }
        if canEditPublicBio { tabs.append(.bio) }
        return tabs
    }
}

struct ArtistWebsiteProfileView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var designViewModel = DesignViewModel()
    @StateObject private var teamViewModel = ManagerSettingsViewModel()
    @State private var hasLoaded = false
    @State private var isShowingManage = false
    @State private var selectedTab: WebsiteProfileTab = .gallery
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

    private var visibleTabs: [WebsiteProfileTab] {
        WebsiteProfileTab.visible(
            canEditPortfolio: authViewModel.teamAccess.canEditPortfolio,
            canEditPublicBio: authViewModel.teamAccess.canEditPublicBio
        )
    }

    var body: some View {
        NavigationView {
            Group {
                if !authViewModel.tenantSubscriptionPlan.allowsTeamInvites && !authViewModel.isDemoMode {
                    planUnavailableContent
                } else if !hasLoaded && !authViewModel.isDemoMode {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if isShowingManage {
                    manageContent
                } else {
                    previewContent
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(isShowingManage ? "Manage" : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Group {
                        if isShowingManage {
                            Button("Preview") {
                                isShowingManage = false
                            }
                            .foregroundStyle(AppDesign.textPrimary)
                        } else {
                            Button(action: { drawerState.isOpen = true }) {
                                Image(systemName: "line.3.horizontal")
                                    .foregroundStyle(AppDesign.textPrimary)
                            }
                        }
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if !isShowingManage {
                        HStack(spacing: 12) {
                            if !visibleTabs.isEmpty {
                                Button("Manage") {
                                    syncSelectedTab()
                                    selectedTab = visibleTabs.first ?? .gallery
                                    isShowingManage = true
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                            }
                            if memberPageURL != nil {
                                Button(action: openMemberPageInSafari) {
                                    Image(systemName: "safari")
                                }
                            }
                        }
                    }
                }
            }
        }
        .task(id: authViewModel.currentUserUid) {
            await reloadAll()
        }
        .refreshable {
            await reloadAll()
        }
        .onChange(of: visibleTabs) { _, tabs in
            if !tabs.contains(selectedTab) {
                selectedTab = tabs.first ?? .gallery
            }
        }
    }

    // MARK: - Preview (Design shell)

    private var previewContent: some View {
        VStack(spacing: 0) {
            if authViewModel.isDemoMode {
                Text("Website profile editing is preview-only in demo mode.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }

            if designViewModel.hasTenant, !authViewModel.isDemoMode {
                DesignThemeDisplayBar(
                    paletteName: designViewModel.activePaletteDisplayName,
                    templateFamily: designViewModel.activeTemplateFamily,
                    accentHex: designViewModel.primaryColorHex
                )
            }

            WebViewPreview(
                url: memberPreviewURL,
                height: nil,
                quickEditEnabled: false
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .appCard()
    }

    // MARK: - Manage (Gallery + Bio only)

    private var manageContent: some View {
        VStack(spacing: 0) {
            if visibleTabs.count > 1 {
                ManageSegmentTabs(
                    tabs: visibleTabs,
                    selectedTab: $selectedTab,
                    title: { $0.segmentTitle }
                )
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if authViewModel.isDemoMode {
                        Text("Website profile editing is preview-only in demo mode.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    switch effectiveTab {
                    case .gallery:
                        if authViewModel.teamAccess.canEditPortfolio, let me = currentMember {
                            ArtistWebsiteProfileGalleryTab(
                                teamViewModel: teamViewModel,
                                member: me,
                                tenantId: teamViewModel.tenantId,
                                isDemoMode: authViewModel.isDemoMode,
                                onGalleryDidChange: {
                                    designViewModel.invalidateWebPreview()
                                }
                            )
                            .environmentObject(authViewModel)
                            .id(me.uid)
                        }
                    case .bio:
                        bioTabContent
                    }
                }
                .padding()
            }
        }
    }

    private var effectiveTab: WebsiteProfileTab {
        if visibleTabs.count == 1 { return visibleTabs[0] }
        return selectedTab
    }

    @ViewBuilder
    private var bioTabContent: some View {
        if authViewModel.teamAccess.canEditPublicBio {
            VStack(alignment: .leading, spacing: 20) {
                if let me = currentMember, me.isBookable, !me.memberSlug.isEmpty {
                    yourPagesSection(for: me)
                }

                ManageSectionHeader("Bio")
                ManageCard {
                    TeamMemberBioTextEditor(
                        placeholder: "Short bio (optional)…",
                        text: $bioText
                    )
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .disabled(authViewModel.isDemoMode || isSavingBio)
                    .padding(14)

                    if let bioSaveMessage {
                        Text(bioSaveMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.bottom, 4)
                    }

                    Button {
                        Task { await saveBio() }
                    } label: {
                        Group {
                            if isSavingBio {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("Saving…")
                                }
                            } else {
                                Text("Save bio")
                                    .font(.body.weight(.medium))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(authViewModel.isDemoMode || isSavingBio)
                }
                Text("Shown on your team profile and booking page.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func yourPagesSection(for member: TenantTeamMember) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ManageSectionHeader("Your pages")
            ManageCard {
                if let teamDisplay = memberTeamLinkDisplay(for: member),
                   let teamCopy = memberTeamLinkCopy(for: member) {
                    ManageMemberBookingLinkRow(
                        displayURL: teamDisplay,
                        copyURL: teamCopy,
                        disabled: authViewModel.isDemoMode
                    )
                }
                if let bookDisplay = memberBookingLinkDisplay(for: member),
                   let bookCopy = memberBookingLinkCopy(for: member) {
                    if memberTeamLinkDisplay(for: member) != nil {
                        ManageCardDivider(leadingInset: 46)
                    }
                    ManageMemberBookingLinkRow(
                        displayURL: bookDisplay,
                        copyURL: bookCopy,
                        disabled: authViewModel.isDemoMode
                    )
                }
            }
            Text("Layout and visibility are managed by your studio owner.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func memberTeamLinkDisplay(for member: TenantTeamMember) -> String? {
        guard let tenant = normalizedTenantSlug, !member.memberSlug.isEmpty else { return nil }
        let path = PublicBookingSite.memberPagePath(memberSlug: member.memberSlug)
        guard !path.isEmpty else { return nil }
        return "\(tenant).\(PublicBookingSite.host)\(path)"
    }

    private func memberTeamLinkCopy(for member: TenantTeamMember) -> String? {
        memberPageURL(for: member)?.absoluteString
    }

    private func memberBookingLinkDisplay(for member: TenantTeamMember) -> String? {
        guard let tenant = normalizedTenantSlug, !member.memberSlug.isEmpty else { return nil }
        let path = PublicBookingSite.memberBookPath(memberSlug: member.memberSlug)
        return "\(tenant).\(PublicBookingSite.host)\(path)"
    }

    private func memberBookingLinkCopy(for member: TenantTeamMember) -> String? {
        guard let tenant = normalizedTenantSlug else { return nil }
        let url = PublicBookingSite.memberBookURLString(tenantSlug: tenant, memberSlug: member.memberSlug)
        return url.isEmpty ? nil : url
    }

    private var normalizedTenantSlug: String? {
        let slug = designViewModel.tenantSlug?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
        return slug.isEmpty ? nil : slug
    }

    private func memberPageURL(for member: TenantTeamMember) -> URL? {
        guard !member.memberSlug.isEmpty,
              designViewModel.hasTenant, !designViewModel.bookingUrl.isEmpty else { return nil }
        let path = PublicBookingSite.memberPagePath(memberSlug: member.memberSlug)
        guard !path.isEmpty else { return nil }
        return URL(string: designViewModel.bookingUrl + path)
    }

    private var planUnavailableContent: some View {
        ContentUnavailableView {
            Label("Studio or Shop plan", systemImage: "person.3")
        } description: {
            Text("Website profile is for team members on Studio or Shop plans when your owner enables bio or portfolio editing.")
        }
    }

    // MARK: - URLs

    private var memberPageURL: URL? {
        guard let me = currentMember else { return nil }
        return memberPageURL(for: me)
    }

    private var memberPreviewURL: URL? {
        guard let base = memberPageURL else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        var q = components?.queryItems ?? []
        q.append(URLQueryItem(name: "_cb", value: String(designViewModel.webPreviewReloadToken)))
        components?.queryItems = q
        return components?.url ?? base
    }

    private func openMemberPageInSafari() {
        guard let url = memberPageURL else { return }
        UIApplication.shared.open(url)
    }

    private func reloadAll() async {
        await designViewModel.loadData(
            isDemoMode: authViewModel.isDemoMode,
            sessionStore: sessionStore
        )
        if authViewModel.isDemoMode {
            await teamViewModel.load(isDemoMode: true)
            bioText = currentMember?.providerAboutText ?? ""
            hasLoaded = true
            syncSelectedTab()
            return
        }
        async let access: () = authViewModel.refreshTeamAccess()
        async let roster: () = teamViewModel.load(isDemoMode: false)
        _ = await (access, roster)
        bioText = currentMember?.providerAboutText ?? ""
        hasLoaded = true
        syncSelectedTab()
    }

    private func syncSelectedTab() {
        let tabs = visibleTabs
        if !tabs.contains(selectedTab) {
            selectedTab = tabs.first ?? .gallery
        }
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
            designViewModel.invalidateWebPreview()
            await teamViewModel.load(isDemoMode: false)
            bioText = currentMember?.providerAboutText ?? trimmed
        } catch {
            bioSaveMessage = error.localizedDescription
        }
    }
}

// MARK: - Gallery tab

private struct ArtistWebsiteProfileGalleryTab: View {
    @ObservedObject var teamViewModel: ManagerSettingsViewModel
    let member: TenantTeamMember
    let tenantId: String?
    let isDemoMode: Bool
    var onGalleryDidChange: () -> Void

    @StateObject private var portfolioViewModel: ProviderPortfolioViewModel
    @State private var selectedItems: [PhotosPickerItem] = []
    @State private var batchCropItem: MultiImageCropSheetItem?
    @State private var showGalleryError = false

    init(
        teamViewModel: ManagerSettingsViewModel,
        member: TenantTeamMember,
        tenantId: String?,
        isDemoMode: Bool,
        onGalleryDidChange: @escaping () -> Void
    ) {
        self.teamViewModel = teamViewModel
        self.member = member
        self.tenantId = tenantId
        self.isDemoMode = isDemoMode
        self.onGalleryDidChange = onGalleryDidChange
        _portfolioViewModel = StateObject(wrappedValue: ProviderPortfolioViewModel(
            member: member,
            tenantId: tenantId,
            isDemoMode: isDemoMode,
            ownerEditingMember: false
        ))
    }

    var body: some View {
        ProviderPortfolioEditorContent(
            teamViewModel: teamViewModel,
            viewModel: portfolioViewModel,
            selectedItems: $selectedItems,
            batchCropItem: $batchCropItem,
            showGalleryError: $showGalleryError,
            manageStyle: true
        )
        .onChange(of: member.providerGalleryImages) { _, urls in
            portfolioViewModel.imageURLs = urls
        }
        .onChange(of: portfolioViewModel.isUploading) { wasUploading, isUploading in
            if wasUploading, !isUploading, portfolioViewModel.errorMessage == nil {
                onGalleryDidChange()
            }
        }
    }
}
