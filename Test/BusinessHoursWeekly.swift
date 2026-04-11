//
//  BusinessHoursWeekly.swift
//
//  Weekly schedule (Mon–Sun) with optional multiple time ranges per day;
//  formatted to `businessHours` for the public site. Legacy Firestore
//  (single openMin/closeMin per day) is migrated on read.
//

import Foundation

struct BusinessHourTimeRange: Equatable {
    var startMinutes: Int
    var endMinutes: Int
}

struct DaySchedule: Equatable {
    var isClosed: Bool
    var ranges: [BusinessHourTimeRange]

    static let closedSchedule = DaySchedule(isClosed: true, ranges: [])

    static func singleNineToFive() -> DaySchedule {
        DaySchedule(isClosed: false, ranges: [
            BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)
        ])
    }

    private static func clampM(_ m: Int) -> Int {
        max(0, min(m, 24 * 60 - 1))
    }

    mutating func normalize() {
        if isClosed {
            ranges = []
            return
        }
        if ranges.isEmpty {
            isClosed = true
            return
        }
        var fixed: [BusinessHourTimeRange] = []
        for var r in ranges {
            r.startMinutes = Self.clampM(r.startMinutes)
            r.endMinutes = Self.clampM(r.endMinutes)
            if r.endMinutes <= r.startMinutes {
                r.endMinutes = min(r.startMinutes + 60, 24 * 60 - 1)
            }
            fixed.append(r)
        }
        ranges = fixed.sorted { $0.startMinutes < $1.startMinutes }
    }

    func summaryFormatted(formatTime: (Int) -> String) -> String {
        if isClosed || ranges.isEmpty { return "Closed" }
        return ranges.map { "\(formatTime($0.startMinutes))–\(formatTime($0.endMinutes))" }.joined(separator: ", ")
    }
}

struct BusinessHoursWeekly: Equatable {
    /// Monday-first: Mon … Sun
    var days: [DaySchedule]

    static let dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    static let firestoreDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    static var defaultOfficeHours: BusinessHoursWeekly {
        let open = DaySchedule.singleNineToFive()
        let closed = DaySchedule.closedSchedule
        return BusinessHoursWeekly(days: [open, open, open, open, open, closed, closed])
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

    mutating func normalizeDay(at index: Int) {
        guard days.indices.contains(index) else { return }
        days[index].normalize()
    }

    /// Groups consecutive days with the same schedule.
    func formattedDisplayString() -> String {
        var lines: [String] = []
        var i = 0
        while i < 7 {
            let d = days[i]
            var j = i
            while j + 1 < 7, days[j + 1] == d { j += 1 }
            let rangeLabel: String
            if i == j {
                rangeLabel = Self.dayLabels[i]
            } else {
                rangeLabel = "\(Self.dayLabels[i])–\(Self.dayLabels[j])"
            }
            if d.isClosed || d.ranges.isEmpty {
                lines.append("\(rangeLabel): Closed")
            } else {
                let part = d.ranges.map { "\(Self.formatTime(minutes: $0.startMinutes))–\(Self.formatTime(minutes: $0.endMinutes))" }.joined(separator: ", ")
                lines.append("\(rangeLabel): \(part)")
            }
            i = j + 1
        }
        return lines.joined(separator: "\n")
    }

    func firestoreDayMap() -> [String: Any] {
        var out: [String: Any] = [:]
        for (idx, key) in Self.firestoreDayKeys.enumerated() {
            let d = days[idx]
            let rangeMaps: [[String: Any]] = d.ranges.map {
                ["openMin": $0.startMinutes, "closeMin": $0.endMinutes]
            }
            out[key] = [
                "closed": d.isClosed,
                "ranges": rangeMaps
            ]
        }
        return out
    }

    static func fromFirestore(_ raw: Any?) -> BusinessHoursWeekly? {
        guard let map = raw as? [String: Any], !map.isEmpty else { return nil }
        var days: [DaySchedule] = []
        for key in firestoreDayKeys {
            if let dayMap = map[key] as? [String: Any] {
                days.append(parseDayMap(dayMap))
            } else {
                days.append(.closedSchedule)
            }
        }
        guard days.count == 7 else { return nil }
        return BusinessHoursWeekly(days: days)
    }

    private static func parseDayMap(_ dayMap: [String: Any]) -> DaySchedule {
        if let rangesArr = dayMap["ranges"] as? [[String: Any]] {
            let closedFlag = dayMap["closed"] as? Bool ?? true
            if closedFlag || rangesArr.isEmpty {
                return .closedSchedule
            }
            var ranges: [BusinessHourTimeRange] = []
            for r in rangesArr {
                let om = intFromFirestore(r["openMin"] ?? r["startMin"]) ?? 0
                let cm = intFromFirestore(r["closeMin"] ?? r["endMin"]) ?? 0
                ranges.append(BusinessHourTimeRange(startMinutes: clampMinutes(om), endMinutes: clampMinutes(cm)))
            }
            var sched = DaySchedule(isClosed: false, ranges: ranges)
            sched.normalize()
            if sched.isClosed || sched.ranges.isEmpty {
                return .closedSchedule
            }
            return sched
        }
        // Legacy: single openMin / closeMin (no `ranges` key)
        let closed = dayMap["closed"] as? Bool ?? true
        if closed {
            return .closedSchedule
        }
        let om = intFromFirestore(dayMap["openMin"]) ?? 9 * 60
        let cm = intFromFirestore(dayMap["closeMin"]) ?? 17 * 60
        var sched = DaySchedule(isClosed: false, ranges: [
            BusinessHourTimeRange(startMinutes: clampMinutes(om), endMinutes: clampMinutes(cm))
        ])
        sched.normalize()
        return sched
    }

    private static func clampMinutes(_ m: Int) -> Int {
        max(0, min(m, 24 * 60 - 1))
    }

    private static func intFromFirestore(_ v: Any?) -> Int? {
        if let x = v as? Int { return x }
        if let n = v as? NSNumber { return n.intValue }
        return nil
    }
}

// MARK: - Special dates (holidays, one-off hours)

struct BusinessHoursException: Identifiable, Equatable {
    var id: String
    /// Local calendar date `yyyy-MM-dd`
    var dateYmd: String
    var closedAllDay: Bool
    var ranges: [BusinessHourTimeRange]

    static func newDefault() -> BusinessHoursException {
        let cal = Calendar.current
        let d = cal.startOfDay(for: Date())
        let fmt = DateFormatter()
        fmt.calendar = cal
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = cal.timeZone
        fmt.dateFormat = "yyyy-MM-dd"
        return BusinessHoursException(
            id: UUID().uuidString,
            dateYmd: fmt.string(from: d),
            closedAllDay: true,
            ranges: []
        )
    }

    mutating func normalize() {
        if closedAllDay {
            ranges = []
            return
        }
        if ranges.isEmpty {
            closedAllDay = true
            return
        }
        var fixed: [BusinessHourTimeRange] = []
        for var r in ranges {
            r.startMinutes = max(0, min(r.startMinutes, 24 * 60 - 1))
            r.endMinutes = max(0, min(r.endMinutes, 24 * 60 - 1))
            if r.endMinutes <= r.startMinutes {
                r.endMinutes = min(r.startMinutes + 60, 24 * 60 - 1)
            }
            fixed.append(r)
        }
        ranges = fixed.sorted { $0.startMinutes < $1.startMinutes }
    }

    func formattedDisplayLine() -> String {
        let pretty = Self.mediumDateString(fromYmd: dateYmd) ?? dateYmd
        if closedAllDay || ranges.isEmpty {
            return "\(pretty): Closed"
        }
        let times = ranges.map { "\(BusinessHoursWeekly.formatTime(minutes: $0.startMinutes))–\(BusinessHoursWeekly.formatTime(minutes: $0.endMinutes))" }
            .joined(separator: ", ")
        return "\(pretty): \(times)"
    }

    private static let ymdParser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar.current
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = Calendar.current.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let mediumFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    private static func mediumDateString(fromYmd ymd: String) -> String? {
        guard let date = ymdParser.date(from: ymd) else { return nil }
        return mediumFormatter.string(from: date)
    }

    func toFirestore() -> [String: Any] {
        var d: [String: Any] = [
            "id": id,
            "date": dateYmd,
            "closedAllDay": closedAllDay
        ]
        if !closedAllDay {
            d["ranges"] = ranges.map { ["openMin": $0.startMinutes, "closeMin": $0.endMinutes] }
        }
        return d
    }

    private static func intFromFirestore(_ v: Any?) -> Int? {
        if let x = v as? Int { return x }
        if let n = v as? NSNumber { return n.intValue }
        return nil
    }

    static func fromFirestore(_ any: Any) -> BusinessHoursException? {
        guard let d = any as? [String: Any],
              let id = d["id"] as? String,
              let date = d["date"] as? String else { return nil }
        let closed = d["closedAllDay"] as? Bool ?? true
        var ranges: [BusinessHourTimeRange] = []
        if let arr = d["ranges"] as? [[String: Any]] {
            for r in arr {
                if let om = intFromFirestore(r["openMin"]), let cm = intFromFirestore(r["closeMin"]) {
                    ranges.append(BusinessHourTimeRange(startMinutes: om, endMinutes: cm))
                }
            }
        }
        return BusinessHoursException(id: id, dateYmd: date, closedAllDay: closed, ranges: ranges)
    }

    static func parseList(_ raw: Any?) -> [BusinessHoursException] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { fromFirestore($0) }.sorted { $0.dateYmd < $1.dateYmd }
    }
}
