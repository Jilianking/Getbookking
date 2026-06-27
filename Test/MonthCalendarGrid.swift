//
//  MonthCalendarGrid.swift
//
//  Month grid with bar indicators for confirmed appointments.
//

import SwiftUI

struct MonthCalendarGrid: View {
    @Binding var displayedMonth: Date
    @Binding var selectedDate: Date
    let eventsByDay: [Date: [Event]]

    private let calendar = Calendar.current
    private let weekdaySymbols = Calendar.current.shortWeekdaySymbols
    private let maxVisibleBars = 3

    var body: some View {
        VStack(spacing: 12) {
            monthHeader
            legend
            weekdayHeader
            dayGrid
        }
        .padding(.horizontal, 16)
    }

    private var monthHeader: some View {
        HStack {
            Button {
                shiftMonth(by: -1)
            } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.brandWarm)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Previous month")

            Spacer()

            Text("Calendar")
                .font(.headline.weight(.bold))
                .foregroundStyle(AppDesign.textPrimary)
                .accessibilityLabel("Calendar, \(monthTitle)")

            Spacer()

            Button {
                shiftMonth(by: 1)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.brandWarm)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Next month")
        }
    }

    private var legend: some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(AppDesign.accentGreen)
                .frame(width: 18, height: 4)
            Text("Confirmed")
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
            Spacer()
        }
    }

    private var weekdayHeader: some View {
        LazyVGrid(columns: gridColumns, spacing: 4) {
            ForEach(orderedWeekdaySymbols, id: \.self) { symbol in
                Text(symbol.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private var dayGrid: some View {
        LazyVGrid(columns: gridColumns, spacing: 6) {
            ForEach(gridDays, id: \.self) { day in
                if let day {
                    dayCell(for: day)
                } else {
                    Color.clear
                        .frame(height: 52)
                }
            }
        }
    }

    @ViewBuilder
    private func dayCell(for day: Date) -> some View {
        let dayStart = calendar.startOfDay(for: day)
        let events = eventsByDay[dayStart] ?? []
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDate)
        let isToday = calendar.isDateInToday(day)
        let inDisplayedMonth = calendar.isDate(day, equalTo: displayedMonth, toGranularity: .month)

        Button {
            selectedDate = day
            if !calendar.isDate(day, equalTo: displayedMonth, toGranularity: .month) {
                displayedMonth = startOfMonth(for: day)
            }
        } label: {
            VStack(spacing: 3) {
                Text("\(calendar.component(.day, from: day))")
                    .font(.subheadline.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(dayNumberColor(isSelected: isSelected, inMonth: inDisplayedMonth))
                    .frame(width: 28, height: 28)
                    .background {
                        if isSelected {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(AppDesign.brandDark)
                        } else if isToday {
                            Circle()
                                .stroke(AppDesign.brandWarm.opacity(0.85), lineWidth: 1.5)
                        }
                    }

                VStack(spacing: 2) {
                    ForEach(events.prefix(maxVisibleBars)) { _ in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(AppDesign.accentGreen)
                            .frame(height: 3)
                    }
                    if events.count > maxVisibleBars {
                        Text("+\(events.count - maxVisibleBars)")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 14, alignment: .top)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52, alignment: .top)
            .opacity(inDisplayedMonth ? 1 : 0.35)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(for: day, events: events, isSelected: isSelected))
    }

    private var gridColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
    }

    private var monthTitle: String {
        displayedMonth.formatted(.dateTime.month(.wide).year())
    }

    private var orderedWeekdaySymbols: [String] {
        let firstWeekday = calendar.firstWeekday
        let symbols = weekdaySymbols
        let offset = firstWeekday - 1
        return Array(symbols[offset...]) + Array(symbols[..<offset])
    }

    private var gridDays: [Date?] {
        let monthStart = startOfMonth(for: displayedMonth)
        guard let dayRange = calendar.range(of: .day, in: .month, for: monthStart) else { return [] }

        let firstWeekday = calendar.component(.weekday, from: monthStart)
        let leadingPadding = (firstWeekday - calendar.firstWeekday + 7) % 7

        var days: [Date?] = Array(repeating: nil, count: leadingPadding)
        for day in dayRange {
            if let date = calendar.date(byAdding: .day, value: day - 1, to: monthStart) {
                days.append(date)
            }
        }
        while days.count % 7 != 0 {
            if let last = days.compactMap({ $0 }).last,
               let next = calendar.date(byAdding: .day, value: 1, to: last) {
                days.append(next)
            } else {
                days.append(nil)
            }
        }
        while days.count < 42 {
            if let last = days.compactMap({ $0 }).last,
               let next = calendar.date(byAdding: .day, value: 1, to: last) {
                days.append(next)
            } else {
                break
            }
        }
        return days
    }

    private func startOfMonth(for date: Date) -> Date {
        calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
    }

    private func shiftMonth(by value: Int) {
        if let next = calendar.date(byAdding: .month, value: value, to: displayedMonth) {
            displayedMonth = startOfMonth(for: next)
        }
    }

    private func dayNumberColor(isSelected: Bool, inMonth: Bool) -> Color {
        if isSelected { return .white }
        if inMonth { return AppDesign.textPrimary }
        return AppDesign.textSecondary
    }

    private func accessibilityLabel(for day: Date, events: [Event], isSelected: Bool) -> String {
        let dayLabel = day.formatted(.dateTime.weekday(.wide).month().day())
        if events.isEmpty {
            return isSelected ? "\(dayLabel), selected, no appointments" : dayLabel
        }
        return "\(dayLabel), \(events.count) confirmed appointment\(events.count == 1 ? "" : "s")"
    }
}
