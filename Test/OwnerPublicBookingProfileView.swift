//
//  OwnerPublicBookingProfileView.swift
//
//  Studio/Shop owner: public title, bookable toggle, and bio for the booking picker.
//

import SwiftUI

struct OwnerPublicBookingProfileView: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @EnvironmentObject var authViewModel: AuthViewModel
    @Environment(\.dismiss) private var dismiss

    let member: TenantTeamMember

    @State private var jobTitlePresetId: String = ""
    @State private var customJobTitle: String = ""
    @State private var isBookable: Bool
    @State private var providerAboutText: String

    init(viewModel: ManagerSettingsViewModel, member: TenantTeamMember) {
        self.viewModel = viewModel
        self.member = member
        _isBookable = State(initialValue: member.isBookable)
        _providerAboutText = State(initialValue: member.providerAboutText)
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let options = TeamJobTitleCatalog.ownerPublicTitleOptions(for: viewModel.tenantIndustry)
        if let match = options.first(where: { $0.label.caseInsensitiveCompare(title) == .orderedSame }) {
            _jobTitlePresetId = State(initialValue: match.id)
            _customJobTitle = State(initialValue: "")
        } else if title.isEmpty {
            _jobTitlePresetId = State(initialValue: options.first?.id ?? "owner_artist")
            _customJobTitle = State(initialValue: "")
        } else {
            _jobTitlePresetId = State(initialValue: TeamJobTitleCatalog.customOptionId)
            _customJobTitle = State(initialValue: title)
        }
    }

    private var resolvedJobTitle: String {
        if jobTitlePresetId == TeamJobTitleCatalog.customOptionId {
            let c = customJobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            return c.isEmpty ? "Owner & artist" : String(c.prefix(60))
        }
        return TeamJobTitleCatalog.ownerPublicTitleOptions(for: viewModel.tenantIndustry)
            .first(where: { $0.id == jobTitlePresetId })?.label ?? "Owner & artist"
    }

    var body: some View {
        Form {
            Section {
                Text("This is what clients see when they choose who to book on your website.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(
                header: Text("Public title"),
                footer: Text("Shown under your name on the booking picker — e.g. Lead artist or Owner & artist.")
                    .font(.caption2)
            ) {
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

            Section(
                header: Text("Online booking"),
                footer: Text("When on, you appear on your studio’s /book page and clients can request appointments with you.")
                    .font(.caption2)
            ) {
                Toggle("Bookable on website", isOn: $isBookable)
                if isBookable, !member.memberSlug.isEmpty {
                    LabeledContent("Page path", value: PublicBookingSite.memberPagePath(memberSlug: member.memberSlug))
                }
                TeamMemberBioTextEditor(
                    placeholder: "Short bio (optional)",
                    text: $providerAboutText
                )
                if isBookable {
                    NavigationLink {
                        ProviderPortfolioView(
                            teamViewModel: viewModel,
                            member: member,
                            tenantId: viewModel.tenantId,
                            isDemoMode: authViewModel.isDemoMode,
                            ownerEditingMember: false
                        )
                        .environmentObject(authViewModel)
                    } label: {
                        Label("Portfolio photos", systemImage: "photo.stack")
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
        .navigationTitle("Your booking profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task { await save() }
                }
                .disabled(viewModel.isUpdatingMember)
            }
        }
    }

    private var jobTitleOptions: [TeamJobTitleOption] {
        TeamJobTitleCatalog.ownerPublicTitleOptions(for: viewModel.tenantIndustry)
    }

    private func save() async {
        let ok = await viewModel.saveOwnerPublicProfile(
            memberUid: member.uid,
            jobTitle: resolvedJobTitle,
            isBookable: isBookable,
            providerAboutText: providerAboutText.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        if ok { dismiss() }
    }
}
