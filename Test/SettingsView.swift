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
    @State private var showingDaysCalendar = false
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
                        Picker("Type", selection: $viewModel.workflowMode) {
                            Text("Open (approve/decline)").tag(WorkflowMode.approval)
                            Text("Fixed time slots").tag(WorkflowMode.fixedSlots)
                        }
                        if viewModel.workflowMode == .approval {
                            Stepper("Response time: \(viewModel.responseTimeHours) hours", value: $viewModel.responseTimeHours, in: 1...168, step: 1)
                        }
                        Button(action: { showingDaysCalendar = true }) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Days & hours")
                                        .foregroundColor(.primary)
                                    Text("\(daysOpenSummary) · \(timeSlotsSummary)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(.secondary)
                            }
                        }
                        .sheet(isPresented: $showingDaysCalendar) {
                            DaysOpenCalendarSheet(viewModel: viewModel)
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

    private var daysOpenSummary: String {
        let labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        let selected = viewModel.sortedDaysOpen.map { labels[$0] }
        return selected.isEmpty ? "None" : selected.joined(separator: ", ")
    }

    private var timeSlotsSummary: String {
        let slots = viewModel.timeSlots
        if slots.isEmpty { return "No slots" }
        if slots.count == 1, let s = slots.first {
            return "\(formatHour(s.open)) – \(formatHour(s.close))"
        }
        return "\(slots.count) time slots"
    }

    private func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }
}

// MARK: - Days open calendar sheet
struct DaysOpenCalendarSheet: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var displayDate = Date()
    @Environment(\.dismiss) var dismiss

    private let weekDays: [(Int, String)] = [
        (0, "Sun"), (1, "Mon"), (2, "Tue"), (3, "Wed"),
        (4, "Thu"), (5, "Fri"), (6, "Sat")
    ]

    private var calendarInstruction: String {
        viewModel.workflowMode == .fixedSlots
            ? "Tap dates to select when you can accept appointments"
            : "Uses shop hours. Tap dates to block (vacation, closed)."
    }

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
                    Text(viewModel.workflowMode == .fixedSlots ? "Select which dates to offer appointments" : "Select the days you're open (shop hours)")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                    if viewModel.workflowMode == .approval {
                        Text("Shop hours – clients request, you approve")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 7), spacing: 12) {
                            ForEach(weekDays, id: \.0) { day, label in
                                Button(action: { viewModel.toggleDay(day) }) {
                                    Text(label)
                                        .font(.caption.weight(.medium))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 12)
                                        .background(viewModel.daysOpen.contains(day) ? Color.black : Color.gray.opacity(0.15))
                                        .foregroundColor(viewModel.daysOpen.contains(day) ? .white : .primary)
                                        .cornerRadius(10)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 24)
                    }
                    Text(calendarInstruction)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
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
                                    isBlocked: viewModel.workflowMode == .approval && viewModel.isDateBlocked(date),
                                    isAvailable: viewModel.workflowMode == .fixedSlots && viewModel.isDateAvailable(date),
                                    isToday: Calendar.current.isDateInToday(date)
                                ) {
                                    if viewModel.workflowMode == .fixedSlots {
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
                        Text("Time available")
                            .font(.subheadline.weight(.medium))
                        Text("Slots offered during these periods on selected dates")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        ForEach(Array(viewModel.timeSlots.enumerated()), id: \.element.id) { index, slot in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("From")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Picker("From", selection: Binding(
                                        get: { slot.open },
                                        set: { viewModel.updateTimeSlot(id: slot.id, open: $0, close: nil) }
                                    )) {
                                        ForEach(0..<24, id: \.self) { hour in
                                            Text(formatHour(hour)).tag(hour)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                }
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("To")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Picker("To", selection: Binding(
                                        get: { slot.close },
                                        set: { viewModel.updateTimeSlot(id: slot.id, open: nil, close: $0) }
                                    )) {
                                        ForEach(0..<24, id: \.self) { hour in
                                            Text(formatHour(hour)).tag(hour)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                }
                                if viewModel.timeSlots.count > 1 {
                                    Button(action: { viewModel.removeTimeSlot(at: index) }) {
                                        Image(systemName: "trash")
                                            .font(.body)
                                            .foregroundColor(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(12)
                            .background(Color.gray.opacity(0.06))
                            .cornerRadius(10)
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
