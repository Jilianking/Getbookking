import SwiftUI

struct CalendarView: View {
    @StateObject private var viewModel = CalendarViewModel()
    @State private var selectedDate = Date()
    
    var body: some View {
        NavigationView {
            VStack {
                // Calendar Picker
                DatePicker("Select Date", selection: $selectedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                
                // Events for selected date
                List(filteredEvents) { event in
                    EventRow(event: event)
                }
                .refreshable {
                    await viewModel.loadEvents()
                }
            }
            .navigationTitle("Calendar")
            .task {
                await viewModel.loadEvents()
            }
        }
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

