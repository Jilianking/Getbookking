import Foundation
import Combine

class CalendarViewModel: ObservableObject {
    @Published var events: [Event] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadEvents(isDemoMode: Bool = false) async {
        await MainActor.run {
            isLoading = true
        }
        
        if isDemoMode {
            await MainActor.run {
                events = []
                isLoading = false
            }
            return
        }
        
        let calendar = Calendar.current
        let now = Date()
        let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
        let endOfMonth = calendar.date(byAdding: .month, value: 1, to: startOfMonth)!
        
        do {
            let fetchedEvents = try await firebaseService.fetchEvents(
                startDate: startOfMonth,
                endDate: endOfMonth
            )
            
            await MainActor.run {
                events = fetchedEvents
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
            print("Error loading events: \(error)")
        }
    }
    
    func createEvent(_ event: Event) async {
        do {
            _ = try await firebaseService.createEvent(event)
            await loadEvents()
        } catch {
            print("Error creating event: \(error)")
        }
    }
}

