//
//  DomainSettingsViewModel.swift
//
//  Settings → Domain: buy (search + prices) or transfer via Namecheap.
//

import Foundation
import FirebaseFunctions
import Combine

struct DomainSearchResult: Identifiable, Equatable {
    var id: String { domain }
    let domain: String
    let tld: String
    let available: Bool?
    let premium: Bool
    let registerPriceUsd: Double?
    let transferPriceUsd: Double?
    let registerPriceLabel: String?
    let transferPriceLabel: String?
    let statusLabel: String

    var isAvailable: Bool { available == true }
    var isTaken: Bool { available == false }

    static func fromDictionary(_ data: [String: Any]) -> DomainSearchResult? {
        guard let domain = data["domain"] as? String, !domain.isEmpty else { return nil }
        return DomainSearchResult(
            domain: domain,
            tld: data["tld"] as? String ?? "",
            available: data["available"] as? Bool,
            premium: data["premium"] as? Bool ?? false,
            registerPriceUsd: Self.double(from: data["registerPriceUsd"]),
            transferPriceUsd: Self.double(from: data["transferPriceUsd"]),
            registerPriceLabel: data["registerPriceLabel"] as? String,
            transferPriceLabel: data["transferPriceLabel"] as? String,
            statusLabel: data["statusLabel"] as? String ?? ""
        )
    }

    private static func double(from value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let n = value as? NSNumber { return n.doubleValue }
        if let s = value as? String { return Double(s) }
        return nil
    }
}

struct DomainHttpsStatus: Equatable {
    let status: String
    let label: String
    let detail: String
    let url: String?

    static func fromDictionary(_ data: [String: Any]?) -> DomainHttpsStatus? {
        guard let data else { return nil }
        return DomainHttpsStatus(
            status: data["status"] as? String ?? "none",
            label: data["label"] as? String ?? "",
            detail: data["detail"] as? String ?? "",
            url: data["url"] as? String
        )
    }

    var isActive: Bool { status.lowercased() == "active" }
    var isPending: Bool { status.lowercased() == "pending" }
}

struct DomainReassurance: Equatable {
    var subdomainHttps: DomainHttpsStatus?
    var customDomainHttps: DomainHttpsStatus?
    var dnsManagedLabel: String?
    var whoisPrivacyLabel: String?
    var autoRenewLabel: String?
    var expiresAt: String?
    var createdAt: String?
    var registrarLockLabel: String?
    var transferOutPrepared: Bool

    static func fromDictionary(_ data: [String: Any]?) -> DomainReassurance? {
        guard let data else { return nil }
        return DomainReassurance(
            subdomainHttps: DomainHttpsStatus.fromDictionary(data["subdomainHttps"] as? [String: Any]),
            customDomainHttps: DomainHttpsStatus.fromDictionary(data["customDomainHttps"] as? [String: Any]),
            dnsManagedLabel: data["dnsManagedLabel"] as? String,
            whoisPrivacyLabel: data["whoisPrivacyLabel"] as? String,
            autoRenewLabel: data["autoRenewLabel"] as? String,
            expiresAt: data["expiresAt"] as? String,
            createdAt: data["createdAt"] as? String,
            registrarLockLabel: data["registrarLockLabel"] as? String,
            transferOutPrepared: data["transferOutPrepared"] as? Bool ?? false
        )
    }
}

struct DomainSuccessSecurityItem: Identifiable, Equatable {
    let id: String
    let icon: String
    let title: String
    let detail: String
}

struct DomainSuccessConfirmation: Identifiable, Equatable {
    enum Kind: Equatable {
        case purchase
        case transfer
    }

    let id = UUID()
    let kind: Kind
    let domain: String
    let headline: String
    let message: String
    let statusLabel: String
    let publicUrl: String?
    let subdomainUrl: String?
    let autoRenewOn: Bool
    let securityItems: [DomainSuccessSecurityItem]

    var title: String {
        switch kind {
        case .purchase: return "Domain purchased"
        case .transfer: return "Transfer started"
        }
    }
}

@MainActor
final class DomainSettingsViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var isWorking = false
    @Published var isSearching = false
    /// Domain currently being purchased (only that row shows Working).
    @Published var purchasingDomain: String?
    @Published var errorMessage: String?
    @Published var infoMessage: String?

    @Published var slug: String?
    @Published var subdomainUrl: String?
    @Published var domain: String?
    @Published var status: String = "none"
    @Published var statusMessage: String?
    @Published var source: String?
    @Published var providerConfigured = false
    @Published var canBuyOrTransfer = false
    @Published var reassurance: DomainReassurance?
    @Published var transferOutSteps: [String] = []
    @Published var transferOutEmailHint: String?

    /// Buy search query (name or full domain).
    @Published var searchQuery = ""
    @Published var searchResults: [DomainSearchResult] = []

    /// Transfer fields.
    @Published var transferDomain = ""
    @Published var authCode = ""

    /// Prefer auto-renew when buying / transferring (default on).
    @Published var autoRenewEnabled = true
    /// Shown as a sheet after successful buy / transfer.
    @Published var successConfirmation: DomainSuccessConfirmation?

    private let functions = Functions.functions(region: "us-central1")

    var statusLabel: String {
        switch status.lowercased() {
        case "active": return "Connected"
        case "transferring": return "Transferring"
        case "pending", "purchasing", "pending_dns": return "Pending"
        case "failed", "error": return "Needs attention"
        case "none", "": return "Not connected"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var hasManagedDomain: Bool {
        let d = (domain ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !d.isEmpty && status.lowercased() != "none"
    }

    var canTransferOut: Bool {
        hasManagedDomain && status.lowercased() == "active"
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await functions.httpsCallable("getCustomDomainStatus").call([:])
            applyStatus(result.data)
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func searchDomains() async {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            errorMessage = "Enter a name like mystudio or mystudio.com"
            return
        }
        isSearching = true
        errorMessage = nil
        infoMessage = nil
        defer { isSearching = false }
        do {
            let result = try await functions.httpsCallable("searchDomains").call([
                "query": q,
            ])
            guard let data = result.data as? [String: Any] else {
                searchResults = []
                return
            }
            let configured =
                (data["providerConfigured"] as? Bool)
                ?? (data["namecheapConfigured"] as? Bool)
                ?? false
            providerConfigured = configured
            canBuyOrTransfer = (data["canBuyOrTransfer"] as? Bool) ?? configured
            if let msg = data["message"] as? String, !msg.isEmpty {
                infoMessage = msg
            }
            let rows = data["results"] as? [[String: Any]] ?? []
            searchResults = rows.compactMap { DomainSearchResult.fromDictionary($0) }
            if searchResults.isEmpty, errorMessage == nil, infoMessage == nil {
                infoMessage = "No results. Try a different name."
            }
        } catch {
            searchResults = []
            errorMessage = friendlyError(error)
        }
    }

    func startTransfer() async {
        let domain = normalizedTransferDomain()
        let code = authCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !domain.isEmpty else {
            errorMessage = "Enter the domain you want to transfer"
            return
        }
        guard code.count >= 4 else {
            errorMessage = "Paste the authorization / EPP code from your current registrar"
            return
        }
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer { isWorking = false }
        do {
            let result = try await functions.httpsCallable("startDomainTransfer").call([
                "domain": domain,
                "authCode": code,
                "autoRenew": autoRenewEnabled,
            ])
            guard let data = result.data as? [String: Any] else { return }
            if data["needsPayment"] as? Bool == true {
                guard let clientSecret = data["clientSecret"] as? String,
                      let paymentIntentId = data["paymentIntentId"] as? String else {
                    errorMessage = "Could not start payment. Try again."
                    return
                }
                let pk = data["publishableKey"] as? String
                let priceLabel = data["customerPriceUsd"].map { "\($0)" } ?? ""
                infoMessage = data["message"] as? String
                let payResult = await DomainPaymentSheetPresenter.present(
                    clientSecret: clientSecret,
                    publishableKey: pk
                )
                switch payResult {
                case .completed:
                    let done = try await functions.httpsCallable("completeDomainTransfer").call([
                        "paymentIntentId": paymentIntentId,
                    ])
                    applyStatus(done.data)
                    var doneMessage = data["message"] as? String
                    if let doneData = done.data as? [String: Any] {
                        doneMessage = doneData["message"] as? String ?? doneMessage
                    }
                    authCode = ""
                    NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
                    await load()
                    presentSuccessConfirmation(
                        kind: .transfer,
                        fallbackDomain: domain,
                        message: doneMessage
                    )
                case .canceled:
                    infoMessage = "Payment canceled. Transfer was not started."
                case .failed(let msg):
                    errorMessage = msg
                }
                _ = priceLabel
            } else {
                applyStatus(result.data)
                let msg = data["message"] as? String
                infoMessage = msg
                authCode = ""
                NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
                await load()
                presentSuccessConfirmation(
                    kind: .transfer,
                    fallbackDomain: domain,
                    message: msg
                )
            }
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func startPurchase(domain: String) async {
        let d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !d.isEmpty else {
            errorMessage = "Pick a domain to buy"
            return
        }
        purchasingDomain = d
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer {
            isWorking = false
            purchasingDomain = nil
        }
        do {
            let result = try await functions.httpsCallable("startDomainPurchase").call([
                "domain": d,
                "autoRenew": autoRenewEnabled,
            ])
            guard let data = result.data as? [String: Any] else { return }
            if data["needsPayment"] as? Bool == true {
                guard let clientSecret = data["clientSecret"] as? String,
                      let paymentIntentId = data["paymentIntentId"] as? String else {
                    errorMessage = "Could not start payment. Try again."
                    return
                }
                let pk = data["publishableKey"] as? String
                infoMessage = data["message"] as? String
                let payResult = await DomainPaymentSheetPresenter.present(
                    clientSecret: clientSecret,
                    publishableKey: pk
                )
                switch payResult {
                case .completed:
                    let done = try await functions.httpsCallable("completeDomainPurchase").call([
                        "paymentIntentId": paymentIntentId,
                    ])
                    applyStatus(done.data)
                    var doneMessage: String?
                    if let doneData = done.data as? [String: Any] {
                        doneMessage = doneData["message"] as? String
                    }
                    NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
                    await load()
                    presentSuccessConfirmation(
                        kind: .purchase,
                        fallbackDomain: d,
                        message: doneMessage
                    )
                case .canceled:
                    infoMessage = "Payment canceled. Domain was not registered."
                case .failed(let msg):
                    errorMessage = msg
                }
            } else {
                applyStatus(result.data)
                let msg = data["message"] as? String
                infoMessage = msg
                NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
                await load()
                presentSuccessConfirmation(
                    kind: .purchase,
                    fallbackDomain: d,
                    message: msg
                )
            }
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func isPurchasing(_ domain: String) -> Bool {
        purchasingDomain == domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    func useForTransfer(_ result: DomainSearchResult) {
        transferDomain = result.domain
        infoMessage = "Paste your authorization code below to transfer \(result.domain)."
    }

    func setAutoRenew(_ enabled: Bool) async {
        guard hasManagedDomain else { return }
        let previous = autoRenewEnabled
        autoRenewEnabled = enabled
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer { isWorking = false }
        do {
            let result = try await functions.httpsCallable("setCustomDomainAutoRenew").call([
                "autoRenew": enabled,
            ])
            applyStatus(result.data)
            if let data = result.data as? [String: Any] {
                infoMessage = data["message"] as? String
            }
        } catch {
            autoRenewEnabled = previous
            errorMessage = friendlyError(error)
        }
    }

    func removeDomain() async {
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer { isWorking = false }
        do {
            let result = try await functions.httpsCallable("removeCustomDomain").call([:])
            if let data = result.data as? [String: Any] {
                infoMessage = data["message"] as? String
            }
            domain = nil
            status = "none"
            statusMessage = nil
            source = nil
            reassurance = nil
            transferOutSteps = []
            NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
            await load()
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func prepareTransferOut() async {
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer { isWorking = false }
        do {
            let result = try await functions.httpsCallable("prepareDomainTransferOut").call([:])
            guard let data = result.data as? [String: Any] else { return }
            infoMessage = data["message"] as? String
            transferOutEmailHint = data["contactEmailHint"] as? String
            transferOutSteps = data["steps"] as? [String] ?? []
            await load()
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func confirmTransferOut() async {
        isWorking = true
        errorMessage = nil
        infoMessage = nil
        defer { isWorking = false }
        do {
            let result = try await functions.httpsCallable("confirmDomainTransferOut").call([:])
            if let data = result.data as? [String: Any] {
                infoMessage = data["message"] as? String
            }
            domain = nil
            status = "none"
            reassurance = nil
            transferOutSteps = []
            NotificationCenter.default.post(name: .customDomainDidChange, object: nil)
            await load()
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func dismissSuccessConfirmation() {
        successConfirmation = nil
    }

    private func presentSuccessConfirmation(
        kind: DomainSuccessConfirmation.Kind,
        fallbackDomain: String,
        message: String?
    ) {
        let domainName = (domain ?? fallbackDomain)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !domainName.isEmpty else { return }

        let r = reassurance
        var items: [DomainSuccessSecurityItem] = []
        if let custom = r?.customDomainHttps {
            items.append(
                DomainSuccessSecurityItem(
                    id: "https",
                    icon: custom.isActive ? "lock.fill" : (custom.isPending ? "lock" : "globe"),
                    title: "HTTPS — \(custom.label)",
                    detail: custom.detail
                )
            )
        } else {
            items.append(
                DomainSuccessSecurityItem(
                    id: "https",
                    icon: "lock.fill",
                    title: "HTTPS",
                    detail: "Visitors get a secure padlock once DNS is live."
                )
            )
        }
        if let whois = r?.whoisPrivacyLabel, !whois.isEmpty {
            items.append(
                DomainSuccessSecurityItem(
                    id: "whois",
                    icon: "eye.slash",
                    title: "WHOIS privacy",
                    detail: whois
                )
            )
        } else {
            items.append(
                DomainSuccessSecurityItem(
                    id: "whois",
                    icon: "eye.slash",
                    title: "WHOIS privacy",
                    detail: "Your contact details stay private."
                )
            )
        }
        items.append(
            DomainSuccessSecurityItem(
                id: "renew",
                icon: "arrow.triangle.2.circlepath",
                title: "Auto-renew",
                detail: autoRenewEnabled
                    ? "On — we’ll renew before it expires."
                    : "Off — renew manually before expiry."
            )
        )
        if let lock = r?.registrarLockLabel, !lock.isEmpty {
            items.append(
                DomainSuccessSecurityItem(
                    id: "lock",
                    icon: "checkmark.shield",
                    title: "Registrar lock",
                    detail: lock
                )
            )
        } else {
            items.append(
                DomainSuccessSecurityItem(
                    id: "lock",
                    icon: "checkmark.shield",
                    title: "Registrar lock",
                    detail: "On — protects against unauthorized transfers."
                )
            )
        }
        if let dns = r?.dnsManagedLabel, !dns.isEmpty {
            items.append(
                DomainSuccessSecurityItem(
                    id: "dns",
                    icon: "server.rack",
                    title: "DNS",
                    detail: dns
                )
            )
        } else {
            items.append(
                DomainSuccessSecurityItem(
                    id: "dns",
                    icon: "server.rack",
                    title: "DNS",
                    detail: "Managed by Get Bookking — you don’t edit records."
                )
            )
        }
        if let exp = r?.expiresAt, !exp.isEmpty {
            items.append(
                DomainSuccessSecurityItem(
                    id: "expires",
                    icon: "calendar",
                    title: "Expires",
                    detail: exp
                )
            )
        }

        let headline: String
        switch kind {
        case .purchase:
            headline = "\(domainName) is yours"
        case .transfer:
            headline = "Transferring \(domainName)"
        }

        let defaultMessage: String
        switch kind {
        case .purchase:
            defaultMessage = "Design is reset to a blank template — open Design to build your site."
        case .transfer:
            defaultMessage =
                "Approve any emails from your old registrar. Your site keeps working on your Bookking preview link."
        }

        successConfirmation = DomainSuccessConfirmation(
            kind: kind,
            domain: domainName,
            headline: headline,
            message: (message?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? defaultMessage,
            statusLabel: statusLabel,
            publicUrl: "https://\(domainName)",
            subdomainUrl: subdomainUrl,
            autoRenewOn: autoRenewEnabled,
            securityItems: items
        )
    }

    private func applyStatus(_ raw: Any?) {
        guard let data = raw as? [String: Any] else { return }
        slug = data["slug"] as? String
        subdomainUrl = data["subdomainUrl"] as? String
        domain = data["domain"] as? String
        status = (data["status"] as? String ?? "none")
        statusMessage = data["statusMessage"] as? String
        source = data["source"] as? String
        let configured =
            (data["providerConfigured"] as? Bool)
            ?? (data["namecheapConfigured"] as? Bool)
            ?? false
        providerConfigured = configured
        canBuyOrTransfer = data["canBuyOrTransfer"] as? Bool ?? configured
        if let ar = data["autoRenew"] as? Bool {
            autoRenewEnabled = ar
        } else if let r = data["reassurance"] as? [String: Any], let ar = r["autoRenew"] as? Bool {
            autoRenewEnabled = ar
        }
        reassurance = DomainReassurance.fromDictionary(data["reassurance"] as? [String: Any])
        if let d = domain,
           transferDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           status.lowercased() != "none" {
            transferDomain = d
        }
    }

    private func normalizedTransferDomain() -> String {
        var d = transferDomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        d = d.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
        d = d.replacingOccurrences(of: "/.*$", with: "", options: .regularExpression)
        if d.hasPrefix("www.") { d = String(d.dropFirst(4)) }
        return d
    }

    private func friendlyError(_ error: Error) -> String {
        let ns = error as NSError
        if let msg = ns.userInfo[NSLocalizedDescriptionKey] as? String, !msg.isEmpty,
           !msg.lowercased().contains("internal") {
            return msg
        }
        if let details = ns.userInfo["details"] as? String, !details.isEmpty {
            return details
        }
        let text = error.localizedDescription
        if text.lowercased().contains("internal") {
            return "Something went wrong. Please try again."
        }
        return text
    }
}
