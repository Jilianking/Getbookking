//
//  ExpensesViewModel.swift
//
//  Loads/saves tenant expenses for tax-deduction tracking, and merges in a
//  live-computed "Payment Processing Fees" row from Stripe Connect balance
//  transactions (never stored — see Expense.swift / firestore.rules).
//

import Foundation
import Combine
import FirebaseFirestore
import FirebaseFunctions

@MainActor
final class ExpensesViewModel: ObservableObject {
    @Published var rows: [ExpenseReportRow] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var rangeStart: Date = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @Published var rangeEnd: Date = Date()

    private let firebaseService = FirebaseService()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)
    private var tenantId: String?

    var totalCents: Int { rows.reduce(0) { $0 + $1.amountCents } }

    var totalsByCategory: [(category: String, cents: Int)] {
        var totals: [String: Int] = [:]
        for row in rows { totals[row.categoryDisplayName, default: 0] += row.amountCents }
        return totals.map { ($0.key, $0.value) }.sorted { $0.cents > $1.cents }
    }

    func loadData(sessionStore: TenantSessionStore) async {
        guard let tid = sessionStore.tenantId else { return }
        tenantId = tid
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        // `rangeStart`/`rangeEnd` are calendar-date pickers — widen to the full selected
        // days so an expense saved later in "today" (after rangeEnd was last evaluated)
        // still falls inside the query bounds, instead of being silently excluded.
        let calendar = Calendar.current
        let queryStart = calendar.startOfDay(for: rangeStart)
        let queryEnd = calendar.date(bySettingHour: 23, minute: 59, second: 59, of: rangeEnd) ?? rangeEnd

        async let manualExpenses: [Expense] = (try? firebaseService.fetchTenantExpenses(
            tenantId: tid, from: queryStart, to: queryEnd
        )) ?? []
        async let stripeFeeRows: [ExpenseReportRow] = loadStripeFeeRows(rangeStart: queryStart, rangeEnd: queryEnd)

        let manualRows = await manualExpenses.map { ExpenseReportRow(expense: $0) }
        let feeRows = await stripeFeeRows
        rows = (manualRows + feeRows).sorted { $0.date > $1.date }
    }

    func refresh(sessionStore: TenantSessionStore) async {
        await loadData(sessionStore: sessionStore)
    }

    /// Filters the existing `getConnectBalanceTransactions` callable (already relied on by
    /// Payments/Insights) to charge fees only, and synthesizes a virtual row per charge —
    /// no new Cloud Function, no new storage, no reconciliation surface.
    private func loadStripeFeeRows(rangeStart: Date, rangeEnd: Date) async -> [ExpenseReportRow] {
        do {
            let payload: [String: Any] = [
                "startTimestampSeconds": Int(rangeStart.timeIntervalSince1970),
                "endTimestampSeconds": Int(rangeEnd.timeIntervalSince1970),
                "limit": 100,
            ]
            let result = try await functions.httpsCallable("getConnectBalanceTransactions").call(payload)
            let data = result.data as? [String: Any]
            let list = data?["transactions"] as? [[String: Any]] ?? []
            var feeRows: [ExpenseReportRow] = []
            for t in list {
                let type = (t["type"] as? String ?? "").lowercased()
                guard type == "charge" else { continue }
                let feeCents = (t["fee"] as? NSNumber)?.intValue ?? 0
                guard feeCents > 0 else { continue }
                let created = (t["created"] as? NSNumber)?.intValue ?? 0
                guard created > 0 else { continue }
                let id = (t["id"] as? String) ?? UUID().uuidString
                let date = Date(timeIntervalSince1970: TimeInterval(created))
                let note = t["description"] as? String
                feeRows.append(ExpenseReportRow(stripeFeeId: id, amountCents: feeCents, date: date, note: note))
            }
            return feeRows
        } catch {
            return []
        }
    }

    /// `expenseId` must be resolved by the caller (existing expense's id, or a freshly
    /// generated UUID for a new one) so it matches whatever id the receipt photo — if any —
    /// was already uploaded under.
    func saveExpense(
        expenseId: String,
        isNew: Bool,
        amountCents: Int,
        category: ExpenseCategory,
        vendor: String,
        date: Date,
        note: String?,
        receiptImageUrl: String?,
        receiptStoragePath: String?,
        source: String
    ) async throws {
        guard let tid = tenantId else { throw NSError(domain: "ExpensesViewModel", code: -1, userInfo: [NSLocalizedDescriptionKey: "No tenant"]) }
        var data: [String: Any] = [
            "amountCents": amountCents,
            "currency": "usd",
            "category": category.rawValue,
            "vendor": vendor,
            "date": Timestamp(date: date),
            "source": source,
        ]
        data["note"] = (note?.isEmpty == false) ? note! : FieldValue.delete()
        if let receiptImageUrl { data["receiptImageUrl"] = receiptImageUrl }
        if let receiptStoragePath { data["receiptStoragePath"] = receiptStoragePath }
        if isNew {
            data["createdAt"] = Timestamp(date: Date())
        }
        try await firebaseService.upsertTenantExpense(tenantId: tid, expenseId: expenseId, data: data)
    }

    func deleteExpense(_ expense: Expense) async throws {
        guard let tid = tenantId else { return }
        try await firebaseService.deleteTenantExpense(tenantId: tid, expenseId: expense.id)
    }

    /// Sends a receipt photo for OCR pre-fill. Runs before the user confirms/saves — the
    /// result only populates the add-expense form fields, never writes anything.
    /// `callSucceeded` distinguishes a hard failure (network/auth/quota — see error logs)
    /// from a call that completed but couldn't confidently read the receipt (all fields nil).
    func runReceiptOcr(imageData: Data) async -> (amountCents: Int?, date: Date?, vendor: String?, callSucceeded: Bool) {
        do {
            let base64 = imageData.base64EncodedString()
            let payload: [String: Any] = ["imageBase64": base64, "mimeType": "image/jpeg"]
            let result = try await functions.httpsCallable("extractReceiptData").call(payload)
            let data = result.data as? [String: Any]
            let amountCents = (data?["amountCents"] as? NSNumber)?.intValue
            var date: Date?
            if let dateString = data?["date"] as? String {
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd"
                formatter.timeZone = TimeZone(identifier: "UTC")
                date = formatter.date(from: dateString)
            }
            let vendor = data?["vendor"] as? String
            return (amountCents, date, vendor, true)
        } catch {
            return (nil, nil, nil, false)
        }
    }

    func exportCSV() -> String {
        var lines = ["Date,Category,Vendor,Amount,Note,Source,Receipt URL"]
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        for row in rows.sorted(by: { $0.date < $1.date }) {
            let fields = [
                dateFormatter.string(from: row.date),
                row.categoryDisplayName,
                row.vendor,
                String(format: "%.2f", row.amount),
                row.note ?? "",
                row.sourceLabel,
                row.receiptImageUrl ?? "",
            ]
            lines.append(fields.map(csvEscape).joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    private func csvEscape(_ field: String) -> String {
        guard field.contains(",") || field.contains("\"") || field.contains("\n") else { return field }
        return "\"\(field.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}
