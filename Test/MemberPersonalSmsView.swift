//
//  MemberPersonalSmsView.swift
//
//  Independent members: optional personal texting line on the studio subscription.
//

import SwiftUI

struct MemberPersonalSmsView: View {
    @ObservedObject var viewModel: ManagerSettingsViewModel
    @EnvironmentObject var authViewModel: AuthViewModel

    let member: TenantTeamMember
    let ownerEditingMember: Bool

    @State private var smsConsentAccepted = false

    private var isActive: Bool {
        member.smsStatus == "active" && !member.smsPhoneNumber.isEmpty
    }

    var body: some View {
        List {
            if !viewModel.smsCanUse && viewModel.smsStatus != "active" {
                Section {
                    Text("Your studio must enable client texting first. Ask the owner to set it up under Settings → Messaging.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                if isActive {
                    LabeledContent("Your number", value: PhoneFormatting.displayUS(member.smsPhoneNumber))
                    Text("Clients see this number when you text them from Messages.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if member.smsStatus == "pending" || viewModel.isProvisioningMemberSms {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Setting up your number…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if member.smsStatus == "failed" {
                    Text(viewModel.errorMessage ?? "Setup failed. Try again.")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Toggle("I agree to send appointment-related texts only", isOn: $smsConsentAccepted)
                        .font(.subheadline)
                    Button {
                        Task {
                            await viewModel.requestMemberSmsProvisioning(
                                memberUid: ownerEditingMember ? member.uid : nil,
                                consentAccepted: smsConsentAccepted
                            )
                            await authViewModel.refreshTeamAccess()
                        }
                    } label: {
                        HStack {
                            Image(systemName: "message.fill")
                            Text("Set up my texting line")
                        }
                    }
                    .disabled(!smsConsentAccepted || viewModel.isProvisioningMemberSms || !viewModel.smsCanUse)
                }
            } header: {
                Text("Personal texting line")
            } footer: {
                Text("Uses your studio’s texting plan and monthly limit. Independent members only — no extra subscription.")
                    .font(.caption2)
            }
        }
        .appListSurface()
        .navigationTitle("My texting")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            await authViewModel.refreshTeamAccess()
        }
    }
}
