//
//  DayCalendarTimelineView.swift
//
//  Day schedule timeline with positioned appointment blocks.
//

import SwiftUI

struct DayCalendarTimelineView: View {
    let selectedDate: Date
    let events: [Event]
    let isLoading: Bool
    let canOpenEvent: (Event) -> Bool
    let onEventTap: (Event) -> Void

    private let calendar = Calendar.current
    private let startHour = 8
    private let endHour = 19
    private let hourHeight: CGFloat = 72
    private let timeColumnWidth: CGFloat = 52

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            dayHeader

            if isLoading && events.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
            } else if events.isEmpty {
                Text("No confirmed appointments on this day.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding(.vertical, 12)
            } else {
                timeline
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
    }

    private var dayHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(selectedDate.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                .font(.title2.weight(.bold))
                .foregroundStyle(AppDesign.textPrimary)

            Text(appointmentCountLabel)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
        }
    }

    private var appointmentCountLabel: String {
        let count = events.count
        return count == 1 ? "1 appointment" : "\(count) appointments"
    }

    private var timeline: some View {
        let totalHeight = CGFloat(endHour - startHour) * hourHeight

        return ZStack(alignment: .topLeading) {
            HStack(alignment: .top, spacing: 0) {
                hourLabels
                    .frame(width: timeColumnWidth, alignment: .trailing)

                ZStack(alignment: .topLeading) {
                    hourGrid(totalHeight: totalHeight)

                    if calendar.isDateInToday(selectedDate), let nowY = currentTimeOffset {
                        nowIndicator(y: nowY)
                    }

                    ForEach(events) { event in
                        eventBlock(for: event, totalHeight: totalHeight)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .frame(height: totalHeight, alignment: .top)
    }

    private var hourLabels: some View {
        VStack(spacing: 0) {
            ForEach(startHour..<endHour, id: \.self) { hour in
                Text(hourLabel(for: hour))
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .frame(height: hourHeight, alignment: .top)
                    .offset(y: -6)
            }
        }
    }

    private func hourGrid(totalHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            ForEach(startHour..<endHour, id: \.self) { _ in
                Rectangle()
                    .fill(AppDesign.chipBorder.opacity(0.55))
                    .frame(height: 1)
                    .frame(maxWidth: .infinity, alignment: .top)
                    .frame(height: hourHeight, alignment: .top)
            }
        }
        .frame(height: totalHeight, alignment: .top)
    }

    private func nowIndicator(y: CGFloat) -> some View {
        HStack(spacing: 0) {
            Circle()
                .fill(AppDesign.brandWarm)
                .frame(width: 8, height: 8)
            Rectangle()
                .fill(AppDesign.brandWarm)
                .frame(height: 2)
        }
        .offset(y: y - 4)
    }

    @ViewBuilder
    private func eventBlock(for event: Event, totalHeight: CGFloat) -> some View {
        let start = event.start
        let end = event.resolvedEnd()
        let y = offset(for: start)
        let height = max(blockHeight(from: start, to: end), 56)

        if y < totalHeight {
            Button {
                onEventTap(event)
            } label: {
                DayTimelineEventCard(event: event)
            }
            .buttonStyle(.plain)
            .disabled(!canOpenEvent(event))
            .frame(height: height, alignment: .top)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4)
            .offset(y: y)
        }
    }

    private func offset(for date: Date) -> CGFloat {
        let components = calendar.dateComponents([.hour, .minute], from: date)
        let hour = CGFloat(components.hour ?? startHour)
        let minute = CGFloat(components.minute ?? 0)
        let hoursFromStart = hour - CGFloat(startHour) + minute / 60
        return max(0, hoursFromStart * hourHeight)
    }

    private func blockHeight(from start: Date, to end: Date) -> CGFloat {
        let duration = end.timeIntervalSince(start)
        return CGFloat(duration / 3600) * hourHeight - 4
    }

    private var currentTimeOffset: CGFloat? {
        let now = Date()
        guard calendar.isDate(now, inSameDayAs: selectedDate) else { return nil }
        let components = calendar.dateComponents([.hour, .minute], from: now)
        guard let hour = components.hour, hour >= startHour, hour < endHour else { return nil }
        return offset(for: now)
    }

    private func hourLabel(for hour: Int) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: selectedDate) ?? selectedDate
        return date.formatted(.dateTime.hour(.defaultDigits(amPM: .abbreviated)))
    }
}

private struct DayTimelineEventCard: View {
    let event: Event

    private var initials: String {
        let parts = event.clientName
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
        return parts.joined().uppercased()
    }

    private var timeRange: String {
        let start = event.start.formatted(date: .omitted, time: .shortened)
        let end = event.resolvedEnd().formatted(date: .omitted, time: .shortened)
        return "\(start) – \(end)"
    }

    var body: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(AppDesign.calendarAppointmentAccent)
                .frame(width: 4)

            HStack(alignment: .top, spacing: 10) {
                Text(initials)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(AppDesign.calendarAppointmentAccent))

                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                                .lineLimit(1)
                            Text(event.clientName)
                                .font(.subheadline)
                                .foregroundStyle(AppDesign.textSecondary)
                                .lineLimit(1)
                            Text(timeRange)
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                        Spacer(minLength: 8)
                        AppStatusPill(text: "Confirmed", soft: true)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(AppDesign.calendarAppointmentFill)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

extension Event {
    func resolvedEnd(defaultDuration: TimeInterval = 3600) -> Date {
        if let end, end > start { return end }
        return start.addingTimeInterval(defaultDuration)
    }
}
