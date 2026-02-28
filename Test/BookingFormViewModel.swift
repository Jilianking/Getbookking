//
//  BookingFormViewModel.swift
//
//  Loads tenant data and submits to tenant bookingRequests when available.
//

import Foundation
import Combine
import FirebaseAuth

class BookingFormViewModel: ObservableObject {
    @Published var tenantId: String?
    @Published var tenantServices: [TenantService] = []
    @Published var legacyServices: [Service] = []
    @Published var availableTimeSlots: [String] = []
    @Published var isLoading = false
    @Published var isLoadingSlots = false

    private let firebaseService = FirebaseService()

    var servicesForPicker: [(id: String, name: String, slug: String)] {
        if !tenantServices.isEmpty {
            return tenantServices.filter { $0.isActive }.map { (id: $0.id, name: $0.name, slug: $0.slug) }
        }
        return legacyServices.map { (id: $0.id, name: $0.name, slug: $0.name.lowercased().replacingOccurrences(of: " ", with: "-")) }
    }

    var useTenantData: Bool { tenantId != nil }

    func loadData(isDemoMode: Bool) async {
        guard !isDemoMode, let uid = Auth.auth().currentUser?.uid else {
            await MainActor.run {
                tenantId = nil
                tenantServices = []
                isLoading = false
            }
            await firebaseService.fetchServices()
            await MainActor.run {
                legacyServices = firebaseService.services
                isLoading = false
            }
            return
        }
        await MainActor.run { isLoading = true }
        do {
            let profile = try await firebaseService.fetchProviderProfile(uid: uid)
            if let tid = profile?.tenantId {
                let services = try await firebaseService.fetchTenantServices(tenantId: tid)
                await MainActor.run {
                    tenantId = tid
                    tenantServices = services
                    legacyServices = []
                    isLoading = false
                }
            } else {
                await firebaseService.fetchServices()
                await MainActor.run {
                    tenantId = nil
                    tenantServices = []
                    legacyServices = firebaseService.services
                    isLoading = false
                }
            }
        } catch {
            await firebaseService.fetchServices()
            await MainActor.run {
                tenantId = nil
                tenantServices = []
                legacyServices = firebaseService.services
                isLoading = false
            }
        }
    }

    func loadAvailableTimeSlots(for date: Date) async {
        await MainActor.run { isLoadingSlots = true; availableTimeSlots = [] }
        do {
            let slots = try await firebaseService.fetchAvailableTimeSlots(for: date)
            await MainActor.run {
                availableTimeSlots = slots
                isLoadingSlots = false
            }
        } catch {
            await MainActor.run {
                availableTimeSlots = []
                isLoadingSlots = false
            }
        }
    }

    func submitTenantBooking(
        customerName: String,
        customerEmail: String,
        customerPhone: String?,
        serviceId: String,
        serviceSlug: String,
        serviceName: String,
        preferredTime: String,
        requestedStartTime: Date?,
        notes: String?
    ) async throws -> String {
        guard let tid = tenantId else { throw NSError(domain: "BookingForm", code: -1, userInfo: [NSLocalizedDescriptionKey: "No tenant configured"]) }
        return try await firebaseService.createTenantBookingRequest(
            tenantId: tid,
            customerName: customerName,
            customerEmail: customerEmail,
            customerPhone: customerPhone,
            serviceId: serviceId,
            serviceSlug: serviceSlug,
            serviceName: serviceName,
            preferredTime: preferredTime,
            requestedStartTime: requestedStartTime,
            notes: notes,
            formResponses: nil
        )
    }

    func submitLegacyBooking(_ booking: Booking) async throws -> String {
        try await firebaseService.createBooking(booking)
    }
}
