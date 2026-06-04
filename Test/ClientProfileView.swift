import SwiftUI

struct ClientProfileView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel: ClientProfileViewModel
    @ObservedObject var clientsViewModel: ClientsViewModel
    var drawerState: DrawerState

    @State private var showingEditSheet = false
    @State private var showingBookingForm = false
    @State private var notesDraft = ""

    init(client: Client, clientsViewModel: ClientsViewModel, drawerState: DrawerState) {
        _viewModel = StateObject(wrappedValue: ClientProfileViewModel(client: client))
        self.clientsViewModel = clientsViewModel
        self.drawerState = drawerState
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(spacing: 0) {
                    profileHeader
                    tabPicker
                    tabContent
                        .padding(.bottom, 96)
                }
            }

            bottomActionBar
        }
        .appScreenBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("+ Book") { showingBookingForm = true }
                    .font(.subheadline.weight(.semibold))
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { showingEditSheet = true }
            }
        }
        .task {
            await viewModel.load(isDemoMode: authViewModel.isDemoMode)
            notesDraft = viewModel.client.notes ?? ""
        }
        .sheet(isPresented: $showingEditSheet) {
            ClientProfileEditSheet(viewModel: viewModel) {
                Task { await clientsViewModel.loadClients(isDemoMode: authViewModel.isDemoMode) }
            }
        }
        .sheet(isPresented: $showingBookingForm) {
            BookingFormView(
                drawerState: drawerState,
                prefillName: viewModel.client.name,
                prefillEmail: viewModel.client.email,
                prefillPhone: viewModel.client.phone
            )
            .environmentObject(authViewModel)
        }
    }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            AppAvatarView(
                tenantLogoURL: nil,
                accountPhotoURL: nil,
                displayNameFallback: viewModel.client.name,
                size: 64
            )

            Text(viewModel.client.name)
                .font(.title2.weight(.semibold))
                .foregroundStyle(AppDesign.textPrimary)

            Text("Client since \(viewModel.client.createdAt.formatted(date: .abbreviated, time: .omitted))")
                .font(.subheadline)
                .foregroundStyle(AppDesign.textSecondary)

            HStack(spacing: 8) {
                if viewModel.client.vip {
                    ProfileBadge(text: "VIP", color: .orange)
                }
                if viewModel.smsOptedIn {
                    ProfileBadge(text: "SMS opted in", color: .green)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .padding(.horizontal, 16)
        .appCard()
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    private var tabPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ClientProfileTab.allCases) { tab in
                    Button {
                        viewModel.selectedTab = tab
                    } label: {
                        Text(tab.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(viewModel.selectedTab == tab ? Color.white : AppDesign.textPrimary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(viewModel.selectedTab == tab ? AppDesign.brandDark : AppDesign.cardBackground)
                            .clipShape(Capsule())
                            .overlay(
                                Capsule().stroke(viewModel.selectedTab == tab ? Color.clear : AppDesign.chipBorder, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    @ViewBuilder
    private var tabContent: some View {
        if viewModel.isLoading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
        } else {
            switch viewModel.selectedTab {
            case .overview:
                overviewTab
            case .history:
                historyTab
            case .notes:
                notesTab
            }
        }
    }

    private var overviewTab: some View {
        VStack(spacing: 22) {
            HStack(spacing: 12) {
                ProfileStatCard(title: "Visits", value: "\(viewModel.visitCount)")
                ProfileStatCard(title: "Total spent", value: formatCurrency(viewModel.totalSpent))
                ProfileStatCard(title: "Avg/month", value: formatCurrency(viewModel.averagePerMonth))
            }

            if let upcoming = viewModel.upcomingBooking, let date = upcoming.requestedStartTime {
                ProfileDetailCard(sectionTitle: "Upcoming appointment") {
                    upcomingAppointmentContent(booking: upcoming, date: date)
                }
            }

            ProfileDetailCard(sectionTitle: "Contact information") {
                contactInformationContent
            }

            ProfileDetailCard(sectionTitle: "Messaging consent") {
                messagingConsentContent
            }

            if hasPreferences {
                ProfileDetailCard(sectionTitle: "Preferences") {
                    preferencesContent
                }
            }

            if let notes = viewModel.client.notes, !notes.isEmpty {
                ProfileDetailCard(sectionTitle: "Internal notes") {
                    Text(notes)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(Color.yellow.opacity(0.12))
                        .cornerRadius(10)
                        .padding(.top, 4)
                }
            }

            if !viewModel.recentVisits.isEmpty {
                ProfileDetailCard(sectionTitle: "Recent visits") {
                    VStack(spacing: 0) {
                        ForEach(Array(viewModel.recentVisits.enumerated()), id: \.element.id) { index, visit in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(visit.serviceName)
                                        .font(.subheadline.weight(.semibold))
                                    Text(visit.date.formatted(date: .abbreviated, time: .omitted))
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                if let price = visit.price {
                                    Text(formatCurrency(price))
                                        .font(.subheadline.weight(.semibold))
                                }
                            }
                            .padding(.vertical, 12)
                            if index < viewModel.recentVisits.count - 1 {
                                Divider()
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 20)
    }

    @ViewBuilder
    private func upcomingAppointmentContent(booking: BookingRequest, date: Date) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 2) {
                Text(date.formatted(.dateTime.month(.abbreviated)))
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                Text(date.formatted(.dateTime.day()))
                    .font(.title2.weight(.bold))
            }
            .frame(width: 54)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(10)

            VStack(alignment: .leading, spacing: 4) {
                Text(booking.serviceName ?? "Appointment")
                    .font(.headline)
                if let staff = booking.assignedMemberDisplayLabel {
                    Text("\(date.formatted(date: .omitted, time: .shortened)) with \(staff)")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                } else {
                    Text(date.formatted(date: .omitted, time: .shortened))
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            }

            Spacer(minLength: 8)

            if let price = viewModel.price(for: booking) {
                Text(formatCurrency(price))
                    .font(.headline)
            }
        }
    }

    @ViewBuilder
    private var contactInformationContent: some View {
        VStack(spacing: 0) {
            if let phone = viewModel.client.phone, !phone.isEmpty,
               let telURL = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") {
                Link(destination: telURL) {
                    contactLinkRow(
                        systemImage: "phone.fill",
                        iconColor: .green,
                        text: PhoneFormatting.displayUS(phone)
                    )
                }
                if !viewModel.client.email.isEmpty { Divider() }
            }

            if !viewModel.client.email.isEmpty,
               let mailURL = URL(string: "mailto:\(viewModel.client.email)") {
                Link(destination: mailURL) {
                    contactLinkRow(
                        systemImage: "envelope.fill",
                        iconColor: .blue,
                        text: viewModel.client.email
                    )
                }
            }

            if let birthday = viewModel.client.birthday, !birthday.isEmpty {
                Divider()
                ProfileKeyValueRow(label: "Birthday", value: birthday)
            }

            if let referral = viewModel.client.referralSource, !referral.isEmpty {
                Divider()
                ProfileKeyValueRow(label: "Referral", value: referral)
            }

            if let extras = viewModel.client.profileExtras {
                ForEach(extras) { extra in
                    if !extra.label.isEmpty || !extra.value.isEmpty {
                        Divider()
                        ProfileKeyValueRow(
                            label: extra.label.isEmpty ? "Detail" : extra.label,
                            value: extra.value.isEmpty ? "—" : extra.value
                        )
                    }
                }
            }
        }
    }

    private var messagingConsentContent: some View {
        VStack(spacing: 14) {
            ProfileKeyValueRow(
                label: "SMS opt-in",
                value: viewModel.smsOptedIn ? "Opted in" : "Not opted in",
                showsStatusDot: true,
                statusColor: viewModel.smsOptedIn ? .green : .secondary
            )
            if let consentDate = viewModel.smsConsentDate {
                ProfileKeyValueRow(
                    label: "Consent date",
                    value: consentDate.formatted(date: .abbreviated, time: .omitted)
                )
            }
            if let method = viewModel.smsConsentMethod {
                ProfileKeyValueRow(label: "Method", value: method)
            }
        }
    }

    @ViewBuilder
    private var preferencesContent: some View {
        VStack(spacing: 14) {
            if let staff = viewModel.preferredStaff {
                ProfileKeyValueRow(label: "Preferred staff", value: staff)
            }
            if let days = viewModel.preferredDays {
                ProfileKeyValueRow(label: "Preferred days", value: days)
            }
            if let time = viewModel.preferredTimeDisplay {
                ProfileKeyValueRow(label: "Preferred time", value: time)
            }
            let styles = viewModel.client.preferences?.resolvedTattooStyles ?? []
            if !styles.isEmpty {
                ProfileKeyValueRow(label: "Style", value: styles.joined(separator: ", "))
            }
            if let allergies = viewModel.client.preferences?.allergies, !allergies.isEmpty {
                ProfileKeyValueRow(label: "Allergies", value: allergies.joined(separator: ", "))
            }
        }
    }

    private func contactLinkRow(systemImage: String, iconColor: Color, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundColor(iconColor)
                .frame(width: 24, alignment: .center)
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundColor(.primary)
                .lineLimit(2)
            Spacer()
            Image(systemName: "arrow.up.right")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    private var historyTab: some View {
        VStack(spacing: 22) {
            if viewModel.matchingBookings.isEmpty {
                ContentUnavailableView("No booking history", systemImage: "calendar")
                    .padding(.top, 40)
            } else {
                ForEach(viewModel.matchingBookings) { booking in
                    ProfileDetailCard(sectionTitle: booking.serviceName ?? "Booking") {
                        VStack(alignment: .leading, spacing: 10) {
                            BookingRequestDetailRow(label: "Status", value: booking.status.capitalized)
                            if let date = booking.requestedStartTime ?? booking.createdAt {
                                BookingRequestDetailRow(
                                    label: "Date",
                                    value: date.formatted(.dateTime.month(.abbreviated).day().year().hour().minute()),
                                    systemImage: "calendar"
                                )
                            }
                            if let notes = booking.notes, !notes.isEmpty {
                                BookingRequestDetailRow(label: "Notes", value: notes)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private var notesTab: some View {
        VStack(spacing: 22) {
            ProfileDetailCard(sectionTitle: "Internal notes") {
                TextEditor(text: $notesDraft)
                    .frame(minHeight: 180)
                    .scrollContentBackground(.hidden)
            }
            Button("Save notes") {
                Task {
                    await viewModel.saveNotes(notesDraft)
                    await clientsViewModel.loadClients(isDemoMode: authViewModel.isDemoMode)
                }
            }
            .buttonStyle(AppPrimaryButtonStyle())
        }
        .padding(.horizontal, 16)
    }

    private var bottomActionBar: some View {
        HStack(spacing: 12) {
            if let phoneURL = callURL {
                Link(destination: phoneURL) {
                    Label("Call", systemImage: "phone.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.bordered)
            }

            Button {
                openMessagesCompose()
            } label: {
                Label("Send message", systemImage: "message.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.messageThreadId == nil)
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }

    private var hasPreferences: Bool {
        let prefs = viewModel.client.preferences
        let hasPreferredTime = viewModel.preferredTimeDisplay != nil
        let hasStyle = !(prefs?.resolvedTattooStyles ?? []).isEmpty
        let hasAllergies = !(prefs?.allergies ?? []).isEmpty
        let hasStaff = viewModel.preferredStaff != nil
        let hasDays = viewModel.preferredDays != nil
        return hasPreferredTime || hasStyle || hasAllergies || hasStaff || hasDays
    }

    private var callURL: URL? {
        let digits = PhoneFormatting.digits(from: viewModel.client.phone ?? "")
        guard digits.count >= 10 else { return nil }
        return URL(string: "tel://+\(digits)")
    }

    private func openMessagesCompose() {
        guard let phone = viewModel.client.phone else { return }
        drawerState.messagesComposePhone = phone
        drawerState.messagesComposeClientName = viewModel.client.name
        drawerState.messagesShouldOpenCompose = true
        drawerState.selectedSection = .messages
    }

    private func formatCurrency(_ value: Double) -> String {
        if value <= 0 { return "$0" }
        if value.rounded() == value {
            return "$\(Int(value))"
        }
        return String(format: "$%.2f", value)
    }
}

private struct ProfileDetailCard<Content: View>: View {
    let sectionTitle: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            BookingRequestSectionHeader(title: sectionTitle)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .appCard()
    }
}

private struct ProfileKeyValueRow: View {
    let label: String
    let value: String
    var showsStatusDot = false
    var statusColor: Color = .green

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.secondary)
            Spacer(minLength: 16)
            HStack(spacing: 6) {
                if showsStatusDot {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                }
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.primary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct ProfileBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.15))
            .foregroundColor(color)
            .clipShape(Capsule())
    }
}

private struct ProfileStatCard: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.headline.weight(.bold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .appCard()
    }
}

private struct ClientProfileEditSheet: View {
    @ObservedObject var viewModel: ClientProfileViewModel
    var onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var vip = false
    @State private var birthday = ""
    @State private var referralSource = ""
    @State private var preferredTime = ""
    @State private var tattooStyles: [String] = []
    @State private var allergies: [String] = []
    @State private var profileExtras: [Client.ClientProfileExtra] = []
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Contact") {
                    TextField("Name", text: $name)
                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    TextField("(555) 123-4567", text: Binding(
                        get: { phone },
                        set: { phone = PhoneFormatting.formatAsYouType($0) }
                    ))
                    .keyboardType(.phonePad)
                }
                Section("Profile") {
                    Toggle("VIP client", isOn: $vip)
                    TextField("Birthday", text: $birthday)
                    TextField("Referral source", text: $referralSource)
                    ForEach($profileExtras) { $extra in
                        HStack(spacing: 8) {
                            TextField("Label", text: $extra.label)
                            TextField("Value", text: $extra.value)
                            Button(role: .destructive) {
                                profileExtras.removeAll { $0.id == extra.id }
                            } label: {
                                Image(systemName: "minus.circle.fill")
                                    .foregroundColor(.red.opacity(0.85))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    addRowButton(title: "Add field") {
                        profileExtras.append(Client.ClientProfileExtra())
                    }
                }
                Section("Preferences") {
                    TextField("Preferred time", text: $preferredTime)
                    ForEach(tattooStyles.indices, id: \.self) { index in
                        HStack(spacing: 8) {
                            TextField("Tattoo style", text: $tattooStyles[index])
                            if tattooStyles.count > 1 {
                                Button(role: .destructive) {
                                    tattooStyles.remove(at: index)
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundColor(.red.opacity(0.85))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    addRowButton(title: "Add style") {
                        tattooStyles.append("")
                    }
                    ForEach(allergies.indices, id: \.self) { index in
                        HStack(spacing: 8) {
                            TextField("Allergy", text: $allergies[index])
                            if allergies.count > 1 {
                                Button(role: .destructive) {
                                    allergies.remove(at: index)
                                } label: {
                                    Image(systemName: "minus.circle.fill")
                                        .foregroundColor(.red.opacity(0.85))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    addRowButton(title: "Add allergy") {
                        allergies.append("")
                    }
                }
            }
            .appListSurface()
            .navigationTitle("Edit client")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task {
                            isSaving = true
                            await viewModel.saveEdits(
                                name: name,
                                email: email,
                                phone: phone,
                                vip: vip,
                                birthday: birthday,
                                referralSource: referralSource,
                                preferredTime: preferredTime,
                                tattooStyles: tattooStyles,
                                allergies: allergies,
                                profileExtras: profileExtras
                            )
                            isSaving = false
                            onSaved()
                            dismiss()
                        }
                    }
                    .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                name = viewModel.client.name
                email = viewModel.client.email
                phone = PhoneFormatting.displayUS(viewModel.client.phone ?? "")
                vip = viewModel.client.vip
                birthday = viewModel.client.birthday ?? ""
                referralSource = viewModel.client.referralSource ?? ""
                preferredTime = viewModel.client.preferences?.preferredTime ?? ""
                let styles = viewModel.client.preferences?.resolvedTattooStyles ?? []
                tattooStyles = styles
                allergies = viewModel.client.preferences?.allergies ?? []
                profileExtras = viewModel.client.profileExtras ?? []
            }
        }
    }

    private func addRowButton(title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                Text(title)
            }
        }
    }
}
