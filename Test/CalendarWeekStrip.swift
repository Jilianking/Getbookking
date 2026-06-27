//
//  CalendarWeekStrip.swift
//
//  Horizontal day strip for day/week calendar modes.
//

import SwiftUI

struct CalendarWeekStrip: View {
    @Binding var displayedMonth: Date
    @Binding var selectedDate: Date
    let eventsByDay: [Date: [Event]]

    private let calendar = Calendar.current

    var body: some View {
        VStack(spacing: 10) {
            monthHeader
            dayStrip
        }
        .padding(.horizontal, 16)
    }

    private var monthHeader: some View {
        HStack(spacing: 6) {
            Text(displayedMonth.formatted(.dateTime.month(.wide).year()))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)

            Spacer()

            Button { shiftSelectedDay(by: -1) } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Previous day")

            Button { shiftSelectedDay(by: 1) } label: {
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Next day")
        }
    }

    private var dayStrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(daysInDisplayedMonth, id: \.self) { day in
                        dayColumn(for: day)
                            .id(day)
                    }
                }
                .padding(.horizontal, 4)
            }
            .onAppear {
                scrollToSelected(proxy: proxy, animated: false)
            }
            .onChange(of: selectedDate) { _, _ in
                scrollToSelected(proxy: proxy, animated: true)
            }
            .onChange(of: displayedMonth) { _, _ in
                scrollToSelected(proxy: proxy, animated: true)
            }
        }
    }

    @ViewBuilder
    private func dayColumn(for day: Date) -> some View {
        let dayStart = calendar.startOfDay(for: day)
        let events = eventsByDay[dayStart] ?? []
        let isSelected = calendar.isDate(day, inSameDayAs: selectedDate)
        let isToday = calendar.isDateInToday(day)

        Button {
            selectedDate = day
            if !calendar.isDate(day, equalTo: displayedMonth, toGranularity: .month) {
                displayedMonth = startOfMonth(for: day)
            }
        } label: {
            VStack(spacing: 6) {
                Text(weekdayLetter(for: day))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AppDesign.textSecondary)

                Text("\(calendar.component(.day, from: day))")
                    .font(.subheadline.weight(isSelected || isToday ? .semibold : .regular))
                    .foregroundStyle(dayNumberForeground(isSelected: isSelected, isToday: isToday))
                    .frame(width: 32, height: 32)
                    .background {
                        if isSelected {
                            Circle().fill(AppDesign.brandWarm)
                        } else if isToday {
                            Circle().fill(AppDesign.brandDark)
                        }
                    }

                Circle()
                    .fill(events.isEmpty ? Color.clear : AppDesign.accentGreen)
                    .frame(width: 5, height: 5)
            }
            .frame(width: 44)
        }
        .buttonStyle(.plain)
    }

    private var daysInDisplayedMonth: [Date] {
        let monthStart = startOfMonth(for: displayedMonth)
        guard let dayRange = calendar.range(of: .day, in: .month, for: monthStart) else { return [] }
        return dayRange.compactMap { day in
            calendar.date(byAdding: .day, value: day - 1, to: monthStart)
        }
    }

    private func weekdayLetter(for day: Date) -> String {
        day.formatted(.dateTime.weekday(.narrow)).uppercased()
    }

    private func dayNumberForeground(isSelected: Bool, isToday: Bool) -> Color {
        if isSelected || isToday { return .white }
        return AppDesign.textPrimary
    }

    private func startOfMonth(for date: Date) -> Date {
        calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
    }

    private func shiftSelectedDay(by value: Int) {
        guard let next = calendar.date(byAdding: .day, value: value, to: selectedDate) else { return }
        selectedDate = next
        let monthStart = startOfMonth(for: next)
        if !calendar.isDate(displayedMonth, equalTo: monthStart, toGranularity: .month) {
            displayedMonth = monthStart
        }
    }

    private func scrollToSelected(proxy: ScrollViewProxy, animated: Bool) {
        let target = calendar.startOfDay(for: selectedDate)
        if animated {
            withAnimation(.easeInOut(duration: 0.25)) {
                proxy.scrollTo(target, anchor: .center)
            }
        } else {
            proxy.scrollTo(target, anchor: .center)
        }
    }
}
