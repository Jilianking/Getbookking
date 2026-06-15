//
//  AccountLifecycleSettingsViews.swift
//
//  Transfer ownership and delete account (Settings → Account).
//

import SwiftUI

struct TransferOwnershipSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var selectedMemberUid: String?
    @State private var confirmPhrase = ""
    @State private var showingConfirmSheet = false
    @State private var successMessage: String?

    var body: some View {
        List {
            Section {
                Text(
                    "Choose a team member to become the new owner. They will manage billing and the business. Your booking site stays the same."
                )
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            }

            Section("Team members") {
                if viewModel.transferCandidates.isEmpty {
                    Text("No other team members yet.")
                        .foregroundStyle(AppDesign.textSecondary)
                } else {
                    ForEach(viewModel.transferCandidates) { member in
                        Button {
                            selectedMemberUid = member.uid
                            showingConfirmSheet = true
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName)
                                        .foregroundStyle(AppDesign.textPrimary)
                                    if !member.email.isEmpty {
                                        Text(member.email)
                                            .font(.caption)
                                            .foregroundStyle(AppDesign.textSecondary)
                                    }
                                }
                                Spacer()
                                Text(member.accessRole.displayName)
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Transfer ownership")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingConfirmSheet) {
            TransferOwnershipConfirmSheet(
                memberName: selectedMemberDisplayName,
                confirmPhrase: $confirmPhrase,
                isSubmitting: viewModel.isTransferringOwnership,
                onCancel: {
                    confirmPhrase = ""
                    showingConfirmSheet = false
                },
                onConfirm: submitTransfer
            )
        }
        .alert("Ownership transferred", isPresented: Binding(
            get: { successMessage != nil },
            set: { if !$0 { successMessage = nil } }
        )) {
            Button("OK") {
                successMessage = nil
                dismiss()
            }
        } message: {
            Text(successMessage ?? "")
        }
        .alert("Transfer failed", isPresented: Binding(
            get: { viewModel.accountLifecycleMessage != nil && showingConfirmSheet == false && successMessage == nil },
            set: { if !$0 { viewModel.accountLifecycleMessage = nil } }
        )) {
            Button("OK", role: .cancel) { viewModel.accountLifecycleMessage = nil }
        } message: {
            Text(viewModel.accountLifecycleMessage ?? "")
        }
    }

    private var selectedMemberDisplayName: String {
        guard let uid = selectedMemberUid else { return "this team member" }
        return viewModel.transferCandidates.first(where: { $0.uid == uid })?.displayName ?? "this team member"
    }

    private func submitTransfer() {
        guard let uid = selectedMemberUid else { return }
        Task {
            do {
                try await viewModel.transferOwnership(to: uid, confirmPhrase: confirmPhrase)
                await authViewModel.refreshTeamAccess()
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
                await MainActor.run {
                    confirmPhrase = ""
                    showingConfirmSheet = false
                    successMessage = "\(selectedMemberDisplayName) is now the owner. Ask them to update billing in account settings."
                }
            } catch {
                await MainActor.run {
                    viewModel.accountLifecycleMessage = error.localizedDescription
                }
            }
        }
    }
}

private struct TransferOwnershipConfirmSheet: View {
    let memberName: String
    @Binding var confirmPhrase: String
    let isSubmitting: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Make **\(memberName)** the owner of this business. You will become a manager.")
                        .font(.subheadline)
                }
                Section("Confirm") {
                    TextField("Type TRANSFER", text: $confirmPhrase)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Confirm transfer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Transfer", role: .destructive) {
                        onConfirm()
                    }
                    .disabled(isSubmitting || confirmPhrase.uppercased() != "TRANSFER")
                }
            }
        }
        .presentationDetents([.medium])
    }
}

struct DeleteAccountSettingsSheet: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var confirmPhrase = ""
    @State private var password = ""
    @State private var localError: String?

    private static let stripeExpressLoginURL = URL(string: "https://connect.stripe.com/express_login")!

    private var eligibility: AccountDeletionEligibility? {
        viewModel.deletionEligibility
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if authViewModel.isDemoMode {
                        deleteInfoCard {
                            Text("Account deletion is not available in demo mode.")
                                .font(.subheadline)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                    } else if viewModel.isLoadingAccountLifecycle, eligibility == nil {
                        HStack {
                            Spacer()
                            ProgressView("Loading…")
                            Spacer()
                        }
                        .padding(.vertical, 40)
                    } else if let eligibility {
                        deleteWarningHeader

                        deleteInfoCard {
                            deletionSummary(for: eligibility)
                        }

                        if eligibility.requiresTransfer {
                            deleteInfoCard {
                                Text("Transfer ownership to a team member first. Then you can delete your account without shutting down the business.")
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        } else if eligibility.stripeBalanceBlocksDeletion {
                            deleteInfoCard {
                                Text(eligibility.stripeBalanceBlockMessage.isEmpty
                                    ? "Withdraw your Stripe payout balance in Payments before deleting your account."
                                    : eligibility.stripeBalanceBlockMessage)
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.accentRed)
                            }
                        } else {
                            VStack(spacing: 0) {
                                VStack(alignment: .leading, spacing: 12) {
                                    TextField("Type DELETE", text: $confirmPhrase)
                                        .textInputAutocapitalization(.characters)
                                        .autocorrectionDisabled()
                                        .font(.body)
                                        .foregroundStyle(AppDesign.textPrimary)

                                    Divider()

                                    SecureField("Password", text: $password)
                                        .font(.body)
                                        .foregroundStyle(AppDesign.textPrimary)
                                }
                                .padding(16)
                            }
                            .appCard()

                            if eligibility.hasStripeConnectAccount {
                                stripeConnectFootnote
                            }

                            Button {
                                submitDeletion()
                            } label: {
                                Group {
                                    if viewModel.isDeletingAccount {
                                        ProgressView()
                                            .tint(.white)
                                    } else {
                                        Text("Delete my account")
                                            .font(.subheadline.weight(.semibold))
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.white)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(canSubmit ? AppDesign.accentRed : AppDesign.accentRed.opacity(0.4))
                            )
                            .disabled(!canSubmit || viewModel.isDeletingAccount)
                            .padding(.top, 4)
                        }
                    } else {
                        deleteInfoCard {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(loadFailureMessage)
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.accentRed)
                                Button("Try again") {
                                    Task {
                                        await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
                                    }
                                }
                                .font(.subheadline.weight(.medium))
                            }
                        }
                    }

                    if let localError {
                        Text(localError)
                            .font(.caption)
                            .foregroundStyle(AppDesign.accentRed)
                            .padding(.horizontal, 4)
                    }
                }
                .padding(16)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .task {
            if eligibility == nil {
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
            }
        }
    }

    private var deleteWarningHeader: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title3)
                .foregroundStyle(AppDesign.brandWarm)
            Text("This cannot be undone")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)
        }
        .padding(.horizontal, 4)
    }

    private func deleteInfoCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var stripeConnectFootnote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your Stripe payout account stays active on Stripe. You won't manage it through Bookking after deletion.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            Text("Sign in at Stripe with the email you used for payouts — not your Bookking password.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            Link("Open Stripe Express login", destination: Self.stripeExpressLoginURL)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private func deletionSummary(for eligibility: AccountDeletionEligibility) -> some View {
        if eligibility.isOwner {
            if eligibility.otherTeamMemberCount > 0 {
                let business = eligibility.businessName.isEmpty ? "this business" : eligibility.businessName
                (Text("You are the owner of ")
                    + Text(business).fontWeight(.semibold)
                    + Text(". Deleting now would shut down the business for your team."))
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            } else {
                Text("This permanently deletes your business, cancels your subscription, removes your booking site, and deletes your account.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            }
        } else {
            let business = eligibility.businessName.isEmpty ? "this business" : eligibility.businessName
            (Text("You will leave ")
                + Text(business).fontWeight(.semibold)
                + Text(" and your Bookking account will be permanently deleted. The business will keep running."))
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
        }
    }

    private var loadFailureMessage: String {
        if let msg = viewModel.accountLifecycleMessage, !msg.isEmpty {
            return msg
        }
        return "Could not load account options. Check your connection and try again."
    }

    private var canSubmit: Bool {
        confirmPhrase.uppercased() == "DELETE" && !password.isEmpty
    }

    private func submitDeletion() {
        localError = nil
        Task {
            do {
                try await authViewModel.reauthenticate(password: password)
                try await viewModel.deleteAccount(confirmPhrase: confirmPhrase)
                await MainActor.run {
                    dismiss()
                    authViewModel.logout()
                }
            } catch {
                await MainActor.run {
                    localError = error.localizedDescription
                }
            }
        }
    }
}
