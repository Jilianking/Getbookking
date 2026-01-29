import Foundation
import Combine

class DashboardViewModel: ObservableObject {
    @Published var pendingRequestsCount = 0
    @Published var upcomingBookingsCount = 0
    @Published var totalClientsCount = 0
    @Published var monthlyRevenue: Double = 0
    @Published var recentRequests: [Request] = []
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadData() async {
        await MainActor.run {
            isLoading = true
        }
        
        do {
            let requests = try await firebaseService.fetchRequests()
            let clients = try await firebaseService.fetchClients()
            
            let pending = requests.filter { $0.status == .pending }
            let upcoming = requests.filter { 
                if let date = $0.appointmentDate {
                    return date >= Date() && $0.status == .confirmed
                }
                return false
            }
            
            let calendar = Calendar.current
            let now = Date()
            let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
            let monthlyRequests = requests.filter {
                if let date = $0.completedAt {
                    return date >= startOfMonth && $0.status == .completed
                }
                return false
            }
            
            let revenue = monthlyRequests.reduce(0.0) { total, request in
                total + (request.price ?? 0) + (request.cashTips ?? 0)
            }
            
            await MainActor.run {
                pendingRequestsCount = pending.count
                upcomingBookingsCount = upcoming.count
                totalClientsCount = clients.count
                monthlyRevenue = revenue
                recentRequests = Array(requests.prefix(10))
                isLoading = false
            }
        } catch {
            await MainActor.run {
                isLoading = false
            }
            print("Error loading dashboard data: \(error)")
        }
    }
    
    func refresh() async {
        await loadData()
    }
}

