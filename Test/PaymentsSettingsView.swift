//
//  PaymentsSettingsView.swift
//  Tap to Pay name, signature, and receipt preferences.
//

import SwiftUI

struct PaymentsSettingsView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @State private var showReceiptPreferences = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                #if TAP_TO_PAY_ENABLED
                if viewModel.canEditTapToPayDisplayName {
                    tapToPayNameSection
                    checkoutOptionsSection
                }
                #endif

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                if viewModel.tapToPaySettingsSaveSuccess {
                    Text("Settings saved.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical, 16)
        }
        .appScreenBackground()
        .navigationTitle("Tap to Pay settings")
        .navigationBarTitleDisplayMode(.inline)
        #if TAP_TO_PAY_ENABLED
        .navigationDestination(isPresented: $showReceiptPreferences) {
            ReceiptPreferencesView(viewModel: viewModel)
        }
        #endif
    }

    #if TAP_TO_PAY_ENABLED
    private var tapToPayNameSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tap to Pay name")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(alignment: .leading, spacing: 12) {
                Text("Customers see “Pay \(viewModel.effectiveTapToPayDisplayName)” on their phone. Does not change your website or business name.")
                    .font(.caption)
                    .foregroundStyle(AppDesign.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(
                    "Name on customer’s phone",
                    text: $viewModel.tapToPayDisplayNameDraft,
                    prompt: Text(viewModel.tapToPayDisplayNamePlaceholder)
                )
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .disabled(viewModel.isSavingTapToPayDisplayName)

                Button {
                    Task { await viewModel.saveTapToPayDisplayName() }
                } label: {
                    HStack {
                        Text("Save name")
                        if viewModel.isSavingTapToPayDisplayName {
                            Spacer()
                            ProgressView().scaleEffect(0.9)
                        }
                    }
                }
                .disabled(viewModel.isSavingTapToPayDisplayName)

                if viewModel.tapToPayDisplayNameSaveSuccess {
                    Text("Saved — new payments will show Pay \(viewModel.effectiveTapToPayDisplayName).")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                }
            }
            .padding(16)
            .appCard()
            .padding(.horizontal)
        }
    }

    private var checkoutOptionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Checkout")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(spacing: 0) {
                Toggle(isOn: requireSignatureBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Require signature")
                            .font(.subheadline.weight(.semibold))
                        Text("Ask for a customer signature after payment")
                            .font(.caption)
                            .foregroundStyle(AppDesign.textSecondary)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .disabled(viewModel.isSavingTapToPaySettings)

                Divider().padding(.leading, 16)

                Button {
                    showReceiptPreferences = true
                } label: {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Receipt preferences")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppDesign.textPrimary)
                            Text(viewModel.tapToPayReceiptPreferences.settingsRowSubtitle)
                                .font(.caption)
                                .foregroundStyle(AppDesign.textSecondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .appCard()
            .padding(.horizontal)
        }
    }

    private var requireSignatureBinding: Binding<Bool> {
        Binding(
            get: { viewModel.tapToPayRequireSignature },
            set: { newValue in
                viewModel.tapToPayRequireSignature = newValue
                Task {
                    await viewModel.saveTapToPayPaymentSettings(requireSignature: newValue)
                }
            }
        )
    }
    #endif
}

struct ReceiptPreferencesView: View {
    @ObservedObject var viewModel: PaymentsViewModel
    @State private var draft = TapToPayReceiptPreferences()
    @State private var didLoadDraft = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                deliverySection
                contentSection

                if let err = viewModel.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                Button {
                    Task {
                        await viewModel.saveTapToPayReceiptPreferences(draft)
                        if viewModel.tapToPaySettingsSaveSuccess {
                            draft = viewModel.tapToPayReceiptPreferences
                        }
                    }
                } label: {
                    HStack {
                        if viewModel.isSavingTapToPaySettings {
                            ProgressView().tint(.white)
                        } else {
                            Text("Save preferences")
                                .font(.headline.weight(.semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(.white)
                    .background(AppDesign.brandDark)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isSavingTapToPaySettings)
                .padding(.horizontal)

                if viewModel.tapToPaySettingsSaveSuccess {
                    Text("Preferences saved.")
                        .font(.caption)
                        .foregroundStyle(AppDesign.accentGreen)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical, 16)
        }
        .appScreenBackground()
        .navigationTitle("Receipt preferences")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !didLoadDraft else { return }
            draft = viewModel.tapToPayReceiptPreferences
            didLoadDraft = true
        }
    }

    private var deliverySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Delivery method")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(spacing: 0) {
                ForEach(Array(TapToPayReceiptDelivery.allCases.enumerated()), id: \.element.id) { index, mode in
                    ReceiptPreferenceRadioRow(
                        title: mode.title,
                        subtitle: mode.subtitle,
                        isSelected: draft.delivery == mode
                    ) {
                        draft.delivery = mode
                    }
                    if index < TapToPayReceiptDelivery.allCases.count - 1 {
                        Divider().padding(.leading, 52)
                    }
                }
            }
            .appCard()
            .padding(.horizontal)
        }
    }

    private var contentSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Receipt content")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppDesign.textSecondary)
                .padding(.horizontal)

            VStack(spacing: 0) {
                Toggle(isOn: $draft.showBusinessName) {
                    preferenceToggleLabel(
                        title: "Show business name",
                        subtitle: "Appears at top of receipt"
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                Divider().padding(.leading, 16)

                Toggle(isOn: $draft.itemized) {
                    preferenceToggleLabel(
                        title: "Itemised breakdown",
                        subtitle: "List amount with payment details"
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                Divider().padding(.leading, 16)

                Toggle(isOn: $draft.customFooter) {
                    preferenceToggleLabel(
                        title: "Custom footer message",
                        subtitle: "e.g. “Thanks for visiting!”"
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                if draft.customFooter {
                    Divider().padding(.leading, 16)
                    TextField("Footer message", text: $draft.footerMessage, axis: .vertical)
                        .lineLimit(2...4)
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                }
            }
            .appCard()
            .padding(.horizontal)
        }
    }

    private func preferenceToggleLabel(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(AppDesign.textSecondary)
        }
    }
}

private struct ReceiptPreferenceRadioRow: View {
    let title: String
    let subtitle: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? AppDesign.brandDark : AppDesign.textSecondary)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppDesign.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AppDesign.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
