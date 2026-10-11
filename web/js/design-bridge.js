/**
 * Design editor bridge — runs on the public booking site when framed by getbookking.com/design.
 * Dormant for normal visitors and for the iOS WKWebView (no ?bk_design=1 / Design shell).
 * Speaks postMessage with the parent Design shell only.
 */
(function () {
  'use strict';

  var ALLOWED_PARENT_ORIGINS = [
    'https://getbookking.com',
    'https://www.getbookking.com',
    'https://getbooking.com',
    'https://www.getbooking.com',
    'https://test-app-96812-marketing.web.app',
    'http://127.0.0.1:5000',
    'http://localhost:5000',
    'http://127.0.0.1:5002',
    'http://localhost:5002',
    'http://127.0.0.1:5007',
    'http://localhost:5007'
  ];

  var SHEET_ONLY = {
    heroImage: 1,
    studio12PhilosophyImage: 1,
    studio12BookCtaImage: 1,
    classicAboutImage: 1
  };

  /** Keys the web editor cannot save yet — no dashed outline, no inline edit. */
  function isUnsupportedTextKey(key) {
    if (!key) return true;
    if (/^svc:/.test(key)) return true;
    if (/^s12Process:/.test(key)) return true;
    if (/^charterFaq:/.test(key)) return true;
    if (/^tm:/.test(key)) return true;
    if (/:edit$/.test(key)) return true;
    return false;
  }

  var active = false;
  var browsing = false;
  var designTool = null;
  var cursorEl = null;
  var lastSample = '';
  var hoverEl = null;
  var hoverFrame = null;
  var selectFrame = null;
  var parentOrigin = null;
  var pendingSection = null;
  var cardClicksInstalled = false;
  var styleEl = null;
  var editingEl = null;
  var markObserver = null;
  var stampTimer = null;
  var navGuardsInstalled = false;
  var originalAssign = null;
  var originalReplace = null;
  var originalOpen = null;
  var originalPushState = null;
  var originalReplaceState = null;

  function resolveEditTarget(t) {
    if (!t || !t.closest) return null;
    var keyed = t.closest('[data-edit-key]');
    if (keyed) return keyed;
    var link = t.closest('a[href]');
    if (link) {
      if (link.getAttribute('data-edit-key')) return link;
      return link.querySelector('[data-edit-key][data-bk-design-editable="1"],[data-edit-key][data-bk-design-photo="1"]') ||
        link.querySelector('[data-edit-key]');
    }
    return null;
  }

  function activateEditTarget(keyed) {
    if (!keyed) return false;
    var key = keyed.getAttribute('data-edit-key');
    if (isUnsupportedTextKey(key) && !isPhotoKey(key)) return false;
    if (isSheetOnlyKey(key)) {
      selectPhoto(keyed, key);
      return true;
    }
    if (isInlineTextKey(key)) {
      startInlineEdit(keyed);
      return true;
    }
    return false;
  }

  function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (ALLOWED_PARENT_ORIGINS.indexOf(origin) !== -1) return true;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
    return false;
  }

  function post(type, payload) {
    if (type === 'section-open' && (!parentOrigin || window.parent === window)) {
      pendingSection = payload || {};
      return;
    }
    if (!parentOrigin || window.parent === window) return;
    try {
      window.parent.postMessage({ source: 'bk-design-bridge', type: type, payload: payload || {} }, parentOrigin);
    } catch (e) { /* ignore */ }
  }

  function flushPendingSection() {
    if (!pendingSection || !parentOrigin || window.parent === window) return;
    var payload = pendingSection;
    pendingSection = null;
    post('section-open', payload);
  }

  function isSheetOnlyKey(key) {
    if (!key) return true;
    if (SHEET_ONLY[key]) return true;
    if (key.indexOf('galleryImage') === 0) return true;
    if (key.indexOf('featuredWork') === 0) return true;
    return false;
  }

  function isPhotoKey(key) {
    return isSheetOnlyKey(key);
  }

  function isInlineTextKey(key) {
    if (!key || isSheetOnlyKey(key) || isUnsupportedTextKey(key)) return false;
    if (key.indexOf('color:') === 0) return false;
    return true;
  }

  function textOf(el) {
    var raw = (el.innerText != null ? el.innerText : el.textContent) || '';
    return String(raw).replace(/^\s+|\s+$/g, '');
  }

  function ringChild(el, kind) {
    if (!el || !el.children) return null;
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (child.getAttribute && child.getAttribute('data-ring') === kind) return child;
    }
    return null;
  }

  function ensureCardRing(el, kind) {
    if (!el || ringChild(el, kind)) return;
    if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
    var ring = document.createElement('div');
    ring.className = 'bk-card-ring';
    ring.setAttribute('data-ring', kind);
    el.appendChild(ring);
  }

  function removeCardRing(el, kind) {
    var ring = ringChild(el, kind);
    if (ring && ring.parentNode) ring.parentNode.removeChild(ring);
  }

  function clearSelection() {
    [].forEach.call(document.querySelectorAll('[data-bk-design-selected]'), function (n) {
      n.removeAttribute('data-bk-design-selected');
      removeCardRing(n, 'selected');
    });
    if (selectFrame) {
      selectFrame.style.display = 'none';
      selectFrame.removeAttribute('data-label');
    }
  }

  function placeCaretAtEnd(el) {
    try {
      el.focus();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) { /* ignore */ }
  }

  function installStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.id = 'bk-design-bridge-style';
    // Canvas-only: site chrome is inert. Only edit / photo / color targets receive hits.
    styleEl.textContent =
      'html.bk-design-mode{overscroll-behavior:none;}' +
      'html.bk-design-mode a[href],' +
      'html.bk-design-mode button,' +
      'html.bk-design-mode input,' +
      'html.bk-design-mode select,' +
      'html.bk-design-mode textarea,' +
      'html.bk-design-mode form,' +
      'html.bk-design-mode label,' +
      'html.bk-design-mode [role="button"],' +
      'html.bk-design-mode [role="link"],' +
      'html.bk-design-mode .tattoo-sidebar,' +
      'html.bk-design-mode .tattoo-nav-menu,' +
      'html.bk-design-mode .gallery-lightbox-trigger{pointer-events:none!important;cursor:default!important;}' +
      /* Menu opens the drawer; the panel fill is the sidebar color. */
      'html.bk-design-mode .tattoo-nav-menu,' +
      'html.bk-design-mode .tattoo-sidebar-panel,' +
      'html.bk-design-mode .tattoo-sidebar-close{pointer-events:auto!important;cursor:pointer!important;}' +
      'html.bk-design-mode .tattoo-sidebar-open .tattoo-sidebar-backdrop{pointer-events:auto!important;cursor:pointer!important;}' +
      'html.bk-design-mode .tattoo-sidebar:not(.tattoo-sidebar-open) .tattoo-sidebar-backdrop{pointer-events:none!important;}' +
      'html.bk-design-mode .tattoo-sidebar-open .tattoo-sidebar-panel{outline:2px dashed rgba(139,111,71,0.45)!important;outline-offset:-2px!important;}' +
      'html.bk-design-mode .tattoo-sidebar-panel[data-bk-design-selected]{outline:2px solid rgba(44,32,24,0.85)!important;outline-offset:-2px!important;}' +
      /* Band content stays hittable so each home card, not the invisible cover, is the target. */
      'html.bk-design-mode .bk-band-content,' +
      'html.bk-design-mode .blade-band-content{pointer-events:auto!important;}' +
      'html.bk-design-mode button.bk-hero-image-hit,' +
      'html.bk-design-mode button.luxe-hero-image-hit,' +
      'html.bk-design-mode button.bk-color-band-hit,' +
      'html.bk-design-mode button.bk-hero-image-hit[data-edit-key],' +
      'html.bk-design-mode button.luxe-hero-image-hit[data-edit-key],' +
      'html.bk-design-mode button.bk-color-band-hit[data-edit-key]{pointer-events:none!important;}' +
      /* Re-enable only builder targets */
      'html.bk-design-mode [data-edit-key][data-bk-design-editable="1"],' +
      'html.bk-design-mode [data-edit-key][data-bk-design-photo="1"],' +
      'html.bk-design-mode [data-bk-color-surface],' +
      'html.bk-design-mode nav,' +
      'html.bk-design-mode footer{pointer-events:auto!important;}' +
      /* Brand / CTA links that wrap editable text — hit the link, edit the child, never navigate */
      'html.bk-design-mode a[href]:has([data-bk-design-editable="1"]),' +
      'html.bk-design-mode a[href]:has([data-bk-design-photo="1"]),' +
      'html.bk-design-mode a[data-edit-key][data-bk-design-editable="1"],' +
      'html.bk-design-mode a[data-edit-key][data-bk-design-photo="1"]{pointer-events:auto!important;cursor:text!important;}' +
      'html.bk-design-mode a[href]:has([data-bk-design-editable="1"]) [data-bk-design-editable="1"],' +
      'html.bk-design-mode a[href]:has([data-bk-design-photo="1"]) [data-bk-design-photo="1"]{pointer-events:auto!important;}' +
      'html.bk-design-mode [data-edit-key]{cursor:default;outline:none!important;box-shadow:none!important;}' +
      'html.bk-design-mode.bk-tool-text [data-edit-key][data-bk-design-editable="1"]{cursor:text!important;' +
      'outline:2px dashed rgba(139,111,71,0.55)!important;outline-offset:3px!important;}' +
      'html.bk-design-mode [data-edit-key][data-bk-inline-editing]{outline:2px solid rgba(44,32,24,0.9)!important;' +
      'outline-offset:3px!important;}';
    document.head.appendChild(styleEl);
    stampEditableMarks();
  }

  function stampEditableMarks() {
    [].forEach.call(document.querySelectorAll('[data-edit-key]'), function (el) {
      var key = el.getAttribute('data-edit-key');
      el.removeAttribute('data-bk-design-editable');
      el.removeAttribute('data-bk-design-photo');
      if (isPhotoKey(key)) {
        el.setAttribute('data-bk-design-photo', '1');
      } else if (isInlineTextKey(key)) {
        el.setAttribute('data-bk-design-editable', '1');
      }
    });
  }

  function scheduleStamp() {
    if (stampTimer) return;
    stampTimer = setTimeout(function () {
      stampTimer = null;
      if (active) stampEditableMarks();
    }, 80);
  }

  function observeEditableMarks() {
    if (markObserver || !document.documentElement) return;
    markObserver = new MutationObserver(scheduleStamp);
    markObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObservingEditableMarks() {
    if (markObserver) {
      markObserver.disconnect();
      markObserver = null;
    }
    if (stampTimer) {
      clearTimeout(stampTimer);
      stampTimer = null;
    }
  }

  function uninstallStyle() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    if (hoverFrame && hoverFrame.parentNode) hoverFrame.parentNode.removeChild(hoverFrame);
    if (selectFrame && selectFrame.parentNode) selectFrame.parentNode.removeChild(selectFrame);
    hoverFrame = null;
    selectFrame = null;
    document.documentElement.classList.remove('bk-design-mode');
    clearSelection();
    [].forEach.call(document.querySelectorAll('[data-bk-design-editable],[data-bk-design-photo]'), function (n) {
      n.removeAttribute('data-bk-design-editable');
      n.removeAttribute('data-bk-design-photo');
    });
    if (editingEl) {
      editingEl.removeAttribute('contenteditable');
      editingEl.removeAttribute('spellcheck');
      editingEl.removeAttribute('data-bk-inline-editing');
      editingEl = null;
    }
  }

  function commitInlineEdit() {
    if (!editingEl) return;
    var key = editingEl.getAttribute('data-edit-key');
    var value = textOf(editingEl);
    editingEl.removeAttribute('contenteditable');
    editingEl.removeAttribute('spellcheck');
    editingEl.removeAttribute('data-bk-inline-editing');
    var el = editingEl;
    editingEl = null;
    if (!key || !isInlineTextKey(key)) return;
    post('field-edit', { key: key, value: value });
    el.setAttribute('data-bk-design-selected', '1');
  }

  function startInlineEdit(el) {
    if (editingEl === el) return;
    commitInlineEdit();
    clearSelection();
    editingEl = el;
    el.setAttribute('data-bk-inline-editing', '1');
    el.setAttribute('data-bk-design-selected', '1');
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'true');
    setTimeout(function () {
      if (editingEl !== el) return;
      placeCaretAtEnd(el);
    }, 0);
    post('field-select', {
      key: el.getAttribute('data-edit-key'),
      value: textOf(el),
      kind: 'text'
    });
  }

  function selectPhoto(keyed, key) {
    commitInlineEdit();
    clearSelection();
    keyed.setAttribute('data-bk-design-selected', '1');
    post('field-select', { key: key, kind: 'sheet', value: '' });
  }

  function stopNavEvent(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  }

  /** Clicks inside the preview open the card. Navigation stays off while Edit is on. */
  function onClickCapture(ev) {
    if (!designLive()) return;
    var t = ev.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    if (t && t.closest && (t.closest('.tattoo-nav-menu') || t.closest('.tattoo-sidebar-close') || (t.closest('.tattoo-sidebar-backdrop') && t.closest('.tattoo-sidebar-open')))) {
      stopNavEvent(ev);
      return;
    }
    var card = (t && cardFromPoint(ev.clientX, ev.clientY)) || (t && cardTargetFrom(t));
    if (card) {
      stopNavEvent(ev);
      selectCard(card);
      return;
    }
    if (active) stopNavEvent(ev);
  }

  function onSubmitCapture(ev) {
    if (!active) return;
    stopNavEvent(ev);
  }

  function installNavGuards() {
    if (navGuardsInstalled) return;
    navGuardsInstalled = true;
    try {
      originalAssign = window.location.assign.bind(window.location);
      window.location.assign = function () {
        if (active) return;
        return originalAssign.apply(window.location, arguments);
      };
    } catch (e) { /* ignore */ }
    try {
      originalReplace = window.location.replace.bind(window.location);
      window.location.replace = function () {
        if (active) return;
        return originalReplace.apply(window.location, arguments);
      };
    } catch (e2) { /* ignore */ }
    try {
      originalOpen = window.open.bind(window);
      window.open = function () {
        if (active) return null;
        return originalOpen.apply(window, arguments);
      };
    } catch (e3) { /* ignore */ }
    try {
      originalPushState = history.pushState.bind(history);
      history.pushState = function () {
        if (active) return;
        return originalPushState.apply(history, arguments);
      };
    } catch (e4) { /* ignore */ }
    try {
      originalReplaceState = history.replaceState.bind(history);
      history.replaceState = function () {
        if (active) return;
        return originalReplaceState.apply(history, arguments);
      };
    } catch (e5) { /* ignore */ }
  }

  function uninstallNavGuards() {
    if (!navGuardsInstalled) return;
    navGuardsInstalled = false;
    try {
      if (originalAssign) window.location.assign = originalAssign;
    } catch (e) { /* ignore */ }
    try {
      if (originalReplace) window.location.replace = originalReplace;
    } catch (e2) { /* ignore */ }
    try {
      if (originalOpen) window.open = originalOpen;
    } catch (e3) { /* ignore */ }
    try {
      if (originalPushState) history.pushState = originalPushState;
    } catch (e4) { /* ignore */ }
    try {
      if (originalReplaceState) history.replaceState = originalReplaceState;
    } catch (e5) { /* ignore */ }
    originalAssign = null;
    originalReplace = null;
    originalOpen = null;
    originalPushState = null;
    originalReplaceState = null;
  }

  function cssColorToHex(rgb) {
    var text = String(rgb || '');
    var m = text.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return '';
    if (/rgba/i.test(text)) {
      var alpha = text.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/i);
      if (alpha && Number(alpha[1]) === 0) return '';
    }
    function part(n) {
      var s = Number(n).toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    return ('#' + part(m[1]) + part(m[2]) + part(m[3])).toUpperCase();
  }

  function ensureToolCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = 'bk-design-cursor';
    cursorEl.style.cssText = 'position:fixed;z-index:100000;pointer-events:none;display:none;align-items:center;gap:6px;transform:translate(10px,14px);';
    document.body.appendChild(cursorEl);
    return cursorEl;
  }

  function syncToolCursorStyle() {
    var node = document.getElementById('bk-design-tool-cursor');
    if (!designTool || !active) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
      if (cursorEl) cursorEl.style.display = 'none';
      return;
    }
    if (!node) {
      node = document.createElement('style');
      node.id = 'bk-design-tool-cursor';
      document.head.appendChild(node);
    }
    node.textContent = 'html.bk-design-mode, html.bk-design-mode *{cursor:none!important;}' +
      'html.bk-design-mode [data-bk-inline-editing]{cursor:text!important;}';
  }

  function designLive() {
    return active || document.documentElement.classList.contains('bk-design-mode');
  }

  function ensureFrame(id, selected) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      document.documentElement.appendChild(el);
    }
    el.style.cssText =
      'position:fixed;z-index:2147483000;pointer-events:none!important;box-sizing:border-box;display:none;margin:0;padding:0;' +
      'border:' + (selected ? '3px' : '2px') + ' solid #2C2018;' +
      'background:rgba(44,32,24,' + (selected ? '0.16' : '0.12') + ');' +
      'box-shadow:0 0 0 1px #F5EDD8;';
    return el;
  }

  function placeFrame(frame, node) {
    if (!frame) return;
    if (!node || !node.getBoundingClientRect) {
      frame.style.display = 'none';
      return;
    }
    var r = node.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      frame.style.display = 'none';
      return;
    }
    frame.style.display = 'block';
    frame.style.left = Math.round(r.left) + 'px';
    frame.style.top = Math.round(r.top) + 'px';
    frame.style.width = Math.round(r.width) + 'px';
    frame.style.height = Math.round(r.height) + 'px';
    var chip = frame.firstChild;
    if (!chip) {
      chip = document.createElement('span');
      chip.style.cssText = 'position:absolute;left:10px;z-index:1;background:#2C2018;color:#F5EDD8;' +
        'font:600 12px/1.2 "DM Sans",system-ui,sans-serif;padding:6px 9px;border-radius:4px;' +
        'pointer-events:none;white-space:nowrap;';
      frame.appendChild(chip);
    }
    chip.textContent = frame.getAttribute('data-label') || 'Section';
    var chipTop = 10;
    if (r.top < 8) chipTop = Math.min(Math.max(10, 8 - r.top), Math.max(10, r.height - 32));
    chip.style.top = chipTop + 'px';
  }

  function syncFrames() {
    hoverFrame = ensureFrame('bk-design-hover-frame', false);
    selectFrame = ensureFrame('bk-design-select-frame', true);
    placeFrame(hoverFrame, hoverEl);
    placeFrame(selectFrame, document.querySelector('[data-bk-design-selected]'));
  }

  function clearHoverTarget() {
    if (hoverEl) {
      hoverEl.removeAttribute('data-bk-design-hover');
      removeCardRing(hoverEl, 'hover');
    }
    hoverEl = null;
    if (hoverFrame) {
      hoverFrame.style.display = 'none';
      hoverFrame.removeAttribute('data-label');
    }
  }

  function setHoverTarget(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    if (node && node.hasAttribute && node.hasAttribute('data-bk-design-selected')) node = null;
    if (hoverEl === node) {
      syncFrames();
      return;
    }
    clearHoverTarget();
    hoverEl = node || null;
    if (!hoverEl) {
      syncFrames();
      return;
    }
    hoverEl.setAttribute('data-bk-design-hover', '1');
    hoverFrame = ensureFrame('bk-design-hover-frame', false);
    hoverFrame.setAttribute('data-label', describeCard(hoverEl).label);
    syncFrames();
  }

  function isFrameNode(n) {
    if (!n || !n.closest) return false;
    return n.id === 'bk-design-hover-frame' || n.id === 'bk-design-select-frame' ||
      !!n.closest('#bk-design-hover-frame, #bk-design-select-frame');
  }

  function cardTargetFrom(t) {
    if (!t || !t.closest) return null;
    if (isFrameNode(t)) return null;
    if (t.closest('.tattoo-sidebar-backdrop') && !t.closest('.tattoo-sidebar-open')) return null;
    var hit = t.closest('.bk-color-band-hit, .bk-hero-image-hit, .luxe-hero-image-hit');
    if (hit && hit.parentNode && hit.parentNode.closest) t = hit.parentNode;
    var side = t.closest('.tattoo-sidebar-panel');
    if (side) return side;
    var keyed = t.closest('[data-bk-surface-key]');
    if (keyed && keyed !== document.body && keyed !== document.documentElement) return keyed;
    var surface = t.closest('[data-bk-color-surface]');
    if (surface) return surface;
    var footer = t.closest('footer');
    if (footer) return footer;
    var nav = t.closest('nav');
    if (nav) return nav;
    return null;
  }

  function cardFromPoint(x, y) {
    var frames = [
      document.getElementById('bk-design-hover-frame'),
      document.getElementById('bk-design-select-frame')
    ];
    var shown = frames.map(function (el) { return el ? el.style.display : ''; });
    frames.forEach(function (el) { if (el) el.style.display = 'none'; });
    var stack = [];
    try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { stack = []; }
    frames.forEach(function (el, i) { if (el) el.style.display = shown[i]; });
    for (var i = 0; i < stack.length; i++) {
      var n = stack[i];
      if (!n || isFrameNode(n)) continue;
      var card = cardTargetFrom(n);
      if (card) return card;
    }
    return null;
  }

  function colorTargetFrom(t) {
    return cardTargetFrom(t);
  }

  function ownedEditNodes(card) {
    var nodes = card.querySelectorAll ? card.querySelectorAll('[data-edit-key]') : [];
    var out = [];
    [].forEach.call(nodes, function (node) {
      var owner = node.closest('[data-bk-surface-key]') || node.closest('[data-bk-color-surface]');
      if (owner && owner !== card && card.contains(owner)) return;
      out.push(node);
    });
    return out;
  }

  // Current text alignment of the section's main heading, so the editor highlights the right option.
  function headingAlign(el) {
    var h = el.querySelector && el.querySelector('h1, h2');
    if (!h) return '';
    var ta = '';
    try { ta = window.getComputedStyle(h).textAlign; } catch (e) { return ''; }
    if (ta === 'center') return 'center';
    if (ta === 'right' || ta === 'end') return 'right';
    return 'left';
  }

  function describeCard(el) {
    var key = keyOnColorTarget(el);
    var surface = (el.getAttribute && el.getAttribute('data-bk-color-surface')) || '';
    var label = 'Section';
    if (el.classList && el.classList.contains('booking-card') || /bookingCard$/.test(key) || key === 'charter.stickyBook') label = 'Booking form';
    else if (el.classList && el.classList.contains('booking-page-band') || /bookingPage$/.test(key)) label = 'Booking page';
    else if ((el.matches && el.matches('nav')) || (el.classList && el.classList.contains('tattoo-nav')) || /\.nav$/.test(key)) label = 'Header';
    else if ((el.tagName && el.tagName === 'FOOTER') || /\.footer$/.test(key) || key === 'luxe.legal') label = 'Footer';
    else if (/\.hero$/.test(key) || surface === 'hero') label = 'Hero';
    else if (/\.svcCard\./.test(key)) label = 'Service';
    else if (/\.services$/.test(key) || el.id === 'services') label = 'Services';
    else if (/shopPage$/.test(key)) label = 'Shop page';
    else if (/\.shop$/.test(key)) label = 'Shop';
    else if (/galleryPage$/.test(key) || surface === 'gallery') label = 'Gallery';
    else if (/\.about$/.test(key)) label = 'About';
    else if (/\.featured$/.test(key) || surface === 'featured') label = 'Featured';
    else if (/team/i.test(key)) label = 'Team';
    else if (surface === 'sidebar' || (el.classList && el.classList.contains('tattoo-sidebar-panel'))) label = 'Sidebar';
    else if (surface === 'about') label = 'Contact';
    else if (surface === 'page') label = 'Page';
    var texts = [];
    var photos = [];
    ownedEditNodes(el).forEach(function (node) {
      var editKey = node.getAttribute('data-edit-key');
      if (!editKey || isUnsupportedTextKey(editKey)) return;
      if (isPhotoKey(editKey)) {
        // Slots the current layout hides (e.g. the 4th tile in "Three across") aren't editable here.
        if (!node.getClientRects().length) return;
        if (photos.length < 5) photos.push({ key: editKey });
        return;
      }
      if (!isInlineTextKey(editKey) || texts.length >= 10) return;
      texts.push({ key: editKey, value: textOf(node) });
    });
    var buttons = [];
    [].forEach.call(el.querySelectorAll ? el.querySelectorAll('[data-cta-key]') : [], function (node) {
      var owner = node.closest('[data-bk-surface-key]') || node.closest('[data-bk-color-surface]');
      if (owner && owner !== el && el.contains(owner)) return;
      if (buttons.length >= 6) return;
      buttons.push({
        key: node.getAttribute('data-cta-key'),
        label: textOf(node) || 'Button'
      });
    });
    var hex = '';
    try { hex = cssColorToHex(window.getComputedStyle(el).backgroundColor); } catch (e) { hex = ''; }
    return {
      label: label,
      theme: document.documentElement.getAttribute('data-bk-theme') || '',
      align: headingAlign(el),
      surface: surface,
      surfaceKey: key,
      texts: texts,
      photos: photos,
      buttons: buttons,
      hex: hex
    };
  }

  function selectCard(card) {
    if (!card) return;
    commitInlineEdit();
    clearSelection();
    clearHoverTarget();
    card.setAttribute('data-bk-design-selected', '1');
    var info = describeCard(card);
    selectFrame = ensureFrame('bk-design-select-frame', true);
    selectFrame.setAttribute('data-label', info.label);
    syncFrames();
    post('section-open', info);
  }

  function keyOnColorTarget(el) {
    if (!el) return '';
    if (el.hasAttribute && el.hasAttribute('data-bk-surface-key')) {
      return (el.getAttribute('data-bk-surface-key') || '').trim();
    }
    var surface = el.getAttribute ? (el.getAttribute('data-bk-color-surface') || '') : '';
    if (surface === 'card') return '';
    var host = el.closest ? el.closest('[data-bk-surface-key]') : null;
    return host ? (host.getAttribute('data-bk-surface-key') || '').trim() : '';
  }

  function setDesignTool(tool) {
    designTool = tool === 'text' || tool === 'background' ? tool : null;
    lastSample = '';
    document.documentElement.classList.toggle('bk-tool-text', designTool === 'text');
    document.documentElement.classList.toggle('bk-tool-background', designTool === 'background');
    clearHoverTarget();
    syncToolCursorStyle();
  }

  function onToolPointerMove(ev) {
    if (!designLive()) return;
    if (!editingEl) setHoverTarget(cardFromPoint(ev.clientX, ev.clientY));
    if (!designTool) {
      if (cursorEl) cursorEl.style.display = 'none';
      return;
    }
    var el = ensureToolCursor();
    el.style.display = 'flex';
    el.style.left = ev.clientX + 'px';
    el.style.top = ev.clientY + 'px';
    if (designTool === 'text') {
      el.textContent = 'T';
      el.style.font = '650 22px/1 Georgia, "Times New Roman", serif';
      el.style.color = '#2c2018';
      el.style.textShadow = '0 1px 0 #fff';
      return;
    }
    var node = cardTargetFrom(ev.target);
    var hex = '';
    if (node) hex = cssColorToHex(window.getComputedStyle(node).backgroundColor);
    el.textContent = '';
    el.style.font = '';
    el.style.textShadow = '';
    var drop = document.createElement('span');
    drop.style.cssText = 'width:16px;height:16px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #2c2018;box-shadow:0 0 0 1px #fff;background:' + (hex || '#fff') + ';';
    var label = document.createElement('span');
    label.textContent = hex || '';
    label.style.cssText = 'font:11px/1.2 ui-monospace, monospace;color:#2c2018;background:rgba(255,255,255,.92);border-radius:4px;padding:1px 4px;';
    el.appendChild(drop);
    el.appendChild(label);
    if (hex !== lastSample) {
      lastSample = hex;
      post('color-sample', { hex: hex });
    }
  }

  function onPointerDown(ev) {
    if (!designLive()) return;
    var t = ev.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    if (!t || !t.closest) return;

    if (editingEl && (t === editingEl || editingEl.contains(t))) {
      return;
    }

    if (t.closest('.tattoo-nav-menu')) {
      stopNavEvent(ev);
      var sidebar = document.getElementById('tattoo-sidebar') || document.querySelector('.tattoo-sidebar');
      var open = !(sidebar && sidebar.classList.contains('tattoo-sidebar-open'));
      if (sidebar) sidebar.classList.toggle('tattoo-sidebar-open', open);
      [].forEach.call(document.querySelectorAll('.tattoo-nav-menu'), function (btn) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      return;
    }
    if (t.closest('.tattoo-sidebar-close') || (t.closest('.tattoo-sidebar-backdrop') && t.closest('.tattoo-sidebar-open'))) {
      stopNavEvent(ev);
      var drawer = document.getElementById('tattoo-sidebar') || document.querySelector('.tattoo-sidebar');
      if (drawer) drawer.classList.remove('tattoo-sidebar-open');
      [].forEach.call(document.querySelectorAll('.tattoo-nav-menu'), function (btn) {
        btn.setAttribute('aria-expanded', 'false');
      });
      return;
    }

    var card = cardFromPoint(ev.clientX, ev.clientY) || cardTargetFrom(t);
    if (card) {
      stopNavEvent(ev);
      selectCard(card);
      return;
    }

    stopNavEvent(ev);
  }

  function onDblClick(ev) {
    if (!active) return;
    var t = ev.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    if (!t || !t.closest) return;
    var keyed = t.closest('[data-edit-key]');
    if (!keyed) return;
    var key = keyed.getAttribute('data-edit-key');
    if (!isPhotoKey(key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectPhoto(keyed, key);
    post('photo-upload', { key: key });
  }

  function onKeyDown(ev) {
    if (!active) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (editingEl) {
        editingEl.blur();
      } else {
        clearSelection();
        post('field-select', null);
      }
      return;
    }
    if (!editingEl) return;
    // Live inspector sync while typing
    if (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter') {
      setTimeout(function () {
        if (!editingEl) return;
        post('field-input', {
          key: editingEl.getAttribute('data-edit-key'),
          value: textOf(editingEl),
          kind: 'text'
        });
      }, 0);
    }
  }

  function onInput() {
    if (!active || !editingEl) return;
    post('field-input', {
      key: editingEl.getAttribute('data-edit-key'),
      value: textOf(editingEl),
      kind: 'text'
    });
  }

  function onFocusOut(ev) {
    if (!active || !editingEl) return;
    if (ev.target === editingEl) commitInlineEdit();
  }

  function enable() {
    setBrowse(false);
    if (active) return;
    active = true;
    document.documentElement.classList.add('bk-design-mode');
    installStyle();
    observeEditableMarks();
    installNavGuards();
    installCardClicks();
    document.addEventListener('submit', onSubmitCapture, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusout', onFocusOut, true);
    post('ready', { href: location.href, cardClicks: true });
  }

  function disable() {
    if (editingEl) commitInlineEdit();
    if (active) {
      active = false;
      document.removeEventListener('pointerdown', onPointerDown, true);
      cardClicksInstalled = false;
      document.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('submit', onSubmitCapture, true);
      document.removeEventListener('dblclick', onDblClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('focusout', onFocusOut, true);
      stopObservingEditableMarks();
      uninstallNavGuards();
      uninstallStyle();
    }
    setBrowse(true);
    post('disabled', { href: location.href });
  }

  function paintRoleKeys(payload) {
    var surfaces = payload.surfaces || [];
    var hex = payload.hex || '';
    if (!surfaces.length || hex.charAt(0) !== '#') return;
    var want = {};
    surfaces.forEach(function (s) { want[s] = 1; });
    var keys = [];
    [].forEach.call(document.querySelectorAll('[data-bk-surface-key]'), function (el) {
      var sid = el.getAttribute('data-bk-color-surface') || '';
      if (!want[sid]) return;
      var key = (el.getAttribute('data-bk-surface-key') || '').trim();
      if (!key) return;
      keys.push(key);
      try { el.style.setProperty('background', hex, 'important'); }
      catch (e) { el.style.background = hex; }
    });
    post('role-keys', { keys: keys, hex: hex });
  }

  function applyColorPatch(patch) {
    if (typeof window.__bkApplyPreviewColorPatch === 'function') {
      window.__bkApplyPreviewColorPatch(patch, { full: true });
    }
  }

  function applyAnnouncement(text, enabled) {
    var existing = document.getElementById('bk-site-announcement');
    if (!enabled || !text) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'bk-site-announcement';
      existing.setAttribute('role', 'status');
      existing.style.cssText =
        'position:sticky;top:0;z-index:9999;width:100%;padding:10px 16px;text-align:center;' +
        'font:500 13px/1.4 DM Sans,system-ui,sans-serif;background:#2C2018;color:#F5EDD8;';
      document.body.insertBefore(existing, document.body.firstChild);
    }
    existing.textContent = text;
  }

  function applySeo(title, description) {
    if (title) document.title = title;
    var meta = document.querySelector('meta[name="description"]');
    if (description) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'description');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', description);
    }
  }

  function applyTextPatch(key, value) {
    if (!key) return;
    var nodes = document.querySelectorAll('[data-edit-key="' + key.replace(/"/g, '') + '"]');
    var text = value == null ? '' : String(value);
    [].forEach.call(nodes, function (el) {
      if (el === editingEl) return;
      el.textContent = text;
    });
    // Placement aliases for site display name
    if (key === 'wc.site.displayName' || key === 'displayName') {
      [].forEach.call(document.querySelectorAll('[data-edit-key^="displayName"]'), function (el) {
        if (el === editingEl) return;
        el.textContent = text;
      });
    }
  }

  function preserveDesignQuery(url) {
    var current = new URL(location.href);
    ['bk_design', 'bk_web_theme', 'bk_vis'].forEach(function (key) {
      var value = current.searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    });
    if (!url.searchParams.get('bk_design')) url.searchParams.set('bk_design', '1');
  }

  function navigate(path) {
    try {
      var url = new URL(path, location.origin);
      if (url.origin !== location.origin) return;
      preserveDesignQuery(url);
      var next = url.pathname + url.search + url.hash;
      if (originalAssign) originalAssign(next);
      else window.location.href = next;
    } catch (e) { /* ignore */ }
  }

  function onBrowseClick(ev) {
    if (!browsing || active) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    var url;
    try { url = new URL(href, location.href); } catch (e) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    ev.preventDefault();
    ev.stopPropagation();
    navigate(url.pathname + url.search + url.hash);
  }

  function setBrowse(on) {
    var inDesign = /(?:^|[?&])bk_design=1(?:&|$)/.test(location.search || '');
    browsing = !!(on && inDesign && !active);
    document.removeEventListener('click', onBrowseClick, true);
    if (browsing) document.addEventListener('click', onBrowseClick, true);
  }

  function helloOrigins() {
    var origins = {};
    ALLOWED_PARENT_ORIGINS.forEach(function (o) { origins[o] = 1; });
    try {
      if (document.referrer) origins[new URL(document.referrer).origin] = 1;
    } catch (e) { /* ignore */ }
    return Object.keys(origins);
  }

  window.addEventListener('message', function (ev) {
    if (!isAllowedOrigin(ev.origin)) return;
    var data = ev.data;
    if (!data || data.source !== 'bk-design-shell') return;
    parentOrigin = ev.origin;
    flushPendingSection();

    switch (data.type) {
      case 'ping':
        post('pong', { href: location.href, cardClicks: true });
        break;
      case 'enable':
        enable();
        syncToolCursorStyle();
        break;
      case 'disable':
        disable();
        syncToolCursorStyle();
        break;
      case 'tool':
        setDesignTool((data.payload && data.payload.tool) || '');
        break;
      case 'clear-selection':
        clearSelection();
        clearHoverTarget();
        break;
      case 'color-patch':
        applyColorPatch(data.payload || {});
        break;
      case 'layouts':
        if (window.__bkApplySectionLayouts) {
          window.__bkApplySectionLayouts({ webSectionLayouts: data.payload || {} });
        }
        syncFrames();
        // A layout can show or hide photo slots, so refresh the open section's fields.
        var selectedCard = document.querySelector('[data-bk-design-selected]');
        if (selectedCard) post('section-refresh', describeCard(selectedCard));
        break;
      case 'paint-role':
        paintRoleKeys(data.payload || {});
        break;
      case 'announcement':
        applyAnnouncement((data.payload || {}).text || '', !!(data.payload || {}).enabled);
        break;
      case 'seo':
        applySeo((data.payload || {}).title || '', (data.payload || {}).description || '');
        break;
      case 'text-patch':
        applyTextPatch((data.payload || {}).key, (data.payload || {}).value);
        break;
      case 'navigate':
        navigate((data.payload || {}).path || '/');
        break;
      case 'reload':
        location.reload();
        break;
      default:
        break;
    }
  });

  var lastPointer = { x: 0, y: 0 };
  function trackPointer(ev) {
    lastPointer.x = ev.clientX;
    lastPointer.y = ev.clientY;
    onToolPointerMove(ev);
  }
  function onDesignScroll() {
    if (!designLive()) return;
    if (editingEl) {
      syncFrames();
      return;
    }
    setHoverTarget(cardFromPoint(lastPointer.x, lastPointer.y));
  }
  document.addEventListener('pointermove', trackPointer, true);
  document.addEventListener('scroll', onDesignScroll, true);
  window.addEventListener('resize', onDesignScroll);

  function installCardClicks() {
    if (cardClicksInstalled) return;
    cardClicksInstalled = true;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClickCapture, true);
  }

  if (window.parent !== window && /(?:^|[?&])bk_design=1(?:&|$)/.test(location.search || '')) {
    document.documentElement.classList.add('bk-design-mode');
    installStyle();
    installCardClicks();
    setTimeout(function () {
      helloOrigins().forEach(function (origin) {
        try {
          window.parent.postMessage({ source: 'bk-design-bridge', type: 'hello', payload: { href: location.href, cardClicks: true } }, origin);
        } catch (e) { /* ignore */ }
      });
    }, 50);
  }
})();
