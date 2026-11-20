//
//  BookingBalance.swift
//  Booking balances on iPhone, matching the web calendar (web/marketing/assets/app-balance.js):
//  the Payment card on a booking (price, payments, balance due, Collect / Text pay link / Mark paid in cash)
//  and the "$100 due" tag on the schedule. Server: functions/balances.js.
//

import SwiftUI
import FirebaseFirestore
import FirebaseFunctions

/// One payment on a booking (tenants/{t}/bookingRequests/{id}.payments.{id}).
struct BookingPaymentEntry: Identifiable, Equatable {
    let id: String
    let kind: String      // card | tap | link | cash
    let role: String      // deposit | balance | payment
    let cents: Int        // toward the price, before card fees
    let refundedCents: Int
    let at: Date?
    var legacy = false

    var netCents: Int { max(0, cents - refundedCents) }

    var label: String {
        let day = at.map { " " + $0.formatted(.dateTime.month(.abbreviated).day()) } ?? ""
        if kind == "cash" { return "Paid\(day) · Cash" }
        let role = ["deposit": "Deposit", "balance": "Balance"][self.role] ?? "Payment"
        let how = ["tap": " · Tap to Pay", "link": " · Pay link"][kind] ?? ""
        return "Paid\(day) · \(role)\(how)"
    }

    static func parse(_ raw: Any?) -> [BookingPaymentEntry] {
        guard let map = raw as? [String: Any] else { return [] }
        return map.compactMap { id, value in
            guard let p = value as? [String: Any] else { return nil }
            return BookingPaymentEntry(
                id: id,
                kind: (p["kind"] as? String) ?? "card",
                role: (p["role"] as? String) ?? "payment",
                cents: BookingRequest.intField(p["cents"]) ?? 0,
                refundedCents: BookingRequest.intField(p["refundedCents"]) ?? 0,
                at: (p["at"] as? Timestamp)?.dateValue()
            )
        }
        .sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }
    }
}

/// Price, payments, and what's still owed on a booking.
struct BookingBalance {
    let price: Int?
    let priceFromService: Bool
    let payments: [BookingPaymentEntry]
    let paid: Int
    let balance: Int?
    /// The shop set a price or took money, so an unpaid balance is real (not just "not recorded").
    let tracked: Bool

    /// Service prices (cents) by service id and "name:<lowercased name>", for bookings without a price.
    @MainActor static var servicePrices: [String: Int] = [:]

    @MainActor
    static func loadServicePrices(tenantId: String) async {
        guard let services = try? await FirebaseService().fetchTenantServices(tenantId: tenantId) else { return }
        var map: [String: Int] = [:]
        for s in services {
            guard let p = s.price, p > 0 else { continue }
            let cents = Int((p * 100).rounded())
            map[s.id] = cents
            map["name:" + s.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()] = cents
        }
        servicePrices = map
    }

    @MainActor
    static func servicePrice(for r: BookingRequest) -> Int {
        if let id = r.serviceId, let c = servicePrices[id] { return c }
        let name = (r.serviceName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return servicePrices["name:" + name] ?? 0
    }

    init(_ r: BookingRequest, servicePriceCents: Int) {
        var list = r.bookingPayments
        if list.isEmpty, let paid = r.paidCents, paid > 0 {
            // Older bookings: one payment, before the payments list existed.
            list = [BookingPaymentEntry(
                id: "legacy", kind: "card", role: r.depositPaidAt != nil ? "deposit" : "payment",
                cents: (r.depositPartCents ?? 0) > 0 ? r.depositPartCents! : paid, refundedCents: 0,
                at: r.paidAt ?? r.depositPaidAt, legacy: true
            )]
        }
        payments = list
        if let p = r.priceCents {
            price = p; priceFromService = false
        } else if let trip = r.tripCents, trip > 0 {
            price = trip + (r.addonCents ?? 0); priceFromService = false
        } else if servicePriceCents > 0 {
            price = servicePriceCents; priceFromService = true
        } else {
            price = nil; priceFromService = false
        }
        let paidTotal = list.reduce(0) { $0 + $1.netCents }
        paid = paidTotal
        balance = price.map { max(0, $0 - paidTotal) }
        tracked = r.priceCents != nil || (r.tripCents ?? 0) > 0 || !list.isEmpty
    }

    /// "$ due" on the schedule: open bookings the shop is tracking that still owe money.
    @MainActor
    static func dueCents(_ r: BookingRequest) -> Int? {
        let s = BookingRequestStatus.normalized(r.status)
        guard [BookingRequestStatus.confirmed, "completed", BookingRequestStatus.pendingDeposit, BookingRequestStatus.pendingPayment].contains(s),
              r.noShowAt == nil else { return nil }
        let b = BookingBalance(r, servicePriceCents: servicePrice(for: r))
        guard b.tracked, let due = b.balance, due > 0 else { return nil }
        return due
    }

    static func usd(_ cents: Int) -> String {
        let v = Double(cents) / 100
        return v.formatted(.currency(code: "USD").precision(.fractionLength(cents % 100 == 0 ? 0 : 2)))
    }
}

/// Small "$100 due" tag for schedule rows.
struct BalanceDueTag: View {
    let cents: Int?
    var body: some View {
        if let cents, cents > 0 {
            Text("\(BookingBalance.usd(cents)) due")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(Color(hex: "#7A5418"))
                .background(Capsule().fill(Color(hex: "#F6E7C8")))
        }
    }
}

// MARK: - Server calls

extension RequestsViewModel {
    private var balanceFunctions: Functions { Functions.functions(region: Constants.Firebase.cloudFunctionsRegion) }

    func setBookingPrice(requestId: String, cents: Int?) async throws {
        _ = try await balanceFunctions.httpsCallable("setBookingPrice").call(["requestId": requestId, "priceCents": cents as Any])
    }

    func recordCashPayment(requestId: String, cents: Int) async throws {
        _ = try await balanceFunctions.httpsCallable("recordBookingCashPayment").call(["requestId": requestId, "cents": cents])
    }

    func removeCashPayment(requestId: String, paymentId: String) async throws {
        _ = try await balanceFunctions.httpsCallable("removeBookingCashPayment").call(["requestId": requestId, "paymentId": paymentId])
    }

    /// A secure link for the client to pay the balance on the shop's site.
    func createBalanceLink(requestId: String) async throws -> (url: String, cents: Int) {
        let res = try await balanceFunctions.httpsCallable("createBookingBalanceLink").call(["requestId": requestId])
        let d = res.data as? [String: Any] ?? [:]
        guard let url = d["url"] as? String, !url.isEmpty else { throw URLError(.badServerResponse) }
        return (url, (d["cents"] as? NSNumber)?.intValue ?? 0)
    }
}

// MARK: - Payment card

struct BookingPaymentSection: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    let canManage: Bool
    let shopName: String
    /// Opens Tap to Pay / card checkout for this amount (nil when it isn't available in this build).
    var onCollect: ((Int) -> Void)?
    /// Default deposit (cents) when the booking doesn't remember what was asked for.
    var defaultDepositCents: Int = 0
    /// Reloads bookings after a change.
    var onChanged: () async -> Void

    @State private var servicePriceCents = 0
    @State private var busy = false
    @State private var message: String?
    @State private var messageOk = true
    @State private var linkURL: String?
    @State private var showPriceAlert = false
    @State private var showCashAlert = false
    @State private var amountText = ""
    @State private var removing: BookingPaymentEntry?
    @State private var showDepositAlert = false

    private var model: BookingBalance { BookingBalance(request, servicePriceCents: servicePriceCents) }
    private var status: String { BookingRequestStatus.normalized(request.status) }
    private var live: Bool {
        ["confirmed", "completed", "pending_deposit", "pending_payment", "pending_consultation", "new", "pending"].contains(status)
    }
    private var mayAct: Bool { canManage && live && !(request.documentId ?? "").isEmpty }

    var body: some View {
        let m = model
        VStack(alignment: .leading, spacing: 10) {
            BookingRequestSectionHeader(title: "Payment")
            row(label: "Price" + (m.priceFromService ? " · from service" : ""), value: m.price.map(BookingBalance.usd) ?? "Not set") {
                if mayAct {
                    Button(m.price == nil || m.priceFromService ? "Set" : "Edit") {
                        amountText = m.price.map { String(format: "%.2f", Double($0) / 100) } ?? ""
                        showPriceAlert = true
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.brandWarm)
                    .disabled(busy)
                }
            }
            ForEach(m.payments) { p in
                row(label: p.label + (p.refundedCents > 0 ? " · \(BookingBalance.usd(p.refundedCents)) refunded" : ""), value: BookingBalance.usd(p.netCents), muted: true) {
                    if mayAct && p.kind == "cash" && !p.legacy {
                        Button("Remove", role: .destructive) { removing = p }
                            .font(.caption.weight(.semibold))
                            .disabled(busy)
                    }
                }
            }
            if status == "pending_deposit" {
                row(label: "Deposit requested · waiting", value: (request.depositRequestCents ?? 0) > 0 ? BookingBalance.usd(request.depositRequestCents!) : "—", muted: true) { EmptyView() }
            }
            Divider().overlay(AppDesign.textPrimary)
            if let due = m.balance {
                if due <= 0 {
                    Label("Paid in full", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.accentGreen)
                } else {
                    HStack {
                        Text("Balance due").font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(BookingBalance.usd(due)).font(.headline)
                    }
                }
            } else {
                HStack {
                    Text("Balance due").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("Set a price").font(.subheadline).foregroundStyle(AppDesign.textSecondary)
                }
            }
            if mayAct && status == "pending_deposit" {
                Button {
                    let cents = (request.depositRequestCents ?? 0) > 0 ? request.depositRequestCents! : defaultDepositCents
                    if cents >= 50 {
                        Task { await resendDeposit(cents: cents) }
                    } else {
                        amountText = ""
                        showDepositAlert = true
                    }
                } label: {
                    Label("Resend deposit link", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppDesign.brandDark)
                .disabled(busy)
            }
            if mayAct, status != "pending_deposit", let due = m.balance, due > 0 {
                VStack(spacing: 8) {
                    if let onCollect {
                        Button {
                            Task {
                                await ensurePrice()
                                onCollect(due)
                            }
                        } label: {
                            Label("Collect \(BookingBalance.usd(due))", systemImage: "wave.3.right")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AppDesign.brandDark)
                    }
                    HStack(spacing: 8) {
                        Button { Task { await textPayLink(due: due) } } label: {
                            Text("Text pay link").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        Button {
                            amountText = String(format: "%.2f", Double(due) / 100)
                            showCashAlert = true
                        } label: {
                            Text("Paid in cash").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .disabled(busy)
            }
            if busy { ProgressView().frame(maxWidth: .infinity) }
            if let message {
                Text(message).font(.caption).foregroundStyle(messageOk ? AppDesign.accentGreen : .red)
            }
            if let linkURL {
                HStack(spacing: 8) {
                    Text(linkURL).font(.caption2).lineLimit(1).truncationMode(.middle).foregroundStyle(AppDesign.textSecondary)
                    Spacer(minLength: 4)
                    Button("Copy") {
                        UIPasteboard.general.string = linkURL
                        say("Link copied.", ok: true)
                    }
                    .font(.caption.weight(.semibold))
                    if let url = URL(string: linkURL) {
                        ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
        .task(id: request.serviceId ?? request.serviceName ?? "") {
            if let tid = request.tenantId ?? viewModel.tenantId, BookingBalance.servicePrices.isEmpty {
                await BookingBalance.loadServicePrices(tenantId: tid)
            }
            servicePriceCents = BookingBalance.servicePrice(for: request)
        }
        .alert(model.price == nil || model.priceFromService ? "Set price" : "Edit price", isPresented: $showPriceAlert) {
            TextField("Total price", text: $amountText).keyboardType(.decimalPad)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await savePrice() } }
        } message: {
            Text("The total for this booking. The balance updates right away.")
        }
        .alert("Paid in cash", isPresented: $showCashAlert) {
            TextField("Cash received", text: $amountText).keyboardType(.decimalPad)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await saveCash() } }
        } message: {
            Text("A smaller amount leaves the rest due.")
        }
        .alert("Deposit amount", isPresented: $showDepositAlert) {
            TextField("Deposit", text: $amountText).keyboardType(.decimalPad)
            Button("Cancel", role: .cancel) {}
            Button("Send") {
                if let c = cents(amountText), c >= 50 { Task { await resendDeposit(cents: c) } }
                else { say("Enter at least $0.50.", ok: false) }
            }
        } message: {
            Text("The client gets a text with a link to pay it.")
        }
        .confirmationDialog("Remove this cash payment?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let p = removing { Task { await removeCash(p) } } }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Use this only if it was entered by mistake.")
        }
    }

    @ViewBuilder
    private func row<Trailing: View>(label: String, value: String, muted: Bool = false, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.subheadline).foregroundStyle(muted ? AppDesign.textSecondary : AppDesign.textPrimary)
            Spacer(minLength: 6)
            Text(value).font(.subheadline.weight(.semibold))
            trailing()
        }
    }

    private func cents(_ text: String) -> Int? {
        let cleaned = text.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "").trimmingCharacters(in: .whitespaces)
        guard let v = Double(cleaned), v > 0, v <= 50_000 else { return nil }
        return Int((v * 100).rounded())
    }

    private func say(_ text: String, ok: Bool) {
        message = text
        messageOk = ok
    }

    private func friendly(_ error: Error, _ fallback: String) -> String {
        let msg = (error as NSError).localizedDescription
        return msg.isEmpty || msg.lowercased() == "internal" ? fallback : msg
    }

    /// The service price becomes the booking's price before money is recorded against it.
    private func ensurePrice() async {
        let m = model
        guard m.priceFromService, let p = m.price, let id = request.documentId else { return }
        try? await viewModel.setBookingPrice(requestId: id, cents: p)
    }

    private func savePrice() async {
        guard let id = request.documentId else { return }
        guard let c = cents(amountText) else { return say("Enter a price between $0.01 and $50,000.", ok: false) }
        busy = true
        defer { busy = false }
        do {
            try await viewModel.setBookingPrice(requestId: id, cents: c)
            await onChanged()
            say("Price saved.", ok: true)
        } catch {
            say(friendly(error, "Couldn't save the price. Try again."), ok: false)
        }
    }

    private func saveCash() async {
        guard let id = request.documentId else { return }
        guard let c = cents(amountText) else { return say("Enter the cash amount.", ok: false) }
        busy = true
        defer { busy = false }
        do {
            await ensurePrice()
            try await viewModel.recordCashPayment(requestId: id, cents: c)
            await onChanged()
            say("\(BookingBalance.usd(c)) cash recorded.", ok: true)
        } catch {
            say(friendly(error, "Couldn't save the cash payment. Try again."), ok: false)
        }
    }

    private func removeCash(_ p: BookingPaymentEntry) async {
        guard let id = request.documentId else { return }
        busy = true
        defer { busy = false; removing = nil }
        do {
            try await viewModel.removeCashPayment(requestId: id, paymentId: p.id)
            await onChanged()
            say("Cash payment removed.", ok: true)
        } catch {
            say(friendly(error, "Couldn't remove it. Try again."), ok: false)
        }
    }

    private func resendDeposit(cents: Int) async {
        busy = true
        linkURL = nil
        say("Making the deposit link…", ok: true)
        defer { busy = false }
        guard let res = await viewModel.sendDepositLinkViaSms(for: request, depositAmount: Double(cents) / 100) else {
            say(viewModel.actionError ?? "Couldn't make the deposit link.", ok: false)
            return
        }
        linkURL = res.url
        say(res.texted ? "Deposit link texted." : "The text didn't send: \(res.error ?? "unknown reason") Copy or share the link below.", ok: res.texted)
        if res.texted { viewModel.actionError = nil }
        await onChanged()
    }

    private func textPayLink(due: Int) async {
        guard let id = request.documentId else { return }
        busy = true
        linkURL = nil
        say("Making the pay link…", ok: true)
        defer { busy = false }
        do {
            await ensurePrice()
            let link = try await viewModel.createBalanceLink(requestId: id)
            linkURL = link.url
            let first = BookingTextCopy.firstName(request.customerName)
            let when = BookingTextCopy.whenPhrase(request.departureStart)
            let body = "Hi\(first.isEmpty ? "" : " " + first), here's your link to pay the \(BookingBalance.usd(link.cents)) balance for \(request.serviceName ?? "your appointment")\(when): \(link.url) — \(shopName)"
            let sent = await viewModel.sendBookingText(to: request.customerPhone, clientName: request.customerName, body: body, preview: "Pay link · \(BookingBalance.usd(link.cents))")
            say(sent ? "Pay link texted\(first.isEmpty ? "" : " to " + first)." : "Couldn't text it. Copy or share the link below.", ok: sent)
        } catch {
            say(friendly(error, "Couldn't make the pay link. Check that card payments are set up."), ok: false)
        }
    }
}
