import SwiftUI

struct AdminTabView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @EnvironmentObject var sessionStore: TenantSessionStore

    var body: some View {
        AdminRootView()
            .environmentObject(authViewModel)
            .environmentObject(sessionStore)
    }
}

