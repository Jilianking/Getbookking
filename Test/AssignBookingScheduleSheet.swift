//
//  AssignBookingScheduleSheet.swift
//
//  Schedule-based assign: date strip, per-staff slots, preferred/taken/selected chips.
//

import SwiftUI

struct AssignBookingScheduleSheet: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    var showsStaffPicker: Bool = true
    @Environment(\.dismiss) private var dismiss

    @State private var selectedDay: Date
    @State private var selectedMemberUid: String?
    @State private var selectedSlotStart: Date?

    init(request: BookingRequest, viewModel: RequestsViewModel, showsStaffPicker: Bool = true) {
        self.request = request
        self.viewModel = viewModel
        self.showsStaffPicker = showsStaffPicker
        let initial = request.requestedStartTime ?? request.createdAt ?? Date()
        _selectedDay = State(initialValue: Calendar.current.startOfDay(for: initial))
        if let uid = request.assignedMemberUid?.trimmingCharacters(in: .whitespacesAndNewlines), !uid.isEmpty {
            _selectedMemberUid = State(initialValue: uid)
        }
        _selectedSlotStart = State(initialValue: request.requestedStartTime)
    }

    private var currentRequest: BookingRequest {
        guard let id = request.documentId,
              let fresh = viewModel.bookingRequests.first(where: { $0.documentId == id }) else {
            return request
        }
        return fresh
    }

    private var assignTitle: String {
        BookingAssignSchedulePlanner.assignTitle(for: viewModel.tenantIndustry)
    }

    private var dateStrip: [Date] {
        BookingAssignSchedulePlanner.dateStrip(anchor: selectedDay)
    }

    private var staffRows: [AssignScheduleStaffRow] {
        BookingAssignSchedulePlanner.buildRows(
            request: currentRequest,
            day: selectedDay,
            roster: viewModel.teamFilterRoster,
            bookings: viewModel.bookingRequests,
            availability: viewModel.studioAvailability,
            selectedMemberUid: selectedMemberUid,
            selectedSlotStart: selectedSlotStart
        )
    }

    private var preferredLabel: String? {
        if let start = currentRequest.requestedStartTime {
            return "Preferred \(BookingAssignSchedulePlanner.formatSlotLabel(start))"
        }
        let pt = (currentRequest.preferredTime ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return pt.isEmpty ? nil : "Preferred \(pt)"
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                requestHeader
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 12)

                dateStripView
                    .padding(.bottom, 12)

                ScrollView {
                    VStack(spacing: 16) {
                        ForEach(staffRows) { row in
                            staffRowView(row)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                }

                legend
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)

                doneFooter
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
            .appScreenBackground()
            .navigationTitle(assignTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onChange(of: selectedDay) { _, _ in
                if let slot = selectedSlotStart,
                   !Calendar.current.isDate(slot, inSameDayAs: selectedDay) {
                    selectedSlotStart = nil
                }
            }
            .onAppear { ensureSoleMemberSelectedIfNeeded() }
        }
    }

    private func ensureSoleMemberSelectedIfNeeded() {
        guard !showsStaffPicker, selectedMemberUid == nil,
              let only = viewModel.teamFilterRoster.first else { return }
        selectedMemberUid = only.uid
    }

    private var requestHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(headerLine)
                .font(.subheadline.weight(.semibold))
            if let day = currentRequest.requestedStartTime ?? currentRequest.createdAt {
                Text(day.formatted(.dateTime.month(.abbreviated).day().year()))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let preferredLabel {
                Label(preferredLabel, systemImage: "star.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerLine: String {
        let name = currentRequest.customerName ?? "Guest"
        let service = currentRequest.serviceName ?? currentRequest.serviceSlug ?? "Appointment"
        return "\(name) · \(service)"
    }

    private var dateStripView: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(dateStrip, id: \.timeIntervalSince1970) { day in
                    let isSelected = Calendar.current.isDate(day, inSameDayAs: selectedDay)
                    Button {
                        selectedDay = Calendar.current.startOfDay(for: day)
                    } label: {
                        Text(BookingAssignSchedulePlanner.formatStripDay(day))
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(isSelected ? AppDesign.brandDark : AppDesign.searchBackground)
                            .foregroundStyle(isSelected ? Color.white : AppDesign.textPrimary)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func staffRowView(_ row: AssignScheduleStaffRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsStaffPicker {
                HStack {
                    Text(row.member.accessRole == .owner ? "Owner" : row.member.displayName)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(row.statusText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(row.statusText == "Available" ? .green : .secondary)
                }
            }
            if row.slots.isEmpty {
                Text("No availability")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(row.slots) { slot in
                            slotChip(slot, memberUid: row.member.uid)
                        }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .appCard()
    }

    private func slotChip(_ slot: AssignScheduleSlot, memberUid: String) -> some View {
        let selectable = slot.state == .available || slot.state == .matchesPreferred || slot.state == .selected
        return Button {
            guard selectable else { return }
            if slot.state == .selected {
                selectedSlotStart = nil
                if showsStaffPicker {
                    selectedMemberUid = nil
                }
            } else {
                selectedMemberUid = memberUid
                selectedSlotStart = slot.start
            }
        } label: {
            Text(slot.label)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(chipBackground(slot.state))
                .foregroundStyle(chipForeground(slot.state))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(chipBorder(slot.state), lineWidth: chipBorderWidth(slot.state))
                )
                .cornerRadius(8)
        }
        .buttonStyle(.plain)
        .disabled(!selectable)
    }

    private func chipBackground(_ state: AssignScheduleSlotState) -> Color {
        switch state {
        case .available: return AppDesign.cardBackground
        case .taken: return Color(.tertiarySystemFill)
        case .matchesPreferred: return Color.orange.opacity(0.2)
        case .selected: return Color.accentColor.opacity(0.15)
        }
    }

    private func chipForeground(_ state: AssignScheduleSlotState) -> Color {
        switch state {
        case .taken: return .secondary
        default: return .primary
        }
    }

    private func chipBorderWidth(_ state: AssignScheduleSlotState) -> CGFloat {
        switch state {
        case .selected: return 2
        case .taken: return 1
        default: return 1.5
        }
    }

    private func chipBorder(_ state: AssignScheduleSlotState) -> Color {
        switch state {
        case .taken: return Color(.separator)
        case .selected, .matchesPreferred, .available: return .black
        }
    }

    private var legend: some View {
        HStack(spacing: 16) {
            legendChip(fill: Color.orange.opacity(0.2), border: .black, label: "Matches preferred")
            legendChip(fill: Color(.tertiarySystemFill), border: Color(.separator), label: "Taken")
            legendChip(fill: Color.accentColor.opacity(0.15), border: .black, borderWidth: 2, label: "Selected")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }

    private func legendChip(
        fill: Color,
        border: Color,
        borderWidth: CGFloat = 1.5,
        label: String
    ) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 3)
                .fill(fill)
                .frame(width: 12, height: 12)
                .overlay(
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(border, lineWidth: borderWidth)
                )
            Text(label)
        }
    }

    private var doneFooter: some View {
        VStack(spacing: 8) {
            if let err = viewModel.actionError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await saveAssignment() }
            } label: {
                Group {
                    if viewModel.isUpdatingAssignment {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text(doneButtonTitle)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSave || viewModel.isUpdatingAssignment)
        }
    }

    private var canSave: Bool {
        guard selectedMemberUid != nil, selectedSlotStart != nil else { return false }
        return !(currentRequest.documentId ?? "").isEmpty
    }

    private var doneButtonTitle: String {
        if selectedMemberUid == nil || selectedSlotStart == nil {
            return "Select a time above"
        }
        if let slot = selectedSlotStart {
            let timeLabel = BookingAssignSchedulePlanner.formatSlotLabel(slot)
            if showsStaffPicker,
               let member = viewModel.teamFilterRoster.first(where: { $0.uid == selectedMemberUid }) {
                let name = member.accessRole == .owner ? "Owner" : member.displayName
                return "Assign \(name) · \(timeLabel)"
            }
            return "Set time · \(timeLabel)"
        }
        return "Done"
    }

    private func saveAssignment() async {
        guard let rid = currentRequest.documentId,
              let uid = selectedMemberUid,
              let slot = selectedSlotStart,
              let member = viewModel.teamFilterRoster.first(where: { $0.uid == uid }) else { return }
        let preferred = BookingAssignSchedulePlanner.formatSlotLabel(slot)
        await viewModel.assignBookingRequest(
            requestId: rid,
            member: member,
            scheduledStart: slot,
            preferredTimeLabel: preferred
        )
        if viewModel.actionError == nil {
            dismiss()
        }
    }
}
