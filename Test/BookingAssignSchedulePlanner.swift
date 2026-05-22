//
//  BookingAssignSchedulePlanner.swift
//
//  Builds per-staff time chips for assign-from-schedule (taken / preferred / available).
//

import Foundation

enum AssignScheduleSlotState: Equatable {
    case available
    case taken
    case matchesPreferred
    case selected
}

struct AssignScheduleSlot: Identifiable, Equatable {
    let id: String
    let start: Date
    let label: String
    var state: AssignScheduleSlotState
}

struct AssignScheduleStaffRow: Identifiable, Equatable {
    var id: String { member.uid }
    let member: TenantTeamMember
    let statusText: String
    let slots: [AssignScheduleSlot]
    var isInteractive: Bool { !slots.isEmpty && statusText != "Day off" }
}

enum BookingAssignSchedulePlanner {
    static let slotIntervalMinutes = 30
    static let defaultServiceDurationMinutes = 30

    static func assignTitle(for industry: String?) -> String {
        switch BookingTemplate(rawValue: (industry ?? "").lowercased()) ?? .custom {
        case .tattoos: return "Assign artist"
        case .barber: return "Assign barber"
        case .hair: return "Assign stylist"
        case .nails: return "Assign technician"
        case .custom: return "Assign team member"
        }
    }

    static func dateStrip(anchor: Date, calendar: Calendar = .current) -> [Date] {
        let start = calendar.startOfDay(for: anchor)
        return (-3...3).compactMap { offset in
            calendar.date(byAdding: .day, value: offset, to: start)
        }
    }

    static func preferredMinutes(for request: BookingRequest, calendar: Calendar = .current) -> Int? {
        if let start = request.requestedStartTime {
            return minutesSinceMidnight(start, calendar: calendar)
        }
        return parseTimeLabelToMinutes(request.preferredTime)
    }

    static func buildRows(
        request: BookingRequest,
        day: Date,
        roster: [TenantTeamMember],
        bookings: [BookingRequest],
        availability: ProviderAvailability,
        selectedMemberUid: String?,
        selectedSlotStart: Date?,
        calendar: Calendar = .current
    ) -> [AssignScheduleStaffRow] {
        let dayStart = calendar.startOfDay(for: day)
        let slotStarts = generateSlotStarts(on: dayStart, availability: availability, calendar: calendar)
        let preferredMin = preferredMinutes(for: request, calendar: calendar)
        let excludingId = request.documentId

        return roster.map { member in
            let status = staffStatus(on: dayStart, availability: availability, calendar: calendar)
            if status == "Day off" {
                return AssignScheduleStaffRow(member: member, statusText: "Day off", slots: [])
            }
            let slots = slotStarts.map { start -> AssignScheduleSlot in
                let label = formatSlotLabel(start, calendar: calendar)
                let id = "\(member.uid)-\(Int(start.timeIntervalSince1970))"
                let taken = isSlotTaken(
                    start: start,
                    member: member,
                    bookings: bookings,
                    excludingRequestId: excludingId,
                    calendar: calendar
                )
                let matchesPreferred = preferredMin.map { abs(minutesSinceMidnight(start, calendar: calendar) - $0) < slotIntervalMinutes } ?? false
                let isSelected = selectedMemberUid == member.uid
                    && selectedSlotStart.map { calendar.isDate($0, equalTo: start, toGranularity: .minute) } == true

                let state: AssignScheduleSlotState
                if isSelected { state = .selected }
                else if taken { state = .taken }
                else if matchesPreferred { state = .matchesPreferred }
                else { state = .available }

                return AssignScheduleSlot(id: id, start: start, label: label, state: state)
            }
            let statusText = slots.contains(where: { $0.state != .taken }) ? "Available" : "Fully booked"
            return AssignScheduleStaffRow(member: member, statusText: statusText, slots: slots)
        }
    }

    private static func staffStatus(
        on dayStart: Date,
        availability: ProviderAvailability,
        calendar: Calendar
    ) -> String {
        let weekday = calendar.component(.weekday, from: dayStart) - 1
        guard availability.daysOpen.contains(weekday) else { return "Day off" }
        let key = dateKey(dayStart, calendar: calendar)
        if availability.blockedDates.contains(key) { return "Day off" }
        return "Available"
    }

    private static func generateSlotStarts(
        on dayStart: Date,
        availability: ProviderAvailability,
        calendar: Calendar
    ) -> [Date] {
        guard staffStatus(on: dayStart, availability: availability, calendar: calendar) != "Day off" else {
            return []
        }
        let ranges = availability.timeSlots.isEmpty
            ? [TimeSlot(open: 9, close: 18)]
            : availability.timeSlots.filter { $0.close > $0.open }
        var merged: [Date] = []
        for range in ranges {
            merged.append(contentsOf: steppedSlots(
                dayStart: dayStart,
                openHour: range.open,
                closeHour: range.close,
                calendar: calendar
            ))
        }
        var seen = Set<Int>()
        return merged.filter { d in
            let m = minutesSinceMidnight(d, calendar: calendar)
            guard !seen.contains(m) else { return false }
            seen.insert(m)
            return true
        }.sorted()
    }

    private static func steppedSlots(
        dayStart: Date,
        openHour: Int,
        closeHour: Int,
        calendar: Calendar
    ) -> [Date] {
        var out: [Date] = []
        var cursor = calendar.date(bySettingHour: openHour, minute: 0, second: 0, of: dayStart) ?? dayStart
        let end = calendar.date(bySettingHour: closeHour, minute: 0, second: 0, of: dayStart) ?? dayStart
        while cursor < end {
            out.append(cursor)
            guard let next = calendar.date(byAdding: .minute, value: slotIntervalMinutes, to: cursor) else { break }
            cursor = next
        }
        return out
    }

    private static func isSlotTaken(
        start: Date,
        member: TenantTeamMember,
        bookings: [BookingRequest],
        excludingRequestId: String?,
        calendar: Calendar
    ) -> Bool {
        guard let slotEnd = calendar.date(byAdding: .minute, value: defaultServiceDurationMinutes, to: start) else {
            return false
        }
        for booking in bookings {
            if booking.documentId == excludingRequestId { continue }
            guard booking.hasAssignedMember else { continue }
            guard booking.matchesAssigneeFilter(key: member.uid, roster: [member]) else { continue }
            guard let otherStart = booking.requestedStartTime else { continue }
            guard calendar.isDate(otherStart, inSameDayAs: start) else { continue }
            let otherEnd = calendar.date(byAdding: .minute, value: defaultServiceDurationMinutes, to: otherStart) ?? otherStart
            if rangesOverlap(start, slotEnd, otherStart, otherEnd) { return true }
        }
        return false
    }

    private static func rangesOverlap(_ a0: Date, _ a1: Date, _ b0: Date, _ b1: Date) -> Bool {
        a0 < b1 && b0 < a1
    }

    static func formatSlotLabel(_ date: Date, calendar: Calendar = .current) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    static func formatStripDay(_ date: Date, calendar: Calendar = .current) -> String {
        let dow = date.formatted(.dateTime.weekday(.abbreviated)).uppercased()
        let day = calendar.component(.day, from: date)
        return "\(dow) \(day)"
    }

    private static func dateKey(_ date: Date, calendar: Calendar) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = calendar.timeZone
        return f.string(from: date)
    }

    private static func minutesSinceMidnight(_ date: Date, calendar: Calendar) -> Int {
        let h = calendar.component(.hour, from: date)
        let m = calendar.component(.minute, from: date)
        return h * 60 + m
    }

    private static func parseTimeLabelToMinutes(_ raw: String?) -> Int? {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        for fmt in ["h:mm a", "h:mma", "HH:mm", "h a"] {
            f.dateFormat = fmt
            if let d = f.date(from: s.uppercased()) {
                return minutesSinceMidnight(d, calendar: Calendar.current)
            }
        }
        return nil
    }
}
