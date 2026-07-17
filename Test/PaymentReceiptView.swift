//
//  PaymentReceiptView.swift
//

import SwiftUI
import UIKit

struct PaymentReceiptView: View {
    let detail: PaymentReceiptDetail
    var forExport: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            receiptHeader
            VStack(alignment: .leading, spacing: 20) {
                Text(detail.headerTitle)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))

                VStack(alignment: .leading, spacing: 6) {
                    if let receiptNumber = detail.receiptNumber, !receiptNumber.isEmpty {
                        metaRow(label: "Receipt number", value: receiptNumber)
                    }
                    metaRow(
                        label: detail.amountMetaLabel,
                        value: PaymentsViewModel.formatUSD(detail.totalPaidUSD)
                    )
                    metaRow(
                        label: detail.dateMetaLabel,
                        value: detail.paidAt.formatted(.dateTime.month(.wide).day().year().hour().minute())
                    )
                    if let statusMessage = detail.statusMessage, !statusMessage.isEmpty {
                        metaRow(label: "Status", value: statusMessage)
                    }
                    if let customerName = detail.customerName, !customerName.isEmpty {
                        metaRow(label: "Customer", value: customerName)
                    }
                    if let customerEmail = detail.customerEmail, !customerEmail.isEmpty {
                        metaRow(label: "Email", value: customerEmail)
                    }
                }

                Divider()

                Text("Summary")
                    .font(.headline)
                    .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))

                VStack(spacing: 0) {
                    summaryHeader
                    ForEach(detail.lineItems) { item in
                        summaryRow(item: item)
                        Divider()
                    }
                    HStack {
                        Text("Total")
                            .font(.subheadline.weight(.bold))
                        Spacer()
                        Text(PaymentsViewModel.formatUSD(detail.totalPaidUSD))
                            .font(.subheadline.weight(.bold))
                    }
                    .padding(.vertical, 10)
                }
            }
            .padding(24)
            .background(Color.white)
        }
        .background(Color(red: 0.93, green: 0.95, blue: 0.97))
        .clipShape(RoundedRectangle(cornerRadius: forExport ? 0 : 16, style: .continuous))
    }

    private var receiptHeader: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: [
                    Color(red: 0.55, green: 0.65, blue: 0.78),
                    Color(red: 0.78, green: 0.82, blue: 0.88),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .frame(height: 120)
            .overlay {
                GeometryReader { geo in
                    Path { path in
                        path.move(to: CGPoint(x: geo.size.width * 0.55, y: 0))
                        path.addLine(to: CGPoint(x: geo.size.width, y: 0))
                        path.addLine(to: CGPoint(x: geo.size.width * 0.72, y: geo.size.height))
                        path.closeSubpath()
                    }
                    .fill(Color.white.opacity(0.18))
                }
            }
        }
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
                .frame(width: 120, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))
            Spacer(minLength: 0)
        }
    }

    private var summaryHeader: some View {
        HStack {
            Text("Description")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
            Spacer()
            Text("Qty")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
                .frame(width: 36, alignment: .trailing)
            Text("Amount")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
                .frame(width: 72, alignment: .trailing)
        }
        .padding(.bottom, 8)
    }

    private func summaryRow(item: PaymentReceiptLineItem) -> some View {
        HStack(alignment: .top) {
            Text(item.name)
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))
            Spacer()
            Text("\(item.quantity)")
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
                .frame(width: 36, alignment: .trailing)
            Text(PaymentsViewModel.formatUSD(item.amountUSD))
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))
                .frame(width: 72, alignment: .trailing)
        }
        .padding(.vertical, 10)
    }
}

// MARK: - PDF export

enum PaymentReceiptPDFExporter {
    private static let pageWidth: CGFloat = 612
    private static let contentWidth: CGFloat = 532

    @MainActor
    static func writePDF(detail: PaymentReceiptDetail) -> URL? {
        let content = PaymentReceiptView(detail: detail, forExport: true)
            .frame(width: contentWidth)
            .background(Color.white)

        let renderer = ImageRenderer(content: content)
        renderer.scale = 2.0
        guard let image = renderer.uiImage else { return nil }

        let pageHeight = max(792, image.size.height + 80)
        let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
        let pdfData = UIGraphicsPDFRenderer(bounds: bounds).pdfData { context in
            context.beginPage()
            let drawRect = CGRect(
                x: (pageWidth - image.size.width) / 2,
                y: 40,
                width: image.size.width,
                height: image.size.height
            )
            image.draw(in: drawRect)
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(detail.pdfFileName)
        do {
            try pdfData.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}

// MARK: - Outcome banner

struct PaymentReceiptOutcomeBannerView: View {
    let banner: PaymentReceiptOutcomeBanner

    private var accentColor: Color {
        banner.style == .success ? .green : .red
    }

    private var backgroundColor: Color {
        banner.style == .success
            ? Color.green.opacity(0.12)
            : Color.red.opacity(0.12)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: banner.style == .success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.title2)
                .foregroundStyle(accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text(banner.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color(red: 0.12, green: 0.14, blue: 0.18))
                if let message = banner.message, !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color(red: 0.45, green: 0.48, blue: 0.52))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(backgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Receipt sheet

struct PaymentReceiptSheet: View {
    let detail: PaymentReceiptDetail
    var drawerState: DrawerState
    var onDismissAll: (() -> Void)?
    var outcomeBanner: PaymentReceiptOutcomeBanner?
    var onTryAgain: (() -> Void)?
    var onManualPayment: (() -> Void)?
    var manualPaymentInProgress: Bool = false
    @Environment(\.dismiss) private var dismiss
    @State private var showShareSheet = false
    @State private var pdfURL: URL?
    @State private var isPreparingShare = false

    private var resolvedBanner: PaymentReceiptOutcomeBanner? {
        outcomeBanner ?? detail.outcomeBanner
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let resolvedBanner {
                        PaymentReceiptOutcomeBannerView(banner: resolvedBanner)
                    }
                    PaymentReceiptView(detail: detail)
                    if detail.isUnpaidAttempt, onTryAgain != nil || onManualPayment != nil {
                        unpaidRecoveryActions
                    }
                }
                .padding(16)
            }
            .appScreenBackground()
            .navigationTitle(detail.sheetNavigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            Task { await sharePDF() }
                        } label: {
                            Label("Share PDF", systemImage: "doc.fill")
                        }
                        Button {
                            sendInMessages()
                        } label: {
                            Label("Send in Messages", systemImage: "message")
                        }
                    } label: {
                        if isPreparingShare {
                            ProgressView()
                        } else {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                    .disabled(isPreparingShare)
                }
            }
            .sheet(isPresented: $showShareSheet, onDismiss: { pdfURL = nil }) {
                if let pdfURL {
                    ReceiptShareSheet(items: [pdfURL])
                }
            }
        }
    }

    @ViewBuilder
    private var unpaidRecoveryActions: some View {
        VStack(spacing: 10) {
            if let onManualPayment {
                Button {
                    onManualPayment()
                } label: {
                    HStack {
                        if manualPaymentInProgress {
                            ProgressView()
                        } else {
                            Text("Manual payment")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(manualPaymentInProgress)
            }
            if let onTryAgain {
                Button("Try tap again") {
                    dismiss()
                    onTryAgain()
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, 4)
    }

    @MainActor
    private func sharePDF() async {
        isPreparingShare = true
        defer { isPreparingShare = false }
        guard let url = PaymentReceiptPDFExporter.writePDF(detail: detail) else { return }
        pdfURL = url
        showShareSheet = true
    }

    private func sendInMessages() {
        drawerState.messagesComposeBody = detail.smsBody()
        drawerState.messagesShouldOpenCompose = true
        drawerState.selectedSection = .messages
        drawerState.isOpen = false
        if let onDismissAll {
            onDismissAll()
        } else {
            dismiss()
        }
    }
}

struct ReceiptShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
