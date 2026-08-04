//
//  MemberPersonalSmsView.swift
//
//  Independent members: Request phone number → free capacity provisions;
//  paid capacity queues a request for the owner ($5/mo).
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

    private var isRequestPending: Bool {
        member.smsLineRequestPending
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
                } else if isRequestPending {
                    Label("Request sent", systemImage: "clock")
                        .font(.subheadline.weight(.medium))
                    Text("Your studio owner was notified. Extra lines are \(viewModel.smsExtraMonthlyPriceLabel) each. After they add capacity, return here and request again, or they can enable your line from Messaging.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if viewModel.isTenantOwner || ownerEditingMember {
                        Button {
                            Task { await viewModel.openBillingForExtraSmsLine() }
                        } label: {
                            HStack {
                                if viewModel.isOpeningBillingWebsite {
                                    ProgressView().scaleEffect(0.9)
                                }
                                Text("Add a number on website")
                            }
                        }
                        .disabled(viewModel.isOpeningBillingWebsite)
                        Button("Dismiss request", role: .destructive) {
                            Task { await viewModel.clearSmsLineRequest(memberUid: member.uid) }
                        }
                    }
                } else if member.smsStatus == "failed" {
                    Text(viewModel.errorMessage ?? "Setup failed. Try again.")
                        .font(.caption)
                        .foregroundStyle(.red)
                    requestPhoneNumberForm
                } else if viewModel.smsAtMaxLines {
                    Text("This studio has reached its maximum texting numbers (\(viewModel.smsMaxLines)).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    requestPhoneNumberForm
                }
            } header: {
                Text("Personal texting line")
            } footer: {
                Text(personalLineFooter)
                    .font(.caption2)
            }
        }
        .appListSurface()
        .navigationTitle("Messaging")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            await authViewModel.refreshTeamAccess()
        }
    }

    @ViewBuilder
    private var requestPhoneNumberForm: some View {
        if viewModel.smsNeedsPurchaseForNextLine {
            Text("Included texting numbers are used. Extra numbers are \(viewModel.smsExtraMonthlyPriceLabel) each — the owner pays on the studio plan.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else if viewModel.smsNextLineIsFree {
            Text("A free included number is available for your personal line.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        Toggle("I agree to send appointment-related texts only", isOn: $smsConsentAccepted)
            .font(.subheadline)
        Button {
            Task {
                _ = await viewModel.requestSmsPhoneNumber(
                    memberUid: ownerEditingMember ? member.uid : nil,
                    consentAccepted: smsConsentAccepted
                )
                await authViewModel.refreshTeamAccess()
            }
        } label: {
            HStack {
                if viewModel.isProvisioningMemberSms { ProgressView().scaleEffect(0.9) }
                Image(systemName: "phone.badge.plus")
                Text("Request phone number")
            }
        }
        .disabled(!smsConsentAccepted || viewModel.isProvisioningMemberSms || !viewModel.smsCanUse)
        if let msg = viewModel.errorMessage, !msg.isEmpty {
            Text(msg)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var personalLineFooter: String {
        if isRequestPending {
            return "Your request is waiting on owner capacity or a \(viewModel.smsExtraMonthlyPriceLabel) add-on."
        }
        if viewModel.smsNeedsPurchaseForNextLine {
            return "Request notifies your owner. After they add a slot, you can set up your number here."
        }
        if viewModel.smsNextLineIsFree {
            return "Uses an included line on your studio plan (no extra charge)."
        }
        return "Uses a paid texting slot on your studio plan and the shared monthly message limit. Independent members only."
    }
}
