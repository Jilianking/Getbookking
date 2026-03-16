//
//  WebViewPreview.swift
//
//  WKWebView wrapper for in-app preview of booking page.
//  Injects viewport to match WebView width so layout matches Safari.
//

import SwiftUI
import WebKit

struct WebViewPreview: View {
    let url: URL?
    /// Pass nil for full-height preview; pass a value for fixed-height embedding.
    let height: CGFloat?

    var body: some View {
        GeometryReader { geo in
            Group {
                if let url = url {
                    WebViewRepresentable(url: url, containerWidth: geo.size.width)
                        .frame(minHeight: 200, maxHeight: height ?? .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.gray.opacity(0.2))
                        .frame(height: height ?? 200)
                        .overlay(
                            Text("Connect your business to see preview")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        )
                }
            }
        }
        .frame(minHeight: 200, maxHeight: height ?? .infinity)
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let url: URL
    var containerWidth: CGFloat = 0

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.scrollView.bounces = false
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let width = containerWidth > 0 ? containerWidth : webView.bounds.width
        guard width > 100 else { return }
        if context.coordinator.lastLoadedURL != url {
            context.coordinator.lastLoadedURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        var lastLoadedURL: URL?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Force viewport to match WebView width so layout matches Safari
            let script = """
            (function() {
                var w = window.innerWidth;
                var meta = document.querySelector('meta[name=viewport]');
                var content = 'width=' + w + ', initial-scale=1';
                if (meta) meta.setAttribute('content', content);
                else {
                    var m = document.createElement('meta');
                    m.name = 'viewport';
                    m.content = content;
                    document.head.appendChild(m);
                }
            })();
            """
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}
