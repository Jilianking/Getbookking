//
//  SettingsView.swift
//
//  Generic settings: account, business info, app info.
//

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var showingLogoutAlert = false
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
                        HStack {
                            Image(systemName: "person.crop.circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(authViewModel.currentUserDisplayName ?? "User")
                                    .font(.subheadline.weight(.medium))
                                Text(email)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
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
        }
        .navigationViewStyle(.stack)
    }
}
