//
//  ImageUploadPreprocessor.swift
//  Test
//
//  Downscales and JPEG-compresses photos before Firebase upload so uploads and
//  public-site downloads stay smaller without separate thumbnail URLs.
//

import UIKit

enum ImageUploadPreprocessor {
    /// Downscales so the longer side is at most `maxLongEdge` px, then JPEG-encodes.
    /// Returns original `data` if the image cannot be decoded.
    static func prepareJPEGForUpload(_ data: Data, maxLongEdge: CGFloat, compressionQuality: CGFloat) -> Data {
        guard let image = UIImage(data: data) else { return data }
        let srcScale = image.scale
        let pxW = image.size.width * srcScale
        let pxH = image.size.height * srcScale
        let longEdge = max(pxW, pxH)
        guard longEdge > 1 else { return data }

        let scaleDown = min(1, maxLongEdge / longEdge)
        let outW = max(1, floor(pxW * scaleDown))
        let outH = max(1, floor(pxH * scaleDown))
        let outSize = CGSize(width: outW, height: outH)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false

        let renderer = UIGraphicsImageRenderer(size: outSize, format: format)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: outSize))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: compressionQuality) else { return data }
        return jpeg
    }
}
