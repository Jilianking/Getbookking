//
//  ShopBlockedTime.swift
//  Shop-wide blocked time and days off on the schedule — the same tenant fields the web calendar uses
//  (blockedTimeRanges, blockedDates, blockedDateLabels). Online booking skips these times.
//

import SwiftUI
import Combine
import FirebaseAuth
import FirebaseFirestore

/// One thing to draw on the schedule for a day: a partial block or the whole day off.
struct ScheduleBlock: Identifiable, Equatable {
    enum Kind: Equatable { case range, allDay }
    let id: String
    let kind: Kind
    let dateYmd: String
    let startMinutes: Int
    let endMinutes: Int
    let label: String?

    var title: String {
        if let label, !label.isEmpty { return label }
        return kind == .allDay ? "Closed all day" : "Blocked"
    }

    var timeLine: String {
        kind == .allDay
            ? "All day"
            : "\(BusinessHoursWeekly.formatTime(minutes: startMinutes)) – \(BusinessHoursWeekly.formatTime(minutes: endMinutes))"
    }
}

@MainActor
final class ShopBlockedTimeStore: ObservableObject {
    @Published private(set) var ranges: [BlockedTimeRange] = []
    @Published private(set) var days: [String] = []
    @Published private(set) var dayLabels: [String: String] = [:]
    @Published var isSaving = false
    @Published var errorMessage: String?

    private var listener: ListenerRegistration?
    private var tenantId: String?
    private var ownerUid: String?
    private let db = Firestore.firestore()

    static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    func start(tenantId: String?, ownerUid: String?) {
        guard let tenantId, !tenantId.isEmpty else { return }
        self.ownerUid = ownerUid
        if self.tenantId == tenantId, listener != nil { return }
        listener?.remove()
        self.tenantId = tenantId
        listener = db.collection("tenants").document(tenantId).addSnapshotListener { [weak self] snap, _ in
            guard let self, let data = snap?.data() else { return }
            Task { @MainActor in
                self.ranges = BlockedTimeRange.parseList(data["blockedTimeRanges"])
                self.days = (data["blockedDates"] as? [String]) ?? []
                self.dayLabels = (data["blockedDateLabels"] as? [String: String]) ?? [:]
            }
        }
    }

    deinit { listener?.remove() }

    func blocks(on date: Date) -> [ScheduleBlock] {
        let key = Self.ymd.string(from: date)
        var out: [ScheduleBlock] = []
        if days.contains(key) {
            out.append(ScheduleBlock(id: "day-\(key)", kind: .allDay, dateYmd: key, startMinutes: 0, endMinutes: 24 * 60, label: dayLabels[key]))
        }
        out += ranges.filter { $0.dateYmd == key }
            .sorted { $0.startMinutes < $1.startMinutes }
            .map { ScheduleBlock(id: $0.id, kind: .range, dateYmd: key, startMinutes: $0.startMinutes, endMinutes: $0.endMinutes, label: $0.label) }
        return out
    }

    func hasBlocks(on date: Date) -> Bool { !blocks(on: date).isEmpty }

    /// Saves a new block, or replaces `editing` with the new values.
    func save(date: Date, allDay: Bool, startMinutes: Int, endMinutes: Int, label: String, replacing editing: ScheduleBlock?) async -> Bool {
        let key = Self.ymd.string(from: date)
        var nextRanges = ranges
        var nextDays = days
        var nextLabels = dayLabels
        if let editing {
            if editing.kind == .range { nextRanges.removeAll { $0.id == editing.id } }
            else { nextDays.removeAll { $0 == editing.dateYmd }; nextLabels[editing.dateYmd] = nil }
        }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if allDay {
            if !nextDays.contains(key) { nextDays.append(key) }
            nextDays.sort()
            nextLabels[key] = trimmed.isEmpty ? nil : String(trimmed.prefix(40))
        } else {
            let id = editing?.kind == .range ? editing!.id : "blk_" + UUID().uuidString.prefix(12).lowercased()
            nextRanges.append(BlockedTimeRange(id: id, dateYmd: key, startMinutes: startMinutes, endMinutes: endMinutes, label: trimmed))
        }
        return await write(ranges: nextRanges, days: nextDays, labels: nextLabels)
    }

    func delete(_ block: ScheduleBlock) async -> Bool {
        var nextRanges = ranges
        var nextDays = days
        var nextLabels = dayLabels
        if block.kind == .range { nextRanges.removeAll { $0.id == block.id } }
        else { nextDays.removeAll { $0 == block.dateYmd }; nextLabels[block.dateYmd] = nil }
        return await write(ranges: nextRanges, days: nextDays, labels: nextLabels)
    }

    private func write(ranges nextRanges: [BlockedTimeRange], days nextDays: [String], labels nextLabels: [String: String]) async -> Bool {
        guard let tenantId, !isSaving else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let sorted = nextRanges.sorted {
            $0.dateYmd != $1.dateYmd ? $0.dateYmd < $1.dateYmd : $0.startMinutes < $1.startMinutes
        }
        let rangeMaps = sorted.map { $0.firestoreMap() }
        do {
            try await db.collection("tenants").document(tenantId).updateData([
                "blockedTimeRanges": rangeMaps,
                "blockedDates": nextDays,
                "blockedDateLabels": nextLabels,
            ])
            // Mirror to the owner's own availability, like the web and Settings → Availability do.
            if let uid = Auth.auth().currentUser?.uid, let ownerUid, uid == ownerUid {
                try? await db.collection("users").document(uid).setData([
                    "availability": ["blockedTimeRanges": rangeMaps, "blockedDates": nextDays]
                ], merge: true)
            }
            ranges = sorted
            days = nextDays
            dayLabels = nextLabels
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

/// Add or edit a block: date, all day or a time range, optional label.
struct BlockTimeSheet: View {
    @ObservedObject var store: ShopBlockedTimeStore
    let editing: ScheduleBlock?
    let initialDate: Date
    @Environment(\.dismiss) private var dismiss

    @State private var date: Date
    @State private var allDay: Bool
    @State private var start: Date
    @State private var end: Date
    @State private var label: String
    @State private var showDeleteConfirm = false
    @State private var localError: String?

    init(store: ShopBlockedTimeStore, editing: ScheduleBlock?, initialDate: Date) {
        self.store = store
        self.editing = editing
        self.initialDate = initialDate
        let cal = Calendar.current
        let day = editing.flatMap { ShopBlockedTimeStore.ymd.date(from: $0.dateYmd) } ?? cal.startOfDay(for: initialDate)
        _date = State(initialValue: day)
        _allDay = State(initialValue: editing?.kind == .allDay)
        let s = editing?.kind == .range ? editing!.startMinutes : 12 * 60
        let e = editing?.kind == .range ? editing!.endMinutes : 13 * 60
        _start = State(initialValue: cal.date(byAdding: .minute, value: s, to: cal.startOfDay(for: day)) ?? day)
        _end = State(initialValue: cal.date(byAdding: .minute, value: e, to: cal.startOfDay(for: day)) ?? day)
        _label = State(initialValue: editing?.label ?? "")
    }

    private func minutes(_ d: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("All day", isOn: $allDay)
                    if !allDay {
                        DatePicker("From", selection: $start, displayedComponents: .hourAndMinute)
                        DatePicker("To", selection: $end, displayedComponents: .hourAndMinute)
                    }
                    TextField("Label (optional) — Lunch, Time off…", text: $label)
                        .textInputAutocapitalization(.sentences)
                } footer: {
                    Text("Online booking won't offer this time. Existing appointments stay booked.")
                }
                if let msg = localError ?? store.errorMessage {
                    Section { Text(msg).foregroundStyle(.red).font(.footnote) }
                }
                if editing != nil {
                    Section {
                        Button(role: .destructive) { showDeleteConfirm = true } label: {
                            HStack { Spacer(); Text("Delete blocked time"); Spacer() }
                        }
                        .disabled(store.isSaving)
                    }
                }
            }
            .navigationTitle(editing == nil ? "Block time" : "Blocked time")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(store.isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(store.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if store.isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                    }
                }
            }
            .confirmationDialog("Delete this blocked time?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    guard let editing else { return }
                    Task { if await store.delete(editing) { dismiss() } }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func save() async {
        localError = nil
        let s = minutes(start)
        let e = minutes(end)
        if !allDay && e <= s {
            localError = "The end time has to be after the start time."
            return
        }
        if await store.save(date: date, allDay: allDay, startMinutes: s, endMinutes: e, label: label, replacing: editing) {
            dismiss()
        }
    }
}

/// Striped row used in the day's appointment list.
struct ScheduleBlockRow: View {
    let block: ScheduleBlock

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: block.kind == .allDay ? "moon.zzz" : "nosign")
                .foregroundStyle(AppDesign.textSecondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(block.title).font(.subheadline.weight(.semibold)).foregroundStyle(AppDesign.textPrimary)
                Text(block.timeLine).font(.caption).foregroundStyle(AppDesign.textSecondary)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ScheduleBlockStripes().opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(AppDesign.textSecondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
    }
}

/// Diagonal stripes for blocked time (matches the web calendar).
struct ScheduleBlockStripes: View {
    var body: some View {
        GeometryReader { geo in
            Path { path in
                let step: CGFloat = 10
                var x: CGFloat = -geo.size.height
                while x < geo.size.width {
                    path.move(to: CGPoint(x: x, y: geo.size.height))
                    path.addLine(to: CGPoint(x: x + geo.size.height, y: 0))
                    x += step
                }
            }
            .stroke(AppDesign.textSecondary.opacity(0.14), lineWidth: 4)
        }
        .background(AppDesign.textSecondary.opacity(0.05))
        .clipped()
    }
}
