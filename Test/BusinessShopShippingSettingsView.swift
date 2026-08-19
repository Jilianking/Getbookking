//
//  BusinessShopShippingSettingsView.swift
//
//  Reuses the Design → Shop “Shipping & pickup” editor inside Business settings.
//

import SwiftUI

struct BusinessShopShippingSettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = DesignViewModel()

    var body: some View {
        ShopShippingSettingsView(viewModel: viewModel)
            .task {
                await viewModel.loadData(isDemoMode: authViewModel.isDemoMode)
            }
    }
}

