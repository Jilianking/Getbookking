//
//  ConfirmBookingAppointmentSheet.swift
//
//  Lock in date, time, and artist when confirming a booking request.
//

import SwiftUI

struct ConfirmBookingAppointmentSheet: View {
    let request: BookingRequest
    @ObservedObject var viewModel: RequestsViewModel
    let canPickArtist: Bool
    let currentMemberUid: String?
    var isReschedule: Bool = false
    var requiresDeposit: Bool = false
    var depositAmount: Double?
    var canSendDepositSms: Bool = false
    @Environment(\.dismiss) private var dismiss

    @State private var confirmedDate: Date
    @State private var confirmedTime: Date
    @State private var selectedMemberUid: String?
    @State private var sendDepositLinkViaText = true

    init(
        request: BookingRequest,
        viewModel: RequestsViewModel,
        canPickArtist: Bool,
        currentMemberUid: String?,
        isReschedule: Bool = false,
        requiresDeposit: Bool = false,
        depositAmount: Double? = nil,
        canSendDepositSms: Bool = false
    ) {
        self.request = request
        self.viewModel = viewModel
        self.canPickArtist = canPickArtist
        self.currentMemberUid = currentMemberUid
        self.isReschedule = isReschedule
        self.requiresDeposit = requiresDeposit
        self.depositAmount = depositAmount
        self.canSendDepositSms = canSendDepositSms

        let seed = request.requestedStartTime ?? request.createdAt ?? Date()
        let calendar = Calendar.current
        _confirmedDate = State(initialValue: calendar.startOfDay(for: seed))
        _confirmedTime = State(initialValue: seed)
        _sendDepositLinkViaText = State(initialValue: isReschedule ? false : canSendDepositSms)

        let roster = viewModel.teamFilterRoster
        let assignedUid = request.assignedMemberUid?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let assignedUid, !assignedUid.isEmpty, roster.contains(where: { $0.uid == assignedUid }) {
            _selectedMemberUid = State(initialValue: assignedUid)
        } else if let currentMemberUid,
                  roster.contains(where: { $0.uid == currentMemberUid }) {
            _selectedMemberUid = State(initialValue: currentMemberUid)
        } else if let owner = roster.first(where: { $0.accessRole == .owner }) {
            _selectedMemberUid = State(initialValue: owner.uid)
        } else {
            _selectedMemberUid = State(initialValue: roster.first?.uid)
        }
    }

    private var currentRequest: BookingRequest {
        guard let id = request.documentId,
              let fresh = viewModel.bookingRequests.first(where: { $0.documentId == id }) else {
            return request
        }
        return fresh
    }

    private var roster: [TenantTeamMember] {
        viewModel.teamFilterRoster
    }

    private var selectedMember: TenantTeamMember? {
        guard let uid = selectedMemberUid else { return nil }
        return roster.first(where: { $0.uid == uid })
    }

    private var scheduledStart: Date? {
        let calendar = Calendar.current
        let day = calendar.dateComponents([.year, .month, .day], from: confirmedDate)
        let time = calendar.dateComponents([.hour, .minute], from: confirmedTime)
        var merged = DateComponents()
        merged.year = day.year
        merged.month = day.month
        merged.day = day.day
        merged.hour = time.hour
        merged.minute = time.minute
        return calendar.date(from: merged)
    }

    private var showDepositSection: Bool {
        requiresDeposit
    }

    private var hasConfiguredDeposit: Bool {
        guard let depositAmount, depositAmount > 0 else { return false }
        return true
    }

    private var depositAmountLabel: String {
        guard let depositAmount, depositAmount > 0 else { return "—" }
        return Self.currencyFormatter.string(from: NSNumber(value: depositAmount)) ?? String(format: "$%.2f", depositAmount)
    }

    private var clientRequestedTimeHint: String? {
        if isReschedule, let start = currentRequest.requestedStartTime {
            return "Currently scheduled for \(start.formatted(.dateTime.weekday(.wide).month(.abbreviated).day().hour().minute()))."
        }
        if let start = currentRequest.requestedStartTime {
            return "Client requested \(start.formatted(.dateTime.weekday(.wide).month(.abbreviated).day().hour().minute()))."
        }
        let preferred = (currentRequest.preferredTime ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferred.isEmpty {
            return "Client noted preferred time: \(preferred)."
        }
        return "Pick the date and time that work for your schedule."
    }

    private var isSaving: Bool {
        isReschedule ? viewModel.isUpdatingAssignment : viewModel.isUpdatingStatus
    }

    private var canSubmit: Bool {
        scheduledStart != nil
            && selectedMember != nil
            && !(currentRequest.documentId ?? "").isEmpty
            && !isSaving
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(currentRequest.customerName ?? "Guest")
                            .font(.title3.weight(.semibold))
                        Text(currentRequest.serviceName ?? currentRequest.serviceSlug ?? "Appointment")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                        AppStatusPill(
                            text: isReschedule ? currentRequest.status : "Pending confirmation",
                            soft: true
                        )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .appCard()

                    VStack(alignment: .leading, spacing: 16) {
                        BookingRequestSectionHeader(
                            title: isReschedule ? "New confirmed time" : "Confirmed appointment"
                        )

                        DatePicker(
                            "Confirmed date",
                            selection: $confirmedDate,
                            displayedComponents: .date
                        )

                        DatePicker(
                            "Confirmed time",
                            selection: $confirmedTime,
                            displayedComponents: .hourAndMinute
                        )

                        if canPickArtist {
                            Picker("Artist", selection: $selectedMemberUid) {
                                ForEach(roster) { member in
                                    Text(artistLabel(for: member)).tag(Optional(member.uid))
                                }
                            }
                        }

                        if let hint = clientRequestedTimeHint {
                            Text(hint)
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .appCard()

                    if showDepositSection {
                        depositRequiredCard
                    }

                    if let err = viewModel.actionError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if showDepositSection && hasConfiguredDeposit && sendDepositLinkViaText && canSendDepositSms {
                        Label(
                            isReschedule ? "Deposit link will be sent after update" : "Deposit link will be sent on confirm",
                            systemImage: "message.fill"
                        )
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button {
                        Task { await save() }
                    } label: {
                        Group {
                            if isSaving {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text(isReschedule ? "Update Time" : "Lock In & Confirm ✓")
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AppPrimaryButtonStyle(enabled: canSubmit))
                    .disabled(!canSubmit)
                }
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle(isReschedule ? "Change Time" : "Confirm Appointment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onAppear {
                viewModel.actionError = nil
            }
        }
    }

    private var depositRequiredCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            BookingRequestSectionHeader(title: isReschedule ? "Deposit link" : "Deposit required")

            if hasConfiguredDeposit {
                HStack {
                    Text("Deposit amount")
                        .font(.subheadline)
                    Spacer()
                    Text(depositAmountLabel)
                        .font(.subheadline.weight(.semibold))
                }

                Toggle(
                    isReschedule ? "Resend deposit link via text" : "Send deposit link via text",
                    isOn: $sendDepositLinkViaText
                )
                    .disabled(!canSendDepositSms)

                Text(depositToggleCaption)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            } else {
                Text("Set a deposit amount in Settings → My booking type to send payment links.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .appCard()
    }

    private var depositToggleCaption: String {
        if !canSendDepositSms {
            if isReschedule {
                return "Texting or client phone is unavailable — update time without sending a link."
            }
            return "Texting or client phone is unavailable — confirm without sending a link."
        }
        if sendDepositLinkViaText {
            if isReschedule {
                return "Send a new link if the client hasn't paid or lost the original text"
            }
            return "Client will receive a text with payment link"
        }
        if isReschedule {
            return "Skip sending — only update the appointment time"
        }
        return "Skip sending — confirm without deposit"
    }

    private func artistLabel(for member: TenantTeamMember) -> String {
        if member.accessRole == .owner { return "Owner" }
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return member.displayName }
        return "\(member.displayName) · \(title)"
    }

    private func save() async {
        guard let rid = currentRequest.documentId,
              let member = selectedMember,
              let start = scheduledStart else { return }
        let preferred = BookingAssignSchedulePlanner.formatSlotLabel(start)
        if isReschedule {
            await viewModel.rescheduleBookingAppointment(
                requestId: rid,
                member: member,
                scheduledStart: start,
                preferredTimeLabel: preferred
            )
        } else {
            await viewModel.confirmBookingAppointment(
                requestId: rid,
                member: member,
                scheduledStart: start,
                preferredTimeLabel: preferred,
                notes: currentRequest.notes
            )
        }
        if viewModel.actionError == nil,
           showDepositSection,
           hasConfiguredDeposit,
           sendDepositLinkViaText,
           canSendDepositSms,
           let amount = depositAmount {
            await viewModel.sendDepositLinkViaSms(for: currentRequest, depositAmount: amount)
        }
        if viewModel.actionError == nil {
            dismiss()
        }
    }

    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()
}
