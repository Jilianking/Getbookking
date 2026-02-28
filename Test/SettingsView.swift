//
//  SettingsView.swift
//
//  Generic settings: account, business info, app info.
//

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = SettingsViewModel()
    @State private var showingLogoutAlert = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("Account")) {
                    if authViewModel.isDemoMode {
                        HStack {
                            Image(systemName: "person.crop.circle")
                            Text("Demo mode")
                                .foregroundColor(.secondary)
                        }
                    } else if let email = authViewModel.currentUserEmail {
                        HStack {
                            Image(systemName: "person.crop.circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(authViewModel.currentUserDisplayName ?? "User")
                                    .font(.subheadline.weight(.medium))
                                Text(email)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    Button(action: { showingLogoutAlert = true }) {
                        HStack {
                            Image(systemName: "arrow.right.square")
                            Text("Logout")
                                .foregroundColor(.red)
                        }
                    }
                }

                if !authViewModel.isDemoMode && viewModel.hasProfile {
                    Section(header: Text("Scheduling & Availability")) {
                        Picker("Booking confirmation", selection: $viewModel.confirmationType) {
                            ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                                Text(type.displayName).tag(type)
                            }
                        }
                        if viewModel.confirmationType.requiresApproval {
                            Stepper("Response time: \(viewModel.responseTimeHours) hours", value: $viewModel.responseTimeHours, in: 1...168, step: 1)
                        }
                        if viewModel.confirmationType.requiresDeposit {
                            HStack {
                                Text("Deposit amount")
                                TextField("0", value: Binding(
                                    get: { viewModel.depositAmount ?? 0 },
                                    set: { viewModel.depositAmount = $0 > 0 ? $0 : nil }
                                ), format: .number)
                                    .keyboardType(.decimalPad)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 80)
                                Text("USD")
                                    .foregroundColor(.secondary)
                            }
                        }
                        TextField("Time zone", text: $viewModel.timeZoneId)
                            .textFieldStyle(.roundedBorder)
                            .autocapitalization(.none)
                        Button("Save") {
                            Task {
                                await viewModel.saveWorkflow()
                                await viewModel.saveAvailability()
                            }
                        }
                        .disabled(viewModel.isLoading)
                        if viewModel.saveSuccess {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Saved")
                                    .foregroundColor(.green)
                            }
                        }
                    }
                }

                if let msg = viewModel.errorMessage {
                    Section {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }

                Section(header: Text("App")) {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0.0")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle(sectionTitle)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                    }
                }
            }
            .alert("Logout", isPresented: $showingLogoutAlert) {
                Button("Cancel", role: .cancel) { }
                Button("Logout", role: .destructive) {
                    authViewModel.logout()
                }
            } message: {
                Text("Are you sure you want to logout?")
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }

}

// MARK: - Days open calendar sheet
struct DaysOpenCalendarSheet: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var displayDate = Date()
    @State private var editingSlot: TimeSlot?
    @Environment(\.dismiss) var dismiss

    private var monthYearText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: displayDate)
    }

    private var calendarDays: [Date?] {
        let cal = Calendar.current
        guard let range = cal.range(of: .day, in: .month, for: displayDate),
              let first = cal.date(from: cal.dateComponents([.year, .month], from: displayDate)) else { return [] }
        let weekday = cal.component(.weekday, from: first) - 1 // 0=Sun
        let count = range.count
        var out: [Date?] = Array(repeating: nil, count: weekday)
        for day in 1...count {
            if let d = cal.date(byAdding: .day, value: day - 1, to: first) {
                out.append(d)
            }
        }
        while out.count % 7 != 0 { out.append(nil) }
        return out
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    Text(viewModel.confirmationType.usesFixedSlots ? "Fixed time slots" : "Open booking")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                    HStack {
                        Button(action: previousMonth) {
                            Image(systemName: "chevron.left")
                                .font(.body.weight(.semibold))
                        }
                        Text(monthYearText)
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                        Button(action: nextMonth) {
                            Image(systemName: "chevron.right")
                                .font(.body.weight(.semibold))
                        }
                    }
                    .padding(.horizontal, 24)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
                        ForEach(Array(calendarDays.enumerated()), id: \.offset) { _, dateOpt in
                            if let date = dateOpt {
                                CalendarDateCell(
                                    date: date,
                                    isBlocked: !viewModel.confirmationType.usesFixedSlots && viewModel.isDateBlocked(date),
                                    isAvailable: viewModel.confirmationType.usesFixedSlots && viewModel.isDateAvailable(date),
                                    isToday: Calendar.current.isDateInToday(date)
                                ) {
                                    if viewModel.confirmationType.usesFixedSlots {
                                        viewModel.toggleAvailableDate(date)
                                    } else {
                                        viewModel.toggleBlockedDate(date)
                                    }
                                }
                            } else {
                                Color.clear
                                    .frame(height: 40)
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Slots available")
                            .font(.subheadline.weight(.medium))
                        ForEach(Array(viewModel.timeSlots.enumerated()), id: \.element.id) { index, slot in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 12) {
                                    Button(action: { editingSlot = slot }) {
                                        HStack {
                                            Text("\(viewModel.formatHour(slot.open)) – \(viewModel.formatHour(slot.close))")
                                                .font(.subheadline.weight(.medium))
                                                .foregroundColor(.primary)
                                            Image(systemName: "chevron.right")
                                                .font(.caption2.weight(.semibold))
                                                .foregroundColor(.secondary)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(12)
                                        .background(viewModel.hasInvalidSlot(slot) ? Color.red.opacity(0.1) : Color.gray.opacity(0.06))
                                        .cornerRadius(10)
                                    }
                                    .buttonStyle(.plain)
                                    Picker("", selection: Binding(
                                        get: { slot.type },
                                        set: { viewModel.updateTimeSlot(id: slot.id, type: $0) }
                                    )) {
                                        ForEach(SlotType.allCases, id: \.self) { type in
                                            Text(type.displayName).tag(type)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                    .frame(minWidth: 130)
                                    if viewModel.timeSlots.count > 1 {
                                        Button(action: { viewModel.removeTimeSlot(at: index) }) {
                                            Image(systemName: "trash")
                                                .font(.body)
                                                .foregroundColor(.red)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                if slot.type == .custom {
                                    TextField("Custom label", text: Binding(
                                        get: { slot.customLabel ?? "" },
                                        set: { viewModel.setSlotCustomLabel(id: slot.id, $0) }
                                    ))
                                    .textFieldStyle(.roundedBorder)
                                    .font(.subheadline)
                                }
                                if slot.type == .recurring {
                                    recurringDaysRow(slot: slot)
                                }
                                if viewModel.hasInvalidSlot(slot) {
                                    Text("End must be after start")
                                        .font(.caption)
                                        .foregroundColor(.red)
                                }
                            }
                        }
                        Button(action: { viewModel.addTimeSlot() }) {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                Text("Add time slot")
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(12)
                    .padding(.horizontal, 24)
                }
            }
            .navigationTitle("Scheduling")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .onAppear {
            displayDate = Date()
        }
        .sheet(item: $editingSlot) { slot in
            TimeSlotEditSheet(slot: slot, viewModel: viewModel) {
                editingSlot = nil
            }
        }
    }

    private func previousMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: -1, to: displayDate) {
            displayDate = d
        }
    }

    private func nextMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: 1, to: displayDate) {
            displayDate = d
        }
    }

    private func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    @ViewBuilder
    private func recurringDaysRow(slot: TimeSlot) -> some View {
        let days = viewModel.dayLabels
        Text("Repeat on")
            .font(.caption)
            .foregroundColor(.secondary)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
            ForEach(days, id: \.0) { day, label in
                Button(action: { viewModel.toggleRecurringDay(slotId: slot.id, day: day) }) {
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background((slot.recurringDays ?? []).contains(day) ? Color.black : Color.gray.opacity(0.15))
                        .foregroundColor((slot.recurringDays ?? []).contains(day) ? .white : .primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Time slot edit sheet
struct TimeSlotEditSheet: View {
    let slot: TimeSlot
    @ObservedObject var viewModel: SettingsViewModel
    let onDismiss: () -> Void

    @State private var openHour: Int
    @State private var closeHour: Int

    init(slot: TimeSlot, viewModel: SettingsViewModel, onDismiss: @escaping () -> Void) {
        self.slot = slot
        self.viewModel = viewModel
        self.onDismiss = onDismiss
        _openHour = State(initialValue: slot.open)
        _closeHour = State(initialValue: slot.close)
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("From")) {
                    Picker("From", selection: $openHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                Section(header: Text("To")) {
                    Picker("To", selection: $closeHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                if closeHour <= openHour {
                    Section {
                        Text("End must be after start")
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Edit time slot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        viewModel.updateTimeSlot(id: slot.id, open: openHour, close: closeHour)
                        onDismiss()
                    }
                    .disabled(closeHour <= openHour)
                }
            }
        }
    }
}

struct CalendarDateCell: View {
    let date: Date
    let isBlocked: Bool   // Approval mode: blocked (vacation)
    let isAvailable: Bool // Fixed slots: selected for appointments
    let isToday: Bool
    let onTap: () -> Void

    private var dayNumber: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d"
        return formatter.string(from: date)
    }

    var body: some View {
        Button(action: onTap) {
            Text(dayNumber)
                .font(.caption.weight(isToday ? .bold : .medium))
                .frame(width: 36, height: 36)
                .background(backgroundColor)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isToday ? Color.black : Color.clear, lineWidth: 2)
                )
                .foregroundColor(foregroundColor)
                .cornerRadius(8)
                .strikethrough(isBlocked, color: .primary)
        }
        .buttonStyle(.plain)
    }

    private var backgroundColor: Color {
        if isBlocked { return Color.red.opacity(0.3) }
        if isAvailable { return Color.green.opacity(0.4) }
        if isToday { return Color.black.opacity(0.08) }
        return Color.clear
    }

    private var foregroundColor: Color {
        if isBlocked { return .secondary }
        return .primary
    }
}
