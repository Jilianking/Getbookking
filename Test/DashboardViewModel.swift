import Foundation
import Combine
import FirebaseAuth

class DashboardViewModel: ObservableObject {
    @Published var pendingRequestsCount = 0
    @Published var unreadRequestsCount = 0
    @Published var upcomingBookingsCount = 0
    @Published var confirmedThisMonthCount = 0
    @Published var totalClientsCount = 0
    @Published var monthlyRevenue: Double = 0
    @Published var businessDisplayName: String = ""
    @Published var tenantIndustry: String = BookingTemplate.custom.rawValue
    @Published var recentRequests: [Request] = []
    @Published var recentBookingRequests: [BookingRequest] = []
    @Published var useTenantData = false
    @Published var isLoading = false
    
    private let firebaseService = FirebaseService()
    
    func loadData(sessionStore: TenantSessionStore, isDemoMode: Bool = false) async {
        await MainActor.run { isLoading = true }
        
        if isDemoMode {
            await MainActor.run {
                pendingRequestsCount = 0
                unreadRequestsCount = 0
                upcomingBookingsCount = 0
                confirmedThisMonthCount = 0
                totalClientsCount = 0
                monthlyRevenue = 0
                businessDisplayName = ""
                tenantIndustry = BookingTemplate.custom.rawValue
                recentRequests = []
                recentBookingRequests = []
                useTenantData = false
                isLoading = false
            }
            return
        }
        
        do {
            guard Auth.auth().currentUser?.uid != nil else {
                await MainActor.run { isLoading = false }
                return
            }
            await sessionStore.ensureSessionLoaded(isDemoMode: false)
            async let dashboardBookings: () = sessionStore.loadDashboardBookingsIfNeeded(isDemoMode: false)
            async let newBookings: () = sessionStore.loadNewBookingsIfNeeded(isDemoMode: false)
            async let customerTotal = sessionStore.customerCount(isDemoMode: false)
            _ = await (dashboardBookings, newBookings)
            let clientsCount = await customerTotal
            
            if sessionStore.tenantId != nil {
                let bookingReqs = sessionStore.bookingRequests
                let upcoming = bookingReqs.filter { $0.status.lowercased() == "confirmed" }
                let monthStart = Calendar.current.date(
                    from: Calendar.current.dateComponents([.year, .month], from: Date())
                ) ?? Date()
                let confirmedMonth = bookingReqs.filter { req in
                    guard req.status.lowercased() == "confirmed" else { return false }
                    guard let created = req.createdAt else { return false }
                    return created >= monthStart
                }
                await MainActor.run {
                    useTenantData = true
                    pendingRequestsCount = sessionStore.pendingRequestsCount
                    unreadRequestsCount = sessionStore.unreadRequestsCount
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = confirmedMonth.count
                    totalClientsCount = clientsCount
                    monthlyRevenue = 0
                    businessDisplayName = sessionStore.businessDisplayName
                    tenantIndustry = sessionStore.tenantIndustry
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
                    unreadRequestsCount = pending.filter { $0.reviewedAt == nil }.count
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = upcoming.count
                    totalClientsCount = clients.count
                    monthlyRevenue = revenue
                    businessDisplayName = sessionStore.businessDisplayName
                    tenantIndustry = sessionStore.tenantIndustry
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
    
    func refresh(sessionStore: TenantSessionStore, isDemoMode: Bool = false) async {
        sessionStore.invalidateBookings()
        await loadData(sessionStore: sessionStore, isDemoMode: isDemoMode)
    }
}
