//
//  BookingFormView.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import SwiftUI
import FirebaseFirestore

struct BookingFormView: View {
    @Environment(\.dismiss) var dismiss
    @ObservedObject var firebaseService: FirebaseService
    var drawerState: DrawerState?
    
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var selectedService = ""
    @State private var selectedDate = Date()
    @State private var selectedTimeSlot = ""
    @State private var promoCode = ""
    @State private var notes = ""
    
    @State private var availableTimeSlots: [String] = []
    @State private var isLoadingSlots = false
    @State private var isSubmitting = false
    @State private var showAlert = false
    @State private var alertMessage = ""
    @State private var promoCodeValidated: PromoCode?
    
    var body: some View {
        NavigationView {
            Form {
                Section("Customer Information") {
                    TextField("Full Name", text: $name)
                    TextField("Email", text: $email)
                    TextField("Phone Number", text: $phone)
                }
                
                Section("Service Details") {
                    Picker("Service", selection: $selectedService) {
                        Text("Select a service").tag("")
                        ForEach(firebaseService.services) { service in
                            Text(service.name).tag(service.name)
                        }
                    }
                    
                    DatePicker("Date", selection: $selectedDate, displayedComponents: [.date])
                        .onChange(of: selectedDate) { oldValue, newValue in
                            loadAvailableTimeSlots()
                        }
                    
                    if isLoadingSlots {
                        HStack {
                            ProgressView()
                            Text("Loading available times...")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    } else {
                        Picker("Time Slot", selection: $selectedTimeSlot) {
                            Text("Select a time").tag("")
                            ForEach(availableTimeSlots, id: \.self) { slot in
                                Text(slot).tag(slot)
                            }
                        }
                    }
                }
                
                Section("Promo Code (Optional)") {
                    HStack {
                        TextField("Enter promo code", text: $promoCode)
                        Button("Validate") {
                            validatePromoCode()
                        }
                        .disabled(promoCode.isEmpty)
                    }
                    
                    if let validated = promoCodeValidated {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                            Text("Valid! \(validated.discount, specifier: "%.0f")% off")
                                .font(.caption)
                                .foregroundColor(.green)
                        }
                    }
                }
                
                Section("Additional Notes") {
                    TextField("Any special requests...", text: $notes)
                }
                
                Button(action: submitBooking) {
                    HStack {
                        if isSubmitting {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        }
                        Text(isSubmitting ? "Submitting..." : "Submit Booking")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .disabled(!isFormValid || isSubmitting)
            }
            .navigationTitle("New Booking")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if let drawerState = drawerState {
                        Button(action: {
                            dismiss()
                            drawerState.isOpen = true
                        }) {
                            Image(systemName: "line.3.horizontal")
                        }
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .alert("Booking Status", isPresented: $showAlert) {
                Button("OK") {
                    if alertMessage.lowercased().contains("success") {
                        dismiss()
                    }
                }
            } message: {
                Text(alertMessage)
            }
            .task {
                await firebaseService.fetchServices()
                if !selectedDate.isToday && !selectedDate.isPast {
                    loadAvailableTimeSlots()
                }
            }
        }
        .navigationViewStyle(.stack)
    }
    
    private var isFormValid: Bool {
        !name.isEmpty &&
        !email.isEmpty &&
        !phone.isEmpty &&
        !selectedService.isEmpty &&
        !selectedTimeSlot.isEmpty
    }
    
    private func loadAvailableTimeSlots() {
        isLoadingSlots = true
        availableTimeSlots = []
        selectedTimeSlot = ""
        
        Task {
            do {
                let slots = try await firebaseService.fetchAvailableTimeSlots(for: selectedDate)
                await MainActor.run {
                    availableTimeSlots = slots
                    isLoadingSlots = false
                }
            } catch {
                await MainActor.run {
                    alertMessage = "Failed to load time slots: \(error.localizedDescription)"
                    showAlert = true
                    isLoadingSlots = false
                }
            }
        }
    }
    
    private func validatePromoCode() {
        Task {
            do {
                let code = try await firebaseService.validatePromoCode(promoCode)
                await MainActor.run {
                    promoCodeValidated = code
                    if code == nil {
                        alertMessage = "Invalid or expired promo code"
                        showAlert = true
                    }
                }
            } catch {
                await MainActor.run {
                    alertMessage = "Error validating code: \(error.localizedDescription)"
                    showAlert = true
                }
            }
        }
    }
    
    private func submitBooking() {
        isSubmitting = true
        
        let booking = Booking(
            id: nil,
            name: name,
            email: email,
            phone: phone,
            service: selectedService,
            date: Timestamp(date: selectedDate),
            timeSlot: selectedTimeSlot,
            promoCode: promoCode.isEmpty ? nil : promoCode,
            status: .pending,
            createdAt: Timestamp(date: Date()),
            notes: notes.isEmpty ? nil : notes
        )
        
        Task {
            do {
                let bookingId = try await firebaseService.createBooking(booking)
                await MainActor.run {
                    alertMessage = "Booking submitted successfully! Your booking ID is: \(bookingId)"
                    showAlert = true
                    isSubmitting = false
                }
            } catch {
                await MainActor.run {
                    alertMessage = "Failed to submit booking: \(error.localizedDescription)"
                    showAlert = true
                    isSubmitting = false
                }
            }
        }
    }
}

extension Date {
    var isToday: Bool {
        Calendar.current.isDateInToday(self)
    }
    
    var isPast: Bool {
        self < Date()
    }
}

