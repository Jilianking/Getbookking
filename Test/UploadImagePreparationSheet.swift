//
//  UploadImagePreparationSheet.swift
//  Test
//
//  Slot-specific aspect presets, then a fixed-aspect crop window (Instagram-style):
//  pan and pinch the photo behind the mask; optional 90° rotate. Multi-select still
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
    static let hero = "Hero uses a fixed frame on your site. Drag to move your photo, pinch to zoom—what you see inside the white border is what visitors see (16:9 and other ratios in the menu)."
    /// Luxe full-bleed wide hero (Design → Home + crop sheet when Luxe is selected).
    static let heroLuxe = "Luxe hero is a wide fixed frame. Move and zoom your photo behind the border; keep the subject clear of the left where your text sits."
    static let studioAux = "Side images use a fixed frame (philosophy 4:5, CTA 4:3). Move and zoom your photo behind the border. Simple backgrounds keep nearby text readable."
    static let gallery = "Gallery uses a fixed cell shape. Move and zoom behind the border. Several photos at once use the same framing with a center crop on each."
    /// Studio 12 live site shows the full uploaded bitmap inside gallery tiles (no second browser crop).
    static let galleryStudio12 = "Studio 12 tiles show your whole upload (letterboxed if needed). Portrait 4:5 is closest to strip tiles—compose inside the border. Several photos at once use center crop with the same framing."
    static let featured = "Strong single shots for the home strip. Move and zoom inside the border; multi-select uses center crop on each with the same framing."
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

// MARK: - Single-image crop for export (fixed mask → pixel rect on working image)

/// Replay data for `FixedMaskCropExport.pixelCropRect` / `croppedUsingFixedMask`.
struct InteractiveCropParameters: Equatable {
    var editorWidth: CGFloat
    var editorHeight: CGFloat
    var maskAspectWidthOverHeight: CGFloat
    /// Pinch multiplier on top of the minimum “cover” scale (≥ 1).
    var userScale: CGFloat
    /// Pan of the image center vs editor center, in points.
    var offsetWidth: CGFloat
    var offsetHeight: CGFloat
    var imagePixelWidth: CGFloat
    var imagePixelHeight: CGFloat
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

    /// 90° clockwise in pixel space (scale 1); chain for 180° / 270°.
    func rotatedClockwise90ForUpload() -> UIImage {
        let img = normalizedForUploadCrop()
        guard let cg = img.cgImage else { return img }
        let w = CGFloat(cg.width)
        let h = CGFloat(cg.height)
        guard w > 1, h > 1 else { return img }
        let outSize = CGSize(width: h, height: w)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: outSize, format: format)
        return renderer.image { ctx in
            ctx.cgContext.translateBy(x: outSize.width, y: 0)
            ctx.cgContext.rotate(by: .pi / 2)
            img.draw(in: CGRect(x: 0, y: 0, width: w, height: h))
        }
    }
}

// MARK: - Fixed mask ↔ pixel crop (export must match on-screen geometry)

private enum FixedMaskCropExport {
    /// Largest axis-aligned mask with aspect `a` inside W×H.
    static func maskSize(containerWidth W: CGFloat, containerHeight H: CGFloat, aspectWidthOverHeight a: CGFloat) -> (mw: CGFloat, mh: CGFloat) {
        guard W > 1, H > 1, a > 0 else { return (min(W, 1), min(H, 1)) }
        var mw = min(W, H * a)
        var mh = mw / a
        if mh > H {
            mh = H
            mw = mh * a
        }
        return (mw, mh)
    }

    static func pixelCropRect(parameters p: InteractiveCropParameters) -> CGRect {
        pixelCropRect(
            editorWidth: p.editorWidth,
            editorHeight: p.editorHeight,
            aspectWidthOverHeight: p.maskAspectWidthOverHeight,
            pixelW: p.imagePixelWidth,
            pixelH: p.imagePixelHeight,
            userScale: p.userScale,
            offset: CGSize(width: p.offsetWidth, height: p.offsetHeight)
        )
    }

    static func pixelCropRect(
        editorWidth W: CGFloat,
        editorHeight H: CGFloat,
        aspectWidthOverHeight a: CGFloat,
        pixelW pw: CGFloat,
        pixelH ph: CGFloat,
        userScale: CGFloat,
        offset: CGSize
    ) -> CGRect {
        let (Mw, Mh) = maskSize(containerWidth: W, containerHeight: H, aspectWidthOverHeight: a)
        let mx = (W - Mw) / 2
        let my = (H - Mh) / 2
        let base = max(Mw / max(pw, 1), Mh / max(ph, 1))
        let s = max(1, userScale)
        let imgW = pw * base * s
        let imgH = ph * base * s
        let cx = W / 2 + offset.width
        let cy = H / 2 + offset.height
        let imLeft = cx - imgW / 2
        let imTop = cy - imgH / 2

        func toPixel(vx: CGFloat, vy: CGFloat) -> CGPoint {
            CGPoint(x: (vx - imLeft) * pw / max(imgW, 1), y: (vy - imTop) * ph / max(imgH, 1))
        }

        let p00 = toPixel(vx: mx, vy: my)
        let p10 = toPixel(vx: mx + Mw, vy: my)
        let p01 = toPixel(vx: mx, vy: my + Mh)
        let p11 = toPixel(vx: mx + Mw, vy: my + Mh)
        let minX = min(p00.x, p10.x, p01.x, p11.x)
        let maxX = max(p00.x, p10.x, p01.x, p11.x)
        let minY = min(p00.y, p10.y, p01.y, p11.y)
        let maxY = max(p00.y, p10.y, p01.y, p11.y)
        let bounds = CGRect(x: 0, y: 0, width: pw, height: ph)
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            .standardized
            .intersection(bounds)
    }

    /// Keep the scaled image covering the full mask after pan or zoom.
    static func clampOffset(
        offset: CGSize,
        editorWidth W: CGFloat,
        editorHeight H: CGFloat,
        aspectWidthOverHeight a: CGFloat,
        pixelW pw: CGFloat,
        pixelH ph: CGFloat,
        userScale: CGFloat
    ) -> CGSize {
        let (Mw, Mh) = maskSize(containerWidth: W, containerHeight: H, aspectWidthOverHeight: a)
        let mx = (W - Mw) / 2
        let my = (H - Mh) / 2
        let base = max(Mw / max(pw, 1), Mh / max(ph, 1))
        let s = max(1, userScale)
        let imgW = pw * base * s
        let imgH = ph * base * s

        let oxMin = mx + Mw - W / 2 - imgW / 2
        let oxMax = mx - W / 2 + imgW / 2
        let oyMin = my + Mh - H / 2 - imgH / 2
        let oyMax = my - H / 2 + imgH / 2

        let ox: CGFloat
        if oxMin <= oxMax {
            ox = min(max(offset.width, oxMin), oxMax)
        } else {
            ox = (oxMin + oxMax) / 2
        }
        let oy: CGFloat
        if oyMin <= oyMax {
            oy = min(max(offset.height, oyMin), oyMax)
        } else {
            oy = (oyMin + oyMax) / 2
        }
        return CGSize(width: ox, height: oy)
    }
}

// MARK: - Fixed crop mask; pan / pinch image behind it (+ rotate via binding)

private struct FixedMaskImageEditor: View {
    @Binding var workingImage: UIImage
    let aspectWidthOverHeight: CGFloat
    @Binding var userScale: CGFloat
    @Binding var offset: CGSize

    private static let maxUserScale: CGFloat = 8

    @State private var dragStartOffset: CGSize?
    @State private var pinchStartScale: CGFloat?

    private var pixelWH: (CGFloat, CGFloat) {
        let im = workingImage.normalizedForUploadCrop()
        guard let cg = im.cgImage else { return (1, 1) }
        return (CGFloat(cg.width), CGFloat(cg.height))
    }

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let (Mw, Mh) = FixedMaskCropExport.maskSize(containerWidth: W, containerHeight: H, aspectWidthOverHeight: aspectWidthOverHeight)
            let (pw, ph) = pixelWH

            let baseScale = max(Mw / max(pw, 1), Mh / max(ph, 1))
            let visScale = max(1, userScale)
            let imgW = pw * baseScale * visScale
            let imgH = ph * baseScale * visScale

            ZStack {
                Color.black.opacity(0.82)

                ZStack {
                    Image(uiImage: workingImage.normalizedForUploadCrop())
                        .resizable()
                        .interpolation(.high)
                        .frame(width: imgW, height: imgH)
                        .position(x: Mw / 2 + offset.width, y: Mh / 2 + offset.height)
                }
                .frame(width: max(1, Mw), height: max(1, Mh))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .position(x: W / 2, y: H / 2)

                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: 2.5)
                    .frame(width: max(1, Mw), height: max(1, Mh))
                    .position(x: W / 2, y: H / 2)
                    .allowsHitTesting(false)
                    .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { g in
                        if dragStartOffset == nil { dragStartOffset = offset }
                        guard let start = dragStartOffset else { return }
                        let next = CGSize(width: start.width + g.translation.width, height: start.height + g.translation.height)
                        offset = FixedMaskCropExport.clampOffset(
                            offset: next,
                            editorWidth: W,
                            editorHeight: H,
                            aspectWidthOverHeight: aspectWidthOverHeight,
                            pixelW: pw,
                            pixelH: ph,
                            userScale: userScale
                        )
                    }
                    .onEnded { _ in
                        dragStartOffset = nil
                    }
            )
            .simultaneousGesture(
                MagnificationGesture()
                    .onChanged { mag in
                        if pinchStartScale == nil { pinchStartScale = userScale }
                        guard let start = pinchStartScale else { return }
                        let next = min(Self.maxUserScale, max(1, start * mag))
                        userScale = next
                        offset = FixedMaskCropExport.clampOffset(
                            offset: offset,
                            editorWidth: W,
                            editorHeight: H,
                            aspectWidthOverHeight: aspectWidthOverHeight,
                            pixelW: pw,
                            pixelH: ph,
                            userScale: userScale
                        )
                    }
                    .onEnded { _ in
                        pinchStartScale = nil
                    }
            )
            .onChange(of: geo.size) { _, _ in
                offset = FixedMaskCropExport.clampOffset(
                    offset: offset,
                    editorWidth: W,
                    editorHeight: H,
                    aspectWidthOverHeight: aspectWidthOverHeight,
                    pixelW: pw,
                    pixelH: ph,
                    userScale: userScale
                )
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
              let p = interactive
        else {
            return images.compactMap { $0.centerCropped(toAspectWidthOverHeight: aspect).jpegDataForUploadCropExport() }
        }
        let cropRect = FixedMaskCropExport.pixelCropRect(parameters: p)
        guard cropRect.width > 1, cropRect.height > 1,
              let cropped = img.normalizedForUploadCrop().croppedToPixelRect(cropRect)
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
    /// When `false`, omits advice and the extra crop hints (Quick edit / power users who already know the editor).
    let showsInstructionalCopy: Bool
    let onUseJPEGData: ([Data]) -> Void

    @State private var choice: UploadCropAspectChoice
    /// Upright pixel bitmap shown in the editor (rotates in-place for 90° steps).
    @State private var workingImageForCrop = UIImage()
    @State private var editorUserScale: CGFloat = 1
    @State private var editorOffset: CGSize = .zero

    init(
        images: [UIImage],
        advice: String,
        navigationTitle: String = "Adjust photo",
        allowedChoices: [UploadCropAspectChoice],
        defaultChoice: UploadCropAspectChoice,
        confirmButtonTitle: String = "Use photo",
        showsInstructionalCopy: Bool = true,
        onUseJPEGData: @escaping ([Data]) -> Void
    ) {
        self.images = images
        self.advice = advice
        self.navigationTitle = navigationTitle
        self.showsInstructionalCopy = showsInstructionalCopy
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

    /// Match the editor region to the chosen crop shape so wide hero crops do not waste vertical space.
    private var editorContainerSize: CGSize {
        let w = contentWidth
        guard let aspect = previewAspect, aspect > 0 else {
            return CGSize(width: w, height: min(480, max(240, w * 1.22)))
        }

        let cropHeight = w / aspect
        let breathingRoom: CGFloat = aspect >= 1 ? 36 : 0
        let minHeight: CGFloat = aspect >= 1 ? 180 : 240
        let maxHeight: CGFloat = aspect >= 1 ? 340 : 480
        let h = min(maxHeight, max(minHeight, cropHeight + breathingRoom))
        return CGSize(width: w, height: h)
    }

    private var useInteractiveEditor: Bool {
        images.count == 1 && previewAspect != nil
    }

    private func resetEditorFromPreview() {
        workingImageForCrop = previewImage.normalizedForUploadCrop()
        editorUserScale = 1
        editorOffset = .zero
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
                VStack(alignment: .leading, spacing: showsInstructionalCopy ? 20 : 12) {
                    if showsInstructionalCopy {
                        if !advice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(advice)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if images.count > 1 {
                            Text("Several photos: the same framing is center-cropped on each. Add one photo at a time to move and zoom inside the border.")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        } else if previewAspect != nil {
                            Text("Move your photo behind the border; pinch to zoom. Rotate if needed—what’s inside the border is what uploads.")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    }

                    VStack(spacing: 12) {
                        if useInteractiveEditor, let asp = previewAspect {
                            FixedMaskImageEditor(
                                workingImage: $workingImageForCrop,
                                aspectWidthOverHeight: asp,
                                userScale: $editorUserScale,
                                offset: $editorOffset
                            )
                            .frame(width: editorContainerSize.width, height: editorContainerSize.height)

                            HStack {
                                Button {
                                    workingImageForCrop = workingImageForCrop.rotatedClockwise90ForUpload()
                                    editorUserScale = 1
                                    editorOffset = .zero
                                } label: {
                                    Label("Rotate 90°", systemImage: "rotate.right")
                                }
                                .buttonStyle(.bordered)
                                Spacer()
                            }
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
                .padding(showsInstructionalCopy ? 20 : 16)
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
                        let interactive: InteractiveCropParameters? = {
                            guard useInteractiveEditor,
                                  let asp = choice.aspectWidthOverHeight,
                                  let cg = workingImageForCrop.normalizedForUploadCrop().cgImage
                            else { return nil }
                            let pw = CGFloat(cg.width)
                            let ph = CGFloat(cg.height)
                            return InteractiveCropParameters(
                                editorWidth: editorContainerSize.width,
                                editorHeight: editorContainerSize.height,
                                maskAspectWidthOverHeight: asp,
                                userScale: editorUserScale,
                                offsetWidth: editorOffset.width,
                                offsetHeight: editorOffset.height,
                                imagePixelWidth: pw,
                                imagePixelHeight: ph
                            )
                        }()
                        let exportImages = useInteractiveEditor ? [workingImageForCrop] : images
                        let list = UploadImageCropExport.jpegDataList(
                            from: exportImages,
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
                resetEditorFromPreview()
            }
            .onChange(of: choice) { _, _ in
                resetEditorFromPreview()
            }
        }
    }
}
