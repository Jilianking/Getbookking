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
                Text("Manage your appointments and schedule")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.bottom, 12)

                // New Booking button
                Button(action: { showingBookingForm = true }) {
                    HStack {
                        Image(systemName: "plus")
                        Text("New Booking")
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.black)
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
                .padding(.horizontal)
                .padding(.bottom, 16)

                // View mode: Month | Week | Day
                HStack {
                    Text("View:")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    ForEach(CalendarViewMode.allCases, id: \.self) { mode in
                        Button(action: { viewMode = mode }) {
                            Text(mode.rawValue)
                                .font(.subheadline.weight(.medium))
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(viewMode == mode ? Color.black : Color.gray.opacity(0.15))
                                .foregroundColor(viewMode == mode ? .white : .primary)
                                .cornerRadius(8)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal)
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
                    List(filteredEvents) { event in
                        EventRow(event: event)
                    }
                    .listStyle(.plain)
                }
                .refreshable {
                    await viewModel.loadEvents(isDemoMode: authViewModel.isDemoMode)
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
            .task {
                await viewModel.loadEvents(isDemoMode: authViewModel.isDemoMode)
            }
            .sheet(isPresented: $showingBookingForm) {
                BookingFormView(drawerState: drawerState)
                    .environmentObject(authViewModel)
                    .onDisappear { Task { await viewModel.loadEvents(isDemoMode: authViewModel.isDemoMode) } }
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
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(event.title)
                    .font(.system(size: 18, weight: .semibold))

                Spacer()

                Text(event.start, style: .time)
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
            }

            Text(event.clientName)
                .font(.system(size: 14))
                .foregroundColor(.secondary)

            Text(event.type.rawValue.capitalized)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(typeColor)
                .cornerRadius(6)
        }
        .padding(.vertical, 4)
    }

    var typeColor: Color {
        switch event.type {
        case .appointment: return .blue
        case .consultation: return .green
        case .touchup: return .orange
        case .flash: return .purple
        }
    }
}
