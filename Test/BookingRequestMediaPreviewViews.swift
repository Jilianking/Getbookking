//
//  BookingRequestMediaPreviewViews.swift
//
//  Full-screen reference photo viewer with pinch zoom and save to Photos.
//

import Photos
import SwiftUI
import UIKit

struct BookingRequestMediaFullScreenPreview: View {
    let urls: [URL]
    let initialIndex: Int

    @Environment(\.dismiss) private var dismiss
    @State private var pageIndex: Int
    @State private var isZoomed = false
    @State private var isSaving = false
    @State private var didSaveSuccessfully = false
    @State private var saveErrorMessage: String?

    init(urls: [URL], initialIndex: Int) {
        self.urls = urls
        self.initialIndex = initialIndex
        _pageIndex = State(initialValue: initialIndex)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $pageIndex) {
                ForEach(Array(urls.enumerated()), id: \.offset) { index, url in
                    ZoomableRemoteImagePage(url: url, isZoomed: $isZoomed)
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: urls.count > 1 ? .automatic : .never))
            .scrollDisabled(isZoomed)
            .onChange(of: pageIndex) { _, _ in
                isZoomed = false
            }

            VStack {
                HStack(spacing: 16) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 28))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.white.opacity(0.35))
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Close")

                    Spacer()

                    Button {
                        Task { await saveCurrentPhoto() }
                    } label: {
                        Group {
                            if isSaving {
                                ProgressView()
                                    .tint(.white)
                            } else if didSaveSuccessfully {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 22, weight: .medium))
                            } else {
                                Label("Save", systemImage: "square.and.arrow.down")
                                    .labelStyle(.iconOnly)
                                    .font(.system(size: 22, weight: .medium))
                            }
                        }
                        .frame(width: 44, height: 44)
                    }
                    .disabled(isSaving || didSaveSuccessfully)
                    .accessibilityLabel("Save to Photos")
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.top, 8)

                Spacer()

                if let saveErrorMessage {
                    Text(saveErrorMessage)
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
            }
            .animation(.easeInOut(duration: 0.2), value: saveErrorMessage)
        }
    }

    private func saveCurrentPhoto() async {
        guard urls.indices.contains(pageIndex) else { return }
        await MainActor.run {
            isSaving = true
            saveErrorMessage = nil
        }
        defer { Task { @MainActor in isSaving = false } }

        do {
            try await BookingRequestPhotoLibrarySaver.saveImage(from: urls[pageIndex])
            await MainActor.run {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                didSaveSuccessfully = true
            }
            try? await Task.sleep(for: .seconds(1.5))
            await MainActor.run { didSaveSuccessfully = false }
        } catch BookingRequestPhotoLibrarySaver.Error.denied {
            await MainActor.run {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                saveErrorMessage = "Allow Photos access in Settings to save images."
                dismissSaveErrorAfterDelay()
            }
        } catch {
            await MainActor.run {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                saveErrorMessage = "Couldn’t save photo."
                dismissSaveErrorAfterDelay()
            }
        }
    }

    private func dismissSaveErrorAfterDelay() {
        Task {
            try? await Task.sleep(for: .seconds(3))
            await MainActor.run { saveErrorMessage = nil }
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

enum BookingRequestPhotoLibrarySaver {
    enum Error: LocalizedError {
        case invalidImage
        case denied
        case failed

        var errorDescription: String? {
            switch self {
            case .invalidImage: return "This file couldn’t be saved as a photo."
            case .denied: return "Photos access was denied."
            case .failed: return "Saving to Photos failed."
            }
        }
    }

    static func saveImage(from url: URL) async throws {
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let image = UIImage(data: data) else { throw Error.invalidImage }

        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        switch status {
        case .authorized, .limited:
            break
        default:
            throw Error.denied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Swift.Error>) in
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }, completionHandler: { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: Error.failed)
                }
            })
        }
    }
}
