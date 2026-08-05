//
//  MessagesSettingsView.swift
//
//  Texting number, monthly usage, and client messaging controls from Messages.
//

import SwiftUI

struct MessagesSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: ManagerSettingsViewModel

    var body: some View {
        Group {
            if authViewModel.isDemoMode {
                Text("Client texting is not available in demo mode.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding()
            } else if viewModel.isTenantOwner {
                TeamClientMessagingSettingsView(viewModel: viewModel)
                    .environmentObject(authViewModel)
            } else {
                memberMessagingContent
            }
        }
        .appListSurface()
        .navigationTitle("Messaging settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            await authViewModel.refreshTeamAccess()
        }
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            await authViewModel.refreshTeamAccess()
        }
    }

    /// Signed-in member's roster row (for personal line + usage).
    private var currentMemberRow: TenantTeamMember? {
        guard let uid = authViewModel.currentUserUid else { return nil }
        return viewModel.members.first(where: { $0.uid == uid })
    }

    private var personalPhone: String {
        let fromAccess = authViewModel.teamAccess.memberSmsPhoneNumber
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !fromAccess.isEmpty { return fromAccess }
        return (currentMemberRow?.smsPhoneNumber ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var personalStatus: String {
        let fromAccess = authViewModel.teamAccess.memberSmsStatus.lowercased()
        if !fromAccess.isEmpty && fromAccess != "off" { return fromAccess }
        return (currentMemberRow?.smsStatus ?? "off").lowercased()
    }

    private var hasPersonalLine: Bool {
        authViewModel.teamAccess.usesOwnSms
            || (personalStatus == "active" && !personalPhone.isEmpty)
    }

    private var personalUsageCount: Int {
        currentMemberRow?.smsMonthlyUsageCount ?? 0
    }

    private var personalUsageLimit: Int {
        let limit = currentMemberRow?.smsMonthlyLimit ?? 0
        return limit > 0 ? limit : 1000
    }

    private var memberMessagingContent: some View {
        List {
            if hasPersonalLine {
                Section {
                    LabeledContent("Status", value: "Active")
                    LabeledContent(
                        "Your number",
                        value: PhoneFormatting.displayUS(personalPhone)
                    )
                    Text("\(personalUsageCount) of \(personalUsageLimit) texts used this month")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Clients text you on this number. Messages in the app only show chats on your personal line.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Your texting line")
                } footer: {
                    Text("Only the business owner can add numbers, refresh lines, or change billing.")
                        .font(.caption2)
                }

                if viewModel.smsStatus == "active", !viewModel.smsPhoneNumber.isEmpty {
                    Section {
                        Text("Studio business line: \(viewModel.smsPhoneDisplay)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text("That number is for the studio inbox (owner/managers), not your personal Messages list.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Studio line")
                    }
                }
            } else if viewModel.smsStatus == "active", !viewModel.smsPhoneNumber.isEmpty {
                Section {
                    Text("Studio business line: \(viewModel.smsPhoneDisplay)")
                        .font(.subheadline)
                    Text(
                        "\(viewModel.smsMonthlyUsageCount) of \(viewModel.smsMonthlyLimit) texts used this month"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text("You don’t have a personal texting number yet. Ask the owner to assign one under Messaging, or request one from Team.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Client texting")
                } footer: {
                    Text("Only the business owner can enable texting, refresh the number, or change billing.")
                        .font(.caption2)
                }
            } else {
                Section {
                    Text("Client texting is not active for this business.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Client texting")
                } footer: {
                    Text("Only the business owner can enable texting, refresh the number, or change billing.")
                        .font(.caption2)
                }
            }
        }
    }
}
