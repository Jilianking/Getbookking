import SwiftUI

enum CalendarViewMode: String, CaseIterable {
    case month = "Month"
    case week = "Week"
}

struct CalendarView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = CalendarViewModel()
    @StateObject private var requestsViewModel = RequestsViewModel()
    @State private var selectedDate = Date()
    @State private var displayedMonth = Calendar.current.date(
        from: Calendar.current.dateComponents([.year, .month], from: Date())
    ) ?? Date()
    @State private var viewMode: CalendarViewMode = .month
    @State private var showingNewBookingSheet = false
    @State private var showingLegacyBookingForm = false
    @State private var selectedBookingRequest: BookingRequest?
    var drawerState: DrawerState
    let sectionTitle: String

    private var canManageAssignment: Bool {
        authViewModel.teamAccess.isOwner || authViewModel.teamAccess.canViewAllBookings
    }

    private var canPickArtistOnConfirm: Bool {
        canManageAssignment && authViewModel.teamAccess.showsStaffAssignmentUI(
            rosterCount: requestsViewModel.teamFilterRoster.count
        )
    }

    private var useStaffScheduleFlow: Bool {
        sessionStore.tenantId != nil
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 0) {
                    AppScreenTitle(title: sectionTitle)
                    Button(action: { openNewBookingSheet() }) {
                        HStack {
                            Image(systemName: "plus")
                            Text("New Booking")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppDesign.brandDark)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 12)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(CalendarViewMode.allCases, id: \.self) { mode in
                                let selected = viewMode == mode
                                Button { viewMode = mode } label: {
                                    Text(mode.rawValue)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(selected ? Color.white : AppDesign.textPrimary)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 9)
                                        .background(selected ? AppDesign.brandDark : AppDesign.cardBackground)
                                        .clipShape(Capsule())
                                        .overlay(
                                            Capsule().stroke(selected ? Color.clear : AppDesign.chipBorder, lineWidth: 1)
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .padding(.bottom, 12)

                    if viewMode == .month {
                        MonthCalendarGrid(
                            displayedMonth: $displayedMonth,
                            selectedDate: $selectedDate,
                            eventsByDay: eventsByDay
                        )
                        .padding(.bottom, 16)

                        appointmentsSection
                    } else if viewMode == .week {
                        CalendarWeekStrip(
                            displayedMonth: $displayedMonth,
                            selectedDate: $selectedDate,
                            eventsByDay: eventsByDay
                        )
                        .padding(.bottom, 12)

                        DayCalendarTimelineView(
                            selectedDate: selectedDate,
                            events: filteredEvents,
                            isLoading: viewModel.isLoading,
                            canOpenEvent: { viewModel.bookingRequest(for: $0) != nil },
                            onEventTap: { event in
                                Task { await openBookingDetail(for: event) }
                            }
                        )
                    }
                }
            }
            .refreshable {
                await viewModel.loadEvents(
                    forMonthAround: displayedMonth,
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .task {
                requestsViewModel.sessionStore = sessionStore
                await viewModel.loadEvents(
                    forMonthAround: displayedMonth,
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
                await requestsViewModel.loadRequests(
                    isDemoMode: authViewModel.isDemoMode,
                    sessionStore: sessionStore
                )
            }
            .onChange(of: displayedMonth) { _, newMonth in
                Task {
                    await viewModel.loadEvents(
                        forMonthAround: newMonth,
                        isDemoMode: authViewModel.isDemoMode,
                        sessionStore: sessionStore
                    )
                }
            }
            .onChange(of: selectedDate) { _, newDate in
                let monthStart = Calendar.current.date(
                    from: Calendar.current.dateComponents([.year, .month], from: newDate)
                ) ?? newDate
                if !Calendar.current.isDate(displayedMonth, equalTo: monthStart, toGranularity: .month) {
                    displayedMonth = monthStart
                }
            }
            .sheet(isPresented: $showingNewBookingSheet) {
                StaffScheduleClientAppointmentSheet(
                    viewModel: requestsViewModel,
                    canPickArtist: canPickArtistOnConfirm,
                    requiresDeposit: authViewModel.teamAccess.confirmationType.requiresDeposit,
                    depositAmount: authViewModel.teamAccess.depositAmount ?? requestsViewModel.workflowDepositAmount,
                    studioCanSendSms: authViewModel.teamAccess.canSendClientSms,
                    onConfirmed: {
                        Task {
                            sessionStore.invalidateBookings()
                            await sessionStore.loadNewBookingsIfNeeded(
                                force: true,
                                isDemoMode: authViewModel.isDemoMode
                            )
                            await viewModel.loadEvents(
                                forMonthAround: displayedMonth,
                                isDemoMode: authViewModel.isDemoMode,
                                sessionStore: sessionStore
                            )
                        }
                    }
                )
            }
            .sheet(isPresented: $showingLegacyBookingForm) {
                BookingFormView(drawerState: drawerState)
                    .environmentObject(authViewModel)
                    .onDisappear {
                        Task {
                            await viewModel.loadEvents(
                                forMonthAround: displayedMonth,
                                isDemoMode: authViewModel.isDemoMode,
                                sessionStore: sessionStore
                            )
                        }
                    }
            }
            .sheet(item: $selectedBookingRequest) { booking in
                BookingRequestDetailView(
                    request: booking,
                    viewModel: requestsViewModel,
                    drawerState: drawerState,
                    teamAccess: authViewModel.teamAccess
                )
                .environmentObject(sessionStore)
            }
            .onAppear {
                requestsViewModel.sessionStore = sessionStore
                openNewBookingIfRequested()
            }
            .onChange(of: drawerState.calendarShouldOpenNewBooking) { _, shouldOpen in
                if shouldOpen {
                    openNewBookingIfRequested()
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private func openNewBookingIfRequested() {
        guard drawerState.calendarShouldOpenNewBooking else { return }
        drawerState.calendarShouldOpenNewBooking = false
        openNewBookingSheet()
    }

    private func openNewBookingSheet() {
        Task {
            requestsViewModel.sessionStore = sessionStore
            await requestsViewModel.loadRequests(
                isDemoMode: authViewModel.isDemoMode,
                sessionStore: sessionStore
            )
            await MainActor.run {
                if useStaffScheduleFlow {
                    showingNewBookingSheet = true
                } else {
                    showingLegacyBookingForm = true
                }
            }
        }
    }

    private var eventsByDay: [Date: [Event]] {
        Dictionary(grouping: viewModel.events) { event in
            Calendar.current.startOfDay(for: event.start)
        }.mapValues { events in
            events.sorted { $0.start < $1.start }
        }
    }

    private var filteredEvents: [Event] {
        let calendar = Calendar.current
        return viewModel.events
            .filter { calendar.isDate($0.start, inSameDayAs: selectedDate) }
            .sorted { $0.start < $1.start }
    }

    private var appointmentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Appointments")
                .font(.headline)
                .padding(.horizontal)

            if viewModel.isLoading && viewModel.events.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else if filteredEvents.isEmpty {
                Text("No confirmed appointments on this day.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding(.horizontal)
                    .padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(filteredEvents) { event in
                        Button {
                            Task { await openBookingDetail(for: event) }
                        } label: {
                            EventRow(event: event)
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.bookingRequest(for: event) == nil)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .padding(.bottom, 24)
    }

    private func openBookingDetail(for event: Event) async {
        guard let booking = viewModel.bookingRequest(for: event) else { return }
        requestsViewModel.sessionStore = sessionStore
        await requestsViewModel.loadRequests(
            isDemoMode: authViewModel.isDemoMode,
            sessionStore: sessionStore
        )
        let enriched = await requestsViewModel.enrichedBookingRequestWithClientContact(booking)
        await MainActor.run {
            selectedBookingRequest = enriched
        }
    }
}

struct EventRow: View {
    let event: Event

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(event.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppDesign.textPrimary)
                Spacer()
                Text(event.start, style: .time)
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            Text(event.clientName)
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)
            HStack {
                AppStatusPill(text: "Confirmed", soft: true)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppDesign.textSecondary)
            }
        }
        .padding(14)
        .appCard()
        .padding(.vertical, 4)
    }
}
