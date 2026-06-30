//
//  BookingFormView.swift
//
//  New booking form. Submits to tenant bookingRequests when tenant exists.
//

import SwiftUI
import FirebaseFirestore

struct BookingFormView: View {
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = BookingFormViewModel()
    var drawerState: DrawerState?
    var prefillName: String? = nil
    var prefillEmail: String? = nil
    var prefillPhone: String? = nil
    /// Opened from Clients — staff is scheduling on the client's behalf (not public web booking).
    var staffSchedulingForClient: Bool = false
    
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var selectedServiceName = ""
    @State private var selectedDate = Date()
    @State private var selectedTimeSlot = ""
    @State private var promoCode = ""
    @State private var notes = ""
    
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
                    TextField("(555) 123-4567", text: Binding(
                        get: { phone },
                        set: { phone = PhoneFormatting.formatAsYouType($0) }
                    ))
                    .keyboardType(.phonePad)
                }
                
                Section("Service Details") {
                    Picker("Service", selection: $selectedServiceName) {
                        Text("Select a service").tag("")
                        ForEach(viewModel.servicesForPicker, id: \.name) { svc in
                            Text(svc.name).tag(svc.name)
                        }
                    }
                    .disabled(viewModel.isLoading)
                    
                    DatePicker("Date", selection: $selectedDate, displayedComponents: [.date])
                        .onChange(of: selectedDate) { _, _ in
                            Task { await viewModel.loadAvailableTimeSlots(for: selectedDate) }
                        }
                    
                    if viewModel.isLoadingSlots {
                        HStack {
                            ProgressView()
                            Text("Loading available times...")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    } else {
                        Picker("Time Slot", selection: $selectedTimeSlot) {
                            Text("Select a time").tag("")
                            ForEach(viewModel.availableTimeSlots, id: \.self) { slot in
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
                
                Section {
                    Button(action: submitBooking) {
                        if isSubmitting {
                            HStack {
                                Spacer()
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                Spacer()
                            }
                        } else {
                            Text(staffSchedulingForClient ? "Confirm appointment" : "Submit Booking")
                        }
                    }
                    .buttonStyle(AppPrimaryButtonStyle(enabled: isFormValid && !isSubmitting))
                    .disabled(!isFormValid || isSubmitting)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 16, trailing: 16))
                    .listRowBackground(Color.clear)
                }
            }
            .appListSurface()
            .appScreenBackground()
            .navigationTitle(staffSchedulingForClient ? "Schedule appointment" : "New Booking")
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
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                if name.isEmpty, let prefillName, !prefillName.isEmpty { name = prefillName }
                if email.isEmpty, let prefillEmail, !prefillEmail.isEmpty { email = prefillEmail }
                if phone.isEmpty, let prefillPhone, !prefillPhone.isEmpty {
                    phone = PhoneFormatting.displayUS(prefillPhone)
                }
                if !selectedDate.isToday && !selectedDate.isPast {
                    await viewModel.loadAvailableTimeSlots(for: selectedDate)
                }
            }
        }
        .navigationViewStyle(.stack)
    }
    
    private var isFormValid: Bool {
        !name.isEmpty &&
        !email.isEmpty &&
        !phone.isEmpty &&
        !selectedServiceName.isEmpty &&
        !selectedTimeSlot.isEmpty
    }
    
    private var selectedServiceInfo: (id: String, name: String, slug: String)? {
        viewModel.servicesForPicker.first { $0.name == selectedServiceName }
    }
    
    private func validatePromoCode() {
        Task {
            do {
                let svc = FirebaseService()
                let code = try await svc.validatePromoCode(promoCode)
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
        
        Task {
            do {
                if viewModel.useTenantData, let svc = selectedServiceInfo {
                    let requestedStart = parseTimeSlot(selectedTimeSlot, on: selectedDate)
                    _ = try await viewModel.submitTenantBooking(
                        customerName: name,
                        customerEmail: email,
                        customerPhone: PhoneFormatting.normalizedForStorage(phone),
                        serviceId: svc.id,
                        serviceSlug: svc.slug,
                        serviceName: svc.name,
                        preferredTime: selectedTimeSlot,
                        requestedStartTime: requestedStart,
                        notes: notes.isEmpty ? nil : notes
                    )
                    await MainActor.run {
                        alertMessage = "Booking request submitted! It will appear in Booking Requests."
                        showAlert = true
                        isSubmitting = false
                    }
                } else {
                    let booking = Booking(
                        id: nil,
                        name: name,
                        email: email,
                        phone: phone,
                        service: selectedServiceName,
                        date: Timestamp(date: selectedDate),
                        timeSlot: selectedTimeSlot,
                        promoCode: promoCode.isEmpty ? nil : promoCode,
                        status: .pending,
                        createdAt: Timestamp(date: Date()),
                        notes: notes.isEmpty ? nil : notes
                    )
                    let bookingId = try await viewModel.submitLegacyBooking(booking)
                    await MainActor.run {
                        alertMessage = "Booking submitted successfully! Your booking ID is: \(bookingId)"
                        showAlert = true
                        isSubmitting = false
                    }
                }
            } catch {
                await MainActor.run {
                    alertMessage = "Failed to submit: \(error.localizedDescription)"
                    showAlert = true
                    isSubmitting = false
                }
            }
        }
    }
    
    private func parseTimeSlot(_ slot: String, on date: Date) -> Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        formatter.defaultDate = date
        return formatter.date(from: slot)
    }
}

private extension Date {
    var isToday: Bool {
        Calendar.current.isDateInToday(self)
    }
    
    var isPast: Bool {
        self < Date()
    }
}
