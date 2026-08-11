//
//  TeamBookingSettingsView.swift
//

import SwiftUI

struct TeamBookingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var settingsViewModel: SettingsViewModel
    @ObservedObject var teamPolicyViewModel: ManagerSettingsViewModel
    /// Solo Business settings: owner booking type only (no manager sections).
    var isSoloBusinessSettings: Bool = false

    /// Single Booking type picker: classic types + Calendar / slots.
    private var bookingTypeSelection: Binding<StudioBookingTypeOption> {
        Binding(
            get: {
                StudioBookingTypeOption.from(
                    mode: settingsViewModel.bookingMode,
                    confirmation: settingsViewModel.confirmationType
                )
            },
            set: { option in
                var mode = settingsViewModel.bookingMode
                var conf = settingsViewModel.confirmationType
                option.apply(toMode: &mode, confirmation: &conf)
                settingsViewModel.bookingMode = mode
                settingsViewModel.confirmationType = conf
            }
        )
    }

    private var isCalendarType: Bool {
        settingsViewModel.bookingMode == .calendarSlots
    }

    var body: some View {
        List {
            if isSoloBusinessSettings {
                soloBookingSection
            } else {
                studioBookingPolicySection
                ownerAccessSection
                ownerAlertsSection
            }

            if isCalendarType {
                availabilitySection
            }

            saveSection

            if let err = settingsViewModel.errorMessage ?? teamPolicyViewModel.errorMessage {
                Section {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .appListSurface()
        .navigationTitle("Booking settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Solo

    private var soloBookingSection: some View {
        Section(
            header: Text("How clients book"),
            footer: Text(soloBookingFooter)
                .font(.caption2)
        ) {
            Picker("Booking type", selection: bookingTypeSelection) {
                ForEach(StudioBookingTypeOption.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }

            if isCalendarType {
                Picker("Confirmation", selection: $settingsViewModel.confirmationType) {
                    ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                        Text(type.displayName).tag(type)
                    }
                }
            }

            if settingsViewModel.confirmationType.requiresDeposit {
                depositAmountRow
            }
        }
    }

    private var soloBookingFooter: String {
        if isCalendarType {
            return "Clients pick a day and time on /book. Confirmation is what happens after they book. Set hours and availability under Availability below."
        }
        return "Choose how clients book appointments with you. Layout for form types is Standard or Guided in Design."
    }

    // MARK: Team

    private var studioBookingPolicySection: some View {
        Section(
            header: Text("Studio booking policy"),
            footer: clientBookingFooter
        ) {
            Toggle("Owner sets team booking type", isOn: $settingsViewModel.managersApproveAppointments)
                .onChange(of: settingsViewModel.managersApproveAppointments) { _, enabled in
                    if !enabled {
                        teamPolicyViewModel.permissions.approveRejectRequests = false
                    }
                }

            // Always owner-controlled: form vs calendar on public /book.
            Picker("Booking type", selection: bookingTypeSelection) {
                ForEach(StudioBookingTypeOption.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }

            if isCalendarType {
                if settingsViewModel.managersApproveAppointments {
                    Picker("Confirmation", selection: $settingsViewModel.confirmationType) {
                        ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                            Text(type.displayName).tag(type)
                        }
                    }
                    if settingsViewModel.confirmationType.requiresDeposit {
                        depositAmountRow
                    }
                } else {
                    Text("Each person chooses Instant / Request + approve / Deposit in Settings → My booking type.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if settingsViewModel.managersApproveAppointments {
                if settingsViewModel.confirmationType.requiresDeposit {
                    depositAmountRow
                }
            }
        }
    }

    private var depositAmountRow: some View {
        HStack {
            Text("Deposit amount")
            TextField("0", value: Binding(
                get: { settingsViewModel.depositAmount ?? 0 },
                set: { settingsViewModel.depositAmount = $0 > 0 ? $0 : nil }
            ), format: .number)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text("USD")
                .foregroundStyle(.secondary)
        }
    }

    private var availabilitySection: some View {
        Section(
            header: Text("Availability"),
            footer: Text("Weekly shop hours set when you’re open on public /book. Availability calendar is only for days off and blocked times of day.")
                .font(.caption2)
        ) {
            NavigationLink {
                PersonalSchedulingSettingsView(viewModel: settingsViewModel)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Scheduling & hours")
                    Text(settingsViewModel.businessHoursSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }

    private var ownerAccessSection: some View {
        Section(
            header: Text("Owner access"),
            footer: Text("When on, your Requests list includes every shop booking and you can approve or decline. When off, you only see and act on bookings assigned to you. Assigned artists can always accept or decline their own.")
                .font(.caption2)
        ) {
            TeamPermissionToggle(
                viewModel: teamPolicyViewModel,
                title: "View all bookings",
                keyPath: \.viewAllBookings
            )
            TeamApproveRejectRow(
                viewModel: teamPolicyViewModel,
                managersApproveAppointments: true,
                bookingRequiresApproval: true
            )
        }
    }

    private var ownerAlertsSection: some View {
        Section(
            header: Text("Owner booking alerts"),
            footer: Text("When on, you get push alerts for new bookings and cancellations. Assigned artists are still notified about their own jobs.")
                .font(.caption2)
        ) {
            TeamNotificationToggle(
                viewModel: teamPolicyViewModel,
                title: "Notify on new booking",
                keyPath: \.onNewBooking
            )
            TeamNotificationToggle(
                viewModel: teamPolicyViewModel,
                title: "Notify on cancellation",
                keyPath: \.onCancellation
            )
        }
    }

    private var saveSection: some View {
        Section {
            Button {
                Task { await saveAll() }
            } label: {
                HStack {
                    Text("Save booking settings")
                    if settingsViewModel.isLoading || teamPolicyViewModel.isSavingPolicy {
                        Spacer()
                        ProgressView().scaleEffect(0.9)
                    }
                }
            }
            .disabled(settingsViewModel.isLoading || teamPolicyViewModel.isSavingPolicy)

            if settingsViewModel.saveSuccess || teamPolicyViewModel.saveSuccess {
                Label(
                    settingsViewModel.bookingMode == .calendarSlots
                        ? "Saved — public /book uses calendar"
                        : "Saved — public /book uses form",
                    systemImage: "checkmark.circle.fill"
                )
                    .foregroundStyle(.green)
                    .font(.subheadline)
            }
        }
    }

    private var clientBookingFooter: some View {
        Group {
            if isCalendarType {
                if settingsViewModel.managersApproveAppointments {
                    Text("Public /book uses the calendar. Confirmation below applies to the whole team.")
                } else {
                    Text("Public /book uses the calendar. Each person sets confirmation in My booking type.")
                }
            } else if settingsViewModel.managersApproveAppointments {
                Text("Your booking type applies to everyone on the team. Turn off to let each person choose their own in Settings → My booking type.")
            } else {
                Text("Booking type still controls public Form vs Calendar. Each person sets Instant / Request + approve / Deposit in My booking type.")
            }
        }
        .font(.caption2)
    }

    private func saveAll() async {
        if isSoloBusinessSettings {
            await settingsViewModel.saveSoloBusinessBookingWorkflow()
        } else {
            // Always attempt save — persistPublicBookingModeToTenant is owner/manager-rule gated server-side.
            await settingsViewModel.saveWorkflow(isOwner: true)
            let publicOk = settingsViewModel.saveSuccess
                || (settingsViewModel.errorMessage ?? "").hasPrefix("Saved for /book")
            if publicOk {
                await teamPolicyViewModel.saveManagerPolicy()
                await teamPolicyViewModel.load(isDemoMode: authViewModel.isDemoMode)
            }
        }
        await authViewModel.refreshTeamAccess()
    }
}
