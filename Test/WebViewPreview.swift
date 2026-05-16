//
//  WebViewPreview.swift
//
//  WKWebView wrapper for in-app preview of booking page.
//  Injects viewport to match WebView width so layout matches Safari.
//  Quick edit: `heroImage` and `svc:*` → native sheet; other keys → inline edit; saves when Quick edit is turned off (batched, one preview reload).
//

import SwiftUI
import WebKit

/// Messages from the injected quick-edit script (`data-edit-key` in `web/index.html`).
enum WebViewQuickEditEvent {
    /// Open `PreviewQuickEditSheet` (or service / hero flows) in SwiftUI.
    case openSheet(key: String, initialText: String)
    /// Persist multiple edited fields after Quick edit is turned off (single preview reload).
    case inlineSaveBatch(changes: [String: String])
}

struct WebViewPreview: View {
    let url: URL?
    /// Pass nil for full-height preview; pass a value for fixed-height embedding.
    let height: CGFloat?
    /// When true, taps on elements with `data-edit-key` drive quick edit (inline text or native sheet).
    var quickEditEnabled: Bool = false
    var onQuickEdit: ((WebViewQuickEditEvent) -> Void)?

    var body: some View {
        GeometryReader { geo in
            Group {
                if let url = url {
                    WebViewRepresentable(
                        url: url,
                        containerWidth: geo.size.width,
                        quickEditEnabled: quickEditEnabled,
                        onQuickEdit: onQuickEdit
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
    var onQuickEdit: ((WebViewQuickEditEvent) -> Void)?

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
        context.coordinator.onQuickEdit = onQuickEdit
        context.coordinator.quickEditEnabled = quickEditEnabled

        let width = containerWidth > 0 ? containerWidth : webView.bounds.width
        guard width > 100 else { return }
        if context.coordinator.lastLoadedURL != url {
            context.coordinator.resetQuickEditInstallState()
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
        var onQuickEdit: ((WebViewQuickEditEvent) -> Void)?
        /// Avoid re-running `installQuickEdit` on every `updateUIView` — reinstall calls JS cleanup, which commits inline edits and triggers a full preview reload.
        private var quickEditInstalledForDocument = false
        private var quickEditInstallInFlight = false

        init(messageHandlerName: String) {
            self.messageHandlerName = messageHandlerName
        }

        fileprivate func resetQuickEditInstallState() {
            quickEditInstalledForDocument = false
            quickEditInstallInFlight = false
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == messageHandlerName,
                  let body = message.body as? [String: Any] else { return }
            let action = body["action"] as? String ?? "openSheet"
            let event: WebViewQuickEditEvent
            if action == "inlineSaveBatch",
               let raw = body["changes"] as? [String: Any] {
                var changes: [String: String] = [:]
                for (k, v) in raw {
                    if let s = v as? String { changes[k] = s }
                    else if let n = v as? NSNumber { changes[k] = n.stringValue }
                }
                event = .inlineSaveBatch(changes: changes)
            } else {
                guard let key = body["key"] as? String else { return }
                let text = body["text"] as? String ?? ""
                event = .openSheet(key: key, initialText: text)
            }
            DispatchQueue.main.async { [weak self] in
                self?.onQuickEdit?(event)
            }
        }

        /// While quick edit is on, block in-preview navigation to booking URLs so `<a href="/book/...">` taps can edit instead of loading the book flow.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard quickEditEnabled else {
                decisionHandler(.allow)
                return
            }
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let path = url.path.lowercased()
            if path == "/book" || path.hasPrefix("/book/") {
                decisionHandler(.cancel)
                return
            }
            if path == "/gallery" || path.hasPrefix("/gallery/") {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            resetQuickEditInstallState()
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
                guard !quickEditInstalledForDocument, !quickEditInstallInFlight else { return }
                quickEditInstallInFlight = true
                installQuickEdit(webView: webView)
            } else {
                uninstallQuickEdit(webView: webView)
            }
        }

        private func installQuickEdit(webView: WKWebView) {
            guard quickEditEnabled else {
                quickEditInstallInFlight = false
                return
            }
            let js = """
            (function(){
              if (window.__bkQuickEditCleanup) { try { window.__bkQuickEditCleanup(); } catch(e) {} }
              var dirty = {};
              function currentText(el) {
                var raw = (el.innerText != null ? el.innerText : el.textContent) || '';
                return raw.replace(/^\\s+|\\s+$/g, '');
              }
              function noteDirtyFrom(el) {
                var k = el.getAttribute('data-edit-key');
                if (!k || isSheetOnlyKey(k)) return;
                dirty[k] = currentText(el);
              }
              var sheet = document.createElement('style');
              sheet.id = 'bk-quick-edit-style';
              sheet.textContent = '[data-edit-key]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;-webkit-tap-highlight-color:rgba(0,122,255,0.12);}' +
                '[data-edit-key][data-bk-inline-editing]{cursor:text!important;outline:2.5px dashed rgba(0,122,255,0.88)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '[data-edit-key="aboutText"],[data-edit-key="bladeHeroDescription"]{display:inline-block!important;width:fit-content!important;max-width:100%!important;box-sizing:border-box!important;vertical-align:top!important;}' +
                '.classic-hero-tag [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="svc:"][role="button"]{display:block!important;cursor:pointer!important;}' +
                'a.blade-service-card[data-edit-key],a.stonecut-service-card[data-edit-key]{cursor:pointer!important;}' +
                'button.luxe-hero-image-hit[data-edit-key="heroImage"]{outline:none!important;outline-offset:0!important;box-shadow:none!important;}';
              document.head.appendChild(sheet);
              function resolveEditTarget(ev) {
                var el = ev.target;
                while (el && el.nodeType !== 1) el = el.parentNode;
                if (!el || !el.closest) return null;
                return el.closest('[data-edit-key]');
              }
              function isSheetOnlyKey(key) {
                return key === 'heroImage' || key.indexOf('svc:') === 0 || key.indexOf('featuredWork:') === 0;
              }
              function postToNative(payload) {
                try {
                  window.webkit.messageHandlers.\(messageHandlerName).postMessage(payload);
                } catch (e) {}
              }
              function deliverOpenSheet(t) {
                var key = t.getAttribute('data-edit-key');
                if (!key) return;
                var text = (t.textContent || '').trim();
                postToNative({ key: key, text: text, action: 'openSheet' });
              }
              var inlineEl = null;
              function stripEditableShell(el) {
                if (!el || !el.isConnected) return;
                el.removeEventListener('blur', onInlineBlur);
                el.removeAttribute('contenteditable');
                el.removeAttribute('spellcheck');
                el.removeAttribute('data-bk-inline-editing');
              }
              function finishActiveInlineNoSave() {
                if (!inlineEl || !inlineEl.isConnected) { inlineEl = null; return; }
                noteDirtyFrom(inlineEl);
                stripEditableShell(inlineEl);
                inlineEl = null;
              }
              function onInlineBlur() {
                setTimeout(function() {
                  if (!inlineEl || !inlineEl.isConnected) { inlineEl = null; return; }
                  if (document.activeElement === inlineEl) return;
                  finishActiveInlineNoSave();
                }, 0);
              }
              function onDocInput(ev) {
                var el = ev.target;
                if (!el || el.nodeType !== 1) return;
                if (el.getAttribute('contenteditable') !== 'true') return;
                var host = el.closest('[data-edit-key]');
                if (!host) return;
                var k = host.getAttribute('data-edit-key');
                if (!k || isSheetOnlyKey(k)) return;
                dirty[k] = currentText(host);
              }
              function startInline(t) {
                if (inlineEl && inlineEl !== t) finishActiveInlineNoSave();
                inlineEl = t;
                t.setAttribute('contenteditable', 'true');
                t.setAttribute('spellcheck', 'true');
                t.setAttribute('data-bk-inline-editing', '1');
                t.addEventListener('blur', onInlineBlur);
                noteDirtyFrom(t);
                setTimeout(function() {
                  try {
                    t.focus();
                    var r = document.createRange();
                    r.selectNodeContents(t);
                    r.collapse(false);
                    var sel = window.getSelection();
                    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
                  } catch (e) {}
                  try { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e2) {}
                }, 0);
              }
              function activateQuickEditTarget(t) {
                if (!t || !t.isConnected) return;
                var key = t.getAttribute('data-edit-key');
                if (!key) return;
                if (isSheetOnlyKey(key)) {
                  if (inlineEl) finishActiveInlineNoSave();
                  deliverOpenSheet(t);
                  return;
                }
                if (inlineEl === t) return;
                startInline(t);
              }
              var touchStart = null;
              var touchEditTarget = null;
              function onTouchStart(ev) {
                var t = resolveEditTarget(ev);
                if (!t || !ev.touches || !ev.touches.length) {
                  touchStart = null;
                  touchEditTarget = null;
                  return;
                }
                touchStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
                touchEditTarget = t;
              }
              function onTouchEnd(ev) {
                if (inlineEl && touchEditTarget && inlineEl.contains(touchEditTarget)) {
                  touchStart = null;
                  touchEditTarget = null;
                  return;
                }
                if (!touchStart || !touchEditTarget) {
                  touchStart = null;
                  touchEditTarget = null;
                  return;
                }
                if (!ev.changedTouches || !ev.changedTouches.length) {
                  touchStart = null;
                  touchEditTarget = null;
                  return;
                }
                var x = ev.changedTouches[0].clientX, y = ev.changedTouches[0].clientY;
                if (Math.abs(x - touchStart.x) > 14 || Math.abs(y - touchStart.y) > 14) {
                  touchStart = null;
                  touchEditTarget = null;
                  return;
                }
                var t = touchEditTarget;
                touchStart = null;
                touchEditTarget = null;
                if (!t || !t.isConnected) return;
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                activateQuickEditTarget(t);
                window.__bkQuickEditSuppressClickUntil = Date.now() + 800;
              }
              function onTap(ev) {
                if (window.__bkQuickEditSuppressClickUntil && Date.now() < window.__bkQuickEditSuppressClickUntil) return;
                if (inlineEl && ev.target && inlineEl.contains(ev.target)) return;
                var t = resolveEditTarget(ev);
                if (!t) return;
                var tapKey = t.getAttribute('data-edit-key');
                if (tapKey && (tapKey === 'heroImage' || tapKey.indexOf('featuredWork:') === 0 || tapKey.indexOf('svc:') === 0)) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                }
                ev.preventDefault();
                ev.stopPropagation();
                activateQuickEditTarget(t);
              }
              document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
              document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
              document.addEventListener('click', onTap, true);
              document.addEventListener('input', onDocInput, true);
              window.__bkQuickEditInstalled = true;
              window.__bkQuickEditCleanup = function() {
                finishActiveInlineNoSave();
                var keys = Object.keys(dirty);
                if (keys.length) {
                  postToNative({ action: 'inlineSaveBatch', changes: dirty });
                  dirty = {};
                }
                document.removeEventListener('touchstart', onTouchStart, { capture: true });
                document.removeEventListener('touchend', onTouchEnd, { capture: true });
                document.removeEventListener('click', onTap, true);
                document.removeEventListener('input', onDocInput, true);
                var s = document.getElementById('bk-quick-edit-style');
                if (s) s.remove();
                window.__bkQuickEditInstalled = false;
                delete window.__bkQuickEditSuppressClickUntil;
                delete window.__bkQuickEditCleanup;
              };
            })();
            """
            webView.evaluateJavaScript(js) { [weak self] _, error in
                guard let self else { return }
                self.quickEditInstallInFlight = false
                guard error == nil, self.quickEditEnabled else { return }
                self.quickEditInstalledForDocument = true
            }
        }

        private func uninstallQuickEdit(webView: WKWebView) {
            quickEditInstallInFlight = false
            let js = "(function(){ if (window.__bkQuickEditCleanup) try { window.__bkQuickEditCleanup(); } catch(e) {} })();"
            webView.evaluateJavaScript(js) { [weak self] _, _ in
                guard let self else { return }
                self.quickEditInstalledForDocument = false
            }
        }
    }
}
