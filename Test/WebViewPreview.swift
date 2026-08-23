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
import UIKit

/// Messages from the injected quick-edit script (`data-edit-key` in `web/index.html`).
enum WebViewQuickEditEvent {
    /// Open `PreviewQuickEditSheet` (or service / hero flows) in SwiftUI.
    case openSheet(key: String, initialText: String)
    /// Persist multiple edited fields after Quick edit is turned off (single preview reload).
    case inlineSaveBatch(changes: [String: String], previous: [String: String])
    /// Inline text field is active (font stepper + navigation in `PreviewQuickEditChrome`).
    case inlineFocus(QuickEditInlineFocus)
    /// Inline text field closed without turning off quick edit.
    case inlineBlur
    /// User tapped a `data-bk-color-surface` band in the preview.
    /// `surfaceKey` is the Classic per-spot override key (`data-bk-surface-key`) when present.
    case openColorSurface(surfaceId: String, surfaceKey: String?)
    /// User tapped CTA chrome (padding outside label) → Background / Text / Button well.
    /// `ctaKey` is the per-button color key when present (Classic independent fills).
    case openChromeColor(targetId: String, ctaKey: String?)
}

/// Native → WebView commands while quick edit is active.
final class WebViewQuickEditBridge {
    weak var coordinator: WebViewRepresentable.Coordinator?
    /// Mirrored so reinstall of the injected script can restore paint mode.
    private(set) var backgroundPaintArmed = false
    /// Last maps applied from the app — re-pushed after each preview navigation / quick-edit install.
    private(set) var cachedButtonColors: [String: String] = [:]
    private(set) var cachedSurfaceColors: [String: String] = [:]
    private(set) var cachedTextColors: [String: String] = [:]
    private(set) var cachedTextFontSizes: [String: String] = [:]

    func navigateEditable(delta: Int) {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditNavigateEditable&&window.__bkQuickEditNavigateEditable(\(delta))")
    }

    func setInlineFontSize(_ px: Int) {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditSetFontSize&&window.__bkQuickEditSetFontSize(\(px))")
    }

    func applyFontSizes(_ map: [String: Int]) {
        cachedTextFontSizes = Dictionary(uniqueKeysWithValues: map.map { ($0.key, String($0.value)) })
        guard let data = try? JSONSerialization.data(withJSONObject: map.mapValues { String($0) }),
              let json = String(data: data, encoding: .utf8) else { return }
        coordinator?.evaluateQuickEdit(
            "(function(){ window.__bkNativeTextFontSizes = \(json); if (window.__bkApplyWebTextStyles) window.__bkApplyWebTextStyles({ webTextFontSizes: \(json) }); if (window.__bkQuickEditApplyFontSizes) window.__bkQuickEditApplyFontSizes(\(json)); })();"
        )
    }

    func applyFieldColors(_ map: [String: String]) {
        cachedTextColors = map
        guard let data = try? JSONSerialization.data(withJSONObject: map),
              let json = String(data: data, encoding: .utf8) else { return }
        coordinator?.evaluateQuickEdit(
            "(function(){ window.__bkNativeTextColors = \(json); if (window.__bkApplyWebTextStyles) window.__bkApplyWebTextStyles({ webTextColors: \(json) }); if (window.__bkQuickEditApplyFieldColors) window.__bkQuickEditApplyFieldColors(\(json)); })();"
        )
    }

    func applyButtonColors(_ map: [String: String]) {
        cachedButtonColors = map
        guard let data = try? JSONSerialization.data(withJSONObject: map),
              let json = String(data: data, encoding: .utf8) else { return }
        // Stamp session overrides even before quick-edit inject exists (mirrors surfaces).
        coordinator?.evaluateQuickEdit(
            "(function(){ window.__bkNativeButtonColors = \(json); if (window.__bkApplyWebButtonColors) window.__bkApplyWebButtonColors({ webButtonColors: \(json) }); })();"
        )
    }

    func applySurfaceColors(_ map: [String: String]) {
        cachedSurfaceColors = map
        guard let data = try? JSONSerialization.data(withJSONObject: map),
              let json = String(data: data, encoding: .utf8) else { return }
        // Stamp native session overrides even before quick-edit inject exists.
        coordinator?.evaluateQuickEdit(
            "(function(){ window.__bkNativeSurfaceColors = \(json); if (window.__bkApplyWebSurfaceColors) window.__bkApplyWebSurfaceColors({ webSurfaceColors: \(json) }); })();"
        )
    }

    /// Re-push cached button/surface/text maps in one WebKit turn (avoids eval ordering races).
    func reapplyCachedStyleMaps() {
        coordinator?.pushCachedStyleMapsToWebView()
    }

    /// Sync bridge cache first, then apply cached maps + full palette patch atomically.
    func flushFullPreviewColorPatch(_ payload: [String: String]) {
        coordinator?.schedulePreviewColorPatch(payload, full: true)
        coordinator?.flushPreviewColorPatch()
    }

    func syncStyleMapsFromViewModel(
        buttons: [String: String],
        surfaces: [String: String],
        textColors: [String: String] = [:],
        textFontSizes: [String: String] = [:]
    ) {
        cachedButtonColors = buttons
        cachedSurfaceColors = surfaces
        cachedTextColors = textColors
        cachedTextFontSizes = textFontSizes
    }

    /// Clears session overrides in the WebView (palette / theme reset).
    func clearStyleMapOverrides() {
        applyButtonColors([:])
        applySurfaceColors([:])
        applyFieldColors([:])
        applyFontSizes([:])
    }

    func setInlineColor(_ hex: String) {
        coordinator?.scheduleInlineColor(hex)
    }

    func commitDirtyEdits() {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditCommitDirty&&window.__bkQuickEditCommitDirty()")
    }

    func showEmptyTextSlots() {
        coordinator?.evaluateQuickEdit("window.__bkQuickEditShowEmptyTextSlots&&window.__bkQuickEditShowEmptyTextSlots()")
    }

    /// When true, band / CTA color taps work as before; text/sheet taps are ignored. When false, color taps are ignored.
    func setBackgroundPaintMode(_ enabled: Bool) {
        backgroundPaintArmed = enabled
        let flag = enabled ? "true" : "false"
        coordinator?.evaluateQuickEdit(
            "window.__bkQuickEditSetBackgroundPaint&&window.__bkQuickEditSetBackgroundPaint(\(flag))"
        )
    }

    func applyTextOverrides(_ map: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: map),
              let json = String(data: data, encoding: .utf8) else { return }
        coordinator?.evaluateQuickEdit(
            "window.__bkQuickEditApplyTextMap&&window.__bkQuickEditApplyTextMap(\(json))"
        )
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
    /// Page background hex — fills WKWebView underlay so Edit chrome never shows a black gap.
    var pageBackgroundHex: String = "#FFFFFF"
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
                        pageBackgroundHex: pageBackgroundHex,
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
    var pageBackgroundHex: String = "#FFFFFF"
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
        webView.uiDelegate = context.coordinator
        context.coordinator.webView = webView
        context.coordinator.bridge = bridge
        bridge?.coordinator = context.coordinator
        Self.applyPageChrome(to: webView, pageBackgroundHex: pageBackgroundHex)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.bridge = bridge
        bridge?.coordinator = context.coordinator
        context.coordinator.onQuickEdit = onQuickEdit
        context.coordinator.quickEditEnabled = quickEditEnabled
        Self.applyPageChrome(to: webView, pageBackgroundHex: pageBackgroundHex)

        let width = containerWidth > 0 ? containerWidth : webView.bounds.width
        guard width > 100 else { return }
        context.coordinator.applyPreviewChromeIfNeeded(webView: webView, width: width)
        if context.coordinator.lastLoadedURL != url {
            context.coordinator.resetQuickEditInstallState()
            context.coordinator.lastLoadedURL = url
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            return
        }
        context.coordinator.applyQuickEditIfNeeded(webView: webView)
    }

    /// Match underlay to page color. Do not change contentInset on Edit — that shifts the preview.
    private static func applyPageChrome(to webView: WKWebView, pageBackgroundHex: String) {
        let bg = UIColor(Color(hex: pageBackgroundHex))
        webView.isOpaque = true
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
        if #available(iOS 15.0, *) {
            webView.underPageBackgroundColor = bg
        }
    }

    /// Charter mobile layout + viewport width — always on in app preview (Edit on or off).
    private static let previewLayoutCSS = """
    .charter-hero>.bk-band-content,.charter-nav>.bk-band-content,.charter-route-canvas>.bk-band-content{position:static!important;display:contents!important;}
    .charter-search>.bk-band-content{position:static!important;display:block!important;width:100%!important;min-width:0!important;box-sizing:border-box!important;}
    .charter-search,.charter-search>.bk-band-content,.charter-search-grid,.charter-search .field,.charter-route-canvas[data-bk-surface-key="charter.chartersPage"],.charter-route-canvas[data-bk-surface-key="charter.chartersPage"]>.bk-band-content,.charter-browse-layout,.charter-browse-filters,.charter-browse-filter-chips,.charter-browse-date-section,.charter-browse-date-strip,.charter-browse-list,.charter-browse-row,.charter-feat-card,.charter-feat-card>.bk-band-content,.charter-blueprint.charter-quote,.charter-blueprint.charter-quote>.bk-band-content,.charter-quote-media,.charter-quote-media [data-edit-key],a.charter-blueprint[data-bk-band-tappable],a.charter-blueprint[data-bk-band-tappable]>.bk-band-content{pointer-events:auto!important;}
    .charter-search input,.charter-search select,.charter-search a.charter-search-go,[data-charter-home-date],.charter-browse-cal-card button,.charter-cal button,.charter-browse-dropdowns select,.charter-cal-nav,.charter-clear-filters,.charter-browse-month-btn,.charter-date-strip-day,.charter-filter-chip{pointer-events:auto!important;}
    .charter-section>.bk-band-content .charter-sec-label,.charter-section>.bk-band-content .charter-sec-heading,.charter-section>.bk-band-content .charter-shop-lead,.charter-section>.bk-band-content .charter-about-title,.charter-section>.bk-band-content a[href],.charter-section>.bk-band-content [data-edit-key]{pointer-events:auto!important;}
    @media (max-width:960px){
    .charter-hero{flex-direction:column!important;justify-content:flex-end!important;align-items:stretch!important;}
    .charter-hero>.bk-band-content,.charter-hero-inner,.charter-search{width:100%!important;min-width:0!important;box-sizing:border-box!important;}
    .charter-search-grid{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;width:100%!important;min-width:0!important;}
    .charter-search .field{min-width:0!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;}
    .charter-search .charter-search-field--full{grid-column:1/-1!important;}
    .charter-search .charter-search-go{grid-column:1/-1!important;width:100%!important;max-width:none!important;display:flex!important;box-sizing:border-box!important;margin:6px 0 0!important;}
    .charter-route-canvas[data-bk-surface-key="charter.chartersPage"]{width:auto!important;min-width:0!important;max-width:none!important;margin:24px 16px 24px!important;box-sizing:border-box!important;}
    .charter-route-canvas[data-bk-surface-key="charter.chartersPage"] .charter-browse-layout{display:flex!important;flex-direction:column!important;gap:16px!important;min-width:0!important;max-width:100%!important;padding:12px 0 28px!important;box-sizing:border-box!important;}
    .charter-browse-list{display:flex!important;flex-direction:column!important;gap:12px!important;min-width:0!important;}
    .charter-browse-row{box-sizing:border-box!important;width:100%!important;min-width:0!important;}
    .charter-browse-filters{display:flex!important;flex-direction:column!important;gap:12px!important;min-width:0!important;}
    .charter-browse-filter-chips{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;align-items:stretch!important;gap:8px!important;margin:0!important;min-width:0!important;overflow-x:auto!important;overflow-y:hidden!important;-webkit-overflow-scrolling:touch!important;}
    .charter-browse-filter-chips .charter-filter-chip{flex:0 0 auto!important;width:auto!important;min-width:0!important;max-width:min(42vw,168px)!important;justify-content:center!important;padding:9px 12px!important;}
    .charter-browse-date-section{display:flex!important;flex-direction:column!important;gap:8px!important;min-width:0!important;}
    .charter-browse-date-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;}
    .charter-browse-month-btn{width:auto!important;max-width:none!important;padding:7px 11px!important;}
    .charter-browse-date-strip{display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;align-items:stretch!important;gap:8px!important;min-width:0!important;width:100%!important;overflow-x:auto!important;overflow-y:hidden!important;-webkit-overflow-scrolling:touch!important;}
    .charter-date-strip-day{flex:0 0 auto!important;width:auto!important;max-width:none!important;min-width:52px!important;padding:8px 6px 10px!important;font-size:inherit!important;font-weight:inherit!important;}
    .charter-nav,.charter-footer{padding-left:16px!important;padding-right:16px!important;}
    }
    """

    fileprivate static func escapedForJSString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
    }

    fileprivate static func applyPreviewViewport(webView: WKWebView, width: CGFloat) {
        let w = max(320, Int(round(width)))
        let script = """
        (function(){
            var content = 'width=\(w), initial-scale=1, viewport-fit=cover';
            var meta = document.querySelector('meta[name=viewport]');
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

    fileprivate static func applyPreviewLayoutStyles(webView: WKWebView) {
        let css = escapedForJSString(previewLayoutCSS)
        let script = """
        (function(){
            var id = 'bk-preview-layout-style';
            var sheet = document.getElementById(id);
            if (!sheet) {
                sheet = document.createElement('style');
                sheet.id = id;
                document.head.appendChild(sheet);
            }
            sheet.textContent = '\(css)';
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let messageHandlerName: String
        var lastLoadedURL: URL?
        weak var webView: WKWebView?
        weak var bridge: WebViewQuickEditBridge?
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
        /// Last viewport width applied — re-run when the preview frame resizes.
        var lastPreviewViewportWidth: Int = 0

        init(messageHandlerName: String) {
            self.messageHandlerName = messageHandlerName
        }

        fileprivate func resetQuickEditInstallState() {
            quickEditInstalledForDocument = false
            quickEditInstallInFlight = false
        }

        /// Viewport + charter mobile layout — persists when Edit toggles off (unlike quick-edit styles).
        func applyPreviewChromeIfNeeded(webView: WKWebView, width: CGFloat) {
            let w = max(320, Int(round(width)))
            if w != lastPreviewViewportWidth {
                lastPreviewViewportWidth = w
                WebViewRepresentable.applyPreviewViewport(webView: webView, width: width)
            }
            WebViewRepresentable.applyPreviewLayoutStyles(webView: webView)
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

        private func styleMapsJson() -> (text: String, surface: String, button: String, font: String) {
            func mapJson(_ map: [String: String]) -> String {
                guard let encoded = try? JSONSerialization.data(withJSONObject: map),
                      let string = String(data: encoded, encoding: .utf8) else { return "{}" }
                return string
            }
            return (
                mapJson(bridge?.cachedTextColors ?? [:]),
                mapJson(bridge?.cachedSurfaceColors ?? [:]),
                mapJson(bridge?.cachedButtonColors ?? [:]),
                mapJson(bridge?.cachedTextFontSizes ?? [:])
            )
        }

        private func jsStampCachedStyleMaps(
            textJson: String,
            surfaceJson: String,
            buttonJson: String,
            fontJson: String
        ) -> String {
            "window.__bkNativeTextColors=\(textJson);" +
            "window.__bkNativeSurfaceColors=\(surfaceJson);" +
            "window.__bkNativeButtonColors=\(buttonJson);" +
            "window.__bkNativeTextFontSizes=\(fontJson);" +
            "if(window.__bkApplyWebSurfaceColors)window.__bkApplyWebSurfaceColors({webSurfaceColors:\(surfaceJson)});" +
            "if(window.__bkApplyWebButtonColors)window.__bkApplyWebButtonColors({webButtonColors:\(buttonJson)});" +
            "if(window.__bkApplyWebTextStyles)window.__bkApplyWebTextStyles({webTextColors:\(textJson),webTextFontSizes:\(fontJson)});" +
            "if(window.__bkQuickEditApplyFieldColors)window.__bkQuickEditApplyFieldColors(\(textJson));" +
            "if(window.__bkQuickEditApplyFontSizes)window.__bkQuickEditApplyFontSizes(\(fontJson));"
        }

        func pushCachedStyleMapsToWebView() {
            let maps = styleMapsJson()
            evaluateQuickEdit(
                "(function(){\(jsStampCachedStyleMaps(textJson: maps.text, surfaceJson: maps.surface, buttonJson: maps.button, fontJson: maps.font))})();"
            )
        }

        private func emitPendingColorPatch() {
            guard let payload = pendingColorPatch,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            let full = pendingColorPatchNeedsFull
            pendingColorPatch = nil
            pendingColorPatchNeedsFull = false
            let opts = full ? "{full:true}" : "{full:false}"
            let maps = styleMapsJson()
            // One WebKit turn: session maps (including `{}`) then palette restamp.
            evaluateQuickEdit(
                "(function(){window.__bkQuickEditEnsureColorPatch&&window.__bkQuickEditEnsureColorPatch();" +
                jsStampCachedStyleMaps(
                    textJson: maps.text,
                    surfaceJson: maps.surface,
                    buttonJson: maps.button,
                    fontJson: maps.font
                ) +
                "window.__bkApplyPreviewColorPatch&&window.__bkApplyPreviewColorPatch(\(json),\(opts));" +
                "if(window.__bkApplyWebTextStyles)window.__bkApplyWebTextStyles({webTextColors:\(maps.text),webTextFontSizes:\(maps.font)});" +
                "})();"
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
                var previous: [String: String] = [:]
                if let rawPrev = body["previous"] as? [String: Any] {
                    for (k, v) in rawPrev {
                        if let s = v as? String { previous[k] = s }
                        else if let n = v as? NSNumber { previous[k] = n.stringValue }
                    }
                }
                event = .inlineSaveBatch(changes: changes, previous: previous)
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
                let surfaceKey = (body["surfaceKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                event = .openColorSurface(
                    surfaceId: surfaceId,
                    surfaceKey: (surfaceKey?.isEmpty == false) ? surfaceKey : nil
                )
            } else if action == "openChromeColor",
                      let targetId = body["target"] as? String {
                let ctaKey = (body["ctaKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                event = .openChromeColor(
                    targetId: targetId,
                    ctaKey: (ctaKey?.isEmpty == false) ? ctaKey : nil
                )
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

        /// Open Instagram / other off-site links in Safari instead of trapping them in the preview WebView.
        private func openExternalIfNeeded(_ url: URL?) -> Bool {
            guard let url else { return false }
            let scheme = (url.scheme ?? "").lowercased()
            guard scheme == "http" || scheme == "https" else { return false }
            let host = (url.host ?? "").lowercased()
            guard !host.isEmpty else { return false }
            let siteHost = (lastLoadedURL?.host ?? "").lowercased()
            let isInstagram = host == "instagram.com" || host.hasSuffix(".instagram.com")
            let isOffsite = !siteHost.isEmpty && host != siteHost && !host.hasSuffix("." + siteHost)
            guard isInstagram || isOffsite else { return false }
            UIApplication.shared.open(url)
            return true
        }

        /// While quick edit is on, block in-preview site navigation so taps edit instead of loading another page.
        /// Off-site links (Instagram) still open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated,
               openExternalIfNeeded(navigationAction.request.url) {
                decisionHandler(.cancel)
                return
            }
            if quickEditEnabled, navigationAction.navigationType == .linkActivated {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if openExternalIfNeeded(navigationAction.request.url) {
                return nil
            }
            if let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            resetQuickEditInstallState()
            lastPreviewViewportWidth = 0
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            let width = webView.bounds.width > 100 ? webView.bounds.width : (webView.superview?.bounds.width ?? UIScreen.main.bounds.width)
            applyPreviewChromeIfNeeded(webView: webView, width: width)
            applyQuickEditIfNeeded(webView: webView)
            // Always re-apply in-memory style maps after navigation (Edit on or off).
            DispatchQueue.main.async { [weak self] in
                self?.bridge?.reapplyCachedStyleMaps()
            }
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
              var dirtyPrev = {};
              var editBaseline = {};
              var inlinePrevText = '';
              // Button labels must stay non-empty so the blue text hit target never collapses.
              var requiredCtaDefaults = {
                'wc.luxe.heroCta': 'Book Appointment',
                'wc.luxe.promoCta': 'Book Now',
                'wc.luxe.navBook': 'Booking',
                'wc.luxe.shopViewAll': 'View full shop \\u2192',
                'wc.blade.navBook': 'Book now',
                'wc.blade.bookPanelPrimary': 'Book now',
                'wc.blade.heroBook': 'Book appointment',
                'wc.stonecut.navBook': 'Book',
                'wc.stonecut.heroBook': 'Book a session',
                'wc.classic.heroBook': 'Book now',
                'wc.classic.navBook': 'Book',
                'wc.classic.heroGallery': 'View work',
                'wc.classic.galleryLink': 'View full gallery \\u2192',
                'wc.s12.navBook': 'Book now',
                'wc.s12.heroReserve': 'Reserve your visit',
                'wc.s12.exploreCta': 'Explore services',
                'wc.s12.bookSectionCta': 'Request appointment',
                'wc.s12.shopViewAll': 'View full shop',
                'wc.s12.galleryViewLink': 'View gallery',
                'wc.book.submit': 'Request booking'
              };
              function isRequiredCtaKey(k) {
                return !!(k && Object.prototype.hasOwnProperty.call(requiredCtaDefaults, k));
              }
              function currentText(el) {
                var raw = (el.innerText != null ? el.innerText : el.textContent) || '';
                return raw.replace(/^\\s+|\\s+$/g, '');
              }
              function canonicalTextSaveKey(k) {
                if (!k) return k;
                if (k === 'displayName' || k.indexOf('displayName.') === 0) return 'displayName';
                return k;
              }
              function syncSharedTextField(host) {
                if (!host || !host.getAttribute) return;
                var field = host.getAttribute('data-bk-text-field');
                if (!field) return;
                var val = currentText(host);
                [].forEach.call(document.querySelectorAll('[data-bk-text-field="' + field + '"]'), function(el) {
                  if (el === host) return;
                  el.textContent = val;
                  if (val) {
                    el.removeAttribute('data-bk-empty-slot');
                    el.removeAttribute('data-bk-empty-slot-label');
                    el.classList.remove('bk-copy-empty');
                  }
                });
              }
              function ensureRequiredCtaLabel(el) {
                if (!el || !el.getAttribute) return;
                var k = el.getAttribute('data-edit-key') || '';
                if (!isRequiredCtaKey(k)) return;
                if (currentText(el)) return;
                var fallback = (inlinePrevText && inlinePrevText.replace(/^\\s+|\\s+$/g, '')) || requiredCtaDefaults[k] || 'Book now';
                el.textContent = fallback;
                el.removeAttribute('data-bk-empty-slot');
                el.removeAttribute('data-bk-empty-slot-label');
                el.classList.remove('bk-copy-empty');
              }
              function noteDirtyFrom(el) {
                var k = el.getAttribute('data-edit-key');
                if (!k || isSheetOnlyKey(k)) return;
                ensureRequiredCtaLabel(el);
                syncSharedTextField(el);
                var saveKey = canonicalTextSaveKey(k);
                if (!(saveKey in dirtyPrev)) {
                  dirtyPrev[saveKey] = (saveKey in editBaseline) ? editBaseline[saveKey] : currentText(el);
                }
                dirty[saveKey] = currentText(el);
              }
              function flushDirtyToNative() {
                var keys = Object.keys(dirty);
                if (!keys.length) {
                  dirtyPrev = {};
                  return;
                }
                var changes = {};
                var previous = {};
                keys.forEach(function(k) {
                  var saveKey = canonicalTextSaveKey(k);
                  var next = dirty[k] == null ? '' : String(dirty[k]);
                  var prev = (k in dirtyPrev)
                    ? String(dirtyPrev[k])
                    : ((saveKey in editBaseline) ? String(editBaseline[saveKey]) : ((k in editBaseline) ? String(editBaseline[k]) : ''));
                  if (next !== prev) {
                    changes[saveKey] = next;
                    if (!(saveKey in previous)) previous[saveKey] = prev;
                  }
                });
                dirty = {};
                dirtyPrev = {};
                if (!Object.keys(changes).length) return;
                postToNative({ action: 'inlineSaveBatch', changes: changes, previous: previous });
              }
              var sheet = document.createElement('style');
              sheet.id = 'bk-quick-edit-style';
              var bkGroupedTextSelector = '.s12-section-title,.s12-section-label,.s12-info-title,.s12-info-book-title,.s12-test-title,.s12-gallery-title,.s12-phil-title,.luxe-section-heading,.luxe-section-label,.classic-section-eyebrow,.classic-hero-tag,.classic-hero-name,.classic-home .tattoo-featured-inner h2,.classic-services h2,.tattoo-featured-sub,.blade-section-label,.blade-section-title,.blade-book-title,.blade-where-city,.blade-hero-title,.stonecut-heading,.booking-page-title,.booking-page-subtitle,.charter-hero-title,.charter-hero-lead,.charter-brand,.charter-sec-label,.charter-loc,.charter-sec-heading,.charter-quote-copy p,.charter-shop-lead,.charter-about-title,.charter-captain-name,.bk-team-member-name,.bk-team-member-role,.bk-team-member-work-title,.bk-team-roster-title,.bk-team-roster-subtitle';
              var bkCtaButtonSelector = 'a.classic-btn-primary,a.classic-btn-ghost,a.classic-nav-book,a.luxe-hero-cta,a.luxe-promo-cta,a.luxe-nav-book,a.luxe-shop-view-all,a.tattoo-gallery-link,a.blade-btn-primary,a.blade-btn-ghost,a.blade-nav-book,a.stonecut-btn,a.s12-btn-dark,a.s12-btn-outline,a.s12-nav-book,a.s12-gallery-link,a.charter-btn,button.charter-btn[data-cta-key],button.charter-product-add[data-cta-key],a.bk-team-member-book,button.booking-submit[data-cta-key]';
              sheet.textContent = '[data-edit-key]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;-webkit-tap-highlight-color:rgba(0,122,255,0.12);}' +
                '[data-edit-key][data-bk-inline-editing]{cursor:text!important;outline:2.5px dashed rgba(0,122,255,0.88)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                /* Outline only — do not set width:max-content (that reflows layout when Edit toggles). */
                bkGroupedTextSelector + '{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;border-radius:2px!important;}' +
                bkGroupedTextSelector + ' [data-edit-key]{outline:none!important;box-shadow:none!important;}' +
                bkCtaButtonSelector + '{cursor:pointer!important;outline:none!important;box-shadow:none!important;}' +
                bkCtaButtonSelector + ' [data-edit-key]{cursor:text!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                bkCtaButtonSelector + ' [data-edit-key][data-bk-inline-editing]{outline:2.5px dashed rgba(0,122,255,0.88)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '[data-edit-key^="svc:"][data-edit-key$=":edit"],[data-edit-key^="s12Process:"][data-edit-key$=":edit"],[data-edit-key^="charterFaq:"][data-edit-key$=":edit"],[data-edit-key="charterQuote:edit"]{outline:none!important;box-shadow:none!important;cursor:pointer!important;}' +
                '[data-edit-key^="svc:"][data-edit-key$=":edit"] [data-edit-key],[data-edit-key^="s12Process:"][data-edit-key$=":edit"] [data-edit-key],[data-edit-key^="charterFaq:"][data-edit-key$=":edit"] [data-edit-key],[data-edit-key="charterQuote:edit"] [data-edit-key]{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                'a.blade-service-card[data-edit-key],a.stonecut-service-card[data-edit-key],div.s12-svc-cell[data-edit-key],div.s12-process-cell[data-edit-key]{cursor:pointer!important;}' +
                'button.bk-hero-image-hit[data-edit-key="heroImage"],button.luxe-hero-image-hit[data-edit-key="heroImage"]{outline:none!important;outline-offset:0!important;box-shadow:none!important;}' +
                '[data-edit-key="heroImage"].classic-hero-placeholder,[data-edit-key="heroImage"].blade-hero-placeholder,[data-edit-key="heroImage"].stonecut-hero-photo--empty,[data-edit-key="heroImage"].s12-hero-img-fallback{outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:0!important;cursor:pointer!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                'img[data-edit-key="heroImage"],img[data-edit-key^="galleryImage"],img[data-edit-key^="featuredWork"],img[data-edit-key="studio12PhilosophyImage"],img[data-edit-key="studio12BookCtaImage"],img[data-edit-key="classicAboutImage"],img[data-edit-key^="tm:"][data-edit-key$=":photo"],' +
                '[data-edit-key^="featuredWork"].luxe-service-placeholder,[data-edit-key^="featuredWork"].tattoo-featured-slot-add,[data-edit-key^="featuredWork"].tattoo-featured-cell,.tattoo-featured-placeholder[data-edit-key],' +
                '[data-edit-key^="galleryImage"].s12-hero-img-fallback,[data-edit-key="studio12PhilosophyImage"].s12-hero-img-fallback,[data-edit-key="studio12BookCtaImage"].s12-hero-img-fallback,[data-edit-key="studio12BookCtaImage"].s12-info-book-img-fallback,[data-edit-key="classicAboutImage"].classic-about-photo--empty,[data-edit-key="classicAboutImage"].charter-about-photo--empty,[data-edit-key^="galleryImage"].charter-quote-ph,[data-edit-key^="tm:"][data-edit-key$=":photo"].bk-team-member-initials' +
                '{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.68)!important;outline-offset:2px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.75)!important;}' +
                '@media (max-width:900px){.studio12-page .s12-nav-trailing .s12-nav-book,.studio12-page .s12-nav-trailing a.s12-nav-book[data-edit-key],.studio12-page .s12-nav-trailing a.s12-nav-book[data-cta-key],.studio12-page .s12-nav-trailing a.s12-nav-book[data-bk-empty-slot]{display:none!important;}}' +
                '[data-bk-color-surface]{outline:none!important;box-shadow:none!important;}' +
                'html[data-bk-paint-mode] [data-bk-color-surface]{cursor:pointer!important;outline:2px dashed rgba(0,122,255,0.55)!important;outline-offset:0!important;box-shadow:none!important;}' +
                'html[data-bk-paint-mode] [data-bk-color-surface][data-bk-color-active]{outline:3px dashed rgba(0,122,255,0.88)!important;}' +
                bkGroupedTextSelector + '[data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                bkGroupedTextSelector + '[data-bk-quick-edit-selected] [data-edit-key],' + bkGroupedTextSelector + ':has([data-bk-inline-editing]) [data-edit-key],'+ bkGroupedTextSelector + ':has([data-bk-inline-editing]) [data-edit-key][data-bk-inline-editing]{outline:none!important;box-shadow:none!important;}' +
                bkGroupedTextSelector + ':has([data-bk-inline-editing]){outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '[data-edit-key][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                'html[data-bk-paint-mode] [data-bk-color-surface][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;border-radius:8px!important;box-shadow:0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                '[data-edit-key][data-bk-inline-editing][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38),0 0 0 4px rgba(0,122,255,0.18)!important;}' +
                '[data-edit-key][data-bk-empty-slot]{outline:1px dashed rgba(0,122,255,0.72)!important;outline-offset:2px!important;cursor:text!important;}' +
                bkCtaButtonSelector + '[data-bk-quick-edit-selected]{outline:none!important;box-shadow:none!important;}' +
                bkCtaButtonSelector + '[data-bk-quick-edit-selected] [data-edit-key],'+ bkCtaButtonSelector + ':has([data-bk-inline-editing]) [data-edit-key]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;border-radius:8px!important;box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2),0 0 0 1px rgba(255,255,255,0.38)!important;}' +
                'button.bk-hero-image-hit[data-bk-quick-edit-selected],button.luxe-hero-image-hit[data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;}' +
                'img[data-edit-key][data-bk-quick-edit-selected]{outline:2px solid rgba(255,255,255,0.92)!important;outline-offset:2px!important;}' +
                'button.bk-color-band-hit,button.bk-hero-band-hit{outline:none!important;box-shadow:none!important;cursor:pointer!important;pointer-events:auto!important;}' +
                /* Keep relative for band hits, but never demote fixed topnavs into document flow. */
                '[data-bk-band-tappable]:not(.blade-topnav):not(.stonecut-nav):not(.s12-topnav){position:relative!important;}' +
                '.bk-band-content,.blade-band-content{position:relative!important;z-index:1!important;pointer-events:none!important;}' +
                /* Charter layout wrappers stay static + contents — full rules live in bk-preview-layout-style. */
                '.charter-hero>.bk-band-content,.charter-nav>.bk-band-content,.charter-route-canvas>.bk-band-content{position:static!important;display:contents!important;}' +
                '.charter-search>.bk-band-content{position:static!important;display:block!important;width:100%!important;min-width:0!important;box-sizing:border-box!important;}' +
                '.charter-search,.charter-search>.bk-band-content,.charter-search-grid,.charter-search .field,.charter-route-canvas[data-bk-surface-key="charter.chartersPage"],.charter-route-canvas[data-bk-surface-key="charter.chartersPage"]>.bk-band-content,.charter-browse-layout,.charter-browse-filters,.charter-browse-filter-chips,.charter-browse-date-section,.charter-browse-date-strip,.charter-browse-list,.charter-browse-row,.charter-feat-card,.charter-feat-card>.bk-band-content,.charter-blueprint.charter-quote,.charter-blueprint.charter-quote>.bk-band-content,.charter-quote-media,.charter-quote-media [data-edit-key],a.charter-blueprint[data-bk-band-tappable],a.charter-blueprint[data-bk-band-tappable]>.bk-band-content{pointer-events:auto!important;}' +
                '.charter-search input,.charter-search select,.charter-search a.charter-search-go,[data-charter-home-date],.charter-browse-cal-card button,.charter-cal button,.charter-browse-dropdowns select,.charter-cal-nav,.charter-clear-filters,.charter-browse-month-btn,.charter-date-strip-day,.charter-filter-chip{pointer-events:auto!important;}' +
                '.charter-section>.bk-band-content .charter-sec-label,.charter-section>.bk-band-content .charter-sec-heading,.charter-section>.bk-band-content .charter-shop-lead,.charter-section>.bk-band-content .charter-about-title,.charter-section>.bk-band-content a[href],.charter-section>.bk-band-content [data-edit-key]{pointer-events:auto!important;}' +
                '.bk-band-content [data-edit-key],.bk-band-content a,.bk-band-content button,.bk-band-content [role="button"],' +
                '.bk-band-content .booking-form,.bk-band-content .booking-form--guided,.bk-band-content .booking-guided,' +
                '.bk-band-content .booking-form input,.bk-band-content .booking-form select,.bk-band-content .booking-form textarea,.bk-band-content .booking-form label,' +
                '.bk-band-content .field-input,.bk-band-content .pref-days-dropdown,.bk-band-content .upload-drop,' +
                '.bk-band-content .charter-search,.bk-band-content .charter-search input,.bk-band-content .charter-search select,.bk-band-content .charter-search label,' +
                '.charter-search > .bk-band-content input,.charter-search > .bk-band-content select,.charter-search > .bk-band-content label,.charter-search > .bk-band-content a,.charter-search > .bk-band-content button,' +
                '.charter-route-canvas[data-bk-band-tappable] .bk-band-content select,.charter-route-canvas[data-bk-band-tappable] .bk-band-content button,.charter-route-canvas[data-bk-band-tappable] .bk-band-content label,.charter-route-canvas[data-bk-band-tappable] .bk-band-content a,.charter-route-canvas[data-bk-band-tappable] .bk-band-content input,' +
                '.charter-blueprint[data-bk-band-tappable] > .bk-band-content a,.charter-blueprint[data-bk-band-tappable] > .bk-band-content button,.charter-blueprint[data-bk-band-tappable] > .bk-band-content input,.charter-blueprint[data-bk-band-tappable] > .bk-band-content select,.charter-blueprint[data-bk-band-tappable] > .bk-band-content label,.charter-blueprint[data-bk-band-tappable] > .bk-band-content span,' +
                '.charter-browse-cal-card > .bk-band-content button,.charter-browse-cal-card > .bk-band-content span,' +
                '.charter-browse-row > .bk-band-content a,.charter-browse-row > .bk-band-content button,' +
                '.bk-band-content .charter-browse-layout input,.bk-band-content .charter-browse-layout select,.bk-band-content .charter-browse-layout label,.bk-band-content .charter-browse-layout button,' +
                '.bk-band-content .charter-drop,.bk-band-content .charter-drop select,.bk-band-content .charter-drop label,' +
                '.bk-band-content [data-charter-detail-date],.bk-band-content [data-charter-detail-time],.bk-band-content [data-charter-detail-people],' +
                '.blade-band-content [data-edit-key],.blade-band-content a,.blade-band-content button,.blade-band-content [role="button"],' +
                '.blade-band-content .booking-form,.blade-band-content .booking-form--guided,.blade-band-content .booking-guided,' +
                '.blade-band-content .booking-form input,.blade-band-content .booking-form select,.blade-band-content .booking-form textarea,.blade-band-content .booking-form label,' +
                '.blade-band-content .field-input,.blade-band-content .pref-days-dropdown,.blade-band-content .upload-drop,' +
                '.blade-band-content .charter-search,.blade-band-content .charter-search input,.blade-band-content .charter-search select,.blade-band-content .charter-search label,' +
                '.charter-search > .bk-band-content input,.charter-search > .bk-band-content select,.charter-search > .bk-band-content label,.charter-search > .bk-band-content a,.charter-search > .bk-band-content button,' +
                '.charter-route-canvas[data-bk-band-tappable] .bk-band-content select,.charter-route-canvas[data-bk-band-tappable] .bk-band-content button,.charter-route-canvas[data-bk-band-tappable] .bk-band-content label,.charter-route-canvas[data-bk-band-tappable] .bk-band-content a,.charter-route-canvas[data-bk-band-tappable] .bk-band-content input,' +
                '.charter-blueprint[data-bk-band-tappable] > .bk-band-content a,.charter-blueprint[data-bk-band-tappable] > .bk-band-content button,.charter-blueprint[data-bk-band-tappable] > .bk-band-content input,.charter-blueprint[data-bk-band-tappable] > .bk-band-content select,.charter-blueprint[data-bk-band-tappable] > .bk-band-content label,.charter-blueprint[data-bk-band-tappable] > .bk-band-content span,' +
                '.charter-browse-cal-card > .bk-band-content button,.charter-browse-cal-card > .bk-band-content span,' +
                '.charter-browse-row > .bk-band-content a,.charter-browse-row > .bk-band-content button,' +
                '.blade-band-content .charter-browse-layout input,.blade-band-content .charter-browse-layout select,.blade-band-content .charter-browse-layout label,.blade-band-content .charter-browse-layout button,' +
                '.blade-band-content .charter-drop,.blade-band-content .charter-drop select,.blade-band-content .charter-drop label,' +
                '.blade-band-content [data-charter-detail-date],.blade-band-content [data-charter-detail-time],.blade-band-content [data-charter-detail-people]{pointer-events:auto!important;}';
              document.head.appendChild(sheet);
              var touchMoveSlopPx = 20;
              function isHeroImageQuickEditTarget(el) {
                if (!el || !el.closest) return false;
                return !!el.closest('.bk-hero-image-hit, .luxe-hero-image-hit, img[data-edit-key="heroImage"], [data-edit-key="heroImage"].classic-hero-placeholder, [data-edit-key="heroImage"].blade-hero-placeholder, [data-edit-key="heroImage"].stonecut-hero-photo--empty, [data-edit-key="heroImage"].s12-hero-img-fallback');
              }
              function isGalleryImageQuickEditTarget(el) {
                if (!el || !el.closest) return false;
                return !!el.closest('img[data-edit-key^="galleryImage"], [data-edit-key^="galleryImage"].charter-quote-ph');
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
                return !!el.closest('.blade-hero-right,.classic-hero-right,.stonecut-hero-right,.s12-hero-img-col,.bk-hero-image-hit,.luxe-hero-image-hit,.luxe-hero');
              }
              /** Luxe hero is photo-only; never open section color from that band. */
              function isLuxeHeroPhotoSurface(el) {
                if (!el || !el.closest) return false;
                return !!el.closest('.luxe-hero');
              }
              function luxeHeroImageHitEl() {
                return document.querySelector('.luxe-hero .luxe-hero-image-hit[data-edit-key="heroImage"], .luxe-hero .bk-hero-image-hit[data-edit-key="heroImage"]');
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
                var keyed = el.closest('[data-edit-key]');
                if (keyed && grouped.contains(keyed) && keyed !== grouped) {
                  var tk = keyed.getAttribute('data-edit-key');
                  if (tk && isSheetOnlyKey(tk)) return { type: 'sheet', el: keyed };
                  if (tk && tk.indexOf('color:') !== 0) return { type: 'text', el: keyed };
                }
                var selfKey = grouped.getAttribute && grouped.getAttribute('data-edit-key');
                if (selfKey) {
                  if (isSheetOnlyKey(selfKey)) return { type: 'sheet', el: grouped };
                  if (selfKey.indexOf('color:') !== 0) return { type: 'text', el: grouped };
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
                if (isLuxeHeroPhotoSurface(el)) return false;
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
              function isCharterBookingControl(el) {
                if (!el || !el.closest) return false;
                return !!el.closest(
                  '.charter-search .field,.charter-search-field-label,.charter-search input,.charter-search select,.charter-search a.charter-search-go,' +
                  '.charter-browse-layout input,.charter-browse-layout select,.charter-browse-layout button,' +
                  '[data-charter-home-date],[data-charter-detail-date],[data-charter-detail-time],' +
                  '[data-charter-detail-people],[data-charter-detail-continue]'
                );
              }
              function resolveQuickEditTap(ev) {
                var el = ev.target;
                while (el && el.nodeType !== 1) el = el.parentNode;
                if (!el || !el.closest) return { type: 'none' };
                if (isCharterBookingControl(el)) return { type: 'none' };
                // Background paint mode: prefer section/button color over text hits.
                if (isBackgroundPaintArmed()) {
                  var menuPaint = el.closest('.tattoo-nav-menu, .classic-hero-nav-menu');
                  if (menuPaint) return { type: 'color', surface: 'sidebar', el: menuPaint };
                  var sidePanelPaint = el.closest('.tattoo-sidebar-panel');
                  if (sidePanelPaint) return { type: 'color', surface: 'sidebar', el: sidePanelPaint };
                  var ctaPaint = el.closest(bkCtaButtonSelector);
                  if (ctaPaint) return { type: 'buttonColor', el: ctaPaint };
                  if (isHeroImageQuickEditTarget(el)) return { type: 'none' };
                  if (isLuxeHeroPhotoSurface(el)) return { type: 'none' };
                  var surfPaint = el.closest('[data-bk-color-surface]');
                  if (surfPaint) {
                    var sidPaint = surfPaint.getAttribute('data-bk-color-surface');
                    if (sidPaint === 'hero' && isHeroImageColumnTarget(el)) {
                      return { type: 'none' };
                    }
                    if (sidPaint) {
                      return { type: 'color', surface: sidPaint, el: surfPaint };
                    }
                  }
                  if (isBandOpenSpaceTap(el)) {
                    var bandPaint = el.closest('[data-bk-color-surface]');
                    if (bandPaint) {
                      var sidBandPaint = bandPaint.getAttribute('data-bk-color-surface');
                      if (sidBandPaint) return { type: 'color', surface: sidBandPaint, el: bandPaint };
                    }
                  }
                  return { type: 'none' };
                }
                // Restored template slots must take precedence over surrounding hero/image hit targets.
                var emptySlot = el.closest('[data-bk-empty-slot]');
                if (emptySlot) return { type: 'text', el: emptySlot };
                var quoteEdit = el.closest('[data-edit-key="charterQuote:edit"], .charter-blueprint.charter-quote');
                if (quoteEdit) {
                  if (quoteEdit.getAttribute && quoteEdit.getAttribute('data-edit-key') !== 'charterQuote:edit') {
                    quoteEdit = quoteEdit.querySelector('[data-edit-key="charterQuote:edit"]') || quoteEdit;
                  }
                  return { type: 'sheet', el: quoteEdit };
                }
                var groupedHit = resolveGroupedTextEditTarget(el);
                if (groupedHit) return groupedHit;
                if (isGalleryImageQuickEditTarget(el)) {
                  var galleryBtn = el.closest('[data-edit-key^="galleryImage"]');
                  if (galleryBtn) return { type: 'sheet', el: galleryBtn };
                }
                // Charter controls frequently wrap one editable label. Treat the full visible
                // link/button as that text target while Edit is on (paint mode was handled above).
                var charterInteractive = el.closest(
                  '.charter-page a[href],.charter-page button,.charter-page [role="button"]'
                );
                if (charterInteractive) {
                  var charterLabels = charterInteractive.querySelectorAll('[data-edit-key]');
                  if (charterLabels.length === 1) {
                    var charterLabel = charterLabels[0];
                    var charterKey = charterLabel.getAttribute('data-edit-key') || '';
                    if (charterKey && charterKey.indexOf('color:') !== 0) {
                      return {
                        type: isSheetOnlyKey(charterKey) ? 'sheet' : 'text',
                        el: charterLabel
                      };
                    }
                  }
                  var charterSelfKey = charterInteractive.getAttribute('data-edit-key') || '';
                  if (charterSelfKey && charterSelfKey.indexOf('color:') !== 0) {
                    return {
                      type: isSheetOnlyKey(charterSelfKey) ? 'sheet' : 'text',
                      el: charterInteractive
                    };
                  }
                }
                var cta = el.closest(bkCtaButtonSelector);
                if (cta) {
                  var label = null;
                  var ctaKey = el.closest('[data-edit-key]');
                  // Prefer nested label only — never treat the CTA <a> itself as the text key.
                  if (ctaKey && cta.contains(ctaKey) && ctaKey !== cta) label = ctaKey;
                  if (!label) {
                    var innerLabel = cta.querySelector('[data-edit-key]');
                    if (innerLabel && (el === innerLabel || innerLabel.contains(el))) label = innerLabel;
                  }
                  // Hit landed on <a> chrome but coordinates sit inside the blue label → edit text.
                  if (!label && typeof ev.clientX === 'number') {
                    var geoLabel = cta.querySelector('[data-edit-key]');
                    if (geoLabel) {
                      var gr = geoLabel.getBoundingClientRect();
                      if (ev.clientX >= gr.left && ev.clientX <= gr.right && ev.clientY >= gr.top && ev.clientY <= gr.bottom) {
                        label = geoLabel;
                      }
                    }
                  }
                  // Empty required CTA labels: any tap on the button opens text (avoid stuck color-only).
                  if (!label) {
                    var emptyLabel = cta.querySelector('[data-edit-key]');
                    if (emptyLabel) {
                      var emptyKey = emptyLabel.getAttribute('data-edit-key') || '';
                      if (isRequiredCtaKey(emptyKey) && !currentText(emptyLabel)) label = emptyLabel;
                    }
                  }
                  if (label) {
                    var ctaTk = label.getAttribute('data-edit-key');
                    if (ctaTk && isSheetOnlyKey(ctaTk)) return { type: 'sheet', el: label };
                    if (ctaTk && ctaTk.indexOf('color:') !== 0) return { type: 'text', el: label };
                  }
                  return { type: 'buttonColor', el: cta };
                }
                if (isBandOpenSpaceTap(el)) {
                  var bandText = resolveGroupedTextEditTarget(el);
                  if (bandText) return bandText;
                  var bandKeyed = el.closest('[data-edit-key]');
                  if (bandKeyed) {
                    var bandTk = bandKeyed.getAttribute('data-edit-key');
                    if (bandTk && bandTk.indexOf('color:') !== 0 && !isSheetOnlyKey(bandTk)) {
                      return { type: 'text', el: bandKeyed };
                    }
                  }
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
                if (isLuxeHeroPhotoSurface(el) && !isBlueOutlinedTextRegion(el)) {
                  var luxeHeroBtn = el.closest('[data-edit-key="heroImage"]') || luxeHeroImageHitEl();
                  if (luxeHeroBtn) return { type: 'sheet', el: luxeHeroBtn };
                }
                var surf = el.closest('[data-bk-color-surface]');
                if (surf && !isEditableQuickEditTarget(el)) {
                  var sidBand2 = surf.getAttribute('data-bk-color-surface');
                  if (sidBand2) return { type: 'color', surface: sidBand2, el: surf };
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
                var btn = el.closest(bkCtaButtonSelector);
                if (btn) {
                  var labelHit = btn.querySelector('[data-edit-key]');
                  if (labelHit) return labelHit;
                  return btn;
                }
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
                var surfaceKey = '';
                try {
                  surfaceKey = (surfEl && surfEl.getAttribute && (surfEl.getAttribute('data-bk-surface-key') || '')) || '';
                } catch (eKey) { surfaceKey = ''; }
                postToNative({ action: 'openColorSurface', surface: sid, surfaceKey: surfaceKey });
              }
              function isSheetOnlyKey(key) {
                if (!key) return true;
                if (key === 'heroImage' || key === 'studio12PhilosophyImage' || key === 'studio12BookCtaImage' || key === 'classicAboutImage') return true;
                if (key.indexOf('featuredWork:') === 0 || key.indexOf('galleryImage:') === 0) return true;
                if (key.indexOf('svc:') === 0) return true;
                if (key.indexOf('s12Process:') === 0) return true;
                if (key.indexOf('charterFaq:') === 0) return key.indexOf(':edit') !== -1;
                if (key === 'charterQuote:edit') return true;
                if (key.indexOf('tm:') === 0) return key.indexOf(':photo') !== -1;
                return false;
              }
              function isFontAdjustableKey(key) {
                if (!key || isSheetOnlyKey(key)) return false;
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
                if (el.closest('a.blade-btn-primary,a.classic-btn-primary,a.luxe-hero-cta,a.luxe-promo-cta,a.luxe-nav-book,a.luxe-shop-view-all,a.s12-btn-dark,a.s12-nav-book,a.stonecut-btn-primary,a.blade-nav-book,a.bk-team-member-book')) {
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
              function clearEmptyTextSlots() {
                [].forEach.call(document.querySelectorAll('[data-bk-empty-slot]'), function(el) {
                  el.removeAttribute('data-bk-empty-slot');
                  if (el.getAttribute('data-bk-empty-slot-label') === '1') {
                    el.textContent = '';
                    el.removeAttribute('data-bk-empty-slot-label');
                  }
                });
              }
              window.__bkQuickEditShowEmptyTextSlots = function() {
                if (inlineEl) finishActiveInlineNoSave();
                if (document.querySelector('[data-bk-empty-slot]')) {
                  clearEmptyTextSlots();
                  return;
                }
                clearEmptyTextSlots();
                [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(el) {
                  var key = el.getAttribute('data-edit-key') || '';
                  if (!key || isSheetOnlyKey(key) || key.indexOf('color:') === 0) return;
                  if (currentText(el)) return;
                  // Required CTAs: put the default back instead of an empty slot (always typeable).
                  if (isRequiredCtaKey(key)) {
                    el.textContent = requiredCtaDefaults[key] || 'Book now';
                    el.classList.remove('bk-copy-empty');
                    dirty[key] = currentText(el);
                    return;
                  }
                  el.setAttribute('data-bk-empty-slot', '1');
                  el.textContent = 'Tap to add text';
                  el.setAttribute('data-bk-empty-slot-label', '1');
                });
              };
              function deliverOpenSheet(t) {
                var key = t.getAttribute('data-edit-key');
                if (!key) return;
                if (t.closest && t.closest('.charter-blueprint.charter-quote')) {
                  var quoteCard = t.closest('[data-edit-key="charterQuote:edit"]') || t.closest('.charter-blueprint.charter-quote');
                  if (quoteCard) {
                    key = 'charterQuote:edit';
                    t = quoteCard;
                  }
                }
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
                flushDirtyToNative();
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
                syncSharedTextField(host);
                var saveKey = canonicalTextSaveKey(k);
                if (!(saveKey in dirtyPrev)) dirtyPrev[saveKey] = (saveKey in editBaseline) ? editBaseline[saveKey] : '';
                dirty[saveKey] = currentText(host);
              }
              function startInline(t) {
                if (inlineEl && inlineEl !== t) finishActiveInlineNoSave();
                inlinePrevText = currentText(t);
                if (t.getAttribute('data-bk-empty-slot-label') === '1') {
                  // Required CTA: seed the default so the box never collapses mid-edit.
                  var slotKey = t.getAttribute('data-edit-key') || '';
                  if (isRequiredCtaKey(slotKey)) {
                    t.textContent = requiredCtaDefaults[slotKey] || 'Book now';
                    inlinePrevText = currentText(t);
                  } else {
                    t.textContent = '';
                  }
                  t.removeAttribute('data-bk-empty-slot-label');
                  t.removeAttribute('data-bk-empty-slot');
                } else if (isRequiredCtaKey(t.getAttribute('data-edit-key') || '') && !currentText(t)) {
                  t.textContent = requiredCtaDefaults[t.getAttribute('data-edit-key')] || 'Book now';
                  inlinePrevText = currentText(t);
                }
                var baselineKey = t.getAttribute('data-edit-key');
                if (baselineKey) editBaseline[canonicalTextSaveKey(baselineKey)] = inlinePrevText;
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
              function openChromeColorTarget(targetId, el) {
                setQuickEditSelected(el);
                var ctaKey = '';
                if (el && el.closest) {
                  var cta = el.closest(bkCtaButtonSelector) || el;
                  ctaKey = (cta.getAttribute && (cta.getAttribute('data-cta-key') || '')) || '';
                  if (!ctaKey) {
                    var label = cta.querySelector && cta.querySelector('[data-edit-key]');
                    if (label) ctaKey = label.getAttribute('data-edit-key') || '';
                  }
                }
                var payload = { action: 'openChromeColor', target: targetId || 'button' };
                if (ctaKey) payload.ctaKey = ctaKey;
                postToNative(payload);
              }
              function isBackgroundPaintArmed() {
                return !!window.__bkQuickEditBackgroundPaint;
              }
              function activateQuickEditHit(hit) {
                if (!hit || hit.type === 'none') return;
                var paint = isBackgroundPaintArmed();
                if (hit.type === 'color') {
                  if (!paint) return;
                  if (inlineEl) finishActiveInlineNoSave();
                  openColorSurface(hit.surface, hit.el);
                  return;
                }
                if (hit.type === 'buttonColor') {
                  if (!paint) return;
                  if (inlineEl) finishActiveInlineNoSave();
                  openChromeColorTarget('button', hit.el);
                  return;
                }
                // Paint mode is color-only; ignore text / image / sheet hits.
                if (paint) return;
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
                if (!isBackgroundPaintArmed()) {
                  /* Color long-press only while Background paint mode is armed. */
                } else if (hit.type === 'color' && hit.surface === 'hero' && isHeroImageQuickEditTarget(touchTarget)) {
                  if (isLuxeHeroPhotoSurface(touchTarget)) {
                    /* Luxe hero is photo-only; no long-press color. */
                  } else {
                    colorLongPressTimer = setTimeout(function() {
                      colorLongPressFired = true;
                      if (inlineEl) finishActiveInlineNoSave();
                      openColorSurface('hero', hit.el);
                    }, 380);
                  }
                } else if (!isBlueOutlinedTextRegion(touchTarget) && !isLuxeHeroPhotoSurface(touchTarget)) {
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
                setEditFontSize(inlineEl, px);
                noteDirtyFrom(inlineEl);
                postInlineFocus(inlineEl);
              };
              window.__bkQuickEditSetInlineColor = function(hex) {
                if (!inlineEl || !inlineEl.isConnected) return;
                var h = (hex && String(hex).trim()) ? String(hex).trim() : '';
                if (h && h.charAt(0) !== '#') h = '#' + h;
                if (h) {
                  try { inlineEl.style.setProperty('color', h, 'important'); }
                  catch (e) { inlineEl.style.color = h; }
                }
              };
              window.__bkQuickEditCommitDirty = function() {
                if (inlineEl) {
                  noteDirtyFrom(inlineEl);
                  stripEditableShell(inlineEl);
                  inlineEl = null;
                  postInlineBlur();
                }
                flushDirtyToNative();
              };
              function firstEditNode(key) {
                var el = null;
                [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(node) {
                  if (!el && node.getAttribute('data-edit-key') === key) el = node;
                });
                return el;
              }
              function allEditNodes(key) {
                var out = [];
                [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(node) {
                  if (node.getAttribute('data-edit-key') === key) out.push(node);
                });
                return out;
              }
              function groupedWrapperFor(el) {
                if (!el || !el.closest) return null;
                var grouped = el.closest(bkGroupedTextSelector);
                if (!grouped || grouped === el) return null;
                var keys = {};
                [].forEach.call(grouped.querySelectorAll('[data-edit-key]'), function(n) {
                  var k = n.getAttribute('data-edit-key') || '';
                  if (k) keys[k] = true;
                });
                var selfKey = el.getAttribute && el.getAttribute('data-edit-key');
                if (selfKey) keys[selfKey] = true;
                if (Object.keys(keys).length > 1) return null;
                return grouped;
              }
              function setEditFontSize(el, px) {
                if (!el) return;
                var size = parseInt(px, 10);
                if (!(size >= 10 && size <= 96)) {
                  el.style.removeProperty('font-size');
                  var wrapClear = groupedWrapperFor(el);
                  if (wrapClear) wrapClear.style.removeProperty('font-size');
                  return;
                }
                var val = size + 'px';
                try { el.style.setProperty('font-size', val, 'important'); }
                catch (e) { el.style.fontSize = val; }
                var wrap = groupedWrapperFor(el);
                if (wrap) {
                  try { wrap.style.setProperty('font-size', val, 'important'); }
                  catch (e2) { wrap.style.fontSize = val; }
                }
              }
              function setEditFieldColor(el, hex) {
                if (!el) return;
                var h = hex == null ? '' : String(hex).trim();
                if (h && h.charAt(0) !== '#') h = '#' + h;
                if (!h) {
                  el.style.removeProperty('color');
                  var wrapClear = groupedWrapperFor(el);
                  if (wrapClear) wrapClear.style.removeProperty('color');
                  return;
                }
                try { el.style.setProperty('color', h, 'important'); }
                catch (e) { el.style.color = h; }
                var wrap = groupedWrapperFor(el);
                if (wrap) {
                  try { wrap.style.setProperty('color', h, 'important'); }
                  catch (e2) { wrap.style.color = h; }
                }
              }
              window.__bkQuickEditApplyTextMap = function(map) {
                if (!map) return;
                Object.keys(map).forEach(function(k) {
                  var val = map[k] == null ? '' : String(map[k]);
                  var saveKey = canonicalTextSaveKey(k);
                  if (saveKey === 'displayName') {
                    [].forEach.call(document.querySelectorAll('[data-bk-text-field="displayName"]'), function(el) {
                      el.textContent = val;
                      if (val) {
                        el.removeAttribute('data-bk-empty-slot');
                        el.removeAttribute('data-bk-empty-slot-label');
                        el.classList.remove('bk-copy-empty');
                      }
                    });
                    return;
                  }
                  allEditNodes(k).forEach(function(el) {
                    el.textContent = val;
                    if (val) {
                      el.removeAttribute('data-bk-empty-slot');
                      el.removeAttribute('data-bk-empty-slot-label');
                      el.classList.remove('bk-copy-empty');
                    }
                  });
                });
              };
              window.__bkQuickEditApplyFontSizes = function(map) {
                map = map || {};
                if (!Object.keys(map).length) {
                  [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(el) {
                    setEditFontSize(el, '');
                  });
                  if (inlineEl) postInlineFocus(inlineEl);
                  return;
                }
                Object.keys(map).forEach(function(k) {
                  allEditNodes(k).forEach(function(el) { setEditFontSize(el, map[k]); });
                  if (inlineEl && inlineEl.getAttribute('data-edit-key') === k) postInlineFocus(inlineEl);
                });
              };
              window.__bkQuickEditApplyFieldColors = function(map) {
                map = map || {};
                if (!Object.keys(map).length) {
                  [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(el) {
                    setEditFieldColor(el, '');
                  });
                  if (inlineEl) postInlineFocus(inlineEl);
                  return;
                }
                Object.keys(map).forEach(function(k) {
                  allEditNodes(k).forEach(function(el) { setEditFieldColor(el, map[k]); });
                  if (inlineEl && inlineEl.getAttribute('data-edit-key') === k) postInlineFocus(inlineEl);
                });
              };
              window.__bkQuickEditApplyButtonColors = function(map) {
                window.__bkNativeButtonColors = map || {};
                if (typeof window.__bkApplyWebButtonColors === 'function') {
                  window.__bkApplyWebButtonColors({ webButtonColors: map || {} });
                }
              };
              window.__bkQuickEditApplySurfaceColors = function(map) {
                window.__bkNativeSurfaceColors = map || {};
                if (typeof window.__bkApplyWebSurfaceColors === 'function') {
                  window.__bkApplyWebSurfaceColors({ webSurfaceColors: map || {} });
                }
              };
              window.__bkQuickEditBackgroundPaint = false;
              window.__bkQuickEditSetBackgroundPaint = function(on) {
                window.__bkQuickEditBackgroundPaint = !!on;
                if (on) {
                  if (inlineEl) finishActiveInlineNoSave();
                  try { document.documentElement.setAttribute('data-bk-paint-mode', '1'); } catch (e) {}
                } else {
                  try { document.documentElement.removeAttribute('data-bk-paint-mode'); } catch (e2) {}
                  setActiveColorSurface(null);
                }
              };
              function ensureColorBandHitAndWrap(el) {
                if (!el || el.tagName === 'NAV') return;
                if (el.classList && el.classList.contains('blade-page')) return;
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
                if (el.querySelector(':scope > .bk-band-content') || el.querySelector(':scope > .blade-band-content')) return;
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
                [].forEach.call(document.querySelectorAll(
                  '.charter-section, .charter-footer, .charter-shop-layout, .charter-nav, .charter-hero'
                ), function(el) {
                  if (el.closest && el.closest('[data-bk-surface-key]')) return;
                  if (el.closest && el.closest('.charter-search, .charter-route-canvas')) return;
                  if (!el.getAttribute('data-bk-color-surface')) el.setAttribute('data-bk-color-surface', 'page');
                  if (!el.getAttribute('data-bk-band-tappable')) el.setAttribute('data-bk-band-tappable', '');
                  ensureColorBandHitAndWrap(el);
                });
                [].forEach.call(document.querySelectorAll('[data-bk-color-surface][data-bk-band-tappable]'), function(el) {
                  ensureColorBandHitAndWrap(el);
                });
              }
              upgradeColorBandTaps();
              /* Live color updates: keep page fn if present; otherwise install a fallback so paint works
                 even when hosting HTML is behind the app or a prior cleanup wiped the global. */
              window.__bkQuickEditEnsureColorPatch = function() {
                if (typeof window.__bkApplyPreviewColorPatch === 'function') return;
                window.__bkApplyPreviewColorPatch = function(patch, opts) {
                  if (!patch) return;
                  var root = document.documentElement;
                  function setVar(k, v) { if (v) root.style.setProperty(k, v); }
                  setVar('--bk-bg', patch.backgroundColor);
                  setVar('--bk-fg', patch.textColor);
                  setVar('--bk-card', patch.cardSurfaceColor);
                  setVar('--bk-accent', patch.primaryColor);
                  setVar('--bk-accent-hover', patch.primaryColorHover);
                  setVar('--bk-accent-ink', patch.accentTextColor || patch.primaryColor);
                  if (patch.sidebarBackgroundColor) setVar('--bk-sidebar-accent-bg', patch.sidebarBackgroundColor);
                  if (patch.sidebarTextColor) setVar('--bk-sidebar-accent-fg', patch.sidebarTextColor);
                  if (patch.sidebarCloseIconColor) setVar('--bk-sidebar-close-icon', patch.sidebarCloseIconColor);
                  var openIcon = (patch.sidebarIconColorHome || '').trim() || (patch.primaryColor || '').trim();
                  var sideBg = (patch.sidebarBackgroundColor || '').trim();
                  var sideFg = (patch.sidebarTextColor || '').trim();
                  var sideClose = (patch.sidebarCloseIconColor || '').trim();
                  if (sideBg || sideFg) {
                    [].forEach.call(document.querySelectorAll('.tattoo-sidebar-panel'), function(panel) {
                      if (sideBg) panel.style.background = sideBg;
                      if (sideFg) panel.style.color = sideFg;
                    });
                  }
                  if (sideFg) {
                    [].forEach.call(document.querySelectorAll('.tattoo-sidebar-panel a'), function(a) {
                      a.style.color = sideFg;
                    });
                    [].forEach.call(document.querySelectorAll('.tattoo-sidebar-wordmark [data-edit-key]'), function(span) {
                      var k = (span.getAttribute('data-edit-key') || '').trim();
                      var override = (window.__bkCachedWebTextColors || {})[k];
                      if (override && String(override).charAt(0) === '#') return;
                      try { span.style.setProperty('color', sideFg, 'important'); }
                      catch (eWord) { span.style.color = sideFg; }
                    });
                  }
                  if (sideClose) {
                    [].forEach.call(document.querySelectorAll('.tattoo-sidebar-close'), function(btn) {
                      try { btn.style.setProperty('color', sideClose, 'important'); }
                      catch (eClose) { btn.style.color = sideClose; }
                    });
                  }
                  if (openIcon) {
                    setVar('--bk-sidebar-open-icon', openIcon);
                    [].forEach.call(document.querySelectorAll('.tattoo-nav-menu'), function(b) {
                      try {
                        b.style.setProperty('color', openIcon, 'important');
                        if (b.classList && b.classList.contains('blade-nav-menu-btn')) {
                          b.style.setProperty('-webkit-text-fill-color', openIcon, 'important');
                        }
                      } catch (eIcon) { b.style.color = openIcon; }
                    });
                  }
                  setVar('--bk-featured-bg', patch.featuredWorkBackgroundColor);
                  setVar('--bk-featured-fg', patch.featuredWorkTextColor);
                  setVar('--bk-gallery-bg', patch.galleryPageBackgroundColor);
                  setVar('--bk-gallery-fg', patch.galleryPageTextColor);
                  setVar('--bk-about-bg', patch.aboutSectionBackgroundColor);
                  setVar('--bk-about-fg', patch.aboutSectionTextColor);
                  if (patch.heroSlotBg) setVar('--bk-hero-slot-bg', patch.heroSlotBg);
                  if (patch.backgroundColor) {
                    document.body.style.background = patch.backgroundColor;
                    document.body.style.backgroundImage = '';
                    if (patch.textColor) document.body.style.color = patch.textColor;
                  }
                  var full = !opts || opts.full !== false;
                  if (!full) return;
                  [].forEach.call(document.querySelectorAll('[data-bk-color-surface]'), function(el) {
                    if (el.tagName === 'NAV') return;
                    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
                    if (el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-bk-surface-key]')) return;
                    var sid = el.getAttribute('data-bk-color-surface');
                    var bg = null, fg = null;
                    if (sid === 'page' || sid === 'hero') {
                      bg = patch.backgroundColor; fg = patch.textColor;
                    } else if (sid === 'card') {
                      bg = patch.cardSurfaceColor; fg = patch.textColor;
                    } else if (sid === 'featured') {
                      bg = patch.featuredWorkBackgroundColor; fg = patch.featuredWorkTextColor;
                    } else if (sid === 'gallery') {
                      bg = patch.galleryPageBackgroundColor; fg = patch.galleryPageTextColor;
                    } else if (sid === 'about') {
                      bg = patch.aboutSectionBackgroundColor; fg = patch.aboutSectionTextColor;
                    }
                    if (bg) el.style.background = bg;
                    if (fg && !el.querySelector('[data-edit-key]')) el.style.color = fg;
                  });
                };
              };
              window.__bkQuickEditEnsureColorPatch();
              window.__bkQuickEditInstalled = true;
              window.__bkQuickEditCleanup = function(commitToNative) {
                if (commitToNative !== false) {
                  if (inlineEl) {
                    noteDirtyFrom(inlineEl);
                    stripEditableShell(inlineEl);
                    inlineEl = null;
                    postInlineBlur();
                  }
                  flushDirtyToNative();
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
                window.__bkQuickEditBackgroundPaint = false;
                try { document.documentElement.removeAttribute('data-bk-paint-mode'); } catch (e3) {}
                delete window.__bkQuickEditSuppressClickUntil;
                delete window.__bkQuickEditNavigateEditable;
                delete window.__bkQuickEditSetInlineColor;
                delete window.__bkQuickEditSetFontSize;
                delete window.__bkQuickEditCommitDirty;
                delete window.__bkQuickEditApplyTextMap;
                delete window.__bkQuickEditApplyFontSizes;
                delete window.__bkQuickEditApplyFieldColors;
                delete window.__bkQuickEditApplyButtonColors;
                delete window.__bkQuickEditApplySurfaceColors;
                delete window.__bkQuickEditSetBackgroundPaint;
                clearEmptyTextSlots();
                delete window.__bkQuickEditShowEmptyTextSlots;
                // Keep __bkApplyPreviewColorPatch — live paint must survive Edit off/on without a full reload.
                delete window.__bkQuickEditEnsureColorPatch;
                delete window.__bkQuickEditCleanup;
              };
            })();
            """
            webView.evaluateJavaScript(js) { [weak self] _, error in
                guard let self else { return }
                self.quickEditInstallInFlight = false
                guard error == nil, self.quickEditEnabled else { return }
                self.quickEditInstalledForDocument = true
                if let bridge = self.bridge, bridge.backgroundPaintArmed {
                    bridge.setBackgroundPaintMode(true)
                }
                self.bridge?.reapplyCachedStyleMaps()
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
