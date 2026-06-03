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
    /// Inline text field is active (font stepper + navigation in `PreviewQuickEditChrome`).
    case inlineFocus(QuickEditInlineFocus)
    /// Inline text field closed without turning off quick edit.
    case inlineBlur
    /// User tapped a `data-bk-color-surface` band in the preview.
    case openColorSurface(surfaceId: String)
}

/// Native → WebView commands while quick edit is active.
final class WebViewQuickEditBridge {
    weak var coordinator: WebViewRepresentable.Coordinator?

    func navigateEditable(delta: Int) {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditNavigateEditable&&window.__bkQuickEditNavigateEditable(\(delta))")
    }

    func setInlineFontSize(_ px: Int) {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditSetFontSize&&window.__bkQuickEditSetFontSize(\(px))")
    }

    func commitDirtyEdits() {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditCommitDirty&&window.__bkQuickEditCommitDirty()")
    }

    func applyPreviewColorPatch(_ payload: [String: String]) {
        coordinator?.applyPreviewColorPatch(payload)
    }
}

struct WebViewPreview: View {
    let url: URL?
    /// Pass nil for full-height preview; pass a value for fixed-height embedding.
    let height: CGFloat?
    /// When true, taps on elements with `data-edit-key` drive quick edit (inline text or native sheet).
    var quickEditEnabled: Bool = false
    var bridge: WebViewQuickEditBridge?
    var onQuickEdit: ((WebViewQuickEditEvent) -> Void)?

    var body: some View {
        GeometryReader { geo in
            Group {
                if let url = url {
                    WebViewRepresentable(
                        url: url,
                        containerWidth: geo.size.width,
                        quickEditEnabled: quickEditEnabled,
                        bridge: bridge,
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
    var bridge: WebViewQuickEditBridge?
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
        bridge?.coordinator = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        bridge?.coordinator = context.coordinator
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

        func evaluateQuickEdit(_ javascript: String) {
            webView?.evaluateJavaScript(javascript, completionHandler: nil)
        }

        func applyPreviewColorPatch(_ payload: [String: String]) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            evaluateQuickEdit("window.__bkApplyPreviewColorPatch&&window.__bkApplyPreviewColorPatch(\(json))")
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == messageHandlerName,
                  let body = message.body as? [String: Any] else { return }
            let action = body["action"] as? String ?? "openSheet"
            let event: WebViewQuickEditEvent?
            if action == "inlineSaveBatch",
               let raw = body["changes"] as? [String: Any] {
                var changes: [String: String] = [:]
                for (k, v) in raw {
                    if let s = v as? String { changes[k] = s }
                    else if let n = v as? NSNumber { changes[k] = n.stringValue }
                }
                event = .inlineSaveBatch(changes: changes)
            } else if action == "inlineFocus",
                      let key = body["key"] as? String {
                let fontSize = (body["fontSize"] as? NSNumber)?.intValue ?? 16
                let fontAdjustable = body["fontAdjustable"] as? Bool ?? false
                event = .inlineFocus(QuickEditInlineFocus(key: key, fontSize: fontSize, fontAdjustable: fontAdjustable))
            } else if action == "inlineBlur" {
                event = .inlineBlur
            } else if action == "openColorSurface",
                      let surfaceId = body["surface"] as? String {
                event = .openColorSurface(surfaceId: surfaceId)
            } else {
                guard let key = body["key"] as? String else { return }
                let text = body["text"] as? String ?? ""
                event = .openSheet(key: key, initialText: text)
            }
            guard let event else { return }
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
              sheet.textContent = '[data-edit-key]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:3px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;-webkit-tap-highlight-color:rgba(0,122,255,0.12);}' +
                '[data-edit-key][data-bk-inline-editing]{cursor:text!important;outline:2.5px dashed rgba(0,122,255,0.88)!important;outline-offset:3px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '.s12-section-title,.s12-info-title,.s12-test-title,.s12-gallery-title,.s12-book-cta-title,.s12-phil-title,.luxe-section-heading{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:4px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;border-radius:2px!important;}' +
                '.s12-section-title [data-edit-key],.s12-info-title [data-edit-key],.s12-test-title [data-edit-key],.s12-gallery-title [data-edit-key],.s12-book-cta-title [data-edit-key],.s12-phil-title [data-edit-key],.luxe-section-heading [data-edit-key]{outline:none!important;box-shadow:none!important;}' +
                '[data-edit-key^="svc:"][data-edit-key$=":edit"] [data-edit-key],[data-edit-key^="s12Process:"][data-edit-key$=":edit"] [data-edit-key],div.s12-process-cell[data-edit-key] [data-edit-key]{outline:none!important;box-shadow:none!important;}' +
                '[data-edit-key="aboutText"],[data-edit-key="bladeHeroDescription"]{display:inline-block!important;width:fit-content!important;max-width:100%!important;box-sizing:border-box!important;vertical-align:top!important;}' +
                '.s12-address [data-edit-key],.s12-phone [data-edit-key],.s12-hours-block [data-edit-key],.s12-phil-body [data-edit-key]{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin:8px 0!important;}' +
                '.classic-hero-tag [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="svc:"][role="button"],[data-edit-key^="svc:"][data-edit-key$=":edit"],[data-edit-key^="s12Process:"][data-edit-key$=":edit"]{display:block!important;cursor:pointer!important;box-sizing:border-box!important;border-radius:4px!important;}' +
                'a.blade-service-card[data-edit-key],a.stonecut-service-card[data-edit-key],div.s12-svc-cell[data-edit-key]{cursor:pointer!important;}' +
                'a.s12-nav-book [data-edit-key],a.s12-btn-dark [data-edit-key],a.s12-btn-outline [data-edit-key],.luxe-contact-item h3 [data-edit-key],.s12-phil-label [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="s12Process:"][data-edit-key$=":body"]{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin-top:4px!important;}' +
                '.s12-footer-brand [data-edit-key]{display:inline-block!important;margin:0 3px!important;}' +
                'button.bk-hero-image-hit[data-edit-key="heroImage"],button.luxe-hero-image-hit[data-edit-key="heroImage"]{outline:none!important;outline-offset:0!important;box-shadow:none!important;}' +
                '.luxe-hero:has(.bk-hero-image-hit),.classic-hero-right:has(.bk-hero-image-hit),.blade-hero-right:has(.bk-hero-image-hit),.stonecut-hero-right:has(.bk-hero-image-hit),.studio12-page .s12-hero-img-col:has(.bk-hero-image-hit){box-shadow:inset 0 0 0 2px rgba(0,122,255,0.68)!important;}' +
                '[data-edit-key="heroImage"].classic-hero-placeholder,[data-edit-key="heroImage"].blade-hero-placeholder,[data-edit-key="heroImage"].stonecut-hero-photo--empty,[data-edit-key="heroImage"].s12-hero-img-fallback{box-shadow:inset 0 0 0 2px rgba(0,122,255,0.68)!important;cursor:pointer!important;}' +
                'img[data-edit-key^="galleryImage"],img[data-edit-key="studio12PhilosophyImage"],img[data-edit-key="studio12BookCtaImage"],' +
                '[data-edit-key^="galleryImage"].s12-hero-img-fallback,[data-edit-key="studio12PhilosophyImage"].s12-hero-img-fallback,[data-edit-key="studio12BookCtaImage"].s12-hero-img-fallback{cursor:pointer!important;}' +
                '[data-bk-color-surface]{cursor:pointer!important;box-shadow:inset 0 0 0 2px rgba(175,82,222,0.72)!important;}' +
                '[data-bk-color-surface][data-bk-color-active]{box-shadow:inset 0 0 0 3px rgba(175,82,222,1)!important;}' +
                '[data-bk-color-surface] [data-edit-key]{outline:none!important;box-shadow:none!important;}';
              document.head.appendChild(sheet);
              function resolveQuickEditTap(ev) {
                var el = ev.target;
                while (el && el.nodeType !== 1) el = el.parentNode;
                if (!el || !el.closest) return { type: 'none' };
                if (el.closest('.bk-hero-image-hit, .luxe-hero-image-hit')) {
                  var heroBtn = el.closest('[data-edit-key="heroImage"]');
                  if (heroBtn) return { type: 'sheet', el: heroBtn };
                }
                var textEl = el.closest('[data-edit-key]');
                if (textEl) {
                  var tk = textEl.getAttribute('data-edit-key');
                  if (tk && isSheetOnlyKey(tk)) return { type: 'sheet', el: textEl };
                  if (tk && tk.indexOf('color:') !== 0) return { type: 'text', el: textEl };
                }
                var surf = el.closest('[data-bk-color-surface]');
                if (surf) {
                  var sid = surf.getAttribute('data-bk-color-surface');
                  if (sid) return { type: 'color', surface: sid, el: surf };
                }
                if (textEl) return { type: 'sheet', el: textEl };
                return { type: 'none' };
              }
              function setActiveColorSurface(el) {
                [].forEach.call(document.querySelectorAll('[data-bk-color-surface]'), function(node) {
                  node.removeAttribute('data-bk-color-active');
                });
                if (el) el.setAttribute('data-bk-color-active', '1');
              }
              function openColorSurface(sid, surfEl) {
                setActiveColorSurface(surfEl);
                postToNative({ action: 'openColorSurface', surface: sid });
              }
              function isSheetOnlyKey(key) {
                return key === 'heroImage' || key === 'studio12PhilosophyImage' || key === 'studio12BookCtaImage' ||
                  key.indexOf('svc:') === 0 || key.indexOf('s12Process:') === 0 || key.indexOf('featuredWork:') === 0 ||
                  key.indexOf('galleryImage:') === 0;
              }
              function isFontAdjustableKey(key) {
                if (!key || isSheetOnlyKey(key)) return false;
                if (key.indexOf('svc:') === 0 || key.indexOf('s12Process:') === 0) return false;
                if (key.indexOf('featuredWork:') === 0 || key.indexOf('galleryImage:') === 0) return false;
                return true;
              }
              function postInlineFocus(el) {
                if (!el || !el.isConnected) return;
                var key = el.getAttribute('data-edit-key');
                if (!key) return;
                var cs = window.getComputedStyle(el);
                var fs = Math.round(parseFloat(cs.fontSize) || 16);
                postToNative({
                  action: 'inlineFocus',
                  key: key,
                  fontSize: fs,
                  fontAdjustable: isFontAdjustableKey(key)
                });
              }
              function postInlineBlur() {
                postToNative({ action: 'inlineBlur' });
              }
              function editableNavTargets() {
                var seen = {};
                var out = [];
                var nodes = document.querySelectorAll('[data-edit-key]');
                for (var i = 0; i < nodes.length; i++) {
                  var el = nodes[i];
                  if (!el || !el.isConnected) continue;
                  var key = el.getAttribute('data-edit-key');
                  if (!key || seen[key]) continue;
                  seen[key] = true;
                  out.push(el);
                }
                return out;
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
                postInlineBlur();
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
                  postInlineFocus(t);
                }, 0);
              }
              function activateQuickEditHit(hit) {
                if (!hit || hit.type === 'none') return;
                if (hit.type === 'color') {
                  if (inlineEl) finishActiveInlineNoSave();
                  openColorSurface(hit.surface, hit.el);
                  return;
                }
                var t = hit.el;
                if (!t || !t.isConnected) return;
                if (hit.type === 'sheet') {
                  if (inlineEl) finishActiveInlineNoSave();
                  deliverOpenSheet(t);
                  return;
                }
                if (hit.type === 'text') {
                  if (inlineEl === t) return;
                  startInline(t);
                }
              }
              var touchStart = null;
              var touchEditHit = null;
              var colorLongPressTimer = null;
              var colorLongPressFired = false;
              function clearColorLongPress() {
                if (colorLongPressTimer) { clearTimeout(colorLongPressTimer); colorLongPressTimer = null; }
              }
              function onTouchStart(ev) {
                clearColorLongPress();
                colorLongPressFired = false;
                var hit = resolveQuickEditTap(ev);
                if (hit.type === 'none' || !ev.touches || !ev.touches.length) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                touchStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
                touchEditHit = hit;
                if (hit.type === 'color' && hit.surface === 'hero') {
                  colorLongPressTimer = setTimeout(function() {
                    colorLongPressFired = true;
                    if (inlineEl) finishActiveInlineNoSave();
                    openColorSurface('hero', hit.el);
                  }, 520);
                }
              }
              function onTouchEnd(ev) {
                clearColorLongPress();
                if (colorLongPressFired) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                if (inlineEl && touchEditHit && touchEditHit.el && inlineEl.contains(touchEditHit.el)) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                if (!touchStart || !touchEditHit) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                if (!ev.changedTouches || !ev.changedTouches.length) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                var x = ev.changedTouches[0].clientX, y = ev.changedTouches[0].clientY;
                if (Math.abs(x - touchStart.x) > 14 || Math.abs(y - touchStart.y) > 14) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                var hit = touchEditHit;
                touchStart = null;
                touchEditHit = null;
                if (hit.type === 'color' && hit.surface === 'hero') {
                  return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                activateQuickEditHit(hit);
                window.__bkQuickEditSuppressClickUntil = Date.now() + 800;
              }
              function onTap(ev) {
                if (window.__bkQuickEditSuppressClickUntil && Date.now() < window.__bkQuickEditSuppressClickUntil) return;
                if (inlineEl && ev.target && inlineEl.contains(ev.target)) return;
                var hit = resolveQuickEditTap(ev);
                if (hit.type === 'none') return;
                if (hit.type === 'sheet') {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                }
                if (hit.type === 'color' && hit.surface === 'hero') return;
                ev.preventDefault();
                ev.stopPropagation();
                activateQuickEditHit(hit);
              }
              document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
              document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
              document.addEventListener('click', onTap, true);
              document.addEventListener('input', onDocInput, true);
              window.__bkQuickEditNavigateEditable = function(delta) {
                var list = editableNavTargets();
                if (!list.length) return;
                var idx = -1;
                if (inlineEl) {
                  var activeKey = inlineEl.getAttribute('data-edit-key');
                  for (var i = 0; i < list.length; i++) {
                    if (list[i].getAttribute('data-edit-key') === activeKey) { idx = i; break; }
                  }
                }
                if (idx < 0) idx = delta > 0 ? -1 : 0;
                var next = (idx + delta + list.length) % list.length;
                activateQuickEditHit({ type: 'text', el: list[next] });
              };
              window.__bkQuickEditSetFontSize = function(px) {
                if (!inlineEl || !inlineEl.isConnected) return;
                var size = Math.max(10, Math.min(96, parseInt(px, 10) || 16));
                inlineEl.style.fontSize = size + 'px';
                noteDirtyFrom(inlineEl);
                postInlineFocus(inlineEl);
              };
              window.__bkQuickEditCommitDirty = function() {
                finishActiveInlineNoSave();
                var keys = Object.keys(dirty);
                if (keys.length) {
                  postToNative({ action: 'inlineSaveBatch', changes: dirty });
                  dirty = {};
                }
              };
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
                delete window.__bkQuickEditNavigateEditable;
                delete window.__bkQuickEditSetFontSize;
                delete window.__bkQuickEditCommitDirty;
                delete window.__bkApplyPreviewColorPatch;
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
