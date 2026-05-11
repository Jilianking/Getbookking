//
//  WebViewPreview.swift
//
//  WKWebView wrapper for in-app preview of booking page.
//  Injects viewport to match WebView width so layout matches Safari.
//  Optional Quick edit mode: tap `[data-edit-key]` → native sheet (Phase 1).
//

import SwiftUI
import WebKit

struct WebViewPreview: View {
    let url: URL?
    /// Pass nil for full-height preview; pass a value for fixed-height embedding.
    let height: CGFloat?
    /// When true, taps on elements with `data-edit-key` post to `onQuickEditTap`.
    var quickEditEnabled: Bool = false
    var onQuickEditTap: ((String, String) -> Void)?

    var body: some View {
        GeometryReader { geo in
            Group {
                if let url = url {
                    WebViewRepresentable(
                        url: url,
                        containerWidth: geo.size.width,
                        quickEditEnabled: quickEditEnabled,
                        onQuickEditTap: onQuickEditTap
                    )
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
    var quickEditEnabled: Bool = false
    var onQuickEditTap: ((String, String) -> Void)?

    private static let messageHandlerName = "bkPreviewEdit"

    func makeCoordinator() -> Coordinator {
        Coordinator(messageHandlerName: Self.messageHandlerName)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: Self.messageHandlerName)
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onQuickEditTap = onQuickEditTap
        context.coordinator.quickEditEnabled = quickEditEnabled

        let width = containerWidth > 0 ? containerWidth : webView.bounds.width
        guard width > 100 else { return }
        if context.coordinator.lastLoadedURL != url {
            context.coordinator.lastLoadedURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            return
        }
        context.coordinator.applyQuickEditIfNeeded(webView: webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let messageHandlerName: String
        var lastLoadedURL: URL?
        weak var webView: WKWebView?
        var quickEditEnabled = false
        var onQuickEditTap: ((String, String) -> Void)?

        init(messageHandlerName: String) {
            self.messageHandlerName = messageHandlerName
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == messageHandlerName,
                  let body = message.body as? [String: Any],
                  let key = body["key"] as? String else { return }
            let text = body["text"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onQuickEditTap?(key, text)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let viewportScript = """
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
            webView.evaluateJavaScript(viewportScript, completionHandler: nil)
            applyQuickEditIfNeeded(webView: webView)
        }

        func applyQuickEditIfNeeded(webView: WKWebView) {
            if quickEditEnabled {
                installQuickEdit(webView: webView)
            } else {
                uninstallQuickEdit(webView: webView)
            }
        }

        private func installQuickEdit(webView: WKWebView) {
            guard quickEditEnabled else { return }
            let js = """
            (function(){
              if (window.__bkQuickEditCleanup) { try { window.__bkQuickEditCleanup(); } catch(e) {} }
              var sheet = document.createElement('style');
              sheet.id = 'bk-quick-edit-style';
              sheet.textContent = '[data-edit-key]{cursor:pointer!important;outline:2px dashed rgba(10,132,255,0.45)!important;outline-offset:3px!important;-webkit-tap-highlight-color:rgba(10,132,255,0.15);}';
              document.head.appendChild(sheet);
              function onTap(ev) {
                var t = ev.target.closest('[data-edit-key]');
                if (!t) return;
                ev.preventDefault();
                ev.stopPropagation();
                var key = t.getAttribute('data-edit-key');
                if (!key) return;
                var text = (t.textContent || '').trim();
                try {
                  window.webkit.messageHandlers.\(messageHandlerName).postMessage({ key: key, text: text });
                } catch (e) {}
              }
              document.addEventListener('click', onTap, true);
              window.__bkQuickEditInstalled = true;
              window.__bkQuickEditCleanup = function() {
                document.removeEventListener('click', onTap, true);
                var s = document.getElementById('bk-quick-edit-style');
                if (s) s.remove();
                window.__bkQuickEditInstalled = false;
                delete window.__bkQuickEditCleanup;
              };
            })();
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        private func uninstallQuickEdit(webView: WKWebView) {
            let js = "(function(){ if (window.__bkQuickEditCleanup) try { window.__bkQuickEditCleanup(); } catch(e) {} })();"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
