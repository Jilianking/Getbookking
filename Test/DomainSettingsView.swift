//
//  DomainSettingsView.swift
//
//  Settings → Domain. Buy: search + prices. Transfer: guided instructions.
//

import SwiftUI

struct DomainSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DomainSettingsViewModel()
    @State private var showRemoveConfirm = false
    @State private var showTransferGuide = false
    @State private var showTransferOutConfirm = false
    @State private var showLeftBookkingConfirm = false
    @FocusState private var focusedField: DomainField?

    private enum DomainField: Hashable {
        case search
        case transferDomain
        case authCode
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard
                freeSubdomainCard
                if viewModel.hasManagedDomain {
                    currentDomainCard
                    trustAndSecurityCard
                    transferOutCard
                } else if !authViewModel.isDemoMode {
                    subdomainTrustCard
                }
                if !authViewModel.isDemoMode {
                    buySearchCard
                    transferCard
                } else {
                    demoNote
                }
                howItWorksCard
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .padding(.bottom, 40)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .simultaneousGesture(
                TapGesture().onEnded {
                    focusedField = nil
                }
            )
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AppDesign.background.ignoresSafeArea())
        .navigationTitle("Domain")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
        .task {
            if !authViewModel.isDemoMode {
                await viewModel.load()
            }
        }
        .alert("Remove domain?", isPresented: $showRemoveConfirm) {
            Button("Remove", role: .destructive) {
                Task { await viewModel.removeDomain() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your site will keep working on your free Bookking subdomain. You can transfer or buy again later.")
        }
        .alert("Transfer out?", isPresented: $showTransferOutConfirm) {
            Button("Unlock & get code", role: .destructive) {
                Task { await viewModel.prepareTransferOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("We’ll unlock \(viewModel.domain ?? "your domain") so you can move it to another registrar. The auth code is emailed to you — it isn’t shown in the app.")
        }
        .alert("Domain left Bookking?", isPresented: $showLeftBookkingConfirm) {
            Button("I’ve left Bookking", role: .destructive) {
                Task { await viewModel.confirmTransferOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only confirm after the transfer finishes at your new registrar. Your site will keep working on your free Bookking link.")
        }
        .sheet(isPresented: $showTransferGuide) {
            NavigationStack {
                DomainTransferInstructionsView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showTransferGuide = false }
                        }
                    }
            }
        }
        .sheet(item: $viewModel.successConfirmation) { confirmation in
            DomainPurchaseConfirmationSheet(
                confirmation: confirmation,
                onDismiss: { viewModel.dismissSuccessConfirmation() }
            )
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your website address")
                .font(.title3.weight(.semibold))
                .foregroundStyle(AppDesign.brandDark)
            Text("Buy a new domain or transfer one you already own. We connect it automatically — no DNS editing.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var freeSubdomainCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(viewModel.hasManagedDomain ? "Bookking preview link" : "Free Bookking link")
                .font(.subheadline.weight(.semibold))
            Text(viewModel.subdomainUrl ?? "https://yourbusiness.getbookking.com")
                .font(.body.monospaced())
                .foregroundStyle(AppDesign.accentBlue)
                .textSelection(.enabled)
            Text(
                viewModel.hasManagedDomain
                    ? "Used inside Design so you can edit your Bookking site while DNS for your custom domain finishes."
                    : "This always works, even without a custom domain."
            )
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var currentDomainCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Custom domain")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(viewModel.statusLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }
            if let domain = viewModel.domain {
                Text(domain)
                    .font(.title3.weight(.medium))
                    .textSelection(.enabled)
            }
            if let msg = viewModel.statusMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if viewModel.status.lowercased() == "transferring" {
                Text("Approve any email from your old registrar. We’ll finish connecting when the transfer completes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Toggle(isOn: Binding(
                get: { viewModel.autoRenewEnabled },
                set: { newValue in
                    Task { await viewModel.setAutoRenew(newValue) }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-renew")
                        .font(.subheadline.weight(.medium))
                    Text("Renews before expiry so your site address doesn’t lapse.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(AppDesign.brandDark)
            .disabled(viewModel.isWorking)
            Button(role: .destructive) {
                showRemoveConfirm = true
            } label: {
                Text("Remove domain")
                    .font(.subheadline.weight(.medium))
            }
            .disabled(viewModel.isWorking)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var subdomainTrustCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Trust & security")
                .font(.subheadline.weight(.semibold))
            trustRow(
                icon: "lock.fill",
                title: "Bookking link — HTTPS on",
                detail: "Your free Bookking link is always served over HTTPS.",
                url: viewModel.subdomainUrl
            )
            Text("Buy or transfer a domain to see SSL, WHOIS privacy, renew, and lock status here.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var trustAndSecurityCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Trust & security")
                .font(.subheadline.weight(.semibold))
            Text("Proof your site is safe for visitors.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let r = viewModel.reassurance {
                if let sub = r.subdomainHttps {
                    trustRow(
                        icon: sub.isActive ? "lock.fill" : "lock.open",
                        title: "Bookking link — \(sub.label)",
                        detail: sub.detail,
                        url: sub.url
                    )
                }
                if let custom = r.customDomainHttps {
                    trustRow(
                        icon: custom.isActive ? "lock.fill" : (custom.isPending ? "lock" : "globe"),
                        title: "Custom domain — \(custom.label)",
                        detail: custom.detail,
                        url: custom.url
                    )
                }
                if let dns = r.dnsManagedLabel {
                    trustRow(icon: "server.rack", title: "DNS", detail: dns, url: nil)
                }
                if let whois = r.whoisPrivacyLabel {
                    trustRow(icon: "eye.slash", title: "WHOIS privacy", detail: whois, url: nil)
                }
                if let renew = r.autoRenewLabel {
                    trustRow(icon: "arrow.triangle.2.circlepath", title: "Auto-renew", detail: renew, url: nil)
                }
                if let exp = r.expiresAt, !exp.isEmpty {
                    trustRow(icon: "calendar", title: "Expires", detail: exp, url: nil)
                }
                if let lock = r.registrarLockLabel {
                    trustRow(icon: "checkmark.shield", title: "Registrar lock", detail: lock, url: nil)
                }
            } else if viewModel.isLoading {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private func trustRow(icon: String, title: String, detail: String, url: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon)
                    .font(.body)
                    .foregroundStyle(AppDesign.accentBlue)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let url, let open = URL(string: url) {
                        Link("Open secure site", destination: open)
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var transferOutCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Transfer out")
                .font(.subheadline.weight(.semibold))
            Text("Moving to another registrar? Unlock the domain and use the auth code from your email.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if viewModel.canTransferOut {
                Button {
                    showTransferOutConfirm = true
                } label: {
                    if viewModel.isWorking {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Unlock & request auth code")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppDesign.brandDark)
                .disabled(viewModel.isWorking)
            } else {
                Text("Available once the domain status is Connected.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let email = viewModel.transferOutEmailHint, !email.isEmpty {
                Text("Code is sent to \(email) (check spam).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !viewModel.transferOutSteps.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(viewModel.transferOutSteps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if viewModel.reassurance?.transferOutPrepared == true || !viewModel.transferOutSteps.isEmpty {
                Button {
                    showLeftBookkingConfirm = true
                } label: {
                    Text("I’ve left Bookking")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isWorking)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var buySearchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Buy a domain")
                .font(.subheadline.weight(.semibold))
            if viewModel.domainPurchasingBlockedDuringTestFlight {
                Label("Unavailable during TestFlight", systemImage: "globe.badge.chevron.backward")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppDesign.brandWarm)
                Text(viewModel.domainPurchaseBlockedDisplayMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Your free yourname.getbookking.com link still works. Design is open to explore.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
            Text("Search a name. We’ll show prices for common endings (.com, .net, .org, .co).")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !viewModel.canBuyOrTransfer {
                Text("Search unlocks when Namecheap API is connected on the server.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Toggle(isOn: $viewModel.autoRenewEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-renew")
                        .font(.subheadline.weight(.medium))
                    Text("Keep the domain every year. Turn off if you only want one year.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(AppDesign.brandDark)
            .disabled(viewModel.hasManagedDomain)

            HStack(alignment: .center, spacing: 10) {
                TextField("mystudio or mystudio.com", text: $viewModel.searchQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.search)
                    .focused($focusedField, equals: .search)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 16)
                    .frame(minHeight: 52)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppDesign.background)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .onTapGesture { focusedField = .search }
                    .onSubmit {
                        focusedField = nil
                        Task { await viewModel.searchDomains() }
                    }

                Button {
                    focusedField = nil
                    Task { await viewModel.searchDomains() }
                } label: {
                    if viewModel.isSearching {
                        ProgressView()
                            .frame(width: 52, height: 52)
                    } else {
                        Image(systemName: "magnifyingglass")
                            .font(.body.weight(.semibold))
                            .frame(width: 52, height: 52)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppDesign.brandDark)
                .disabled(
                    viewModel.isSearching
                        || viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }

            if !viewModel.searchResults.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.searchResults.enumerated()), id: \.element.id) { index, row in
                        domainResultRow(row)
                        if index < viewModel.searchResults.count - 1 {
                            Divider()
                        }
                    }
                }
                .padding(.vertical, 4)
                .background(AppDesign.background)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            if let err = viewModel.errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(AppDesign.accentRed)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let info = viewModel.infoMessage {
                Text(info)
                    .font(.caption)
                    .foregroundStyle(AppDesign.accentGreen)
                    .fixedSize(horizontal: false, vertical: true)
            }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private func domainResultRow(_ row: DomainSearchResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.domain)
                        .font(.body.weight(.semibold))
                    Text(row.statusLabel)
                        .font(.caption)
                        .foregroundStyle(row.isAvailable ? AppDesign.accentGreen : .secondary)
                }
                Spacer()
                if row.isAvailable, let price = row.registerPriceLabel {
                    Text(price)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.brandDark)
                } else if row.isTaken, let price = row.transferPriceLabel {
                    Text(price)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if row.isAvailable {
                Button {
                    Task { await viewModel.startPurchase(domain: row.domain) }
                } label: {
                    Group {
                        if viewModel.isPurchasing(row.domain) {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Buy")
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppDesign.brandDark)
                .disabled(viewModel.isWorking || !viewModel.canBuyOrTransfer)
            } else if row.isTaken {
                Button {
                    viewModel.useForTransfer(row)
                } label: {
                    Text("Transfer instead")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.isWorking)
            }
        }
        .padding(12)
    }

    private var transferCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Already own a domain?")
                .font(.subheadline.weight(.semibold))
            if viewModel.domainPurchasingBlockedDuringTestFlight {
                Text(viewModel.domainPurchaseBlockedDisplayMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
            Text("Transfer it into Get Bookking. Follow the guide to get your code — we connect it automatically when the transfer finishes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                showTransferGuide = true
            } label: {
                Label("How to get your transfer code", systemImage: "list.bullet.rectangle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .font(.subheadline)

            TextField("yourbusiness.com", text: $viewModel.transferDomain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .focused($focusedField, equals: .transferDomain)
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
                .frame(minHeight: 52)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppDesign.background)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onTapGesture { focusedField = .transferDomain }

            SecureField("Authorization / EPP code", text: $viewModel.authCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: .authCode)
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
                .frame(minHeight: 52)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppDesign.background)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onTapGesture { focusedField = .authCode }

            Toggle(isOn: $viewModel.autoRenewEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-renew")
                        .font(.subheadline.weight(.medium))
                    Text("Keep the domain every year after the transfer.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(AppDesign.brandDark)
            .disabled(viewModel.hasManagedDomain)

            Button {
                Task { await viewModel.startTransfer() }
            } label: {
                Text(viewModel.isWorking ? "Starting transfer…" : "Start transfer")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppDesign.brandDark)
            .disabled(viewModel.isWorking || !viewModel.canBuyOrTransfer)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var howItWorksCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How connecting works")
                .font(.subheadline.weight(.semibold))
            bullet("Buy: search a name, see the price, purchase in Bookking.")
            bullet("Transfer: unlock at your old registrar, paste the auth code here.")
            bullet("Auto-renew keeps the domain each year — you can change it anytime.")
            bullet("We point the domain at your Bookking site automatically.")
            bullet("If the domain stays elsewhere, we can’t connect it — transfer or buy here first.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var demoNote: some View {
        Text("Domain connect is unavailable in demo mode.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .appCard()
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(AppDesign.brandWarm)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var statusColor: Color {
        switch viewModel.status.lowercased() {
        case "active": return AppDesign.accentGreen
        case "transferring", "pending", "purchasing", "pending_dns": return AppDesign.brandWarm
        case "failed", "error": return AppDesign.accentRed
        default: return .secondary
        }
    }
}

// MARK: - Purchase / transfer confirmation

struct DomainPurchaseConfirmationSheet: View {
    let confirmation: DomainSuccessConfirmation
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) {
                            Image(systemName: confirmation.kind == .purchase ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath.circle.fill")
                                .font(.title2)
                                .foregroundStyle(AppDesign.accentGreen)
                            Text(confirmation.title)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(AppDesign.brandDark)
                        }
                        Text(confirmation.headline)
                            .font(.title2.weight(.medium))
                            .textSelection(.enabled)
                        HStack(spacing: 8) {
                            Text(confirmation.statusLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppDesign.accentGreen)
                            if confirmation.autoRenewOn {
                                Text("· Auto-renew on")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("· Auto-renew off")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(confirmation.message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Your links")
                            .font(.subheadline.weight(.semibold))
                        if let publicUrl = confirmation.publicUrl {
                            linkRow(title: "Public site", value: publicUrl)
                        }
                        if let preview = confirmation.subdomainUrl {
                            linkRow(title: "Bookking preview", value: preview)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .appCard()

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Trust & security")
                            .font(.subheadline.weight(.semibold))
                        Text("Included with your Get Bookking domain.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(confirmation.securityItems) { item in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: item.icon)
                                    .font(.body)
                                    .foregroundStyle(AppDesign.accentBlue)
                                    .frame(width: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title)
                                        .font(.subheadline.weight(.medium))
                                    Text(item.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .appCard()

                    Button {
                        onDismiss()
                    } label: {
                        Text("Done")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppDesign.brandDark)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .padding(.bottom, 24)
            }
            .background(AppDesign.background.ignoresSafeArea())
            .navigationTitle(confirmation.kind == .purchase ? "You’re set" : "Transfer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onDismiss() }
                }
            }
        }
    }

    private func linkRow(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.body.monospaced())
                .foregroundStyle(AppDesign.accentBlue)
                .textSelection(.enabled)
            if let url = URL(string: value) {
                Link("Open", destination: url)
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Transfer instructions

struct DomainTransferInstructionsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                intro
                beforeYouStart
                checklist
                registrarGuides
                dontKnowWhere
                vercelNote
                afterYouStart
                Text("Need help? domainsupport@getbookking.com")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .padding(.bottom, 40)
        }
        .background(AppDesign.background.ignoresSafeArea())
        .navigationTitle("Transfer guide")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Move your domain to Bookking")
                .font(.title3.weight(.semibold))
            Text("You still own the domain. You’re only changing who manages it so we can connect your site automatically — no DNS records to edit.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var beforeYouStart: some View {
        section(title: "Before you start") {
            bullet("Plan about 15 minutes now, then up to 5–7 days for the transfer to finish.")
            bullet("You’ll need the login where you bought the domain, and access to that account’s email.")
            bullet("If you registered the domain in the last 60 days, many registrars block transfers — wait, or buy a new domain in Bookking instead.")
        }
    }

    private var checklist: some View {
        section(title: "At your current registrar") {
            numbered(1, "Unlock the domain (turn off Domain Lock / Registrar Lock).")
            numbered(2, "Turn off WHOIS privacy temporarily if they require it for transfer.")
            numbered(3, "Confirm the registrant email is one you can open.")
            numbered(4, "Get the Authorization / EPP / Transfer code.")
            numbered(5, "Paste that code in Settings → Domain and tap Start transfer.")
        }
    }

    private var registrarGuides: some View {
        section(title: "Where to click") {
            registrar("GoDaddy", "Domain → Settings → Domain Lock Off → Get authorization code")
            registrar("Namecheap", "Domain List → Manage → Sharing & Transfer → Unlock → Auth Code")
            registrar("Google Domains / Squarespace Domains", "Domains → Transfer out → get transfer code")
            registrar("Hover", "Domain → Overview → Unlock → Authorization code")
            registrar("Other registrars", "Look for Transfer lock + Auth / EPP / authorization code")
        }
    }

    private var dontKnowWhere: some View {
        section(title: "Don’t know where you bought it?") {
            bullet("Search your email for “domain registration”, “renewal”, GoDaddy, Namecheap, Google Domains.")
            bullet("Use a WHOIS lookup and note the Registrar name — that’s who to log into.")
            bullet("If you’re stuck, the fastest path is Buy a new domain in Bookking.")
        }
    }

    private var vercelNote: some View {
        section(title: "Site on Vercel, Squarespace, or Wix?") {
            Text("That’s often only where the website lives. The domain was usually bought at a registrar (GoDaddy, Namecheap, etc.). Transfer from the registrar — not from the website editor — unless you bought the domain through that builder.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var afterYouStart: some View {
        section(title: "After you tap Start transfer") {
            bullet("Approve the transfer email if your old registrar sends one.")
            bullet("Don’t re-lock the domain until Bookking shows Connected.")
            bullet("Status in Domain settings moves from Transferring → Connected. We handle the rest.")
        }
    }

    private func section(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(AppDesign.brandWarm)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func numbered(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n).")
                .font(.caption.weight(.bold))
                .foregroundStyle(AppDesign.brandWarm)
                .frame(width: 18, alignment: .leading)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func registrar(_ name: String, _ steps: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .font(.caption.weight(.semibold))
            Text(steps)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}
