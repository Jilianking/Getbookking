import Foundation
import Combine
import FirebaseAuth

class DashboardViewModel: ObservableObject {
    @Published var pendingRequestsCount = 0
    @Published var upcomingBookingsCount = 0
    @Published var totalClientsCount = 0
    @Published var monthlyRevenue: Double = 0
    @Published var recentRequests: [Request] = []
    @Published var recentBookingRequests: [BookingRequest] = []
    @Published var useTenantData = false
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadData(isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run {
                pendingRequestsCount = 0
                upcomingBookingsCount = 0
                totalClientsCount = 0
                monthlyRevenue = 0
                recentRequests = []
                recentBookingRequests = []
                useTenantData = false
                isLoading = false
            }
            return
        }
        
        do {
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            
            if let tid = profile?.tenantId {
                let bookingReqs = try await firebaseService.fetchTenantBookingRequests(tenantId: tid)
                let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
                let pending = bookingReqs.filter { $0.status == "NEW" }
                let upcoming = bookingReqs.filter { $0.status == "confirmed" }
                await MainActor.run {
                    useTenantData = true
                    pendingRequestsCount = pending.count
                    upcomingBookingsCount = upcoming.count
                    totalClientsCount = customers.count
                    monthlyRevenue = 0
                    recentBookingRequests = Array(bookingReqs.prefix(10))
                    recentRequests = []
                    isLoading = false
                }
            } else {
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
                    useTenantData = false
                    pendingRequestsCount = pending.count
                    upcomingBookingsCount = upcoming.count
                    totalClientsCount = clients.count
                    monthlyRevenue = revenue
                    recentRequests = Array(requests.prefix(10))
                    recentBookingRequests = []
                    isLoading = false
                }
            }
        } catch {
            await MainActor.run { isLoading = false }
            print("Error loading dashboard data: \(error)")
        }
    }
    
    func refresh(isDemoMode: Bool = false) async {
        await loadData(isDemoMode: isDemoMode)
    }
}

