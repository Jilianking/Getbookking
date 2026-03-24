//
//  BookingRequestDetailModel.swift
//  Parsing & grouping formResponses for booking request detail UI.
//

import Foundation
import SwiftUI

enum BookingRequestDetailModel {
    /// Keys already shown as top-level contact / scheduling (or duplicated there).
    static let excludedFormKeys: Set<String> = [
        "name", "email", "phone", "notes", "service",
        "preferredtime", "preferredtimeofday", "preferreddays"
    ]

    static let displayLabels: [String: String] = [
        "placement": "Placement",
        "size": "Size",
        "style": "Style",
        "description": "Description",
        "referenceimages": "Reference images",
        "hairtype": "Hair type",
        "stylepreference": "Style preference",
        "visittype": "Visit type",
        "fadeorstyle": "Fade / style",
        "facialhair": "Facial hair",
        "cutdetails": "Cut details",
        "scalpsensitivity": "Scalp sensitivity",
        "designpreference": "Design preference",
        "nailtype": "Nail type",
        "design": "Design",
        "issuetype": "Issue type",
        "propertytype": "Property type",
        "preferredcontact": "Preferred contact",
        "attachments": "Attachments",
        "address": "Service address",
        "skintone": "Skin tone",
        "allergies": "Allergies",
        "urgency": "Urgency"
    ]

    static func humanizedKey(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func label(forKey key: String) -> String {
        let low = key.lowercased()
        if let l = displayLabels[low] { return l }
        return humanizedKey(key)
    }

    static func stringValue(from value: Any) -> String {
        switch value {
        case let s as String:
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        case let arr as [Any]:
            return arr.map { stringValue(from: $0) }.filter { !$0.isEmpty }.joined(separator: ", ")
        case let arr as [String]:
            return arr.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: ", ")
        case is NSNull:
            return ""
        default:
            return "\(value)".trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// 0 tattoo / creative, 1 health, 2 trades service, 3 catch-all
    static func bucket(forKey key: String) -> Int {
        let k = key.lowercased()
        let tattooKeys = ["placement", "size", "style", "description", "referenceimages", "hairtype", "stylepreference",
                          "designpreference", "nailtype", "design", "visittype", "fadeorstyle", "facialhair", "cutdetails", "scalpsensitivity"]
        if tattooKeys.contains(where: { k == $0 || k.hasPrefix($0) }) {
            return 0
        }
        if ["skintone", "allergies", "urgency", "health", "medical"].contains(where: { k.contains($0) }) {
            return 1
        }
        if ["address", "issuetype", "propertytype", "preferredcontact", "attachments"].contains(where: { k.contains($0) }) {
            return 2
        }
        return 3
    }

    static let bucketTitles = ["Tattoo details", "Health & safety", "Service details", "Additional details"]

    struct FormRow: Identifiable {
        let id: String
        let label: String
        let value: String
    }

    /// Shown as image/PDF gallery, not plain text.
    static let mediaGalleryFieldKeys: Set<String> = ["referenceimages", "attachments"]

    static func valueForResponseKey(_ key: String, in responses: [String: Any]) -> Any? {
        if let v = responses[key] { return v }
        return responses.first { $0.key.lowercased() == key.lowercased() }?.value
    }

    static func urlStrings(from value: Any) -> [String] {
        switch value {
        case let s as String:
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { return [] }
            return t.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        case let arr as [Any]:
            return arr.compactMap { stringValue(from: $0) }.filter { !$0.isEmpty }
        case let arr as [String]:
            return arr.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        default:
            return []
        }
    }

    static func normalizedURLs(from value: Any) -> [URL] {
        urlStrings(from: value).compactMap { URL(string: $0) }
    }

    /// PDFs open as links; everything else tries inline image (Firebase URLs often have no file extension).
    static func isPDFURL(_ url: URL) -> Bool {
        let s = url.absoluteString.lowercased()
        if s.contains(".pdf") { return true }
        return url.path.lowercased().hasSuffix(".pdf")
    }

    static func formRows(from responses: [String: Any]) -> [FormRow] {
        responses
            .filter { !$0.key.isEmpty }
            .sorted { $0.key.lowercased() < $1.key.lowercased() }
            .compactMap { key, raw -> FormRow? in
                let lk = key.lowercased()
                guard !excludedFormKeys.contains(lk) else { return nil }
                guard !mediaGalleryFieldKeys.contains(lk) else { return nil }
                let v = stringValue(from: raw)
                guard !v.isEmpty else { return nil }
                return FormRow(id: key, label: label(forKey: key), value: v)
            }
    }

    /// Which form keys render as media for each bucket (must match `bucket(forKey:)`).
    static func mediaKeys(forBucket index: Int) -> [String] {
        switch index {
        case 0: return ["referenceImages"]
        case 2: return ["attachments"]
        default: return []
        }
    }

    static func rowsByBucket(_ rows: [FormRow]) -> [Int: [FormRow]] {
        var out: [Int: [FormRow]] = [:]
        for row in rows {
            let b = bucket(forKey: row.id)
            out[b, default: []].append(row)
        }
        return out
    }
}

struct BookingRequestSectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundColor(.secondary)
            .tracking(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BookingRequestDetailRow: View {
    let label: String
    let value: String
    var systemImage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(alignment: .top, spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .frame(width: 18, alignment: .center)
                }
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Inline thumbnails for `referenceImages` / `attachments` (HTTPS URLs from Storage).
struct BookingRequestFormMediaGalleryView: View {
    let title: String
    let value: Any

    private var urls: [URL] {
        BookingRequestDetailModel.normalizedURLs(from: value)
    }

    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: 104, maximum: 200), spacing: 10)]
    }

    var body: some View {
        Group {
            if !urls.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(title)
                        .font(.caption)
                        .foregroundColor(.secondary)
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(urls, id: \.absoluteString) { url in
                            if BookingRequestDetailModel.isPDFURL(url) {
                                Link(destination: url) {
                                    VStack(spacing: 8) {
                                        Image(systemName: "doc.richtext.fill")
                                            .font(.title2)
                                            .foregroundColor(.secondary)
                                        Text("Open PDF")
                                            .font(.caption.weight(.medium))
                                    }
                                    .frame(maxWidth: .infinity)
                                    .frame(minHeight: 112)
                                    .background(Color.gray.opacity(0.12))
                                    .cornerRadius(12)
                                }
                            } else {
                                AsyncImage(url: url) { phase in
                                    switch phase {
                                    case .empty:
                                        ProgressView()
                                            .frame(maxWidth: .infinity, minHeight: 120)
                                            .background(Color.gray.opacity(0.08))
                                            .cornerRadius(12)
                                    case .success(let image):
                                        image
                                            .resizable()
                                            .scaledToFill()
                                            .frame(maxWidth: .infinity, minHeight: 120)
                                            .frame(maxHeight: 220)
                                            .clipped()
                                            .cornerRadius(12)
                                    case .failure:
                                        Link(destination: url) {
                                            VStack(spacing: 6) {
                                                Image(systemName: "arrow.up.right.square")
                                                    .font(.title2)
                                                Text("Open")
                                                    .font(.caption)
                                            }
                                            .foregroundColor(.primary)
                                            .frame(maxWidth: .infinity, minHeight: 120)
                                            .background(Color.gray.opacity(0.1))
                                            .cornerRadius(12)
                                        }
                                    @unknown default:
                                        EmptyView()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

struct BookingRequestFormSectionsView: View {
    let responses: [String: Any]?

    var body: some View {
        Group {
            if let responses, !responses.isEmpty {
                formSectionCards(responses)
            }
        }
    }

    @ViewBuilder
    private func formSectionCards(_ responses: [String: Any]) -> some View {
        let rows = BookingRequestDetailModel.formRows(from: responses)
        let byBucket = BookingRequestDetailModel.rowsByBucket(rows)
        ForEach(0 ..< BookingRequestDetailModel.bucketTitles.count, id: \.self) { idx in
            let sectionRows = byBucket[idx] ?? []
            let mediaKeys = BookingRequestDetailModel.mediaKeys(forBucket: idx)
            let mediaPairs: [(String, Any)] = mediaKeys.compactMap { key in
                guard let v = BookingRequestDetailModel.valueForResponseKey(key, in: responses) else { return nil }
                guard !BookingRequestDetailModel.normalizedURLs(from: v).isEmpty else { return nil }
                return (key, v)
            }
            if sectionRows.isEmpty, mediaPairs.isEmpty {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    BookingRequestSectionHeader(title: BookingRequestDetailModel.bucketTitles[idx])
                    ForEach(mediaPairs, id: \.0) { pair in
                        BookingRequestFormMediaGalleryView(
                            title: BookingRequestDetailModel.label(forKey: pair.0),
                            value: pair.1
                        )
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(sectionRows) { row in
                            BookingRequestDetailRow(label: row.label, value: row.value)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
            }
        }
    }
}
