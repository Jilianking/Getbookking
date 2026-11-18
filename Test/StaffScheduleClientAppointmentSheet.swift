//
//  StaffScheduleClientAppointmentSheet.swift
//
//  Staff scheduling: walk-in (editable customer) or existing client, then create + confirm.
//

import SwiftUI
import FirebaseAuth

struct StaffScheduleClientAppointmentSheet: View {
    let client: Client?
    @ObservedObject var viewModel: RequestsViewModel
    let canPickArtist: Bool
    let requiresDeposit: Bool
    let depositAmount: Double?
    let studioCanSendSms: Bool
    var onConfirmed: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var customerName: String
    @State private var customerEmail: String
    @State private var customerPhone: String
    @State private var services: [(id: String, name: String, slug: String, durationMinutes: Int?)] = []
    @State private var isLoadingServices = true
    @State private var selectedServiceId: String?
    @State private var confirmedDate: Date
    @State private var confirmedTime: Date
    @State private var selectedMemberUid: String?
    @State private var selectedBoatId: String?
    @State private var notes = ""
    @State private var sendDepositLinkViaText = true
    /// "Text the client a confirmation" — on by default; off books it without a text.
    @State private var sendConfirmationText = true
    @State private var depositAmountText: String
    /// Locks the main button from the first tap until the whole save (booking, texts, deposit link) finishes.
    @State private var isSubmitting = false

    init(
        client: Client? = nil,
        prefillName: String? = nil,
        prefillEmail: String? = nil,
        prefillPhone: String? = nil,
        viewModel: RequestsViewModel,
        canPickArtist: Bool,
        requiresDeposit: Bool,
        depositAmount: Double?,
        studioCanSendSms: Bool,
        onConfirmed: @escaping () -> Void = {}
    ) {
        self.client = client
        self.viewModel = viewModel
        self.canPickArtist = canPickArtist
        self.requiresDeposit = requiresDeposit
        self.depositAmount = depositAmount
        self.studioCanSendSms = studioCanSendSms
        self.onConfirmed = onConfirmed

        _customerName = State(initialValue: client?.name ?? prefillName ?? "")
        _customerEmail = State(initialValue: client?.email ?? prefillEmail ?? "")
        if let phone = client?.phone ?? prefillPhone, !phone.isEmpty {
            _customerPhone = State(initialValue: PhoneFormatting.displayUS(phone))
        } else {
            _customerPhone = State(initialValue: "")
        }

        // Start on the next clean 15-minute mark (6:33 → 6:45, 6:45 stays), same as the website.
        let seed = Self.nextQuarterHour(after: Date())
        let calendar = Calendar.current
        _confirmedDate = State(initialValue: calendar.startOfDay(for: seed))
        _confirmedTime = State(initialValue: seed)

        let roster = viewModel.teamFilterRoster
        if let currentMemberUid = Auth.auth().currentUser?.uid,
           roster.contains(where: { $0.uid == currentMemberUid }) {
            _selectedMemberUid = State(initialValue: currentMemberUid)
        } else if let owner = roster.first(where: { $0.accessRole == .owner }) {
            _selectedMemberUid = State(initialValue: owner.uid)
        } else {
            _selectedMemberUid = State(initialValue: roster.first?.uid)
        }
        _selectedBoatId = State(initialValue: viewModel.charterBoats.first?.id)
        _sendDepositLinkViaText = State(initialValue: studioCanSendSms)
        _depositAmountText = State(initialValue: DepositAmountInput.initialText(defaultAmount: depositAmount))
    }

    private var isWalkIn: Bool { client == nil }

    /// Rounds up to the next quarter hour; rolls into the next day near midnight.
    static func nextQuarterHour(after date: Date, calendar: Calendar = .current) -> Date {
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        guard let floored = calendar.date(from: parts) else { return date }
        let minute = parts.minute ?? 0
        let remainder = minute % 15
        let atMark = remainder == 0 && floored == date
        if atMark { return floored }
        let add = remainder == 0 ? 15 : 15 - remainder
        return calendar.date(byAdding: .minute, value: add, to: floored) ?? date
    }

    private var roster: [TenantTeamMember] {
        viewModel.teamFilterRoster
    }

    private var selectedMember: TenantTeamMember? {
        guard let uid = selectedMemberUid else { return nil }
        return roster.first(where: { $0.uid == uid })
    }

    private var selectedService: (id: String, name: String, slug: String, durationMinutes: Int?)? {
        guard let id = selectedServiceId else { return nil }
        return services.first(where: { $0.id == id })
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

    private var resolvedClientForSave: Client? {
        if let client { return client }
        let name = customerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = customerEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !email.isEmpty else { return nil }
        return Client(
            name: name,
            email: email,
            phone: PhoneFormatting.normalizedForStorage(customerPhone)
        )
    }

    private var confirmationToggleTitle: String {
        let first = (resolvedClientForSave?.name ?? customerName)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "Text the client a confirmation" : "Text \(first) a confirmation"
    }

    private var confirmationToggleHint: String {
        if !studioCanSendSms { return "Set up your texting number in Settings → Messaging to text clients." }
        if !canSendDepositSms { return "Add the client's phone number to text them." }
        return "Sent from your shop's texting number."
    }

    private var canSendDepositSms: Bool {
        guard studioCanSendSms else { return false }
        let phone = client?.phone ?? PhoneFormatting.normalizedForStorage(customerPhone)
        return !PhoneFormatting.digits(from: phone ?? "").isEmpty
    }

    private var effectiveDepositAmount: Double? {
        DepositAmountInput.parse(depositAmountText)
    }

    private var willSendDeposit: Bool {
        requiresDeposit
            && sendDepositLinkViaText
            && canSendDepositSms
            && DepositAmountInput.isValidForLink(effectiveDepositAmount)
    }

    private var depositSendBlocksSubmit: Bool {
        requiresDeposit
            && sendDepositLinkViaText
            && canSendDepositSms
            && !DepositAmountInput.isValidForLink(effectiveDepositAmount)
    }

    private var isSaving: Bool {
        viewModel.isUpdatingStatus || isSubmitting
    }

    private var hasValidCustomer: Bool {
        guard let save = resolvedClientForSave else { return false }
        if isWalkIn {
            let digits = PhoneFormatting.digits(from: save.phone ?? customerPhone)
            return digits.count >= 10
        }
        return true
    }

    private var canSubmit: Bool {
        hasValidCustomer
            && selectedService != nil
            && scheduledStart != nil
            && selectedMember != nil
            && (!viewModel.isCharterPlan || (selectedBoatId != nil && !viewModel.charterBoats.isEmpty))
            && !isSaving
            && !isLoadingServices
            && !depositSendBlocksSubmit
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    customerSection

                    VStack(alignment: .leading, spacing: 16) {
                        BookingRequestSectionHeader(
                            title: viewModel.isCharterPlan ? "Confirmed charter" : "Confirmed appointment"
                        )

                        if isLoadingServices {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else if services.isEmpty {
                            Text(viewModel.isCharterPlan
                                 ? "Add trips in Business settings before scheduling."
                                 : "Add services in Settings before scheduling.")
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        } else {
                            Picker(viewModel.isCharterPlan ? "Trip" : "Service", selection: $selectedServiceId) {
                                Text(viewModel.isCharterPlan ? "Select trip" : "Select service").tag(Optional<String>.none)
                                ForEach(services, id: \.id) { service in
                                    Text(service.name).tag(Optional(service.id))
                                }
                            }
                        }

                        DatePicker(
                            viewModel.isCharterPlan ? "Trip date" : "Confirmed date",
                            selection: $confirmedDate,
                            displayedComponents: .date
                        )

                        DatePicker(
                            viewModel.isCharterPlan ? "Departure time" : "Confirmed time",
                            selection: $confirmedTime,
                            displayedComponents: .hourAndMinute
                        )

                        if canPickArtist {
                            Picker(BookingAssignSchedulePlanner.providerRoleLabel(for: viewModel.tenantIndustry), selection: $selectedMemberUid) {
                                ForEach(roster) { member in
                                    Text(artistLabel(for: member)).tag(Optional(member.uid))
                                }
                            }
                        }

                        if viewModel.isCharterPlan {
                            if viewModel.charterBoats.isEmpty {
                                Label("Add a boat in Business settings before confirming.", systemImage: "exclamationmark.triangle")
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.statusPending)
                            } else {
                                Picker("Boat", selection: $selectedBoatId) {
                                    ForEach(viewModel.charterBoats) { boat in
                                        Text("\(boat.displayName) · \(boat.capacityLabel)")
                                            .tag(Optional(boat.id))
                                    }
                                }
                            }
                        }

                        TextField("Notes (optional)", text: $notes, axis: .vertical)
                            .lineLimit(2...4)

                        // Always shown so owners know it exists; it only turns on once texting can actually go out.
                        Toggle(isOn: Binding(
                            get: { canSendDepositSms && sendConfirmationText },
                            set: { sendConfirmationText = $0 }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(confirmationToggleTitle)
                                    .font(.subheadline.weight(.medium))
                                Text(confirmationToggleHint)
                                    .font(.caption)
                                    .foregroundStyle(AppDesign.textSecondary)
                            }
                        }
                        .tint(AppDesign.brandWarm)
                        .disabled(!canSendDepositSms)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .appCard()

                    if requiresDeposit {
                        PerAppointmentDepositSection(
                            sectionTitle: "Deposit required",
                            sendToggleTitle: "Send deposit link via text",
                            amountText: $depositAmountText,
                            sendViaText: $sendDepositLinkViaText,
                            canSendSms: canSendDepositSms
                        )
                    }

                    if let err = viewModel.actionError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if willSendDeposit {
                        Label("Deposit link will be sent on confirm", systemImage: "message.fill")
                            .font(.caption)
                            .foregroundStyle(AppDesign.statusPending)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button {
                        guard !isSubmitting else { return }
                        isSubmitting = true
                        Task {
                            await save()
                            isSubmitting = false
                        }
                    } label: {
                        Group {
                            if isSaving {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text(viewModel.isCharterPlan ? "Confirm charter" : "Confirm")
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
            .navigationTitle(isWalkIn
                ? (viewModel.isCharterPlan ? "New charter" : "New booking")
                : (viewModel.isCharterPlan ? "Schedule charter" : "Schedule appointment"))
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSubmitting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .task {
                await loadServices()
            }
            .onAppear {
                viewModel.actionError = nil
            }
        }
    }

    @ViewBuilder
    private var customerSection: some View {
        if isWalkIn {
            VStack(alignment: .leading, spacing: 16) {
                BookingRequestSectionHeader(title: "Customer information")
                TextField("Full name", text: $customerName)
                    .textContentType(.name)
                TextField("Email", text: $customerEmail)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                TextField("(555) 123-4567", text: Binding(
                    get: { customerPhone },
                    set: { customerPhone = PhoneFormatting.formatAsYouType($0) }
                ))
                .keyboardType(.phonePad)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .appCard()
        } else if let client {
            VStack(alignment: .leading, spacing: 8) {
                Text(client.name)
                    .font(.title3.weight(.semibold))
                if !client.email.isEmpty {
                    Text(client.email)
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                if let phone = client.phone, !phone.isEmpty {
                    Text(PhoneFormatting.displayUS(phone))
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                }
                AppStatusPill(text: "Walk-in schedule", soft: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .appCard()
        }
    }

    private func artistLabel(for member: TenantTeamMember) -> String {
        if member.accessRole == .owner { return "Owner" }
        let title = member.jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return member.displayName }
        return "\(member.displayName) · \(title)"
    }

    private func loadServices() async {
        isLoadingServices = true
        defer { isLoadingServices = false }
        guard let tid = viewModel.tenantId else {
            services = []
            return
        }
        do {
            let fetched = try await FirebaseService().fetchTenantServices(tenantId: tid)
            let active = fetched.filter(\.isActive).map {
                (id: $0.id, name: $0.name, slug: $0.slug, durationMinutes: $0.durationMinutes)
            }
            await MainActor.run {
                services = active
                selectedServiceId = active.first?.id
            }
        } catch {
            await MainActor.run { services = [] }
        }
    }

    private func save() async {
        guard let saveClient = resolvedClientForSave,
              let service = selectedService,
              let member = selectedMember,
              let start = scheduledStart else { return }
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestId = await viewModel.createAndConfirmBookingForClient(
            client: saveClient,
            serviceId: service.id,
            serviceSlug: service.slug,
            serviceName: service.name,
            member: member,
            scheduledStart: start,
            notes: trimmedNotes.isEmpty ? nil : trimmedNotes,
            durationMinutes: service.durationMinutes,
            boatId: viewModel.isCharterPlan ? selectedBoatId : nil,
            skipConfirmationSms: canSendDepositSms && !sendConfirmationText
        )
        if requestId != nil,
           willSendDeposit,
           let amount = effectiveDepositAmount {
            let booking = BookingRequest(
                documentId: requestId,
                status: "confirmed",
                source: nil,
                serviceId: service.id,
                serviceSlug: service.slug,
                serviceName: service.name,
                tenantId: viewModel.tenantId,
                customerId: saveClient.id,
                customerName: saveClient.name,
                customerPhone: saveClient.phone,
                customerEmail: saveClient.email,
                bookingModeUsed: nil,
                preferredDays: nil,
                preferredTime: nil,
                requestedStartTime: start,
                notes: trimmedNotes.isEmpty ? nil : trimmedNotes,
                formResponses: nil,
                createdAt: nil,
                readAt: nil,
                assignedMemberUid: member.uid,
                assignedMemberName: member.displayName,
                assignedMemberEmail: member.email,
                smsConsentAccepted: nil,
                smsConsentAt: nil
            )
            await viewModel.sendDepositLinkViaSms(for: booking, depositAmount: amount)
        }
        if viewModel.actionError == nil, requestId != nil {
            onConfirmed()
            dismiss()
        }
    }
}
