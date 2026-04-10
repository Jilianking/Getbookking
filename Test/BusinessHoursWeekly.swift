//
//  BusinessHoursWeekly.swift
//
//  Per-day schedule (Mon–Sun) stored as `businessHoursWeekly` in Firestore;
//  formatted to `businessHours` string for the public site.
//

import Foundation

struct BusinessHoursWeekly: Equatable {
    struct DaySlot: Equatable {
        var isClosed: Bool
        var openMinutes: Int
        var closeMinutes: Int

        static let defaultClosed = DaySlot(isClosed: true, openMinutes: 9 * 60, closeMinutes: 17 * 60)
    }

    /// Monday-first: Mon … Sun
    var slots: [DaySlot]

    static let dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    static let firestoreDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    static var defaultOfficeHours: BusinessHoursWeekly {
        let open = DaySlot(isClosed: false, openMinutes: 9 * 60, closeMinutes: 17 * 60)
        let closed = DaySlot.defaultClosed
        return BusinessHoursWeekly(slots: [open, open, open, open, open, closed, closed])
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    static func dateFromMinutes(_ minutes: Int) -> Date {
        let clamped = max(0, min(minutes, 24 * 60 - 1))
        var cal = Calendar.current
        cal.timeZone = TimeZone.current
        return cal.date(from: DateComponents(hour: clamped / 60, minute: clamped % 60)) ?? Date()
    }

    static func minutesFromDate(_ date: Date) -> Int {
        let cal = Calendar.current
        let c = cal.dateComponents([.hour, .minute], from: date)
        let h = c.hour ?? 0
        let m = c.minute ?? 0
        return max(0, min(h * 60 + m, 24 * 60 - 1))
    }

    static func formatTime(minutes: Int) -> String {
        timeFormatter.string(from: dateFromMinutes(minutes))
    }

    /// Groups consecutive days with the same slot into ranges (e.g. Mon–Fri).
    func formattedDisplayString() -> String {
        var lines: [String] = []
        var i = 0
        while i < 7 {
            let slot = slots[i]
            var j = i
            while j + 1 < 7, slots[j + 1] == slot { j += 1 }
            let rangeLabel: String
            if i == j {
                rangeLabel = Self.dayLabels[i]
            } else {
                rangeLabel = "\(Self.dayLabels[i])–\(Self.dayLabels[j])"
            }
            if slot.isClosed {
                lines.append("\(rangeLabel): Closed")
            } else {
                let o = Self.formatTime(minutes: slot.openMinutes)
                let c = Self.formatTime(minutes: slot.closeMinutes)
                lines.append("\(rangeLabel): \(o)–\(c)")
            }
            i = j + 1
        }
        return lines.joined(separator: "\n")
    }

    func firestoreDayMap() -> [String: Any] {
        var out: [String: Any] = [:]
        for (idx, key) in Self.firestoreDayKeys.enumerated() {
            let s = slots[idx]
            out[key] = [
                "closed": s.isClosed,
                "openMin": s.openMinutes,
                "closeMin": s.closeMinutes
            ]
        }
        return out
    }

    static func fromFirestore(_ raw: Any?) -> BusinessHoursWeekly? {
        guard let map = raw as? [String: Any], !map.isEmpty else { return nil }
        var slots: [DaySlot] = []
        for key in firestoreDayKeys {
            if let dayMap = map[key] as? [String: Any] {
                let closed = dayMap["closed"] as? Bool ?? true
                let om = dayMap["openMin"] as? Int ?? 9 * 60
                let cm = dayMap["closeMin"] as? Int ?? 17 * 60
                slots.append(DaySlot(isClosed: closed, openMinutes: clampMinutes(om), closeMinutes: clampMinutes(cm)))
            } else {
                slots.append(.defaultClosed)
            }
        }
        guard slots.count == 7 else { return nil }
        return BusinessHoursWeekly(slots: slots)
    }

    private static func clampMinutes(_ m: Int) -> Int {
        max(0, min(m, 24 * 60 - 1))
    }

    mutating func normalizeSlot(at index: Int) {
        guard slots.indices.contains(index), !slots[index].isClosed else { return }
        if slots[index].closeMinutes <= slots[index].openMinutes {
            slots[index].closeMinutes = min(slots[index].openMinutes + 60, 24 * 60 - 1)
        }
    }
}
