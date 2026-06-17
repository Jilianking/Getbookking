import SwiftUI

enum CalendarViewMode: String, CaseIterable {
    case month = "Month"
    case week = "Week"
    case day = "Day"
}

struct CalendarView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = CalendarViewModel()
    @State private var selectedDate = Date()
    @State private var viewMode: CalendarViewMode = .month
    @State private var showingBookingForm = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                Button(action: { showingBookingForm = true }) {
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

                // Calendar
                DatePicker("Select Date", selection: $selectedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding(.horizontal)

                // Events for selected date
                VStack(alignment: .leading, spacing: 8) {
                    Text("Appointments")
                        .font(.headline)
                        .padding(.horizontal)
                    if viewModel.isLoading && viewModel.events.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    } else if filteredEvents.isEmpty {
                        Text("No appointments on this day.")
                            .font(.subheadline)
                            .foregroundStyle(AppDesign.textSecondary)
                            .padding(.horizontal)
                            .padding(.vertical, 12)
                    } else {
                        List(filteredEvents) { event in
                            EventRow(event: event)
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                        .background(AppDesign.background)
                    }
                }
                .refreshable {
                    await viewModel.loadEvents(
                        forMonthAround: selectedDate,
                        isDemoMode: authViewModel.isDemoMode
                    )
                }
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .task {
                await viewModel.loadEvents(
                    forMonthAround: selectedDate,
                    isDemoMode: authViewModel.isDemoMode
                )
            }
            .onChange(of: selectedDate) { _, newDate in
                Task {
                    await viewModel.loadEventsIfMonthChanged(
                        forMonthAround: newDate,
                        isDemoMode: authViewModel.isDemoMode
                    )
                }
            }
            .sheet(isPresented: $showingBookingForm) {
                BookingFormView(drawerState: drawerState)
                    .environmentObject(authViewModel)
                    .onDisappear {
                        Task {
                            await viewModel.loadEvents(
                                forMonthAround: selectedDate,
                                isDemoMode: authViewModel.isDemoMode
                            )
                        }
                    }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var filteredEvents: [Event] {
        let calendar = Calendar.current
        return viewModel.events.filter { event in
            calendar.isDate(event.start, inSameDayAs: selectedDate)
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
            AppStatusPill(text: statusLabel, soft: true)
        }
        .padding(14)
        .appCard()
        .padding(.vertical, 4)
    }

    private var statusLabel: String {
        switch event.status {
        case .confirmed: return "Confirmed"
        case .pending: return "New"
        case .cancelled: return "Cancelled"
        }
    }
}
