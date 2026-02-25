//
//  WebViewPreview.swift
//
//  WKWebView wrapper for in-app preview of booking page.
//

import SwiftUI
import WebKit

struct WebViewPreview: View {
    let url: URL?
    let height: CGFloat

    var body: some View {
        Group {
            if let url = url {
                WebViewRepresentable(url: url)
                    .frame(height: height)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.gray.opacity(0.2))
                    .frame(height: height)
                    .overlay(
                        Text("Connect your business to see preview")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    )
            }
        }
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
