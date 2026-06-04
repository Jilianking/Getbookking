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
                managerReadOnlyContent
            }
        }
        .navigationTitle("Messaging settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
        .refreshable {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
        }
    }

    private var managerReadOnlyContent: some View {
        List {
            Section {
                if viewModel.smsStatus == "active", !viewModel.smsPhoneNumber.isEmpty {
                    Text("Business line: \(viewModel.smsPhoneDisplay)")
                        .font(.subheadline)
                    Text(
                        "\(viewModel.smsMonthlyUsageCount) of \(viewModel.smsMonthlyLimit) texts used this month"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                } else {
                    Text("Client texting is not active for this business.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Client texting")
            } footer: {
                Text("Only the business owner can enable texting, refresh the number, or change billing.")
                    .font(.caption2)
            }
        }
    }
}
