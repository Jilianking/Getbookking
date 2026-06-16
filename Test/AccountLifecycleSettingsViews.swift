//
//  AccountLifecycleSettingsViews.swift
//
//  Delete account (Settings → Account), including ownership transfer when required.
//

import SwiftUI

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
    @State private var shutdownConfirmPhrase = ""
    @State private var password = ""
    @State private var localError: String?
    @State private var selectedMemberUid: String?
    @State private var transferConfirmPhrase = ""
    @State private var showingTransferConfirmSheet = false
    @State private var transferSuccessMessage: String?
    @State private var showingTransferOptions = false

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

                        if let transferSuccessMessage {
                            deleteInfoCard {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(AppDesign.brandWarm)
                                    Text(transferSuccessMessage)
                                        .font(.subheadline)
                                        .foregroundStyle(AppDesign.textSecondary)
                                }
                            }
                        }

                        if eligibility.requiresTransfer {
                            transferOwnershipOption

                            orDivider
                        }

                        if eligibility.stripeBalanceBlocksDeletion {
                            deleteInfoCard {
                                Text(eligibility.stripeBalanceBlockMessage.isEmpty
                                    ? "Withdraw your Stripe payout balance in Payments before deleting your account."
                                    : eligibility.stripeBalanceBlockMessage)
                                    .font(.subheadline)
                                    .foregroundStyle(AppDesign.accentRed)
                            }
                        } else if eligibility.canDelete || eligibility.requiresShutdownConfirm {
                            deleteAccountSection(for: eligibility)
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
        .sheet(isPresented: $showingTransferConfirmSheet) {
            TransferOwnershipConfirmSheet(
                memberName: selectedMemberDisplayName,
                confirmPhrase: $transferConfirmPhrase,
                isSubmitting: viewModel.isTransferringOwnership,
                onCancel: {
                    transferConfirmPhrase = ""
                    showingTransferConfirmSheet = false
                },
                onConfirm: submitTransfer
            )
        }
        .task {
            if eligibility == nil {
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
            }
        }
    }

    private var orDivider: some View {
        HStack(spacing: 12) {
            Rectangle()
                .fill(AppDesign.textSecondary.opacity(0.2))
                .frame(height: 1)
            Text("Or")
                .font(.caption.weight(.medium))
                .foregroundStyle(AppDesign.textSecondary)
            Rectangle()
                .fill(AppDesign.textSecondary.opacity(0.2))
                .frame(height: 1)
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private func deleteAccountSection(for eligibility: AccountDeletionEligibility) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if eligibility.requiresShutdownConfirm {
                Text("Delete account and shut down the business for your team.")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.textPrimary)
                    .padding(.horizontal, 4)
            }

            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Type DELETE", text: $confirmPhrase)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body)
                        .foregroundStyle(AppDesign.textPrimary)

                    if eligibility.requiresShutdownConfirm {
                        Divider()

                        TextField("Type SHUTDOWN", text: $shutdownConfirmPhrase)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.body)
                            .foregroundStyle(AppDesign.textPrimary)
                    }

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
                submitDeletion(requiresShutdown: eligibility.requiresShutdownConfirm)
            } label: {
                Group {
                    if viewModel.isDeletingAccount {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text(eligibility.requiresShutdownConfirm
                            ? "Delete account and shut down business"
                            : "Delete my account")
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
                    .fill(canSubmit(requiresShutdown: eligibility.requiresShutdownConfirm)
                        ? AppDesign.accentRed
                        : AppDesign.accentRed.opacity(0.4))
            )
            .disabled(!canSubmit(requiresShutdown: eligibility.requiresShutdownConfirm) || viewModel.isDeletingAccount)
            .padding(.top, 4)
        }
    }

    private var transferOwnershipOption: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("To delete without shutting down the business, transfer ownership first.")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal, 4)

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showingTransferOptions.toggle()
                }
            } label: {
                Text(showingTransferOptions ? "Hide transfer options" : "Transfer ownership")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppDesign.textPrimary)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppDesign.textSecondary.opacity(0.25), lineWidth: 1)
            )

            if showingTransferOptions {
                transferMemberPicker
            }
        }
    }

    private var transferMemberPicker: some View {
        deleteInfoCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choose who should become the new owner. They will manage billing and the business.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)

                if viewModel.transferCandidates.isEmpty {
                    Text("No other team members yet.")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(viewModel.transferCandidates.enumerated()), id: \.element.id) { index, member in
                            if index > 0 {
                                Divider()
                            }
                            Button {
                                selectedMemberUid = member.uid
                                showingTransferConfirmSheet = true
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(member.displayName)
                                            .font(.subheadline)
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
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(AppDesign.textSecondary.opacity(0.6))
                                }
                                .padding(.vertical, 10)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
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
                try await viewModel.transferOwnership(to: uid, confirmPhrase: transferConfirmPhrase)
                await authViewModel.refreshTeamAccess()
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                await viewModel.loadAccountLifecycle(isDemoMode: authViewModel.isDemoMode)
                await MainActor.run {
                    transferConfirmPhrase = ""
                    showingTransferConfirmSheet = false
                    showingTransferOptions = false
                    transferSuccessMessage = "\(selectedMemberDisplayName) is now the owner. You can delete your account below. Ask them to update billing in Payments."
                    localError = nil
                    viewModel.accountLifecycleMessage = nil
                }
            } catch {
                await MainActor.run {
                    localError = error.localizedDescription
                }
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

    private func canSubmit(requiresShutdown: Bool) -> Bool {
        guard confirmPhrase.uppercased() == "DELETE", !password.isEmpty else { return false }
        if requiresShutdown {
            return shutdownConfirmPhrase.uppercased() == "SHUTDOWN"
        }
        return true
    }

    private func submitDeletion(requiresShutdown: Bool) {
        localError = nil
        Task {
            do {
                try await authViewModel.reauthenticate(password: password)
                try await viewModel.deleteAccount(
                    confirmPhrase: confirmPhrase,
                    shutdownConfirmPhrase: requiresShutdown ? shutdownConfirmPhrase : nil
                )
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
