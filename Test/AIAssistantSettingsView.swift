//
//  AIAssistantSettingsView.swift
//  Connect Claude or ChatGPT to the shop. Same server functions as the website's
//  Settings → AI assistant screen. Only shown to owners whose shop is on early access.
//

import SwiftUI
import Combine
import UIKit
import FirebaseFunctions

struct AIConnection: Identifiable, Equatable {
    let id: String
    let name: String
    let hint: String
    let createdAt: Date?
    let lastUsedAt: Date?
    var actions: Bool
}

@MainActor
final class AIAssistantViewModel: ObservableObject {
    @Published var allowed: Bool?
    @Published var connections: [AIConnection] = []
    @Published var isLoading = false
    @Published var isCreating = false
    @Published var busyId: String?
    @Published var newLink: String?
    @Published var errorMessage: String?

    private let functions = Functions.functions(region: Constants.Firebase.cloudFunctionsRegion)

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func date(_ value: Any?) -> Date? {
        guard let s = value as? String, !s.isEmpty else { return nil }
        return Self.iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// Quiet check used by Settings to decide whether to show the row at all.
    func checkAccess() async {
        guard allowed == nil else { return }
        await load(quiet: true)
    }

    func load(quiet: Bool = false) async {
        if !quiet { isLoading = true }
        defer { isLoading = false }
        do {
            let result = try await functions.httpsCallable("listMcpKeys").call([:])
            let data = result.data as? [String: Any] ?? [:]
            allowed = (data["allowed"] as? Bool) == true
            let rows = data["keys"] as? [[String: Any]] ?? []
            connections = rows.compactMap { row in
                guard let id = row["id"] as? String else { return nil }
                return AIConnection(
                    id: id,
                    name: (row["name"] as? String) ?? "AI assistant",
                    hint: (row["hint"] as? String) ?? "",
                    createdAt: date(row["createdAt"]),
                    lastUsedAt: date(row["lastUsedAt"]),
                    actions: (row["actions"] as? Bool) != false
                )
            }
        } catch {
            if quiet {
                allowed = false
            } else {
                errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
            }
        }
    }

    func create(name: String) async {
        guard !isCreating else { return }
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            let result = try await functions.httpsCallable("createMcpKey").call([
                "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            ])
            let data = result.data as? [String: Any] ?? [:]
            newLink = data["connectorUrl"] as? String
            await load(quiet: true)
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func setActions(_ on: Bool, for connection: AIConnection) async {
        guard let i = connections.firstIndex(of: connection) else { return }
        connections[i].actions = on
        busyId = connection.id
        errorMessage = nil
        defer { busyId = nil }
        do {
            _ = try await functions.httpsCallable("setMcpKeyActions").call([
                "id": connection.id,
                "actions": on,
            ])
        } catch {
            if let j = connections.firstIndex(where: { $0.id == connection.id }) {
                connections[j].actions = !on
            }
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }

    func revoke(_ connection: AIConnection) async {
        busyId = connection.id
        errorMessage = nil
        defer { busyId = nil }
        do {
            _ = try await functions.httpsCallable("revokeMcpKey").call(["id": connection.id])
            connections.removeAll { $0.id == connection.id }
        } catch {
            errorMessage = FirebaseFunctionsErrorHelper.message(from: error)
        }
    }
}

struct AIAssistantSettingsView: View {
    @ObservedObject var viewModel: AIAssistantViewModel
    @State private var name = ""
    @State private var copied = false
    @State private var pendingRevoke: AIConnection?

    var body: some View {
        List {
            Section {
                Text("Connect Claude or ChatGPT to your shop. It can read your schedule, requests, clients, payments, messages, and website. With actions on, it can also confirm bookings, send payment links, and text clients, but only after you say yes in the chat.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if viewModel.allowed == false {
                Section {
                    Text("The AI assistant is in early access and isn’t on for your shop yet.")
                        .font(.subheadline)
                        .foregroundStyle(AppDesign.textSecondary)
                }
            } else if viewModel.allowed == true {
                createSection
                if let link = viewModel.newLink {
                    newLinkSection(link)
                }
                connectionsSection
            } else {
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading…").font(.subheadline)
                    }
                }
            }

            if let error = viewModel.errorMessage, !error.isEmpty {
                Section {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                Link("See how to connect, step by step",
                     destination: URL(string: "\(Constants.Hosting.marketingWebOrigin)/ai-assistant")!)
                    .font(.subheadline)
            }
        }
        .appListSurface()
        .navigationTitle("AI assistant")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .confirmationDialog(
            "Revoke this connection?",
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                if let c = pendingRevoke {
                    Task { await viewModel.revoke(c) }
                }
                pendingRevoke = nil
            }
            Button("Cancel", role: .cancel) { pendingRevoke = nil }
        } message: {
            Text("The assistant using it stops working right away.")
        }
    }

    private var createSection: some View {
        Section {
            TextField("Claude or ChatGPT", text: $name)
                .textInputAutocapitalization(.words)
                .onChange(of: name) { _, value in
                    if value.count > 40 { name = String(value.prefix(40)) }
                }
            Button {
                Task {
                    await viewModel.create(name: name)
                    if viewModel.newLink != nil { name = "" }
                }
            } label: {
                HStack {
                    if viewModel.isCreating { ProgressView() }
                    Text("Create connection link").font(.headline)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isCreating)
        } header: {
            Text("Name this connection")
        }
    }

    private func newLinkSection(_ link: String) -> some View {
        Section {
            Text(link)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button(copied ? "Copied" : "Copy link") {
                UIPasteboard.general.string = link
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            }
        } header: {
            Text("Your connection link")
        } footer: {
            Text("Shown only once, so copy it now. Anyone with this link can read your shop data. Keep it private, and revoke it if it’s ever shared.")
        }
    }

    private var connectionsSection: some View {
        Section {
            if viewModel.connections.isEmpty {
                Text("No connections yet.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
            }
            ForEach(viewModel.connections) { c in
                VStack(alignment: .leading, spacing: 8) {
                    Text(c.name).font(.subheadline.weight(.semibold))
                    Text(detail(for: c))
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                    Toggle("Can take actions", isOn: Binding(
                        get: { c.actions },
                        set: { on in Task { await viewModel.setActions(on, for: c) } }
                    ))
                    .font(.subheadline)
                    .disabled(viewModel.busyId == c.id)
                    Button("Revoke", role: .destructive) { pendingRevoke = c }
                        .font(.subheadline)
                        .disabled(viewModel.busyId == c.id)
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("Connections")
        }
    }

    private func detail(for c: AIConnection) -> String {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy"
        let created = c.createdAt.map { f.string(from: $0) } ?? "Never"
        let used = c.lastUsedAt.map { f.string(from: $0) } ?? "Never"
        let hint = c.hint.isEmpty ? "" : "…\(c.hint) · "
        return "\(hint)Created \(created) · Last used \(used)"
    }
}
