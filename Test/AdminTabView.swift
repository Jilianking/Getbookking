import SwiftUI

struct AdminTabView: View {
    @EnvironmentObject var authViewModel: AuthViewModel

    var body: some View {
        AdminRootView()
            .environmentObject(authViewModel)
    }
}

