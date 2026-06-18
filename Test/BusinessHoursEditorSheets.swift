//
//  BusinessHoursEditorSheets.swift
//
//  Weekly business hours editor (website display) shared by Manage and About.
//

import SwiftUI

struct BusinessHoursWeeklyEditor: View {
    @ObservedObject var viewModel: DesignViewModel
    var onCommitted: (() async -> Void)? = nil

    @State private var businessHoursDaySheet: BusinessHoursDaySheetToken?
    @State private var businessHoursExceptionSheet: BusinessHoursException?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tap a day to set hours (including split shifts). Your site shows a short summary.")
                .font(.caption)
                .foregroundColor(.secondary)

            ForEach(0..<7, id: \.self) { dayIndex in
                Button {
                    businessHoursDaySheet = BusinessHoursDaySheetToken(dayIndex: dayIndex)
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Text(BusinessHoursWeekly.dayLabels[dayIndex])
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                            .frame(width: 40, alignment: .leading)
                        Spacer(minLength: 8)
                        Text(
                            viewModel.businessHoursWeekly.days[dayIndex].summaryFormatted {
                                BusinessHoursWeekly.formatTime(minutes: $0)
                            }
                        )
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
            }

            Divider()
                .padding(.vertical, 4)

            Text("Special dates")
                .font(.subheadline.weight(.semibold))
            Text("Holidays or one-off hours. Listed after your weekly hours on the site.")
                .font(.caption)
                .foregroundColor(.secondary)

            if viewModel.businessHoursExceptions.isEmpty {
                Text("None yet")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            } else {
                ForEach(viewModel.businessHoursExceptions) { ex in
                    HStack(alignment: .center, spacing: 8) {
                        Button {
                            businessHoursExceptionSheet = ex
                        } label: {
                            HStack {
                                Text(ex.formattedDisplayLine())
                                    .font(.subheadline)
                                    .foregroundColor(.primary)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        Button(role: .destructive) {
                            viewModel.removeBusinessHoursException(id: ex.id)
                            commitIfNeeded()
                        } label: {
                            Image(systemName: "trash")
                                .font(.body)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Delete special date")
                    }
                    .padding(.vertical, 4)
                }
            }

            Button {
                businessHoursExceptionSheet = .newDefault()
            } label: {
                Label("Add special date", systemImage: "plus.circle")
                    .font(.subheadline)
            }
        }
        .sheet(item: $businessHoursDaySheet) { token in
            BusinessHoursDayEditSheet(dayIndex: token.dayIndex, viewModel: viewModel) {
                commitIfNeeded()
            }
        }
        .sheet(item: $businessHoursExceptionSheet) { ex in
            BusinessHoursExceptionEditSheet(exception: ex, viewModel: viewModel) {
                commitIfNeeded()
            }
        }
    }

    private func commitIfNeeded() {
        guard let onCommitted else { return }
        Task { await onCommitted() }
    }
}

struct BusinessHoursDaySheetToken: Identifiable {
    var id: Int { dayIndex }
    let dayIndex: Int
}

struct BusinessHoursDayEditSheet: View {
    let dayIndex: Int
    @ObservedObject var viewModel: DesignViewModel
    var onCommitted: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DaySchedule

    init(dayIndex: Int, viewModel: DesignViewModel, onCommitted: (() -> Void)? = nil) {
        self.dayIndex = dayIndex
        self.viewModel = viewModel
        self.onCommitted = onCommitted
        _draft = State(initialValue: viewModel.businessHoursWeekly.days[dayIndex])
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Open", isOn: Binding(
                        get: { !draft.isClosed },
                        set: { open in
                            draft.isClosed = !open
                            if open && draft.ranges.isEmpty {
                                draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
                            }
                            draft.normalize()
                        }
                    ))
                }
                if !draft.isClosed {
                    Section {
                        ForEach(draft.ranges.indices, id: \.self) { i in
                            HStack(spacing: 8) {
                                DatePicker(
                                    "From",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].startMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].startMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                DatePicker(
                                    "To",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].endMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].endMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                if draft.ranges.count > 1 {
                                    Button {
                                        draft.ranges.remove(at: i)
                                        draft.normalize()
                                    } label: {
                                        Image(systemName: "minus.circle.fill")
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        Button {
                            draft.ranges.append(BusinessHourTimeRange(startMinutes: 12 * 60, endMinutes: 17 * 60))
                            draft.normalize()
                        } label: {
                            Label("Add hours", systemImage: "plus.circle")
                        }
                    }
                }
                Section {
                    Button("Apply to all weekdays") {
                        draft.normalize()
                        viewModel.applySchedule(draft, toIndices: Set(0..<5))
                        onCommitted?()
                        dismiss()
                    }
                } header: {
                    Text("Copy these hours")
                } footer: {
                    Text("Done saves only \(BusinessHoursWeekly.dayLabels[dayIndex]). Apply copies this schedule to Mon–Fri.")
                }
            }
            .navigationTitle(BusinessHoursWeekly.dayLabels[dayIndex])
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        draft.normalize()
                        viewModel.replaceBusinessHoursDay(index: dayIndex, schedule: draft)
                        onCommitted?()
                        dismiss()
                    }
                }
            }
        }
    }
}

struct BusinessHoursExceptionEditSheet: View {
    @ObservedObject var viewModel: DesignViewModel
    var onCommitted: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var draft: BusinessHoursException

    init(exception: BusinessHoursException, viewModel: DesignViewModel, onCommitted: (() -> Void)? = nil) {
        self.viewModel = viewModel
        self.onCommitted = onCommitted
        _draft = State(initialValue: exception)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(
                        "Date",
                        selection: Binding(
                            get: { Self.localDate(fromYmd: draft.dateYmd) },
                            set: { draft.dateYmd = Self.ymd(from: $0) }
                        ),
                        displayedComponents: [.date]
                    )
                    Toggle("Closed all day", isOn: $draft.closedAllDay)
                }
                if !draft.closedAllDay {
                    Section {
                        ForEach(draft.ranges.indices, id: \.self) { i in
                            HStack(spacing: 8) {
                                DatePicker(
                                    "From",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].startMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].startMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                DatePicker(
                                    "To",
                                    selection: Binding(
                                        get: { BusinessHoursWeekly.dateFromMinutes(draft.ranges[i].endMinutes) },
                                        set: { new in
                                            var r = draft.ranges
                                            r[i].endMinutes = BusinessHoursWeekly.minutesFromDate(new)
                                            draft.ranges = r
                                        }
                                    ),
                                    displayedComponents: [.hourAndMinute]
                                )
                                .labelsHidden()
                                if draft.ranges.count > 1 {
                                    Button {
                                        draft.ranges.remove(at: i)
                                        draft.normalize()
                                    } label: {
                                        Image(systemName: "minus.circle.fill")
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        Button {
                            draft.ranges.append(BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60))
                            draft.normalize()
                        } label: {
                            Label("Add hours", systemImage: "plus.circle")
                        }
                    }
                }
            }
            .navigationTitle("Special date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if !draft.closedAllDay && draft.ranges.isEmpty {
                            draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
                        }
                        draft.normalize()
                        viewModel.upsertBusinessHoursException(draft)
                        onCommitted?()
                        dismiss()
                    }
                }
            }
            .onChange(of: draft.closedAllDay) { _, closed in
                if !closed && draft.ranges.isEmpty {
                    draft.ranges = [BusinessHourTimeRange(startMinutes: 9 * 60, endMinutes: 17 * 60)]
                }
                draft.normalize()
            }
        }
    }

    private static let ymdFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar.current
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = Calendar.current.timeZone
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func localDate(fromYmd ymd: String) -> Date {
        ymdFormatter.date(from: ymd) ?? Date()
    }

    private static func ymd(from date: Date) -> String {
        ymdFormatter.string(from: date)
    }
}
