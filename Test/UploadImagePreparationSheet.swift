//
//  UploadImagePreparationSheet.swift
//  Test
//
//  Slot-specific aspect presets, then a dimmed full-image view with a draggable
//  (and pinch-resizable) crop frame for single-photo uploads. Multi-select still
//  uses center crop per image with the chosen aspect.
//

import SwiftUI
import UIKit

// MARK: - Identifiable tokens for .sheet(item:)

struct SingleImageCropSheetItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

struct MultiImageCropSheetItem: Identifiable {
    let id = UUID()
    let images: [UIImage]
}

// MARK: - Short guidance per upload context

enum UploadImageAdvice {
    static let hero = "Hero is a fixed 16:9 frame. Drag the white frame over your photo; pinch to resize. What the frame shows is exactly what visitors see."
    /// Luxe full-bleed wide hero (Design → Home + crop sheet when Luxe is selected).
    static let heroLuxe = "Luxe hero is a fixed 16:9 frame across the whole page. Drag the white frame to pick the exact crop; keep the subject clear of the left side where your text sits."
    static let studioAux = "Side image is a fixed frame (philosophy 4:5, CTA 4:3). Drag the white frame to pick your crop. Simple backgrounds keep nearby text readable."
    static let gallery = "Gallery cells are a fixed shape for every photo. Drag the frame to pick your crop. Several photos at once use the same framing with a center crop on each."
    /// Studio 12 live site shows the full uploaded bitmap inside gallery tiles (no second browser crop).
    static let galleryStudio12 = "Studio 12 home strip and /gallery tiles show your whole upload (letterboxed if needed). Portrait 4:5 is closest to strip tiles—drag the frame to compose. Several photos at once use center crop with the same framing."
    static let featured = "Strong single shots for the home strip—finished work or a signature look. Drag the crop frame; multi-select uses center crop on each with the same framing."
    static let product = "Clear product on a simple background; square or centered framing reads best in the shop grid."
    static let profile = "Face-forward or logo-style image; square framing matches the round avatar on your account."
}

// MARK: - Aspect choice

enum UploadCropAspectChoice: String, CaseIterable, Identifiable {
    case original
    case square
    case portrait4_5
    case portrait3_4
    case landscape4_3
    case landscape16_9

    var id: String { rawValue }

    var title: String {
        switch self {
        case .original: return "Original (no crop)"
        case .square: return "Square 1:1"
        case .portrait4_5: return "Portrait 4:5"
        case .portrait3_4: return "Portrait 3:4"
        case .landscape4_3: return "Landscape 4:3"
        case .landscape16_9: return "Wide 16:9"
        }
    }

    /// `nil` means do not aspect-crop.
    var aspectWidthOverHeight: CGFloat? {
        switch self {
        case .original: return nil
        case .square: return 1
        case .portrait4_5: return 4 / 5
        case .portrait3_4: return 3 / 4
        case .landscape4_3: return 4 / 3
        case .landscape16_9: return 16 / 9
        }
    }
}

// MARK: - Preset menus per upload destination

enum UploadCropPresetMenu {
    /// Hero / large vertical site imagery
    static let hero: [UploadCropAspectChoice] = [.portrait3_4, .portrait4_5, .landscape16_9, .square, .original]
    /// Luxe full-bleed wide hero (`background-size: cover`): wide presets first so exports match the live crop better.
    static let heroLuxe: [UploadCropAspectChoice] = [.landscape16_9, .landscape4_3, .portrait3_4, .portrait4_5, .square, .original]
    /// Gallery page / portfolio grids
    static let gallery: [UploadCropAspectChoice] = [.landscape4_3, .landscape16_9, .portrait4_5, .square, .original]
    /// Studio 12 home marquee + /gallery: prioritize ~4:5 to match tile proportions.
    static let studio12Gallery: [UploadCropAspectChoice] = [.portrait4_5, .portrait3_4, .landscape4_3, .square, .landscape16_9, .original]
    /// Home featured strip
    static let featured: [UploadCropAspectChoice] = [.portrait4_5, .portrait3_4, .square, .landscape4_3, .original]
    /// Studio 12 side columns
    static let studioAux: [UploadCropAspectChoice] = [.portrait3_4, .portrait4_5, .square, .original]
    /// Shop product
    static let product: [UploadCropAspectChoice] = [.square, .portrait4_5, .landscape4_3, .original]
    /// Account avatar
    static let profile: [UploadCropAspectChoice] = [.square, .original]
}

// MARK: - Single-image crop for export (pixel space, upright image)

struct InteractiveCropParameters: Equatable {
    /// Crop rectangle in pixels of `normalizedForUploadCrop()` CGImage coordinates.
    var cropRectPixels: CGRect
}

// MARK: - Crop box geometry (pixel space, fixed aspect)

private enum CropBoxMath {
    /// Largest axis-aligned rect with given aspect inside pw × ph, centered.
    static func initialMaxCrop(pixelW pw: CGFloat, pixelH ph: CGFloat, aspectWidthOverHeight aspect: CGFloat) -> CGRect {
        guard pw > 1, ph > 1, aspect > 0 else {
            return CGRect(x: 0, y: 0, width: max(1, pw), height: max(1, ph))
        }
        let ai = pw / ph
        let w: CGFloat
        let h: CGFloat
        let x: CGFloat
        let y: CGFloat
        if ai >= aspect {
            h = ph
            w = h * aspect
            x = (pw - w) / 2
            y = 0
        } else {
            w = pw
            h = w / aspect
            x = 0
            y = (ph - h) / 2
        }
        return CGRect(x: x, y: y, width: w, height: h).standardized
    }

    static func clampOriginPreservingSize(_ r: CGRect, pixelW pw: CGFloat, pixelH ph: CGFloat) -> CGRect {
        let s = r.standardized
        let x = min(max(0, s.origin.x), pw - s.width)
        let y = min(max(0, s.origin.y), ph - s.height)
        return CGRect(origin: CGPoint(x: x, y: y), size: s.size)
    }

    /// Minimum width/height in pixels (both enforced via aspect).
    static func minCropSize(pixelW pw: CGFloat, pixelH ph: CGFloat, aspect: CGFloat) -> CGFloat {
        let m = min(pw, ph)
        return max(32, m * 0.06)
    }

    /// Scale `r` uniformly about its center by `factor`, keep aspect, clamp inside image.
    static func scaleRectAboutCenter(
        _ r: CGRect,
        factor: CGFloat,
        pixelW pw: CGFloat,
        pixelH ph: CGFloat,
        aspect: CGFloat
    ) -> CGRect {
        let s = r.standardized
        guard s.width > 0, s.height > 0, factor > 0, pw > 0, ph > 0 else { return s }
        let cx = s.midX
        let cy = s.midY
        let minW = minCropSize(pixelW: pw, pixelH: ph, aspect: aspect)
        let maxByW = min(pw, ph * aspect)
        let maxByH = min(ph, pw / aspect)
        var nw = min(max(s.width * factor, minW), maxByW)
        var nh = nw / aspect
        if nh > maxByH {
            nh = maxByH
            nw = nh * aspect
        }
        var x = cx - nw / 2
        var y = cy - nh / 2
        x = min(max(0, x), pw - nw)
        y = min(max(0, y), ph - nh)
        return CGRect(x: x, y: y, width: nw, height: nh).standardized
    }
}

// MARK: - UIImage helpers

extension UIImage {
    func normalizedForUploadCrop() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// Center-crop in pixel space to `aspect` width ÷ height.
    func centerCropped(toAspectWidthOverHeight aspect: CGFloat) -> UIImage {
        let img = normalizedForUploadCrop()
        guard let cg = img.cgImage else { return img }
        let pixelW = CGFloat(cg.width)
        let pixelH = CGFloat(cg.height)
        guard pixelW > 1, pixelH > 1, aspect > 0 else { return img }

        let imageAspect = pixelW / pixelH
        let cropRect: CGRect
        if imageAspect > aspect {
            let newW = pixelH * aspect
            cropRect = CGRect(x: floor((pixelW - newW) / 2), y: 0, width: newW, height: pixelH)
        } else {
            let newH = pixelW / aspect
            cropRect = CGRect(x: 0, y: floor((pixelH - newH) / 2), width: pixelW, height: newH)
        }

        guard let cropped = cg.cropping(to: cropRect) else { return img }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    func croppedToPixelRect(_ rect: CGRect) -> UIImage? {
        let img = normalizedForUploadCrop()
        guard let cg = img.cgImage else { return nil }
        let pw = CGFloat(cg.width)
        let ph = CGFloat(cg.height)
        let bounds = CGRect(x: 0, y: 0, width: pw, height: ph)
        let r = rect.standardized.intersection(bounds)
        guard r.width > 1, r.height > 1 else { return nil }
        let integral = CGRect(
            x: floor(r.origin.x),
            y: floor(r.origin.y),
            width: ceil(r.width),
            height: ceil(r.height)
        )
        .intersection(bounds)
        guard integral.width > 0, integral.height > 0,
              let cropped = cg.cropping(to: integral) else { return nil }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    func applyingUploadCropChoice(_ choice: UploadCropAspectChoice) -> UIImage {
        guard let aspect = choice.aspectWidthOverHeight else {
            return normalizedForUploadCrop()
        }
        return centerCropped(toAspectWidthOverHeight: aspect)
    }

    func jpegDataForUploadCropExport(compressionQuality: CGFloat = 0.92) -> Data? {
        jpegData(compressionQuality: compressionQuality)
    }
}

// MARK: - Draggable crop frame over full image (single image)

private struct DraggableCropBoxEditor: View {
    let image: UIImage
    let aspectWidthOverHeight: CGFloat
    @Binding var cropRectPixels: CGRect

    @State private var dragStartCrop: CGRect?
    @State private var pinchStartCrop: CGRect?

    private var normalized: UIImage { image.normalizedForUploadCrop() }

    private var pixelWH: (CGFloat, CGFloat) {
        guard let cg = normalized.cgImage else { return (1, 1) }
        return (CGFloat(cg.width), CGFloat(cg.height))
    }

    var body: some View {
        GeometryReader { geo in
            let container = geo.size
            let (pw, ph) = pixelWH
            let s = min(container.width / pw, container.height / ph)
            let iw = pw * s
            let ih = ph * s
            let ix = (container.width - iw) / 2
            let iy = (container.height - ih) / 2
            let imageRect = CGRect(x: ix, y: iy, width: iw, height: ih)

            let crop = cropRectPixels.standardized
            let cropViewW = crop.width / pw * imageRect.width
            let cropViewH = crop.height / ph * imageRect.height
            let cropMidX = imageRect.minX + crop.midX / pw * imageRect.width
            let cropMidY = imageRect.minY + crop.midY / ph * imageRect.height

            ZStack {
                Image(uiImage: normalized)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: container.width, height: container.height)

                ZStack {
                    Rectangle()
                        .fill(Color.black.opacity(0.52))
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .frame(width: max(1, cropViewW), height: max(1, cropViewH))
                        .position(x: cropMidX, y: cropMidY)
                        .blendMode(.destinationOut)
                }
                .compositingGroup()

                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: 2.5)
                    .frame(width: max(1, cropViewW), height: max(1, cropViewH))
                    .position(x: cropMidX, y: cropMidY)
                    .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { g in
                        if dragStartCrop == nil { dragStartCrop = cropRectPixels.standardized }
                        guard let start = dragStartCrop else { return }
                        let dpx = g.translation.width / s
                        let dpy = g.translation.height / s
                        let moved = start.offsetBy(dx: dpx, dy: dpy)
                        cropRectPixels = CropBoxMath.clampOriginPreservingSize(moved, pixelW: pw, pixelH: ph)
                    }
                    .onEnded { _ in
                        dragStartCrop = nil
                    }
            )
            .simultaneousGesture(
                MagnificationGesture()
                    .onChanged { mag in
                        if pinchStartCrop == nil { pinchStartCrop = cropRectPixels.standardized }
                        guard let start = pinchStartCrop else { return }
                        cropRectPixels = CropBoxMath.scaleRectAboutCenter(
                            start,
                            factor: mag,
                            pixelW: pw,
                            pixelH: ph,
                            aspect: aspectWidthOverHeight
                        )
                    }
                    .onEnded { mag in
                        guard let start = pinchStartCrop else { return }
                        cropRectPixels = CropBoxMath.scaleRectAboutCenter(
                            start,
                            factor: mag,
                            pixelW: pw,
                            pixelH: ph,
                            aspect: aspectWidthOverHeight
                        )
                        pinchStartCrop = nil
                    }
            )
            .onChange(of: geo.size) { _, _ in
                cropRectPixels = CropBoxMath.clampOriginPreservingSize(cropRectPixels, pixelW: pw, pixelH: ph)
            }
        }
    }
}

// MARK: - Export

enum UploadImageCropExport {
    static func jpegDataList(
        from images: [UIImage],
        choice: UploadCropAspectChoice,
        interactive: InteractiveCropParameters?,
        allowsInteractive: Bool
    ) -> [Data] {
        if choice == .original {
            return images.compactMap { $0.normalizedForUploadCrop().jpegDataForUploadCropExport() }
        }
        guard let aspect = choice.aspectWidthOverHeight else {
            return images.compactMap { $0.normalizedForUploadCrop().jpegDataForUploadCropExport() }
        }

        if images.count > 1 {
            return images.compactMap { $0.centerCropped(toAspectWidthOverHeight: aspect).jpegDataForUploadCropExport() }
        }

        guard let img = images.first,
              allowsInteractive,
              let p = interactive,
              p.cropRectPixels.width > 1,
              p.cropRectPixels.height > 1,
              let cropped = img.croppedToPixelRect(p.cropRectPixels)
        else {
            return images.compactMap { $0.centerCropped(toAspectWidthOverHeight: aspect).jpegDataForUploadCropExport() }
        }
        return [cropped].compactMap { $0.jpegDataForUploadCropExport() }
    }
}

// MARK: - Sheet

struct UploadImagePreparationSheet: View {
    @Environment(\.dismiss) private var dismiss

    let images: [UIImage]
    let advice: String
    let navigationTitle: String
    let allowedChoices: [UploadCropAspectChoice]
    let defaultChoice: UploadCropAspectChoice
    let confirmButtonTitle: String
    let onUseJPEGData: ([Data]) -> Void

    @State private var choice: UploadCropAspectChoice
    @State private var cropRectPixels: CGRect = .zero

    init(
        images: [UIImage],
        advice: String,
        navigationTitle: String = "Adjust photo",
        allowedChoices: [UploadCropAspectChoice],
        defaultChoice: UploadCropAspectChoice,
        confirmButtonTitle: String = "Use photo",
        onUseJPEGData: @escaping ([Data]) -> Void
    ) {
        self.images = images
        self.advice = advice
        self.navigationTitle = navigationTitle
        self.allowedChoices = allowedChoices.isEmpty ? [.original] : allowedChoices
        let resolvedDefault = self.allowedChoices.contains(defaultChoice)
            ? defaultChoice
            : (self.allowedChoices.first ?? .original)
        self.defaultChoice = resolvedDefault
        self.confirmButtonTitle = images.count > 1 ? "Use \(images.count) photos" : confirmButtonTitle
        self.onUseJPEGData = onUseJPEGData
        _choice = State(initialValue: resolvedDefault)
    }

    private var previewImage: UIImage { images.first ?? UIImage() }

    private var previewAspect: CGFloat? { choice.aspectWidthOverHeight }

    private var contentWidth: CGFloat {
        max(200, UIScreen.main.bounds.width - 40)
    }

    private func previewHeight(forContentWidth w: CGFloat) -> CGFloat {
        if let asp = previewAspect {
            return min(340, max(120, w / asp))
        }
        let im = previewImage.normalizedForUploadCrop()
        guard let cg = im.cgImage, cg.width > 0 else { return 220 }
        let iw = CGFloat(cg.width)
        let ih = CGFloat(cg.height)
        let fitH = w * (ih / iw)
        return min(300, max(140, fitH))
    }

    /// Taller region so vertical photos show with room to move the crop frame.
    private var editorContainerSize: CGSize {
        let w = contentWidth
        let h = min(480, max(240, w * 1.22))
        return CGSize(width: w, height: h)
    }

    private var useInteractiveEditor: Bool {
        images.count == 1 && previewAspect != nil
    }

    private func resetCropRectForCurrentChoice() {
        guard let asp = choice.aspectWidthOverHeight,
              let cg = previewImage.normalizedForUploadCrop().cgImage else {
            cropRectPixels = .zero
            return
        }
        let pw = CGFloat(cg.width)
        let ph = CGFloat(cg.height)
        cropRectPixels = CropBoxMath.initialMaxCrop(pixelW: pw, pixelH: ph, aspectWidthOverHeight: asp)
    }

    private func previewOriginal(width w: CGFloat, height h: CGFloat) -> some View {
        let im = previewImage.normalizedForUploadCrop()
        return Image(uiImage: im)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: w, maxHeight: h)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(advice)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if images.count > 1 {
                        Text("Several photos: the same framing is center-cropped on each. Add one photo at a time to drag and resize the frame.")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    } else if previewAspect != nil {
                        Text("Drag the white frame to choose the area. Pinch to resize it.")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 12) {
                        if useInteractiveEditor, let asp = previewAspect {
                            DraggableCropBoxEditor(
                                image: previewImage,
                                aspectWidthOverHeight: asp,
                                cropRectPixels: $cropRectPixels
                            )
                            .frame(width: editorContainerSize.width, height: editorContainerSize.height)
                        } else if previewAspect != nil {
                            let w = contentWidth
                            let h = previewHeight(forContentWidth: w)
                            ZStack {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Color(.secondarySystemGroupedBackground))
                                Image(uiImage: previewImage.applyingUploadCropChoice(choice))
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: w, height: h)
                                    .clipped()
                            }
                            .frame(width: w, height: h)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        } else {
                            let w = contentWidth
                            let h = previewHeight(forContentWidth: w)
                            ZStack {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Color(.secondarySystemGroupedBackground))
                                previewOriginal(width: w, height: h)
                            }
                            .frame(width: w, height: h)
                        }

                        if allowedChoices.count > 1 {
                            Picker("Framing", selection: $choice) {
                                ForEach(allowedChoices) { option in
                                    Text(option.title).tag(option)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                    }
                }
                .padding(20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmButtonTitle) {
                        let interactive: InteractiveCropParameters? = useInteractiveEditor
                            ? InteractiveCropParameters(cropRectPixels: cropRectPixels.standardized)
                            : nil
                        let list = UploadImageCropExport.jpegDataList(
                            from: images,
                            choice: choice,
                            interactive: interactive,
                            allowsInteractive: useInteractiveEditor
                        )
                        guard !list.isEmpty else { return }
                        onUseJPEGData(list)
                        dismiss()
                    }
                }
            }
            .onAppear {
                resetCropRectForCurrentChoice()
            }
            .onChange(of: choice) { _, _ in
                resetCropRectForCurrentChoice()
            }
        }
    }
}
