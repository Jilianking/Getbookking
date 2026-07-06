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
    var confirmationType: BookingConfirmationType = .requestApprove
    var requiresDeposit: Bool = false
    var depositAmount: Double?
    var canSendDepositSms: Bool = false
    @Environment(\.dismiss) private var dismiss

    @State private var confirmedDate: Date
    @State private var confirmedTime: Date
    @State private var selectedMemberUid: String?
    @State private var sendDepositLinkViaText = true
    @State private var depositAmountText: String

    init(
        request: BookingRequest,
        viewModel: RequestsViewModel,
        canPickArtist: Bool,
        currentMemberUid: String?,
        isReschedule: Bool = false,
        confirmationType: BookingConfirmationType = .requestApprove,
        requiresDeposit: Bool = false,
        depositAmount: Double? = nil,
        canSendDepositSms: Bool = false
    ) {
        self.request = request
        self.viewModel = viewModel
        self.canPickArtist = canPickArtist
        self.currentMemberUid = currentMemberUid
        self.isReschedule = isReschedule
        self.confirmationType = confirmationType
        self.requiresDeposit = requiresDeposit
        self.depositAmount = depositAmount
        self.canSendDepositSms = canSendDepositSms

        let seed = request.requestedStartTime ?? request.createdAt ?? Date()
        let calendar = Calendar.current
        _confirmedDate = State(initialValue: calendar.startOfDay(for: seed))
        _confirmedTime = State(initialValue: seed)
        _sendDepositLinkViaText = State(initialValue: isReschedule ? false : canSendDepositSms)
        _depositAmountText = State(initialValue: DepositAmountInput.initialText(defaultAmount: depositAmount))

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

    private var effectiveDepositAmount: Double? {
        DepositAmountInput.parse(depositAmountText)
    }

    private var willSendDeposit: Bool {
        showDepositSection
            && sendDepositLinkViaText
            && canSendDepositSms
            && DepositAmountInput.isValidForLink(effectiveDepositAmount)
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

    private var pendingStatusLabel: String {
        if confirmationType == .consultationFirst {
            return BookingRequestStatus.displayLabel(BookingRequestStatus.pendingConsultation)
        }
        if willSendDeposit {
            return BookingRequestStatus.displayLabel(BookingRequestStatus.pendingDeposit)
        }
        return "Pending confirmation"
    }

    private var confirmButtonTitle: String {
        if isReschedule { return "Update Time" }
        if confirmationType == .consultationFirst { return "Schedule consult" }
        if willSendDeposit { return "Send deposit & hold time" }
        return "Lock In & Confirm ✓"
    }

    private var isSaving: Bool {
        isReschedule ? viewModel.isUpdatingAssignment : viewModel.isUpdatingStatus
    }

    private var depositSendBlocksSubmit: Bool {
        showDepositSection
            && sendDepositLinkViaText
            && canSendDepositSms
            && !DepositAmountInput.isValidForLink(effectiveDepositAmount)
    }

    private var canSubmit: Bool {
        scheduledStart != nil
            && selectedMember != nil
            && !(currentRequest.documentId ?? "").isEmpty
            && !isSaving
            && !depositSendBlocksSubmit
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
                            text: isReschedule ? currentRequest.status : pendingStatusLabel,
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
                        PerAppointmentDepositSection(
                            sectionTitle: isReschedule ? "Deposit link" : "Deposit required",
                            sendToggleTitle: isReschedule
                                ? "Resend deposit link via text"
                                : "Send deposit link via text",
                            amountText: $depositAmountText,
                            sendViaText: $sendDepositLinkViaText,
                            canSendSms: canSendDepositSms,
                            skipSendCaption: isReschedule
                                ? "Skip sending — only update the appointment time"
                                : "Skip sending — confirm without deposit",
                            unavailableSmsCaption: isReschedule
                                ? "Texting or client phone is unavailable — update time without sending a link."
                                : "Texting or client phone is unavailable — confirm without sending a link."
                        )
                    }

                    if let err = viewModel.actionError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if willSendDeposit {
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
                                Text(confirmButtonTitle)
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
        let targetStatus = isReschedule
            ? BookingRequestStatus.confirmed
            : BookingRequestStatus.targetStatusAfterAccept(
                confirmationType: confirmationType,
                requiresDeposit: requiresDeposit,
                sendDepositLink: willSendDeposit
            )
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
                notes: currentRequest.notes,
                targetStatus: targetStatus
            )
        }
        if viewModel.actionError == nil,
           willSendDeposit,
           let amount = effectiveDepositAmount {
            await viewModel.sendDepositLinkViaSms(for: currentRequest, depositAmount: amount)
        }
        if viewModel.actionError == nil {
            dismiss()
        }
    }
}
