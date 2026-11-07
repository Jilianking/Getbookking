//
//  DepositBalanceSettings.swift
//  Deposit and balance options in Booking settings (same fields as the website).
//

import SwiftUI
import Combine
import FirebaseFirestore
import FirebaseFunctions

@MainActor
final class DepositBalanceSettingsModel: ObservableObject {
    struct ServiceDeposit: Identifiable {
        let id: String
        let name: String
        var text: String
        let was: Double
    }

    @Published var perService = false
    @Published var refundable = true
    @Published var balanceDue = "at"
    @Published var reminderDays = 1
    @Published var services: [ServiceDeposit] = []
    @Published var loaded = false

    private var tenantId: String?
    private let db = Firestore.firestore()
    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    func load(tenantId: String?, isCharter: Bool, defaultDeposit: Double) async {
        guard let tid = tenantId, !loaded else { return }
        self.tenantId = tid
        let wf = ((try? await db.collection("tenants").document(tid).getDocument())?.data()?["workflow"] as? [String: Any]) ?? [:]
        perService = (wf["depositPerService"] as? Bool) == true
        refundable = (wf["depositRefundable"] as? Bool) != false
        balanceDue = (wf["balanceDue"] as? String) ?? (isCharter ? "before" : "at")
        reminderDays = (wf["balanceReminderDays"] as? NSNumber)?.intValue ?? (isCharter ? 2 : 1)
        let snap = try? await db.collection("tenants").document(tid).collection("services").getDocuments()
        services = (snap?.documents ?? []).map { d in
            let own = (d.data()["depositAmount"] as? NSNumber)?.doubleValue ?? 0
            let shown = own > 0 ? own : defaultDeposit
            return ServiceDeposit(
                id: d.documentID,
                name: (d.data()["name"] as? String) ?? "Service",
                text: shown > 0 ? String(format: "%.2f", shown) : "",
                was: own
            )
        }
        loaded = true
    }

    /// Saves through the same server function as the website. Returns an error message or nil.
    func save() async -> String? {
        guard let tid = tenantId, loaded else { return nil }
        do {
            _ = try await functions.httpsCallable("updateBalanceSettings").call([
                "balanceDue": balanceDue,
                "balanceReminderDays": reminderDays,
                "depositRefundable": refundable,
                "depositPerService": perService,
            ])
            if perService {
                let batch = db.batch()
                var changed = 0
                for (i, s) in services.enumerated() {
                    let v = Double(s.text.replacingOccurrences(of: "$", with: "")) ?? 0
                    let next = v > 0 ? (v * 100).rounded() / 100 : 0
                    if next == s.was { continue }
                    let ref = db.collection("tenants").document(tid).collection("services").document(s.id)
                    batch.updateData(["depositAmount": next > 0 ? next : NSNull()], forDocument: ref)
                    services[i] = ServiceDeposit(id: s.id, name: s.name, text: s.text, was: next)
                    changed += 1
                }
                if changed > 0 { try await batch.commit() }
            }
            return nil
        } catch {
            return "Deposit options didn’t save: \(error.localizedDescription)"
        }
    }
}

struct DepositBalanceSettingsSection: View {
    @ObservedObject var model: DepositBalanceSettingsModel
    let showsDeposit: Bool
    let isCharter: Bool

    var body: some View {
        Section(
            header: Text("Deposits & balances"),
            footer: Text("Balance reminders go to the client by text and email before the appointment. Non-refundable deposits are kept when a booking is cancelled; other payments are still refunded.")
                .font(.caption2)
        ) {
            if showsDeposit {
                Toggle("Different deposit per service", isOn: $model.perService)
                if model.perService {
                    if model.services.isEmpty {
                        Text("Add services first, then set their deposits here.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach($model.services) { $s in
                        HStack {
                            Text(s.name)
                            Spacer()
                            TextField("Default", text: $s.text)
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .frame(maxWidth: 90)
                            Text("USD").foregroundStyle(.secondary)
                        }
                    }
                }
                Picker("Deposits when cancelled", selection: $model.refundable) {
                    Text("Refundable").tag(true)
                    Text("Non-refundable").tag(false)
                }
            }
            Picker("Balance due", selection: $model.balanceDue) {
                Text(isCharter ? "At the trip" : "At the appointment").tag("at")
                Text(isCharter ? "Before departure" : "Before the appointment").tag("before")
            }
            Picker("Balance reminder", selection: $model.reminderDays) {
                Text("Off").tag(0)
                Text("1 day before").tag(1)
                Text("2 days before").tag(2)
                Text("3 days before").tag(3)
                Text("1 week before").tag(7)
            }
        }
    }
}
