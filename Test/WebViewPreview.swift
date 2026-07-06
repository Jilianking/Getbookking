//
//  WebViewPreview.swift
//
//  WKWebView wrapper for in-app preview of booking page.
//  Injects viewport to match WebView width so layout matches Safari.
//  Quick edit: `heroImage` and `svc:*` → native sheet; other keys → inline edit.
//  Text saves defer WKWebView reload until Quick edit is turned off or Design is left.
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

    func setInlineColor(_ hex: String) {
        coordinator?.scheduleInlineColor(hex)
    }

    func commitDirtyEdits() {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditCommitDirty&&window.__bkQuickEditCommitDirty()")
    }

    func schedulePreviewColorPatch(_ payload: [String: String], full: Bool = false) {
        coordinator?.schedulePreviewColorPatch(payload, full: full)
    }

    func flushPreviewColorPatch() {
        coordinator?.flushPreviewColorPatch()
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
                        .fill(AppDesign.searchBackground)
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
        private var pendingColorPatch: [String: String]?
        private var pendingColorPatchNeedsFull = false
        private var colorPatchWorkItem: DispatchWorkItem?
        private var pendingInlineColorHex: String?
        private var inlineColorWorkItem: DispatchWorkItem?

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

        func schedulePreviewColorPatch(_ payload: [String: String], full: Bool) {
            pendingColorPatch = payload
            if full { pendingColorPatchNeedsFull = true }
            colorPatchWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in
                self?.emitPendingColorPatch()
            }
            colorPatchWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.07, execute: work)
        }

        func flushPreviewColorPatch() {
            colorPatchWorkItem?.cancel()
            pendingColorPatchNeedsFull = true
            emitPendingColorPatch()
        }

        private func emitPendingColorPatch() {
            guard let payload = pendingColorPatch,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            let full = pendingColorPatchNeedsFull
            pendingColorPatch = nil
            pendingColorPatchNeedsFull = false
            let opts = full ? "{full:true}" : "{full:false}"
            evaluateQuickEdit(
                "window.__bkApplyPreviewColorPatch&&window.__bkApplyPreviewColorPatch(\(json),\(opts))"
            )
        }

        func scheduleInlineColor(_ hex: String) {
            pendingInlineColorHex = hex
            inlineColorWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in
                self?.emitPendingInlineColor()
            }
            inlineColorWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
        }

        private func emitPendingInlineColor() {
            guard let hex = pendingInlineColorHex else { return }
            pendingInlineColorHex = nil
            let escaped = hex.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            evaluateQuickEdit(
                "window.__bkQuickEditSetInlineColor&&window.__bkQuickEditSetInlineColor('\(escaped)')"
            )
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
                let colorHex = body["colorHex"] as? String ?? "#333333"
                let colorRole = body["colorRole"] as? String ?? "text"
                event = .inlineFocus(QuickEditInlineFocus(
                    key: key,
                    fontSize: fontSize,
                    fontAdjustable: fontAdjustable,
                    colorHex: colorHex,
                    colorRole: colorRole
                ))
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

        /// While quick edit is on, block in-preview link navigation so taps edit instead of loading another page.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard quickEditEnabled else {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated {
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
              if (window.__bkQuickEditCleanup) { try { window.__bkQuickEditCleanup(false); } catch(e) {} }
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
              var bkGroupedTextSelector = '.s12-section-title,.s12-section-label,.s12-info-title,.s12-info-book-title,.s12-test-title,.s12-gallery-title,.s12-phil-title,.luxe-section-heading,.luxe-section-label,.classic-section-eyebrow,.classic-hero-tag,.classic-hero-name,.classic-home .tattoo-featured-inner h2,.classic-services h2,.tattoo-featured-sub,.blade-section-label,.blade-section-title,.blade-book-title,.blade-where-city,.blade-hero-title,.stonecut-heading,.booking-page-title,.booking-page-subtitle,a.blade-service-card[data-edit-key],a.stonecut-service-card[data-edit-key],div.s12-svc-cell[data-edit-key],[data-edit-key^="svc:"][data-edit-key$=":edit"],div.s12-process-cell[data-edit-key],[data-edit-key^="s12Process:"][data-edit-key$=":edit"]';
              sheet.textContent = '[data-edit-key]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:3px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;-webkit-tap-highlight-color:rgba(0,122,255,0.12);}' +
                '[data-edit-key][data-bk-inline-editing]{cursor:text!important;outline:2.5px dashed rgba(0,122,255,0.88)!important;outline-offset:3px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                bkGroupedTextSelector + '{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:4px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;border-radius:2px!important;}' +
                bkGroupedTextSelector + ' [data-edit-key]{outline:none!important;box-shadow:none!important;}' +
                '.luxe-hero-cta [data-edit-key],.luxe-promo-cta [data-edit-key],a.luxe-hero-cta [data-edit-key],a.luxe-promo-cta [data-edit-key],.classic-btn-primary [data-edit-key],.classic-btn-ghost [data-edit-key],a.classic-btn-primary [data-edit-key],a.classic-btn-ghost [data-edit-key],.tattoo-gallery-link [data-edit-key],.blade-btn-primary [data-edit-key],.blade-btn-ghost [data-edit-key],a.blade-btn-primary [data-edit-key],a.blade-btn-ghost [data-edit-key],a.blade-nav-book [data-edit-key]{display:inline-block!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="svc:"][data-edit-key$=":edit"] [data-edit-key],[data-edit-key^="s12Process:"][data-edit-key$=":edit"] [data-edit-key],div.s12-process-cell[data-edit-key] [data-edit-key]{outline:none!important;box-shadow:none!important;}' +
                '[data-edit-key="aboutText"],[data-edit-key="bladeHeroDescription"]{display:inline-block!important;width:fit-content!important;max-width:100%!important;box-sizing:border-box!important;vertical-align:top!important;}' +
                '.s12-address [data-edit-key],.s12-phone [data-edit-key],.s12-hours-block [data-edit-key],.s12-phil-body [data-edit-key]{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin:8px 0!important;}' +
                '.classic-hero-tag [data-edit-key],.tattoo-brand [data-edit-key],.booking-page-title [data-edit-key],.booking-page-subtitle [data-edit-key],.booking-page-eyebrow [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="svc:"][role="button"],[data-edit-key^="svc:"][data-edit-key$=":edit"],[data-edit-key^="s12Process:"][data-edit-key$=":edit"]{display:block!important;cursor:pointer!important;box-sizing:border-box!important;border-radius:4px!important;}' +
                'a.blade-service-card[data-edit-key],a.stonecut-service-card[data-edit-key],div.s12-svc-cell[data-edit-key]{cursor:pointer!important;}' +
                'a.s12-nav-book [data-edit-key],a.s12-btn-dark [data-edit-key],a.s12-btn-outline [data-edit-key],.luxe-contact-item h3 [data-edit-key],.s12-phil-label [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-edit-key^="s12Process:"][data-edit-key$=":body"]{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin-top:4px!important;}' +
                '.s12-footer-brand [data-edit-key]{display:inline-block!important;margin:0 3px!important;}' +
                'button.bk-hero-image-hit[data-edit-key="heroImage"],button.luxe-hero-image-hit[data-edit-key="heroImage"]{outline:none!important;outline-offset:0!important;box-shadow:none!important;}' +
                '.luxe-hero:has(.bk-hero-image-hit),.blade-hero-right:has(.bk-hero-image-hit),.stonecut-hero-right:has(.bk-hero-image-hit),.studio12-page .s12-hero-img-col:has(.bk-hero-image-hit){box-shadow:inset 0 0 0 2px rgba(0,122,255,0.68)!important;}' +
                '.classic-hero-right:has(.bk-hero-image-hit),.classic-hero-right:has([data-edit-key="heroImage"]){outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:0!important;overflow:visible!important;}' +
                '[data-edit-key="heroImage"].classic-hero-placeholder,[data-edit-key="heroImage"].blade-hero-placeholder,[data-edit-key="heroImage"].stonecut-hero-photo--empty,[data-edit-key="heroImage"].s12-hero-img-fallback{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:0!important;cursor:pointer!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                'img[data-edit-key="heroImage"],img[data-edit-key^="galleryImage"],img[data-edit-key^="featuredWork"],img[data-edit-key="studio12PhilosophyImage"],img[data-edit-key="studio12BookCtaImage"],' +
                '[data-edit-key^="featuredWork"].luxe-service-placeholder,[data-edit-key^="featuredWork"].tattoo-featured-slot-add,[data-edit-key^="featuredWork"].tattoo-featured-cell,.tattoo-featured-placeholder[data-edit-key],' +
                '[data-edit-key^="galleryImage"].s12-hero-img-fallback,[data-edit-key="studio12PhilosophyImage"].s12-hero-img-fallback,[data-edit-key="studio12BookCtaImage"].s12-hero-img-fallback,[data-edit-key="studio12BookCtaImage"].s12-info-book-img-fallback' +
                '{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                '[data-bk-color-surface] [data-edit-key]{display:inline-block!important;max-width:100%!important;box-sizing:border-box!important;}' +
                '[data-bk-color-surface]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:0!important;box-shadow:none!important;}' +
                '[data-bk-color-surface][data-bk-color-active]{outline:3px dashed rgba(0,122,255,0.88)!important;}' +
                bkGroupedTextSelector + '[data-bk-quick-edit-selected]{position:relative!important;outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:3px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                bkGroupedTextSelector + '[data-bk-quick-edit-selected] [data-edit-key],' + bkGroupedTextSelector + ':has([data-bk-inline-editing]) [data-edit-key],'+ bkGroupedTextSelector + ':has([data-bk-inline-editing]) [data-edit-key][data-bk-inline-editing]{outline:none!important;box-shadow:none!important;}' +
                bkGroupedTextSelector + ':has([data-bk-inline-editing]){position:relative!important;outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:3px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '[data-edit-key][data-bk-quick-edit-selected]{position:relative!important;outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:3px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                '[data-bk-color-surface][data-bk-quick-edit-selected]{position:relative!important;outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:3px!important;border-radius:8px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                '[data-edit-key][data-bk-inline-editing][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                'a.classic-btn-primary[data-bk-quick-edit-selected],a.classic-btn-ghost[data-bk-quick-edit-selected],a.luxe-hero-cta[data-bk-quick-edit-selected],a.luxe-promo-cta[data-bk-quick-edit-selected],a.tattoo-gallery-link[data-bk-quick-edit-selected],a.blade-btn-primary[data-bk-quick-edit-selected],a.blade-btn-ghost[data-bk-quick-edit-selected],a.blade-nav-book[data-bk-quick-edit-selected],a.stonecut-btn[data-bk-quick-edit-selected],a.s12-btn-dark[data-bk-quick-edit-selected],a.s12-btn-outline[data-bk-quick-edit-selected],a.s12-nav-book[data-bk-quick-edit-selected],a.s12-gallery-link[data-bk-quick-edit-selected]{display:inline-block!important;box-sizing:border-box!important;}' +
                'button.bk-hero-image-hit[data-bk-quick-edit-selected],button.luxe-hero-image-hit[data-bk-quick-edit-selected],img[data-edit-key][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;}' +
                'button.bk-color-band-hit,button.bk-hero-band-hit{outline:none!important;box-shadow:none!important;cursor:pointer!important;}' +
                '[data-bk-band-tappable]{position:relative!important;}' +
                '.bk-band-content,.blade-band-content{position:relative!important;z-index:1!important;pointer-events:none!important;}' +
                '.bk-band-content [data-edit-key],.bk-band-content a,.bk-band-content button,.bk-band-content [role="button"],' +
                '.bk-band-content .booking-form,.bk-band-content .booking-form--guided,.bk-band-content .booking-guided,' +
                '.bk-band-content .booking-form input,.bk-band-content .booking-form select,.bk-band-content .booking-form textarea,.bk-band-content .booking-form label,' +
                '.bk-band-content .field-input,.bk-band-content .pref-days-dropdown,.bk-band-content .upload-drop,' +
                '.blade-band-content [data-edit-key],.blade-band-content a,.blade-band-content button,.blade-band-content [role="button"],' +
                '.blade-band-content .booking-form,.blade-band-content .booking-form--guided,.blade-band-content .booking-guided,' +
                '.blade-band-content .booking-form input,.blade-band-content .booking-form select,.blade-band-content .booking-form textarea,.blade-band-content .booking-form label,' +
                '.blade-band-content .field-input,.blade-band-content .pref-days-dropdown,.blade-band-content .upload-drop{pointer-events:auto!important;}';
              document.head.appendChild(sheet);
              var touchMoveSlopPx = 20;
              function isHeroImageQuickEditTarget(el) {
                if (!el || !el.closest) return false;
                return !!el.closest('.bk-hero-image-hit, .luxe-hero-image-hit, img[data-edit-key="heroImage"], [data-edit-key="heroImage"].classic-hero-placeholder, [data-edit-key="heroImage"].blade-hero-placeholder, [data-edit-key="heroImage"].stonecut-hero-photo--empty, [data-edit-key="heroImage"].s12-hero-img-fallback');
              }
              function isEditableQuickEditTarget(el) {
                if (!el || !el.closest) return false;
                if (isBlueOutlinedTextRegion(el)) return true;
                if (el.closest('.bk-color-band-hit, .bk-hero-band-hit')) return false;
                if (isHeroImageQuickEditTarget(el)) return true;
                if (el.closest('a[href], button, input, textarea, select, [contenteditable="true"], [role="button"]')) return true;
                var dk = el.closest('[data-edit-key]');
                if (!dk) return false;
                var tk = dk.getAttribute('data-edit-key');
                if (!tk || tk.indexOf('color:') === 0) return false;
                return true;
              }
              function isHeroImageColumnTarget(el) {
                if (!el || !el.closest) return false;
                return !!el.closest('.blade-hero-right,.classic-hero-right,.stonecut-hero-right,.s12-hero-img-col,.bk-hero-image-hit,.luxe-hero-image-hit');
              }
              function closestGroupedTextContainer(el) {
                if (!el || !el.closest) return null;
                return el.closest(bkGroupedTextSelector);
              }
              /** Blue dashed outline = text-only; never open section color from these regions. */
              function isBlueOutlinedTextRegion(el) {
                if (!el || !el.closest) return false;
                if (closestGroupedTextContainer(el)) return true;
                var keyed = el.closest('[data-edit-key]');
                if (!keyed) return false;
                var tk = keyed.getAttribute('data-edit-key');
                return !!(tk && tk.indexOf('color:') !== 0);
              }
              function resolveGroupedTextEditTarget(el) {
                if (!el || !el.closest) return null;
                var grouped = closestGroupedTextContainer(el);
                if (!grouped) return null;
                var selfKey = grouped.getAttribute && grouped.getAttribute('data-edit-key');
                if (selfKey) {
                  if (isSheetOnlyKey(selfKey)) return { type: 'sheet', el: grouped };
                  if (selfKey.indexOf('color:') !== 0) return { type: 'text', el: grouped };
                }
                var keyed = el.closest('[data-edit-key]');
                if (keyed && grouped.contains(keyed)) {
                  var tk = keyed.getAttribute('data-edit-key');
                  if (tk && isSheetOnlyKey(tk)) return { type: 'sheet', el: keyed };
                  if (tk && tk.indexOf('color:') !== 0) return { type: 'text', el: keyed };
                }
                var first = grouped.querySelector('[data-edit-key]');
                if (first) {
                  var fk = first.getAttribute('data-edit-key');
                  if (fk && isSheetOnlyKey(fk)) return { type: 'sheet', el: first };
                  if (fk && fk.indexOf('color:') !== 0) return { type: 'text', el: first };
                }
                return null;
              }
              /** True when tap is on editable copy inside a color band (not wrapper padding). */
              function isInsideSurfaceTextKey(el, surf) {
                if (!el || !surf || !el.closest) return false;
                if (!surf.contains(el)) return false;
                if (closestGroupedTextContainer(el)) return true;
                var keyed = el.closest('[data-edit-key]');
                if (el.closest('a[href], button, [role="button"]')) {
                  return !!(keyed && surf.contains(keyed));
                }
                var selfKey = el.getAttribute && el.getAttribute('data-edit-key');
                if (selfKey && selfKey.indexOf('color:') !== 0) {
                  if (isSheetOnlyKey(selfKey)) return true;
                  return true;
                }
                if (!keyed || !surf.contains(keyed)) return false;
                var tk = keyed.getAttribute('data-edit-key');
                if (!tk || tk.indexOf('color:') === 0 || isSheetOnlyKey(tk)) return false;
                return true;
              }
              /** Open padding in a color band → section color; blue copy → text. */
              function isBandOpenSpaceTap(el) {
                if (!el || !el.closest) return false;
                if (isBlueOutlinedTextRegion(el)) return false;
                if (el.closest('.bk-color-band-hit, .bk-hero-band-hit')) return true;
                var surf = el.closest('[data-bk-color-surface]');
                if (!surf) return false;
                var sid = surf.getAttribute('data-bk-color-surface');
                if (!sid) return false;
                if (sid === 'hero' && isHeroImageColumnTarget(el)) return false;
                if (surf === el) return true;
                var openCol = el.closest('[data-bk-band-tappable]');
                if (openCol && openCol === el && !isInsideSurfaceTextKey(el, surf)) return true;
                return !isInsideSurfaceTextKey(el, surf);
              }
              function resolveQuickEditTap(ev) {
                var el = ev.target;
                while (el && el.nodeType !== 1) el = el.parentNode;
                if (!el || !el.closest) return { type: 'none' };
                var groupedHit = resolveGroupedTextEditTarget(el);
                if (groupedHit) return groupedHit;
                if (isBandOpenSpaceTap(el)) {
                  var colorBand = el.closest('[data-bk-color-surface]');
                  if (colorBand) {
                    var sidBand = colorBand.getAttribute('data-bk-color-surface');
                    if (sidBand) return { type: 'color', surface: sidBand, el: colorBand };
                  }
                }
                if (isHeroImageQuickEditTarget(el)) {
                  var heroBtn = el.closest('[data-edit-key="heroImage"]');
                  if (heroBtn) return { type: 'sheet', el: heroBtn };
                }
                var surf = el.closest('[data-bk-color-surface]');
                if (surf && !isEditableQuickEditTarget(el)) {
                  var sidBand = surf.getAttribute('data-bk-color-surface');
                  if (sidBand) return { type: 'color', surface: sidBand, el: surf };
                }
                var textEl = el.closest('[data-edit-key]');
                if (textEl) {
                  var tk = textEl.getAttribute('data-edit-key');
                  if (tk && isSheetOnlyKey(tk)) return { type: 'sheet', el: textEl };
                  if (tk && tk.indexOf('color:') !== 0) return { type: 'text', el: textEl };
                }
                if (surf && !isBlueOutlinedTextRegion(el)) {
                  var sid = surf.getAttribute('data-bk-color-surface');
                  if (sid) return { type: 'color', surface: sid, el: surf };
                }
                if (textEl) return { type: 'sheet', el: textEl };
                return { type: 'none' };
              }
              function resolveHighlightTarget(el) {
                if (!el || !el.closest) return el;
                var btn = el.closest('a.classic-btn-primary,a.classic-btn-ghost,a.luxe-hero-cta,a.luxe-promo-cta,a.tattoo-gallery-link,a.blade-btn-primary,a.blade-btn-ghost,a.blade-nav-book,a.stonecut-btn,a.s12-btn-dark,a.s12-btn-outline,a.s12-nav-book,a.s12-gallery-link');
                if (btn && btn.querySelector('[data-edit-key]')) return btn;
                var innerKey = el.closest('[data-edit-key]');
                if (innerKey) {
                  var grouped = innerKey.closest(bkGroupedTextSelector);
                  if (grouped && grouped !== innerKey) return grouped;
                  return innerKey;
                }
                return el;
              }
              function setQuickEditSelected(el) {
                [].forEach.call(document.querySelectorAll('[data-bk-quick-edit-selected]'), function(node) {
                  node.removeAttribute('data-bk-quick-edit-selected');
                });
                if (!el) return;
                var target = resolveHighlightTarget(el);
                if (target) target.setAttribute('data-bk-quick-edit-selected', '1');
              }
              function setActiveColorSurface(el) {
                [].forEach.call(document.querySelectorAll('[data-bk-color-surface]'), function(node) {
                  node.removeAttribute('data-bk-color-active');
                });
                if (el) el.setAttribute('data-bk-color-active', '1');
              }
              function openColorSurface(sid, surfEl) {
                setActiveColorSurface(surfEl);
                setQuickEditSelected(surfEl);
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
              function computedColorToHex(el) {
                if (!el) return '#333333';
                var cs = window.getComputedStyle(el);
                var raw = (cs && cs.color) ? String(cs.color) : '';
                if (!raw) return '#333333';
                var m = raw.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
                if (m) {
                  function pad2(n) {
                    var h = Math.max(0, Math.min(255, n)).toString(16);
                    return h.length === 1 ? '0' + h : h;
                  }
                  return '#' + pad2(parseInt(m[1], 10)) + pad2(parseInt(m[2], 10)) + pad2(parseInt(m[3], 10));
                }
                if (raw.charAt(0) === '#') return raw;
                return '#333333';
              }
              function resolveInlineColorRole(el) {
                if (!el || !el.closest) return 'text';
                if (el.closest('a.blade-btn-primary,a.classic-btn-primary,a.luxe-hero-cta,a.luxe-promo-cta,a.s12-btn-dark,a.s12-nav-book,a.stonecut-btn-primary,a.blade-nav-book')) {
                  return 'button';
                }
                if (el.closest('a.blade-btn-ghost,a.classic-btn-ghost,a.s12-btn-outline,a.stonecut-btn')) {
                  return 'button';
                }
                return 'text';
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
                  fontAdjustable: isFontAdjustableKey(key),
                  colorHex: computedColorToHex(el),
                  colorRole: resolveInlineColorRole(el)
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
                setQuickEditSelected(t);
                t.setAttribute('contenteditable', 'true');
                t.setAttribute('spellcheck', 'true');
                t.setAttribute('data-bk-inline-editing', '1');
                t.addEventListener('blur', onInlineBlur);
                setTimeout(function() {
                  try {
                    t.focus();
                    var r = document.createRange();
                    r.selectNodeContents(t);
                    r.collapse(false);
                    var sel = window.getSelection();
                    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
                  } catch (e) {}
                  try { t.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (e2) {}
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
                  setQuickEditSelected(t);
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
                var touchTarget = ev.target;
                while (touchTarget && touchTarget.nodeType !== 1) touchTarget = touchTarget.parentNode;
                if (hit.type === 'color' && hit.surface === 'hero' && isHeroImageQuickEditTarget(touchTarget)) {
                  colorLongPressTimer = setTimeout(function() {
                    colorLongPressFired = true;
                    if (inlineEl) finishActiveInlineNoSave();
                    openColorSurface('hero', hit.el);
                  }, 380);
                } else if (!isBlueOutlinedTextRegion(touchTarget)) {
                  var bandEl = touchTarget && touchTarget.closest('[data-bk-color-surface]');
                  if (bandEl && bandEl.tagName !== 'NAV' && touchTarget.closest('[data-bk-band-tappable],.booking-page-band,.booking-card,.gallery-page-band')) {
                    colorLongPressTimer = setTimeout(function() {
                      colorLongPressFired = true;
                      if (inlineEl) finishActiveInlineNoSave();
                      var sid = bandEl.getAttribute('data-bk-color-surface');
                      if (sid) openColorSurface(sid, bandEl);
                    }, 420);
                  }
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
                if (Math.abs(x - touchStart.x) > touchMoveSlopPx || Math.abs(y - touchStart.y) > touchMoveSlopPx) {
                  touchStart = null;
                  touchEditHit = null;
                  return;
                }
                var hit = touchEditHit;
                touchStart = null;
                touchEditHit = null;
                ev.preventDefault();
                ev.stopPropagation();
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                activateQuickEditHit(hit);
                window.__bkQuickEditSuppressClickUntil = Date.now() + 450;
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
              window.__bkQuickEditSetInlineColor = function(hex) {
                if (!inlineEl || !inlineEl.isConnected) return;
                var h = (hex && String(hex).trim()) ? String(hex).trim() : '';
                if (h && h.charAt(0) !== '#') h = '#' + h;
                if (h) inlineEl.style.color = h;
              };
              window.__bkQuickEditCommitDirty = function() {
                finishActiveInlineNoSave();
                var keys = Object.keys(dirty);
                if (keys.length) {
                  postToNative({ action: 'inlineSaveBatch', changes: dirty });
                  dirty = {};
                }
              };
              function ensureColorBandHitAndWrap(el) {
                if (!el || el.tagName === 'NAV') return;
                if (!el.getAttribute('data-bk-band-tappable')) el.setAttribute('data-bk-band-tappable', '');
                var hasHit = false;
                for (var i = 0; i < el.children.length; i++) {
                  if (el.children[i].classList && el.children[i].classList.contains('bk-color-band-hit')) { hasHit = true; break; }
                }
                if (!hasHit) {
                  var btn = document.createElement('button');
                  btn.type = 'button';
                  btn.className = 'bk-color-band-hit';
                  btn.setAttribute('aria-label', 'Edit section background');
                  el.insertBefore(btn, el.firstChild);
                }
                if (!el.querySelector('.bk-band-content') && !el.querySelector('.blade-band-content')) {
                  var wrap = document.createElement('div');
                  wrap.className = 'bk-band-content';
                  var move = [];
                  for (var j = 0; j < el.children.length; j++) {
                    var ch = el.children[j];
                    if (ch.classList && ch.classList.contains('bk-color-band-hit')) continue;
                    move.push(ch);
                  }
                  for (var k = 0; k < move.length; k++) wrap.appendChild(move[k]);
                  el.appendChild(wrap);
                }
              }
              function upgradeColorBandTaps() {
                if (!document.querySelectorAll) return;
                [].forEach.call(document.querySelectorAll('.blade-page .blade-info-section'), function(sec) {
                  sec.removeAttribute('data-bk-color-surface');
                  var secHit = sec.querySelector(':scope > .bk-color-band-hit');
                  if (secHit) secHit.parentNode.removeChild(secHit);
                });
                [].forEach.call(document.querySelectorAll('.blade-page .blade-info-half'), function(half) {
                  if (!half.getAttribute('data-bk-color-surface')) half.setAttribute('data-bk-color-surface', 'card');
                  ensureColorBandHitAndWrap(half);
                });
                [].forEach.call(document.querySelectorAll('[data-bk-color-surface][data-bk-band-tappable]'), function(el) {
                  ensureColorBandHitAndWrap(el);
                });
              }
              upgradeColorBandTaps();
              window.__bkQuickEditInstalled = true;
              window.__bkQuickEditCleanup = function(commitToNative) {
                if (commitToNative !== false) {
                  finishActiveInlineNoSave();
                  var keys = Object.keys(dirty);
                  if (keys.length) {
                    postToNative({ action: 'inlineSaveBatch', changes: dirty });
                    dirty = {};
                  }
                }
                [].forEach.call(document.querySelectorAll('[data-bk-quick-edit-selected]'), function(node) {
                  node.removeAttribute('data-bk-quick-edit-selected');
                });
                document.removeEventListener('touchstart', onTouchStart, { capture: true });
                document.removeEventListener('touchend', onTouchEnd, { capture: true });
                document.removeEventListener('click', onTap, true);
                document.removeEventListener('input', onDocInput, true);
                var s = document.getElementById('bk-quick-edit-style');
                if (s) s.remove();
                window.__bkQuickEditInstalled = false;
                delete window.__bkQuickEditSuppressClickUntil;
                delete window.__bkQuickEditNavigateEditable;
                delete window.__bkQuickEditSetInlineColor;
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
            let js = "(function(){ if (window.__bkQuickEditCleanup) try { window.__bkQuickEditCleanup(true); } catch(e) {} })();"
            webView.evaluateJavaScript(js) { [weak self] _, _ in
                guard let self else { return }
                self.quickEditInstalledForDocument = false
            }
        }
    }
}
