//
//  BookingRequestMediaPreviewViews.swift
//
//  Full-screen reference photo viewer with pinch zoom and system share sheet.
//

import SwiftUI
import UIKit

struct BookingRequestMediaFullScreenPreview: View {
    let urls: [URL]
    let initialIndex: Int

    @Environment(\.dismiss) private var dismiss
    @State private var pageIndex: Int
    @State private var isZoomed = false
    @State private var isPreparingShare = false
    @State private var shareErrorMessage: String?
    @State private var dragOffset: CGFloat = 0

    private let dismissDragThreshold: CGFloat = 120

    init(urls: [URL], initialIndex: Int) {
        self.urls = urls
        self.initialIndex = initialIndex
        _pageIndex = State(initialValue: initialIndex)
    }

    var body: some View {
        ZStack {
            Color.black
                .opacity(max(0.35, 1 - Double(dragOffset) / 400))
                .ignoresSafeArea()

            TabView(selection: $pageIndex) {
                ForEach(Array(urls.enumerated()), id: \.offset) { index, url in
                    ZoomableRemoteImagePage(url: url, isZoomed: $isZoomed)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: urls.count > 1 ? .automatic : .never))
            .scrollDisabled(isZoomed || dragOffset > 0)
            .onChange(of: pageIndex) { _, _ in
                isZoomed = false
            }

            if let shareErrorMessage {
                VStack {
                    Spacer()
                    Text(shareErrorMessage)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 12)
                        .background(.black.opacity(0.65))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(.horizontal, 24)
                        .padding(.bottom, 32)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                .zIndex(5)
                .allowsHitTesting(false)
                .animation(.easeInOut(duration: 0.2), value: shareErrorMessage)
            }
        }
        .offset(y: dragOffset)
        .simultaneousGesture(swipeDownDismissGesture)
        .safeAreaInset(edge: .top, spacing: 0) {
            photoViewerHeader
        }
    }

    private var photoViewerHeader: some View {
        HStack(spacing: 12) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.black)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Color.black.opacity(0.08)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")

            Spacer(minLength: 0)

            Text(headerTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.black)
                .lineLimit(1)

            Spacer(minLength: 0)

            Button {
                Task { await shareCurrentPhoto() }
            } label: {
                Group {
                    if isPreparingShare {
                        ProgressView()
                            .tint(.black)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.black)
                    }
                }
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.black.opacity(0.08)))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isPreparingShare)
            .accessibilityLabel("Share")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(AppDesign.cardBackground)
        .overlay(alignment: .bottom) {
            Divider().overlay(AppDesign.chipBorder.opacity(0.6))
        }
    }

    private var headerTitle: String {
        guard urls.count > 1 else { return "Photo" }
        return "\(pageIndex + 1) of \(urls.count)"
    }

    private var swipeDownDismissGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard !isZoomed else { return }
                let vertical = value.translation.height
                let horizontal = abs(value.translation.width)
                // Prefer vertical dismiss; ignore mostly-horizontal paging swipes.
                guard vertical > 0, vertical > horizontal else { return }
                dragOffset = vertical
            }
            .onEnded { value in
                guard !isZoomed else {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
                        dragOffset = 0
                    }
                    return
                }
                let shouldDismiss =
                    value.translation.height > dismissDragThreshold
                    || value.predictedEndTranslation.height > dismissDragThreshold * 1.4
                if shouldDismiss {
                    dismiss()
                } else {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
                        dragOffset = 0
                    }
                }
            }
    }

    @MainActor
    private func shareCurrentPhoto() async {
        guard urls.indices.contains(pageIndex) else { return }
        isPreparingShare = true
        shareErrorMessage = nil
        defer { isPreparingShare = false }

        do {
            let (data, _) = try await URLSession.shared.data(from: urls[pageIndex])
            guard !data.isEmpty, let image = UIImage(data: data) else {
                throw URLError(.cannotDecodeContentData)
            }

            // Present from the topmost VC so we don't nest a blank SwiftUI sheet
            // on top of the photo fullScreenCover (that was showing an empty sheet).
            // UIImage yields Save Image / Messages / Mail like a normal photo share.
            Self.presentActivityViewController(items: [image])
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            shareErrorMessage = "Couldn’t prepare photo to share."
            dismissShareErrorAfterDelay()
        }
    }

    @MainActor
    private static func presentActivityViewController(items: [Any]) {
        guard let presenter = topViewController() else { return }
        let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(
                x: presenter.view.bounds.midX,
                y: presenter.view.safeAreaInsets.top + 28,
                width: 1,
                height: 1
            )
            popover.permittedArrowDirections = []
        }
        presenter.present(activity, animated: true)
    }

    @MainActor
    private static func topViewController(
        base: UIViewController? = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
    ) -> UIViewController? {
        if let nav = base as? UINavigationController {
            return topViewController(base: nav.visibleViewController)
        }
        if let tab = base as? UITabBarController {
            return topViewController(base: tab.selectedViewController)
        }
        if let presented = base?.presentedViewController {
            return topViewController(base: presented)
        }
        return base
    }

    private func dismissShareErrorAfterDelay() {
        Task {
            try? await Task.sleep(for: .seconds(3))
            await MainActor.run { shareErrorMessage = nil }
        }
    }
}

private struct ZoomableRemoteImagePage: View {
    let url: URL
    @Binding var isZoomed: Bool
    @State private var loadState: ZoomableRemoteImageView.LoadState = .loading

    var body: some View {
        ZStack {
            ZoomableRemoteImageView(url: url, isZoomed: $isZoomed, loadState: $loadState)

            switch loadState {
            case .loading:
                ProgressView()
                    .tint(.white)
            case .failed:
                VStack(spacing: 12) {
                    Image(systemName: "photo")
                        .font(.largeTitle)
                    Link("Open in browser", destination: url)
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(.white)
            case .loaded:
                EmptyView()
            }
        }
    }
}

struct ZoomableRemoteImageView: UIViewRepresentable {
    enum LoadState {
        case loading
        case loaded
        case failed
    }

    let url: URL
    @Binding var isZoomed: Bool
    @Binding var loadState: LoadState

    func makeCoordinator() -> Coordinator {
        Coordinator(isZoomed: $isZoomed, loadState: $loadState)
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 4
        scrollView.backgroundColor = .clear
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never

        let imageView = UIImageView()
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        scrollView.addSubview(imageView)

        context.coordinator.scrollView = scrollView
        context.coordinator.imageView = imageView
        context.coordinator.load(url: url)
        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        if context.coordinator.loadedURL != url {
            context.coordinator.load(url: url)
        } else if scrollView.bounds.width > 0 {
            context.coordinator.layoutImage()
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        @Binding var isZoomed: Bool
        @Binding var loadState: LoadState
        weak var scrollView: UIScrollView?
        weak var imageView: UIImageView?
        var loadedURL: URL?
        private var loadTask: Task<Void, Never>?

        init(isZoomed: Binding<Bool>, loadState: Binding<LoadState>) {
            _isZoomed = isZoomed
            _loadState = loadState
        }

        deinit {
            loadTask?.cancel()
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            isZoomed = scrollView.zoomScale > 1.01
            centerImage(in: scrollView)
        }

        func load(url: URL) {
            loadTask?.cancel()
            loadedURL = url
            imageView?.image = nil
            scrollView?.zoomScale = 1
            isZoomed = false
            loadState = .loading

            loadTask = Task {
                do {
                    let (data, _) = try await URLSession.shared.data(from: url)
                    guard !Task.isCancelled, let image = UIImage(data: data) else {
                        await MainActor.run {
                            guard self.loadedURL == url else { return }
                            self.loadState = .failed
                        }
                        return
                    }
                    await MainActor.run {
                        guard self.loadedURL == url else { return }
                        self.imageView?.image = image
                        self.scrollView?.zoomScale = 1
                        self.isZoomed = false
                        self.loadState = .loaded
                        self.layoutImage()
                    }
                } catch {
                    await MainActor.run {
                        guard self.loadedURL == url else { return }
                        self.loadState = .failed
                    }
                }
            }
        }

        func layoutImage() {
            guard let scrollView, let imageView, let image = imageView.image else { return }
            let bounds = scrollView.bounds.size
            guard bounds.width > 0, bounds.height > 0 else { return }

            let imageSize = image.size
            guard imageSize.width > 0, imageSize.height > 0 else { return }

            let widthScale = bounds.width / imageSize.width
            let heightScale = bounds.height / imageSize.height
            let fitScale = min(widthScale, heightScale)
            let fittedSize = CGSize(width: imageSize.width * fitScale, height: imageSize.height * fitScale)

            imageView.frame = CGRect(origin: .zero, size: fittedSize)
            scrollView.contentSize = fittedSize
            scrollView.zoomScale = 1
            centerImage(in: scrollView)
        }

        private func centerImage(in scrollView: UIScrollView) {
            guard let imageView else { return }
            let boundsSize = scrollView.bounds.size
            var frameToCenter = imageView.frame

            if frameToCenter.size.width < boundsSize.width {
                frameToCenter.origin.x = (boundsSize.width - frameToCenter.size.width) / 2
            } else {
                frameToCenter.origin.x = 0
            }

            if frameToCenter.size.height < boundsSize.height {
                frameToCenter.origin.y = (boundsSize.height - frameToCenter.size.height) / 2
            } else {
                frameToCenter.origin.y = 0
            }

            imageView.frame = frameToCenter
        }
    }
}
