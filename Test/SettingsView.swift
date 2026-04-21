//
//  SettingsView.swift
//
//  Generic settings: account, business info, app info.
//

import SwiftUI
import PhotosUI
import UIKit
import FirebaseAuth

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = SettingsViewModel()
    @State private var showingLogoutAlert = false
    @State private var showEnterModeAlert = false
    @State private var previousIndustryForCancel: String = ""
    /// When true, ignores `onChange` so reverting the picker after Cancel doesn’t reopen the alert.
    @State private var isRestoringIndustry = false
    @State private var hasLoadedServiceOnce = false
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("Account")) {
                    if authViewModel.isDemoMode {
                        HStack {
                            Image(systemName: "person.crop.circle")
                            Text("Demo mode")
                                .foregroundColor(.secondary)
                        }
                    } else if let email = authViewModel.currentUserEmail {
                        NavigationLink {
                            AccountSettingsDetailView(viewModel: viewModel)
                                .environmentObject(authViewModel)
                        } label: {
                            HStack {
                                Image(systemName: "person.crop.circle")
                                    .font(.title3)
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(
                                        viewModel.accountDisplayName.isEmpty
                                            ? (authViewModel.currentUserDisplayName ?? "Account")
                                            : viewModel.accountDisplayName
                                    )
                                    .font(.subheadline.weight(.medium))
                                    Text(email)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    } else {
                        HStack {
                            Image(systemName: "person.crop.circle")
                            Text("Account")
                        }
                    }
                    Button(action: { showingLogoutAlert = true }) {
                        HStack {
                            Image(systemName: "arrow.right.square")
                            Text("Logout")
                                .foregroundColor(.red)
                        }
                    }
                }

                if !authViewModel.isDemoMode && viewModel.hasProfile && viewModel.isTenantOwner
                    && viewModel.tenantSubscriptionPlan.allowsTeamInvites
                {
                    Section(
                        header: Text("Team invites"),
                        footer: Text("Creates a single-use link (expires in 7 days). Anyone with the link can sign up or sign in once to join as staff.")
                            .font(.caption2)
                    ) {
                        Button(action: {
                            Task { await viewModel.createTeamInviteLink() }
                        }) {
                            HStack {
                                Text("Create team invite link")
                                if viewModel.isCreatingTeamInvite {
                                    Spacer()
                                    ProgressView()
                                        .scaleEffect(0.9)
                                }
                            }
                        }
                        .disabled(viewModel.isCreatingTeamInvite)
                        if let err = viewModel.teamInviteError {
                            Text(err)
                                .font(.caption)
                                .foregroundColor(.red)
                        }
                        if let url = viewModel.teamInviteShareURL {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Invite link ready")
                                    .font(.subheadline.weight(.semibold))
                                Link(destination: url) {
                                    Text(url.absoluteString)
                                        .font(.caption)
                                        .foregroundColor(.accentColor)
                                        .multilineTextAlignment(.leading)
                                        .lineLimit(4)
                                        .truncationMode(.middle)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                Button(action: {
                                    UIPasteboard.general.string = url.absoluteString
                                }) {
                                    Label("Copy link", systemImage: "doc.on.doc")
                                        .font(.subheadline.weight(.medium))
                                }
                                ShareLink(item: url, subject: Text("Join our team"), message: Text("Open this link to join on GetBookKing.")) {
                                    Label("Share link", systemImage: "square.and.arrow.up")
                                        .font(.body.weight(.medium))
                                }
                                .buttonStyle(.borderedProminent)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                if !authViewModel.isDemoMode && viewModel.hasProfile && viewModel.isTenantOwner
                    && !viewModel.tenantSubscriptionPlan.allowsTeamInvites
                {
                    Section(header: Text("Team invites")) {
                        Text("Solo is owner only. Upgrade to Studio or Shop to invite team members.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if !authViewModel.isDemoMode && viewModel.hasProfile && viewModel.isTenantOwner {
                    Section(
                        header: Text("Owner settings"),
                        footer: Text("Business type controls your booking form, default services, and how template copy is auto-filled. Changing it asks for confirmation because your current services are replaced. Template choice lives in Website Design.")
                            .font(.caption2)
                    ) {
                        Picker("Business type", selection: $viewModel.selectedIndustry) {
                            ForEach(BookingTemplate.allCases) { template in
                                Text(template.displayName).tag(template.rawValue)
                            }
                        }
                        .onChange(of: viewModel.selectedIndustry) { oldValue, newValue in
                            guard hasLoadedServiceOnce else { return }
                            if isRestoringIndustry {
                                isRestoringIndustry = false
                                return
                            }
                            previousIndustryForCancel = oldValue
                            showEnterModeAlert = true
                        }
                        Button(action: {
                            Task { await viewModel.applyTemplateAndSave() }
                        }) {
                            HStack {
                                Text("Save and apply to website")
                                if viewModel.isSavingService {
                                    Spacer()
                                    ProgressView()
                                        .scaleEffect(0.9)
                                }
                            }
                        }
                        .disabled(viewModel.isSavingService)
                        if viewModel.saveSuccess {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Saved — booking form and services applied")
                                    .foregroundColor(.green)
                            }
                        }
                    }
                }

                if !authViewModel.isDemoMode && viewModel.hasProfile {
                    Section(header: Text("Scheduling & Availability")) {
                        Picker("Booking confirmation", selection: $viewModel.confirmationType) {
                            ForEach(BookingConfirmationType.allCases, id: \.self) { type in
                                Text(type.displayName).tag(type)
                            }
                        }
                        if viewModel.confirmationType.requiresApproval {
                            Stepper("Response time: \(viewModel.responseTimeHours) hours", value: $viewModel.responseTimeHours, in: 1...168, step: 1)
                        }
                        if viewModel.confirmationType.requiresDeposit {
                            HStack {
                                Text("Deposit amount")
                                TextField("0", value: Binding(
                                    get: { viewModel.depositAmount ?? 0 },
                                    set: { viewModel.depositAmount = $0 > 0 ? $0 : nil }
                                ), format: .number)
                                    .keyboardType(.decimalPad)
                                    .multilineTextAlignment(.trailing)
                                    .frame(width: 80)
                                Text("USD")
                                    .foregroundColor(.secondary)
                            }
                        }
                        TextField("Time zone", text: $viewModel.timeZoneId)
                            .textFieldStyle(.roundedBorder)
                            .autocapitalization(.none)
                        Button("Save") {
                            Task {
                                await viewModel.saveWorkflow()
                                await viewModel.saveAvailability()
                            }
                        }
                        .disabled(viewModel.isLoading)
                        if viewModel.saveSuccess {
                            HStack {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                                Text("Saved")
                                    .foregroundColor(.green)
                            }
                        }
                    }
                }

                if let msg = viewModel.errorMessage {
                    Section {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }

                Section(header: Text("App")) {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0.0")
                            .foregroundColor(.secondary)
                    }
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
            .alert("Logout", isPresented: $showingLogoutAlert) {
                Button("Cancel", role: .cancel) { }
                Button("Logout", role: .destructive) {
                    authViewModel.logout()
                }
            } message: {
                Text("Are you sure you want to logout?")
            }
            .alert(businessTypeChangeAlertTitle, isPresented: $showEnterModeAlert) {
                Button("Cancel", role: .cancel) {
                    isRestoringIndustry = true
                    viewModel.selectedIndustry = previousIndustryForCancel
                }
                Button("Continue") {
                    Task { await viewModel.applyTemplateAndSave() }
                }
            } message: {
                Text(businessTypeChangeAlertMessage)
            }
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
                hasLoadedServiceOnce = true
            }
            .refreshable {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
        }
        .navigationViewStyle(.stack)
    }

    private var businessTypeChangeAlertTitle: String {
        let name = BookingTemplate(rawValue: viewModel.selectedIndustry)?.displayName ?? "this type"
        return "Switch to \(name)?"
    }

    private var businessTypeChangeAlertMessage: String {
        guard let template = BookingTemplate(rawValue: viewModel.selectedIndustry) else {
            return "Your booking form and services will update to match this business type. Website templates in Website Design follow the business type you set here."
        }
        switch template {
        case .custom:
            return """
            You're entering Custom mode.

            • Booking form switches to a generic field set (editable in Website Design).
            • Your current services are removed. Custom starts with no default services—add them under Book in Website Design.
            • In Website Design, only templates for Custom are available under Website templates.

            You can customize everything after saving.
            """
        default:
            let label = template.displayName
            return """
            You're entering \(label) mode.

            • Booking form switches to fields for this industry (editable afterward).
            • Your current services are removed and replaced with starter services for \(label).
            • Website Design → Website templates only shows options that match this business type.

            Tap Continue to apply, or Cancel to keep your previous type.
            """
        }
    }
}

// MARK: - Account detail (name, plan, profile photo)
private struct AccountSettingsDetailView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @ObservedObject var viewModel: SettingsViewModel
    @State private var profilePhotoPickerItem: PhotosPickerItem?
    @State private var profilePhotoCropItem: SingleImageCropSheetItem?

    var body: some View {
        List {
            if authViewModel.isDemoMode {
                Section {
                    Text("Account details aren’t available in demo mode.")
                        .foregroundStyle(.secondary)
                }
            } else {
                if let email = authViewModel.currentUserEmail {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Signed in as")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(email)
                                .font(.body)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if viewModel.hasProfile, viewModel.tenantId != nil {
                    Section(
                        footer: Text("Used for your account profile. Website logo is managed in Web Page Design. \(UploadImageAdvice.profile)")
                            .font(.caption2)
                    ) {
                        HStack(alignment: .center, spacing: 12) {
                            PhotosPicker(
                                selection: $profilePhotoPickerItem,
                                matching: .images,
                                photoLibrary: .shared()
                            ) {
                                ZStack(alignment: .bottomTrailing) {
                                    Group {
                                        if viewModel.profilePhotoUrl.isEmpty {
                                            Circle()
                                                .fill(Color(.secondarySystemGroupedBackground))
                                                .overlay(
                                                    Image(systemName: "person.fill")
                                                        .font(.system(size: 22))
                                                        .foregroundColor(.secondary)
                                                )
                                        } else if let url = URL(string: viewModel.profilePhotoUrl) {
                                            AsyncImage(url: url) { phase in
                                                switch phase {
                                                case .success(let image):
                                                    image
                                                        .resizable()
                                                        .scaledToFill()
                                                case .failure:
                                                    Image(systemName: "exclamationmark.triangle")
                                                        .font(.caption)
                                                        .foregroundColor(.secondary)
                                                default:
                                                    Color(.secondarySystemGroupedBackground)
                                                        .overlay(ProgressView().scaleEffect(0.7))
                                                }
                                            }
                                        } else {
                                            Circle()
                                                .fill(Color(.secondarySystemGroupedBackground))
                                        }
                                    }
                                    .frame(width: 52, height: 52)
                                    .clipShape(Circle())
                                    .overlay(
                                        Circle()
                                            .strokeBorder(Color(.separator), lineWidth: 0.5)
                                    )

                                    Image(systemName: "camera.circle.fill")
                                        .symbolRenderingMode(.multicolor)
                                        .font(.system(size: 20))
                                        .background(
                                            Circle()
                                                .fill(Color(.systemBackground))
                                                .frame(width: 16, height: 16)
                                        )
                                        .offset(x: 1, y: 1)
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(viewModel.isUploadingLogo)

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Tap photo to change")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                if viewModel.isUploadingLogo {
                                    ProgressView()
                                        .scaleEffect(0.85)
                                }
                                if !viewModel.profilePhotoUrl.isEmpty {
                                    Button(role: .destructive) {
                                        Task {
                                            await viewModel.removeProfilePhoto()
                                            await MainActor.run {
                                                authViewModel.accountPhotoUrl = nil
                                            }
                                        }
                                    } label: {
                                        Text("Remove")
                                            .font(.caption.weight(.medium))
                                    }
                                    .disabled(viewModel.isUploadingLogo)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 2)
                    }
                }
                if viewModel.hasProfile {
                    Section(header: Text("Name")) {
                        TextField("Full name", text: $viewModel.accountFullNameDraft)
                            .textContentType(.name)
                            .submitLabel(.done)
                            .disabled(viewModel.isSavingAccountName)
                            .onSubmit {
                                let trimmed = viewModel.accountFullNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                                let current = viewModel.accountDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty, trimmed != current else { return }
                                Task {
                                    await viewModel.saveAccountFullName()
                                    if let name = Auth.auth().currentUser?.displayName {
                                        await MainActor.run {
                                            authViewModel.currentUserDisplayName = name
                                        }
                                    }
                                }
                            }
                        if viewModel.isSavingAccountName {
                            HStack {
                                ProgressView()
                                    .scaleEffect(0.85)
                                Text("Saving…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if viewModel.hasProfile, viewModel.tenantId != nil {
                    Section(header: Text("Plan")) {
                        HStack {
                            Text("Current plan")
                            Spacer()
                            Text(viewModel.tenantSubscriptionPlan.displayName)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if authViewModel.currentUserEmail != nil && !viewModel.hasProfile {
                    Section {
                        Text("Your business profile is still loading. Pull to refresh on Settings, or try again in a moment.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: profilePhotoPickerItem) { _, newItem in
            Task {
                guard let newItem else { return }
                guard let data = try? await newItem.loadTransferable(type: Data.self), !data.isEmpty,
                      let uiImage = UIImage(data: data) else {
                    await MainActor.run { profilePhotoPickerItem = nil }
                    return
                }
                await MainActor.run {
                    profilePhotoCropItem = SingleImageCropSheetItem(image: uiImage)
                    profilePhotoPickerItem = nil
                }
            }
        }
        .sheet(item: $profilePhotoCropItem, onDismiss: { profilePhotoCropItem = nil }) { item in
            UploadImagePreparationSheet(
                images: [item.image],
                advice: UploadImageAdvice.profile,
                navigationTitle: "Profile photo",
                allowedChoices: UploadCropPresetMenu.profile,
                defaultChoice: .square,
                onUseJPEGData: { dataList in
                    profilePhotoCropItem = nil
                    guard let data = dataList.first else { return }
                    Task {
                        await viewModel.uploadProfilePhoto(imageData: data)
                        await MainActor.run {
                            let trimmed = viewModel.profilePhotoUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                            authViewModel.accountPhotoUrl = trimmed.isEmpty ? nil : trimmed
                        }
                    }
                }
            )
        }
    }
}

// MARK: - Days open calendar sheet
struct DaysOpenCalendarSheet: View {
    @ObservedObject var viewModel: SettingsViewModel
    @State private var displayDate = Date()
    @State private var editingSlot: TimeSlot?
    @Environment(\.dismiss) var dismiss

    private var monthYearText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        return formatter.string(from: displayDate)
    }

    private var calendarDays: [Date?] {
        let cal = Calendar.current
        guard let range = cal.range(of: .day, in: .month, for: displayDate),
              let first = cal.date(from: cal.dateComponents([.year, .month], from: displayDate)) else { return [] }
        let weekday = cal.component(.weekday, from: first) - 1 // 0=Sun
        let count = range.count
        var out: [Date?] = Array(repeating: nil, count: weekday)
        for day in 1...count {
            if let d = cal.date(byAdding: .day, value: day - 1, to: first) {
                out.append(d)
            }
        }
        while out.count % 7 != 0 { out.append(nil) }
        return out
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    Text(viewModel.confirmationType.usesFixedSlots ? "Fixed time slots" : "Open booking")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                    HStack {
                        Button(action: previousMonth) {
                            Image(systemName: "chevron.left")
                                .font(.body.weight(.semibold))
                        }
                        Text(monthYearText)
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                        Button(action: nextMonth) {
                            Image(systemName: "chevron.right")
                                .font(.body.weight(.semibold))
                        }
                    }
                    .padding(.horizontal, 24)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
                        ForEach(Array(calendarDays.enumerated()), id: \.offset) { _, dateOpt in
                            if let date = dateOpt {
                                CalendarDateCell(
                                    date: date,
                                    isBlocked: !viewModel.confirmationType.usesFixedSlots && viewModel.isDateBlocked(date),
                                    isAvailable: viewModel.confirmationType.usesFixedSlots && viewModel.isDateAvailable(date),
                                    isToday: Calendar.current.isDateInToday(date)
                                ) {
                                    if viewModel.confirmationType.usesFixedSlots {
                                        viewModel.toggleAvailableDate(date)
                                    } else {
                                        viewModel.toggleBlockedDate(date)
                                    }
                                }
                            } else {
                                Color.clear
                                    .frame(height: 40)
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Slots available")
                            .font(.subheadline.weight(.medium))
                        ForEach(Array(viewModel.timeSlots.enumerated()), id: \.element.id) { index, slot in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 12) {
                                    Button(action: { editingSlot = slot }) {
                                        HStack {
                                            Text("\(viewModel.formatHour(slot.open)) – \(viewModel.formatHour(slot.close))")
                                                .font(.subheadline.weight(.medium))
                                                .foregroundColor(.primary)
                                            Image(systemName: "chevron.right")
                                                .font(.caption2.weight(.semibold))
                                                .foregroundColor(.secondary)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(12)
                                        .background(viewModel.hasInvalidSlot(slot) ? Color.red.opacity(0.1) : Color.gray.opacity(0.06))
                                        .cornerRadius(10)
                                    }
                                    .buttonStyle(.plain)
                                    Picker("", selection: Binding(
                                        get: { slot.type },
                                        set: { viewModel.updateTimeSlot(id: slot.id, type: $0) }
                                    )) {
                                        ForEach(SlotType.allCases, id: \.self) { type in
                                            Text(type.displayName).tag(type)
                                        }
                                    }
                                    .pickerStyle(.menu)
                                    .labelsHidden()
                                    .frame(minWidth: 130)
                                    if viewModel.timeSlots.count > 1 {
                                        Button(action: { viewModel.removeTimeSlot(at: index) }) {
                                            Image(systemName: "trash")
                                                .font(.body)
                                                .foregroundColor(.red)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                if slot.type == .custom {
                                    TextField("Custom label", text: Binding(
                                        get: { slot.customLabel ?? "" },
                                        set: { viewModel.setSlotCustomLabel(id: slot.id, $0) }
                                    ))
                                    .textFieldStyle(.roundedBorder)
                                    .font(.subheadline)
                                }
                                if slot.type == .recurring {
                                    recurringDaysRow(slot: slot)
                                }
                                if viewModel.hasInvalidSlot(slot) {
                                    Text("End must be after start")
                                        .font(.caption)
                                        .foregroundColor(.red)
                                }
                            }
                        }
                        Button(action: { viewModel.addTimeSlot() }) {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                Text("Add time slot")
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(12)
                    .padding(.horizontal, 24)
                }
            }
            .navigationTitle("Scheduling")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .onAppear {
            displayDate = Date()
        }
        .sheet(item: $editingSlot) { slot in
            TimeSlotEditSheet(slot: slot, viewModel: viewModel) {
                editingSlot = nil
            }
        }
    }

    private func previousMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: -1, to: displayDate) {
            displayDate = d
        }
    }

    private func nextMonth() {
        if let d = Calendar.current.date(byAdding: .month, value: 1, to: displayDate) {
            displayDate = d
        }
    }

    private func formatHour(_ hour: Int) -> String {
        if hour == 0 { return "12 AM" }
        if hour == 12 { return "12 PM" }
        if hour < 12 { return "\(hour) AM" }
        return "\(hour - 12) PM"
    }

    @ViewBuilder
    private func recurringDaysRow(slot: TimeSlot) -> some View {
        let days = viewModel.dayLabels
        Text("Repeat on")
            .font(.caption)
            .foregroundColor(.secondary)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 8) {
            ForEach(days, id: \.0) { day, label in
                Button(action: { viewModel.toggleRecurringDay(slotId: slot.id, day: day) }) {
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background((slot.recurringDays ?? []).contains(day) ? Color.black : Color.gray.opacity(0.15))
                        .foregroundColor((slot.recurringDays ?? []).contains(day) ? .white : .primary)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Time slot edit sheet
struct TimeSlotEditSheet: View {
    let slot: TimeSlot
    @ObservedObject var viewModel: SettingsViewModel
    let onDismiss: () -> Void

    @State private var openHour: Int
    @State private var closeHour: Int

    init(slot: TimeSlot, viewModel: SettingsViewModel, onDismiss: @escaping () -> Void) {
        self.slot = slot
        self.viewModel = viewModel
        self.onDismiss = onDismiss
        _openHour = State(initialValue: slot.open)
        _closeHour = State(initialValue: slot.close)
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("From")) {
                    Picker("From", selection: $openHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                Section(header: Text("To")) {
                    Picker("To", selection: $closeHour) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(viewModel.formatHour(hour)).tag(hour)
                        }
                    }
                    .pickerStyle(.wheel)
                }
                if closeHour <= openHour {
                    Section {
                        Text("End must be after start")
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Edit time slot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        viewModel.updateTimeSlot(id: slot.id, open: openHour, close: closeHour)
                        onDismiss()
                    }
                    .disabled(closeHour <= openHour)
                }
            }
        }
    }
}

struct CalendarDateCell: View {
    let date: Date
    let isBlocked: Bool   // Approval mode: blocked (vacation)
    let isAvailable: Bool // Fixed slots: selected for appointments
    let isToday: Bool
    let onTap: () -> Void

    private var dayNumber: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d"
        return formatter.string(from: date)
    }

    var body: some View {
        Button(action: onTap) {
            Text(dayNumber)
                .font(.caption.weight(isToday ? .bold : .medium))
                .frame(width: 36, height: 36)
                .background(backgroundColor)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isToday ? Color.black : Color.clear, lineWidth: 2)
                )
                .foregroundColor(foregroundColor)
                .cornerRadius(8)
                .strikethrough(isBlocked, color: .primary)
        }
        .buttonStyle(.plain)
    }

    private var backgroundColor: Color {
        if isBlocked { return Color.red.opacity(0.3) }
        if isAvailable { return Color.green.opacity(0.4) }
        if isToday { return Color.black.opacity(0.08) }
        return Color.clear
    }

    private var foregroundColor: Color {
        if isBlocked { return .secondary }
        return .primary
    }
}
