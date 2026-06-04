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
    
    func loadData(isDemoMode: Bool = false) async {
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
            guard let uid = Auth.auth().currentUser?.uid else {
                await MainActor.run { isLoading = false }
                return
            }
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            
            if let tid = profile?.tenantId {
                let bookingReqs = try await firebaseService.fetchTenantBookingRequests(tenantId: tid)
                let customers = try await firebaseService.fetchTenantCustomers(tenantId: tid)
                var industry = profile?.industry ?? BookingTemplate.custom.rawValue
                if let tenant = try? await firebaseService.fetchTenant(tenantId: tid) {
                    industry = (tenant["industry"] as? String) ?? industry
                }
                let pending = bookingReqs.filter { ($0.status).uppercased() == "NEW" }
                let unread = bookingReqs.filter {
                    $0.status.uppercased() == "NEW" && $0.readAt == nil
                }
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
                    pendingRequestsCount = pending.count
                    unreadRequestsCount = unread.count
                    upcomingBookingsCount = upcoming.count
                    confirmedThisMonthCount = confirmedMonth.count
                    totalClientsCount = customers.count
                    monthlyRevenue = 0
                    businessDisplayName = profile?.business ?? ""
                    tenantIndustry = industry
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
                    businessDisplayName = profile?.business ?? ""
                    tenantIndustry = profile?.industry ?? BookingTemplate.custom.rawValue
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

